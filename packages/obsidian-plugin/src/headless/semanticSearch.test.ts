import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { env as hfEnv } from "@huggingface/transformers";
import type { App } from "obsidian";
import { FORMAT_VERSION } from "$/features/semantic-search/services/store";
import { ToolRegistryClass } from "$/features/mcp-transport/services/toolRegistry";
import { logger } from "$/shared/logger";
import { mockApp, resetMockVault, setMockFile } from "$/test-setup";
import { acquireLock, lockFilePath, type CacheLockDeps } from "./cacheLock";
import {
  createFileHost,
  createMemoryHost,
  defaultCachePath,
  type HeadlessHost,
} from "./hostData";
import { ORT_VERSION } from "./ortAssets";
import { sessionHooks } from "./ortSessionPatch";
import { registerTools } from "./registerTools";
import { createHeadlessSemantic } from "./semanticSearch";

/**
 * The unit-test app: every file is already known, so the layout is ready
 * at once, as it is on a headless server.
 */
function readyApp(): App {
  const app = mockApp();
  return Object.assign(app, {
    workspace: {
      ...app.workspace,
      onLayoutReady: (callback: () => void): void => callback(),
    },
  });
}

describe("createHeadlessSemantic", () => {
  let tmp: string;
  const saved = {
    cacheDir: hfEnv.cacheDir,
    allowLocalModels: hfEnv.allowLocalModels,
    useBrowserCache: hfEnv.useBrowserCache,
    fetch: hfEnv.fetch,
    wasmPaths: hfEnv.backends.onnx.wasm?.wasmPaths,
    globalFetch: globalThis.fetch,
  };

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "headless-semantic-"));
  });

  afterEach(async () => {
    // Wiring points the libraries' globals at the cache.
    const { globalFetch, wasmPaths, ...hf } = saved;
    Object.assign(hfEnv, hf);
    if (hfEnv.backends.onnx.wasm)
      hfEnv.backends.onnx.wasm.wasmPaths = wasmPaths;
    globalThis.fetch = globalFetch;
    delete sessionHooks.beforeCreate;
    delete sessionHooks.afterRun;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** A realpath, as the entry passes: a temp dir may sit behind a symlink. */
  async function makeVault(): Promise<string> {
    const vault = path.join(tmp, "vault");
    await fs.mkdir(vault);
    return fs.realpath(vault);
  }

  const note = `# Title\n\n${"A sentence long enough to be worth embedding. ".repeat(8)}\n`;

  describe("the libraries", () => {
    test("are pointed at the cache, with the browser cache off", async () => {
      resetMockVault();
      const env = { XDG_CACHE_HOME: path.join(tmp, "cache") };
      const host = createMemoryHost({
        app: readyApp(),
        manifest: { version: "0" },
      });
      const search = createHeadlessSemantic(
        host.app,
        await makeVault(),
        host,
        env,
      );
      try {
        expect(await search.gate()).toBeUndefined();
        const root = path.join(tmp, "cache", "obsidian-mcp-connector");
        expect(hfEnv.cacheDir).toBe(path.join(root, "models"));
        expect(hfEnv.allowLocalModels).toBe(false);
        // Node defines `navigator`, which the shared configuration reads as
        // a browser, but it has no Cache API.
        expect(hfEnv.useBrowserCache).toBe(false);
        expect(hfEnv.backends.onnx.wasm?.wasmPaths).toBe(
          `file://${path.join(root, "ort-1.26.0")}/`,
        );
        expect(hfEnv.backends.onnx.wasm?.numThreads).toBe(1);
        expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
      } finally {
        await search.teardown();
      }
    });

    test("wiring twice does not stack the fetch timeout", async () => {
      resetMockVault();
      const env = { XDG_CACHE_HOME: path.join(tmp, "cache") };
      const vault = await makeVault();
      const wire = async () => {
        const host = createMemoryHost({
          app: readyApp(),
          manifest: { version: "0" },
        });
        const search = createHeadlessSemantic(host.app, vault, host, env);
        await search.gate();
        await search.teardown();
      };
      await wire();
      const first = hfEnv.fetch;
      await wire();
      expect(hfEnv.fetch).toBe(first);
    });

    test("the model fetch carries the headers-timeout signal", async () => {
      resetMockVault();
      setMockFile("Notes/a.md", note);
      const seen: Array<{ url: string; signal: AbortSignal | undefined }> = [];
      let reached!: () => void;
      const fetched = new Promise<void>((resolve) => (reached = resolve));
      hfEnv.fetch = (async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: String(input), signal: init?.signal ?? undefined });
        reached();
        throw new Error("offline");
      }) as typeof hfEnv.fetch;
      const host = createMemoryHost({
        app: readyApp(),
        manifest: { version: "0" },
      });
      const search = createHeadlessSemantic(host.app, await makeVault(), host, {
        XDG_CACHE_HOME: path.join(tmp, "cache"),
      });
      try {
        expect(await search.gate()).toBeUndefined();
        host.semanticSearchState!.startIndexerIfNeeded!();
        await fetched;
        expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
        expect(seen[0]?.signal?.aborted).toBe(false);
      } finally {
        await search.teardown();
      }
    });

    test("the runtime files are fetched, with the same signal, before the first session", async () => {
      resetMockVault();
      const seen: Array<{ url: string; signal: AbortSignal | undefined }> = [];
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        seen.push({ url: String(input), signal: init?.signal ?? undefined });
        throw new Error("offline");
      }) as unknown as typeof fetch;
      const host = createMemoryHost({
        app: readyApp(),
        manifest: { version: "0" },
      });
      const search = createHeadlessSemantic(host.app, await makeVault(), host, {
        XDG_CACHE_HOME: path.join(tmp, "cache"),
      });
      try {
        await search.gate();
        // What the patched InferenceSession.create runs first.
        await expect(sessionHooks.beforeCreate!()).rejects.toThrow(
          "the ONNX runtime files could not be downloaded or stored",
        );
        expect(seen[0]?.url).toContain("onnxruntime-web");
        expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
        // A failed download is not remembered: the next session asks again.
        const before = seen.length;
        await expect(sessionHooks.beforeCreate!()).rejects.toThrow(
          "the ONNX runtime files could not be downloaded or stored",
        );
        expect(seen.length).toBeGreaterThan(before);
        expect(typeof sessionHooks.afterRun).toBe("function");
      } finally {
        await search.teardown();
      }
    });
  });

  describe("index lock", () => {
    let vault: string;
    let env: Record<string, string>;
    let fetches: number;
    /** Locks taken by the test to stand in for another server. */
    let foreign: Array<{ release: () => void }>;

    beforeEach(async () => {
      resetMockVault();
      setMockFile("Notes/a.md", "# Title\n\nA sentence worth embedding.\n");
      fetches = 0;
      foreign = [];
      globalThis.fetch = (async () => {
        fetches++;
        throw new Error("offline");
      }) as unknown as typeof fetch;
      vault = await makeVault();
      env = { XDG_CACHE_HOME: path.join(tmp, "cache") };
    });

    afterEach(() => {
      for (const lock of foreign) lock.release();
    });

    const lockFile = () =>
      lockFilePath(
        path.join(tmp, "cache", "obsidian-mcp-connector"),
        defaultCachePath(vault, env),
      );

    /** Hold the vault's index lock as another server would. */
    const otherServerHolds = async () => {
      await fs.mkdir(path.dirname(lockFile()), { recursive: true });
      const got = acquireLock(lockFile());
      if (!got.ok) throw new Error("the test could not take the lock");
      foreign.push(got);
      return got;
    };

    const create = (lockDeps?: CacheLockDeps) => {
      const host = createMemoryHost({
        app: readyApp(),
        manifest: { version: "0" },
      });
      return {
        host,
        search: createHeadlessSemantic(host.app, vault, host, env, lockDeps),
      };
    };

    test("is not taken, and nothing is wired, until the first search", async () => {
      const { host, search } = create();
      try {
        expect(existsSync(lockFile())).toBe(false);
        expect(host.semanticSearchState).toBeUndefined();
        expect(await search.gate()).toBeUndefined();
        expect(acquireLock(lockFile()).ok).toBe(false);
        expect(host.semanticSearchState).toBeDefined();
      } finally {
        await search.teardown();
      }
    });

    test("later searches reuse the lock and the wiring", async () => {
      const { host, search } = create();
      try {
        await search.gate();
        const state = host.semanticSearchState;
        await Promise.all([search.gate(), search.gate()]);
        await search.gate();
        expect(host.semanticSearchState).toBe(state);
      } finally {
        await search.teardown();
      }
    });

    test("a lock held by another process says so and wires nothing", async () => {
      await otherServerHolds();
      const { host, search } = create();
      try {
        const reason = await search.gate();
        expect(reason).toContain("obsidian-mcp-headless");
        expect(reason).toContain("using the semantic index");
        expect(host.semanticSearchState).toBeUndefined();
        expect(fetches).toBe(0);
      } finally {
        await search.teardown();
      }
    });

    test("an old-format store is left alone while another process holds the lock", async () => {
      const dir = path.join(
        defaultCachePath(vault, env),
        "embeddings",
        "native-minilm-l6-v2",
      );
      await fs.mkdir(dir, { recursive: true });
      const stale = JSON.stringify({
        version: FORMAT_VERSION - 1,
        recordCount: 3,
      });
      const files = [
        "embeddings.meta.json",
        "embeddings.index.json",
        "mtimes.json",
      ];
      for (const name of files) await fs.writeFile(path.join(dir, name), stale);
      await fs.writeFile(path.join(dir, "embeddings.bin"), "bytes");
      await otherServerHolds();

      const { search } = create();
      try {
        expect(await search.gate()).toContain("obsidian-mcp-headless");
        for (const name of [...files, "embeddings.bin"]) {
          expect(existsSync(path.join(dir, name))).toBe(true);
        }
        expect(
          readFileSync(path.join(dir, "embeddings.meta.json"), "utf8"),
        ).toBe(stale);
      } finally {
        await search.teardown();
      }
    });

    test("an old-format store is replaced once this process holds the lock", async () => {
      const dir = path.join(
        defaultCachePath(vault, env),
        "embeddings",
        "native-minilm-l6-v2",
      );
      await fs.mkdir(dir, { recursive: true });
      const stale = JSON.stringify({
        version: FORMAT_VERSION - 1,
        recordCount: 3,
      });
      for (const name of ["embeddings.meta.json", "embeddings.index.json"]) {
        await fs.writeFile(path.join(dir, name), stale);
      }
      await fs.writeFile(path.join(dir, "embeddings.bin"), "bytes");

      const { search } = create();
      try {
        expect(await search.gate()).toBeUndefined();
        expect(existsSync(path.join(dir, "embeddings.bin"))).toBe(false);
        expect(existsSync(path.join(dir, "embeddings.meta.json"))).toBe(false);
      } finally {
        await search.teardown();
      }
    });

    test("a lock that could not be taken for another reason reports why", async () => {
      const { search } = create({
        open: () => {
          throw Object.assign(new Error("unable to open database file"), {
            errcode: 14,
          });
        },
      });
      try {
        const reason = await search.gate();
        expect(reason).toContain(
          "the index lock for this vault could not be taken",
        );
        expect(reason).not.toContain("unable to open database file");
        expect(reason).not.toContain("using the semantic index");
      } finally {
        await search.teardown();
      }
    });

    test("teardown releases the lock, and a later search is refused", async () => {
      const { search } = create();
      await search.gate();
      expect(acquireLock(lockFile()).ok).toBe(false);
      await search.teardown();
      const free = acquireLock(lockFile());
      expect(free.ok).toBe(true);
      if (free.ok) free.release();
      expect(await search.gate()).toContain("shutting down");
      const stillFree = acquireLock(lockFile());
      expect(stillFree.ok).toBe(true);
      if (stillFree.ok) stillFree.release();
    });

    test("a search that was waiting when teardown ran takes no lock and wires nothing", async () => {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      const host = createMemoryHost({
        app: readyApp(),
        manifest: { version: "0" },
      });
      const search = createHeadlessSemantic(
        host.app,
        vault,
        host,
        env,
        undefined,
        {
          prepareRoot: async () => {
            await fs.mkdir(path.dirname(lockFile()), { recursive: true });
            await barrier;
          },
        },
      );
      const pending = search.gate();
      await search.teardown();
      release();
      expect(await pending).toContain("shutting down");
      expect(host.semanticSearchState).toBeUndefined();
      // Nothing is left holding the lock.
      const free = acquireLock(lockFile());
      expect(free.ok).toBe(true);
      if (free.ok) free.release();
    });

    test("a search that was refused succeeds once the other process is gone", async () => {
      const other = await otherServerHolds();
      const { host, search } = create();
      try {
        expect(await search.gate()).toBeDefined();
        other.release();
        expect(await search.gate()).toBeUndefined();
        expect(host.semanticSearchState).toBeDefined();
      } finally {
        await search.teardown();
      }
    });

    test("a second server for the same vault is refused until the first shuts down", async () => {
      const make = () => {
        const host = createMemoryHost({
          app: readyApp(),
          manifest: { version: "0" },
        });
        return createHeadlessSemantic(host.app, vault, host, env);
      };
      const first = make();
      const second = make();
      try {
        expect(await first.gate()).toBeUndefined();
        expect(await second.gate()).toContain("obsidian-mcp-headless");
        await first.teardown();
        expect(await second.gate()).toBeUndefined();
      } finally {
        await first.teardown();
        await second.teardown();
      }
    });

    test("on a fresh cache the lock file has its private folder before it is made", async () => {
      const host = createMemoryHost({
        app: readyApp(),
        manifest: { version: "0" },
      });
      const fresh = { XDG_CACHE_HOME: path.join(tmp, "fresh-cache") };
      const search = createHeadlessSemantic(host.app, vault, host, fresh);
      try {
        expect(existsSync(fresh.XDG_CACHE_HOME)).toBe(false);
        expect(await search.gate()).toBeUndefined();
        const root = path.join(fresh.XDG_CACHE_HOME, "obsidian-mcp-connector");
        expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
        const locks = (await fs.readdir(root)).filter((n) =>
          n.endsWith(".sqlite"),
        );
        expect(locks).toHaveLength(1);
        expect((await fs.stat(path.join(root, locks[0]))).mode & 0o777).toBe(
          0o600,
        );
        expect(host.semanticSearchState).toBeDefined();
      } finally {
        await search.teardown();
      }
    });

    test("a cache folder that cannot be made is reported, not thrown", async () => {
      const blocker = path.join(tmp, "blocker");
      await fs.writeFile(blocker, "a file where a folder should be");
      const host = createMemoryHost({
        app: readyApp(),
        manifest: { version: "0" },
      });
      const search = createHeadlessSemantic(host.app, vault, host, {
        XDG_CACHE_HOME: blocker,
      });
      expect(await search.gate()).toContain(
        "cache folder could not be prepared",
      );
      await search.teardown();
    });

    test("a setup that fails is reported, and the next search tries again", async () => {
      const { host, search } = create();
      // The host's own settings cannot be read: the feature does not start.
      const load = host.loadData;
      let fail = true;
      host.loadData = async () => {
        if (fail) throw new Error("settings unreadable");
        return load();
      };
      // The semantic host reads the transport's `mcpTools` slice through it.
      try {
        const reason = await search.gate();
        expect(reason).toContain("Semantic search is unavailable");
        expect(host.semanticSearchState).toBeUndefined();
        fail = false;
        expect(await search.gate()).toBeUndefined();
        expect(host.semanticSearchState).toBeDefined();
      } finally {
        await search.teardown();
      }
    });
  });

  describe("what a client is told", () => {
    let vault: string;
    let logged: string[];
    let errors: ReturnType<typeof spyOn>;

    beforeEach(async () => {
      resetMockVault();
      vault = await makeVault();
      logged = [];
      errors = spyOn(logger, "error").mockImplementation(
        (_message: string, fields?: unknown) => {
          logged.push(JSON.stringify(fields ?? {}));
        },
      );
    });
    afterEach(() => errors.mockRestore());

    /** The refusal a `search_vault_smart` call returns, as the registry builds it. */
    async function refusal(
      search: ReturnType<typeof createHeadlessSemantic>,
      host: HeadlessHost,
    ): Promise<{ error: string; errorCode: string }> {
      host.semanticGate = search.gate;
      const registry = new ToolRegistryClass();
      await registerTools(registry, {
        app: host.app,
        plugin: host as never,
        pluginVersion: "0.0.0-test",
      });
      const result = (await registry.dispatch(
        { name: "search_vault_smart", arguments: { query: "dough" } },
        {} as never,
      )) as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      return JSON.parse(result.content[0].text);
    }

    const memoryHost = () =>
      createMemoryHost({ app: readyApp(), manifest: { version: "0" } });

    /** Every part of the injected paths, none of which a client may read. */
    const leaks = (text: string, parts: string[]) =>
      parts.filter((part) => text.includes(part));

    test("a cache folder that cannot be made carries no host path", async () => {
      // A space in the path used to cut the scrub short.
      const blocker = path.join(tmp, "Private Cache");
      await fs.writeFile(blocker, "a file where a folder should be");
      const host = memoryHost();
      const search = createHeadlessSemantic(host.app, vault, host, {
        XDG_CACHE_HOME: blocker,
      });
      try {
        const body = await refusal(search, host);
        expect(body.errorCode).toBe("semantic_search_unavailable");
        expect(body.error).toBe(
          "Semantic search is unavailable: the cache folder could not be prepared (ENOTDIR). Details are in the server log.",
        );
        expect(leaks(body.error, [tmp, "Private", "Cache"])).toEqual([]);
        // The detail stays with the operator.
        expect(logged.join("\n")).toContain(blocker);
      } finally {
        await search.teardown();
      }
    });

    test("a cache folder error with no code says only what failed", async () => {
      const host = memoryHost();
      const search = createHeadlessSemantic(
        host.app,
        vault,
        host,
        { XDG_CACHE_HOME: path.join(tmp, "cache") },
        undefined,
        {
          prepareRoot: async () => {
            throw new Error("cannot make 'C:\\Users\\Jane Doe\\cache'");
          },
        },
      );
      try {
        const body = await refusal(search, host);
        expect(body.error).toBe(
          "Semantic search is unavailable: the cache folder could not be prepared. Details are in the server log.",
        );
        expect(logged.join("\n")).toContain("Jane Doe");
      } finally {
        await search.teardown();
      }
    });

    test("a lock that cannot be taken carries no host path", async () => {
      const cache = path.join(tmp, "Private Cache");
      const host = memoryHost();
      const search = createHeadlessSemantic(
        host.app,
        vault,
        host,
        { XDG_CACHE_HOME: cache },
        {
          open: (file) => {
            throw Object.assign(
              new Error(`unable to open database file '${file}'`),
              { code: "ERR_SQLITE_ERROR" },
            );
          },
        },
      );
      try {
        const body = await refusal(search, host);
        expect(body.errorCode).toBe("semantic_search_unavailable");
        expect(body.error).toBe(
          "Semantic search is unavailable: the index lock for this vault could not be taken (ERR_SQLITE_ERROR). Details are in the server log.",
        );
        expect(
          leaks(body.error, [tmp, "Private", "Cache", "unable to open"]),
        ).toEqual([]);
        expect(logged.join("\n")).toContain(cache);
      } finally {
        await search.teardown();
      }
    });

    test("a lock error with no code says only what failed", async () => {
      const host = memoryHost();
      const search = createHeadlessSemantic(
        host.app,
        vault,
        host,
        { XDG_CACHE_HOME: path.join(tmp, "Private Cache") },
        {
          open: (file) => {
            throw new Error(`unable to open file:///${file}`);
          },
        },
      );
      try {
        const body = await refusal(search, host);
        expect(body.error).toBe(
          "Semantic search is unavailable: the index lock for this vault could not be taken. Details are in the server log.",
        );
      } finally {
        await search.teardown();
      }
    });

    test.each([
      {
        name: "a path with a space",
        message: (cache: string) =>
          `cannot read '${path.join(cache, "state.json")}'`,
        code: undefined,
      },
      {
        name: "a Windows path with a space",
        message: () => "cannot read 'C:\\Users\\Jane Doe\\AppData\\state.json'",
        code: "EACCES",
      },
      {
        name: "a file URL",
        message: () => "cannot import file:///tmp/cache/models/config.mjs",
        code: undefined,
      },
    ])(
      "a setup that fails on $name carries no host path",
      async ({ message, code }) => {
        const cache = path.join(tmp, "Private Cache");
        const host = memoryHost();
        host.loadData = async () => {
          throw Object.assign(new Error(message(cache)), code ? { code } : {});
        };
        const search = createHeadlessSemantic(host.app, vault, host, {
          XDG_CACHE_HOME: cache,
        });
        try {
          const body = await refusal(search, host);
          expect(body.errorCode).toBe("semantic_search_unavailable");
          expect(body.error).toBe(
            `Semantic search is unavailable: setup failed${code ? ` (${code})` : ""}. Details are in the server log.`,
          );
          expect(
            leaks(body.error, [
              tmp,
              "Private",
              "Cache",
              "Jane",
              "Doe",
              "AppData",
              "file:",
              "config.mjs",
              "cannot",
            ]),
          ).toEqual([]);
          expect(logged.join("\n")).toContain("cannot");
        } finally {
          await search.teardown();
        }
      },
    );

    test("runtime files that cannot be stored carry no host path", async () => {
      const cache = path.join(tmp, "Private Cache");
      const host = memoryHost();
      const search = createHeadlessSemantic(host.app, vault, host, {
        XDG_CACHE_HOME: cache,
      });
      try {
        expect(await search.gate()).toBeUndefined();
        const ortDir = path.join(
          cache,
          "obsidian-mcp-connector",
          `ort-${ORT_VERSION}`,
        );
        await fs.writeFile(ortDir, "a file where a folder should be");
        const error = await sessionHooks.beforeCreate!().then(
          () => undefined,
          (err: Error) => err,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error!.message).toBe(
          "the ONNX runtime files could not be downloaded or stored (EEXIST). Details are in the server log.",
        );
        expect(leaks(error!.message, [tmp, "Private", "Cache"])).toEqual([]);
        expect(logged.join("\n")).toContain(ortDir);
      } finally {
        await search.teardown();
      }
    });

    test("a runtime failure keeps its message when the search reports it", async () => {
      const cache = path.join(tmp, "Private Cache");
      const host = memoryHost();
      const search = createHeadlessSemantic(host.app, vault, host, {
        XDG_CACHE_HOME: cache,
      });
      try {
        expect(await search.gate()).toBeUndefined();
        const ortDir = path.join(
          cache,
          "obsidian-mcp-connector",
          `ort-${ORT_VERSION}`,
        );
        await fs.writeFile(ortDir, "a file where a folder should be");
        const failure = await sessionHooks.beforeCreate!().then(
          () => undefined,
          (err: Error) => err,
        );
        // The search itself, past the index that is still being built.
        host.semanticSearchState!.startIndexerIfNeeded = undefined;
        host.semanticSearchState!.nativeIndexBuildInProgress = false;
        host.semanticSearchState!.provider = {
          isReady: () => true,
          search: async () => {
            throw failure;
          },
        } as never;
        const body = await refusal(search, host);
        expect(body.errorCode).toBe("semantic_search_failed");
        expect(body.error).toBe(
          "Semantic search failed: the ONNX runtime files could not be downloaded or stored (EEXIST). Details are in the server log.",
        );
      } finally {
        await search.teardown();
      }
    });
  });

  describe("index storage", () => {
    test("lives in the cache, outside the vault, privately", async () => {
      resetMockVault();
      setMockFile("Notes/a.md", note);
      const vault = await makeVault();
      const env = { XDG_CACHE_HOME: path.join(tmp, "cache") };
      const host = createMemoryHost({
        app: readyApp(),
        manifest: { version: "0" },
      });
      const search = createHeadlessSemantic(host.app, vault, host, env);
      try {
        expect(await search.gate()).toBeUndefined();
        await host.semanticSearchState!.store!.flush();
        const dir = defaultCachePath(vault, env);
        expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
        expect(await fs.readdir(vault)).toEqual([]);
      } finally {
        await search.teardown();
      }
    });
  });

  describe("folder exclusions", () => {
    let vault: string;
    let env: Record<string, string>;
    let fetches: number;

    beforeEach(async () => {
      resetMockVault();
      fetches = 0;
      // Reaching the model means reaching this fetch: nothing is embedded
      // before the model files are asked for.
      hfEnv.fetch = (async () => {
        fetches++;
        throw new Error("offline");
      }) as typeof hfEnv.fetch;
      vault = await makeVault();
      env = { XDG_CACHE_HOME: path.join(tmp, "cache") };
    });

    /** The HTTP setup: exclusions in the state file, semantic settings apart. */
    async function httpHost(excludedFolders: string[]): Promise<HeadlessHost> {
      const file = path.join(tmp, "state.json");
      const host = await createFileHost(
        { app: readyApp(), manifest: { version: "0" } },
        file,
      );
      await host.saveData({ mcpTools: { excludedFolders } });
      return host;
    }

    /** Run the first indexer start to its end and return the store. */
    async function indexOnce(host: HeadlessHost) {
      const state = host.semanticSearchState!;
      const indexer = state.indexer!;
      const start = indexer.start.bind(indexer);
      let started: Promise<void> | undefined;
      // The start follows the layout-ready barrier by a few microtasks: wait
      // for the call itself.
      const called = new Promise<void>((resolve) => {
        indexer.start = (opts) => {
          started = start(opts);
          resolve();
          return started;
        };
      });
      state.startIndexerIfNeeded!();
      await called;
      await started!.catch(() => {});
      return state.store!;
    }

    test("a note in an excluded folder never reaches the embedder or the store", async () => {
      setMockFile("Hidden/secret.md", note);
      const host = await httpHost(["Hidden"]);
      const search = createHeadlessSemantic(host.app, vault, host, env);
      try {
        expect(await search.gate()).toBeUndefined();
        const store = await indexOnce(host);
        expect(fetches).toBe(0);
        expect(store.size()).toBe(0);
        expect(store.hasRecords("Hidden/secret.md")).toBe(false);
        expect(store.mtimeFor("Hidden/secret.md")).toBeUndefined();
      } finally {
        await search.teardown();
      }
    });

    test("the same note outside the excluded folder is indexed", async () => {
      setMockFile("Notes/a.md", note);
      const host = await httpHost(["Hidden"]);
      const search = createHeadlessSemantic(host.app, vault, host, env);
      try {
        await search.gate();
        await indexOnce(host);
        expect(fetches).toBeGreaterThan(0);
      } finally {
        await search.teardown();
      }
    });

    test("without exclusions the hidden note would be embedded", async () => {
      setMockFile("Hidden/secret.md", note);
      const host = createMemoryHost({
        app: readyApp(),
        manifest: { version: "0" },
      });
      const search = createHeadlessSemantic(host.app, vault, host, env);
      try {
        await search.gate();
        await indexOnce(host);
        expect(fetches).toBeGreaterThan(0);
      } finally {
        await search.teardown();
      }
    });

    test("the semantic settings never reach the transport's state file", async () => {
      setMockFile("Notes/a.md", note);
      const host = await httpHost([]);
      const search = createHeadlessSemantic(host.app, vault, host, env);
      try {
        await search.gate();
        expect(JSON.stringify(await host.loadData())).not.toContain(
          "semanticSearch",
        );
      } finally {
        await search.teardown();
      }
    });
  });
});
