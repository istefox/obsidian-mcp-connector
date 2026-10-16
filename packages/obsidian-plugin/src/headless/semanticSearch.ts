/**
 * Semantic search for the headless server: the desktop feature, wired to a
 * plain cache directory instead of the vault's plugin folder.
 *
 * The desktop `wireSemanticSearch` is used as it is. It takes the plugin,
 * and everything it reaches through `plugin.app` is the headless side's to
 * supply: the vault adapter the embedding index is stored through is a
 * folder in the user's cache (outside the vault, `0700`/`0600`), the
 * layout is always ready, and `Notice` is a log line.
 *
 * Nothing is wired and nothing is fetched at startup. The first
 * `search_vault_smart` call goes through `gate`, which takes the lock on
 * the vault's index, wires the feature (which may rewrite an index in an
 * old format, so it must hold the lock), and returns. The call then starts
 * the indexer, which loads the model, which first downloads the ONNX
 * runtime files and then the model weights. Until the index is ready the
 * call returns the usual `index_building` error with progress.
 *
 * Cache layout, under $XDG_CACHE_HOME or ~/.cache:
 *   obsidian-mcp-connector/models/              model weights, shared
 *   obsidian-mcp-connector/ort-<version>/       ONNX runtime files, shared
 *   obsidian-mcp-connector/<vault>-<hash>/embeddings/   this vault's index
 *
 * One process at a time writes a vault's index (see cacheLock.ts). If
 * another process holds the lock, `search_vault_smart` stays registered and
 * answers with `semantic_search_unavailable`, and a later call tries again.
 *
 * Library settings the desktop wiring leaves to its environment are set
 * here, once, before the first model load: the browser cache is off
 * (Node defines `navigator`, which the shared configuration reads as a
 * browser, but has no Cache API), the model cache is the folder above, the
 * ONNX runtime files are the pinned local copies, and a request that gets
 * no response headers is abandoned.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { env as hfEnv } from "@huggingface/transformers";
import type { App } from "obsidian";
import { configureEnv } from "$/features/semantic-search/services/onnxEnv";
import { wireSemanticSearch } from "$/features/semantic-search/services/productionWiring";
import type { SemanticSearchState } from "$/features/semantic-search";
import { logger } from "$/shared/logger";
import {
  acquireLock,
  lockFilePath,
  type AcquireResult,
  type CacheLockDeps,
} from "./cacheLock";
import { RUNTIME_FILES_FAILED, codeOf, fixedMessage } from "./clientMessage";
import { withHeadersTimeout } from "./fetchTimeout";
import {
  asPlugin,
  createExclusionsHost,
  defaultCachePath,
  defaultCacheRoot,
  type HeadlessHost,
} from "./hostData";
import { nodeFsAdapter } from "./nodeFsAdapter";
import { ensureOrtAssets, ortAssetsPrefix } from "./ortAssets";
import { sessionHooks } from "./ortSessionPatch";

/** A request that gets no response headers in this long is abandoned. */
const HEADERS_TIMEOUT_MS = 30_000;

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

export type HeadlessSemantic = {
  /**
   * Run before every `search_vault_smart` call. Resolves undefined when the
   * search may go on, else why semantic search is unavailable right now.
   * Takes the index lock and wires the feature the first time.
   */
  gate: () => Promise<string | undefined>;
  /** Stop the indexer and give the lock up. Safe to call more than once. */
  teardown: () => Promise<void>;
};

/**
 * The `app` semantic search sees: the headless app, with the vault's
 * adapter swapped for the cache folder's. Everything else, the file list
 * and the events the indexer follows, is the vault's own.
 */
function appWithAdapter(app: App, adapter: unknown): App {
  const bound = <T extends object>(target: T, own: Record<string, unknown>) =>
    new Proxy(target, {
      get(t, prop) {
        if (typeof prop === "string" && prop in own) return own[prop];
        const value: unknown = Reflect.get(t, prop, t);
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(t)
          : value;
      },
    });
  const vault = bound(app.vault, { adapter });
  return bound(app, { vault });
}

/** The fetches this module made, so a second wiring does not wrap one twice. */
const timedFetches = new WeakSet<object>();

/**
 * Point transformers.js and onnxruntime-web at the cache. `configureEnv` is
 * the shared configuration, called first so that it is spent and does not
 * run again over these settings.
 */
function configureLibraries(root: string): void {
  configureEnv();
  // transformers.js falls back to "/.cache" without this, and would look
  // for models under a local path before the hub.
  hfEnv.cacheDir = path.join(root, "models");
  hfEnv.allowLocalModels = false;
  hfEnv.useBrowserCache = false;
  if (!timedFetches.has(hfEnv.fetch)) {
    const timed = withHeadersTimeout(hfEnv.fetch, HEADERS_TIMEOUT_MS);
    timedFetches.add(timed);
    hfEnv.fetch = timed;
  }
  const wasm = hfEnv.backends.onnx.wasm;
  if (wasm) wasm.wasmPaths = ortAssetsPrefix(root);
}

/**
 * What a client may read about a failure in the cache folder, the lock or
 * the wiring: `what` failed, and the error's code if it has one (see
 * clientMessage.ts). The whole error goes to the log, which is stderr on
 * the server.
 */
function forClient(
  what: string,
  err: unknown,
  code: string | undefined = codeOf(err),
): string {
  logger.error(`semantic-search: ${what}`, {
    error: err instanceof Error ? err.message : String(err),
  });
  return fixedMessage(what, code);
}

/** Make sure the ONNX runtime files are in the cache before a session is made. */
function prepareRuntimeOnce(root: string): () => Promise<void> {
  let runtime: Promise<void> | undefined;
  return () => {
    runtime ??= ensureOrtAssets(root, {
      // `init` carries the timeout's AbortSignal: dropping it would leave
      // a request that never answers hanging for good.
      fetch: withHeadersTimeout(
        (url, init) => fetch(url, init),
        HEADERS_TIMEOUT_MS,
      ) as (url: string) => Promise<Response>,
    }).then(
      () => undefined,
      (err: unknown) => {
        // The next attempt starts over rather than replaying the failure.
        runtime = undefined;
        // The session fails with this message, which a search can return.
        throw new Error(forClient(RUNTIME_FILES_FAILED, err));
      },
    );
    return runtime;
  };
}

/**
 * Semantic search for the vault at `vaultRealPath`, not yet wired. `app` is
 * the headless app. `transport` is the host the tools run under: its
 * `mcpTools` settings (the folder exclusions) are the ones the index
 * honors, and it receives `semanticSearchState` once the feature is wired.
 */
export function createHeadlessSemantic(
  app: App,
  vaultRealPath: string,
  transport: HeadlessHost,
  environment: Record<string, string | undefined> = process.env,
  lockDeps?: CacheLockDeps,
  seams: { prepareRoot?: () => Promise<void> } = {},
): HeadlessSemantic {
  const root = defaultCacheRoot(environment);
  const vaultDir = defaultCachePath(vaultRealPath, environment);
  const lockFile = lockFilePath(root, vaultDir);
  let held: Extract<AcquireResult, { ok: true }> | undefined;
  const prepareRuntime = prepareRuntimeOnce(root);
  let wiring: Promise<SemanticSearchState> | undefined;
  let closed = false;

  /**
   * The cache root, private. It exists before the lock is taken, because
   * the lock file lives in it. The index holds note paths and headings in
   * clear text.
   */
  const prepareRoot =
    seams.prepareRoot ??
    (async (): Promise<void> => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.chmod(root, 0o700);
    });

  async function wire(): Promise<SemanticSearchState> {
    await fs.mkdir(vaultDir, { recursive: true, mode: 0o700 });
    configureLibraries(root);
    sessionHooks.beforeCreate = prepareRuntime;
    sessionHooks.afterRun = yieldToEventLoop;
    const host = createExclusionsHost(
      {
        app: appWithAdapter(app, nodeFsAdapter(vaultDir)),
        // An empty plugin folder: the adapter's root is the cache folder.
        manifest: { ...transport.manifest, dir: "" },
      },
      transport,
    );
    const state = await wireSemanticSearch(asPlugin(host));
    if (!state) {
      throw new Error("the feature did not start, see the log");
    }
    transport.semanticSearchState = state;
    return state;
  }

  async function gate(): Promise<string | undefined> {
    if (closed)
      return "Semantic search is unavailable: the server is shutting down.";
    try {
      await prepareRoot();
    } catch (err) {
      return `Semantic search is unavailable: ${forClient("the cache folder could not be prepared", err)}`;
    }
    // Teardown may have run while the folder was being made. From here to
    // the wiring there is no await, so nothing can be taken after it.
    if (closed)
      return "Semantic search is unavailable: the server is shutting down.";
    const got = held ?? acquireLock(lockFile, lockDeps);
    if (!got.ok) {
      return got.error
        ? `Semantic search is unavailable: ${forClient("the index lock for this vault could not be taken", got.error, got.code)}`
        : "Semantic search is unavailable: another obsidian-mcp-headless process is using the semantic index for this vault. Use that server, or stop it and retry.";
    }
    held = got;
    wiring ??= wire().catch((err: unknown) => {
      // The next call starts over rather than replaying the failure.
      wiring = undefined;
      throw err;
    });
    try {
      await wiring;
    } catch (err) {
      return `Semantic search is unavailable: ${forClient("setup failed", err)}`;
    }
    return undefined;
  }

  async function teardown(): Promise<void> {
    closed = true;
    try {
      const state = await wiring?.catch(() => undefined);
      await state?.teardown();
    } finally {
      held?.release();
      held = undefined;
    }
  }

  return { gate, teardown };
}
