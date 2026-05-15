import { exec } from "child_process";
import { promisify } from "util";
import { logger } from "$/shared/logger";
import {
  detectNode,
  getDetectedNodeBinDir,
  getDetectedNpxPath,
} from "./nodeDetect";

/**
 * `mcp-remote` pre-warm (Phase 4 T10).
 *
 * The Claude Desktop bridge runs `npx -y mcp-remote ...` at every
 * launch; if the package is not in the npm cache, the first invocation
 * is a 20-60 s pause while it downloads. The Settings UI exposes a
 * "Pre-warm now" button that runs `npx -y mcp-remote@latest --help`
 * once, populating the cache. Subsequent Claude Desktop launches hit
 * the cache and are near-instant.
 *
 * Read-only of the user's filesystem (npm cache lives under
 * `~/.npm/_npx`). Network egress: required (npm registry). Idempotent:
 * re-running just bumps `lastWarmedAt`.
 *
 * **PATH gotcha**: same launchctl-PATH issue as `nodeDetect`. We don't
 * call plain `npx ...` — instead we resolve the absolute npx binary
 * from the detected Node install (`getDetectedNpxPath`). If Node was
 * not detected, we don't even try; the UI surfaces the install hint.
 *
 * Persistence: `data.json` slice
 * `mcpClientConfig.mcpRemotePreWarm = { lastWarmedAt, version? }`.
 */

const DATA_KEY = "mcpClientConfig";
const SLICE_KEY = "mcpRemotePreWarm";

/** Timeout for the prewarm shell call. Generous — first run can be slow. */
const PREWARM_TIMEOUT_MS = 120_000;

export type PreWarmCacheEntry = {
  lastWarmedAt: string;
  version?: string;
};

export type PreWarmResult =
  | { ok: true; entry: PreWarmCacheEntry }
  | { ok: false; error: string };

export type ExecRunner = (
  command: string,
  options?: { timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: ExecRunner = (command, options) => {
  const exec_ = promisify(exec) as (
    cmd: string,
    opts?: { timeout?: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  return exec_(command, options);
};

type PluginLike = {
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function getPreWarmCache(
  plugin: PluginLike,
): Promise<PreWarmCacheEntry | null> {
  const data = (await plugin.loadData()) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return null;
  const slice = data[DATA_KEY];
  if (!slice || typeof slice !== "object") return null;
  const entry = (slice as Record<string, unknown>)[SLICE_KEY];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.lastWarmedAt !== "string") return null;
  return {
    lastWarmedAt: e.lastWarmedAt,
    ...(typeof e.version === "string" ? { version: e.version } : {}),
  };
}

async function persistPreWarmCache(
  plugin: PluginLike,
  entry: PreWarmCacheEntry,
): Promise<void> {
  const data =
    ((await plugin.loadData()) as Record<string, unknown> | null) ?? {};
  const slice = (data[DATA_KEY] as Record<string, unknown> | undefined) ?? {};
  await plugin.saveData({
    ...data,
    [DATA_KEY]: { ...slice, [SLICE_KEY]: entry },
  });
}

// ---------------------------------------------------------------------------
// Pre-warm action
// ---------------------------------------------------------------------------

/**
 * Run `npx -y mcp-remote@latest --help` and persist the timestamp on
 * success. Returns a structured result the UI can render directly.
 *
 * Args:
 *   plugin: data persistence handle.
 *   runner: optional override for tests.
 */
export async function preWarm(
  plugin: PluginLike,
  opts?: { runner?: ExecRunner; npxPath?: string },
): Promise<PreWarmResult> {
  const runner = opts?.runner ?? defaultRunner;

  // Resolve the absolute npx path from detectNode() — running plain
  // `npx ...` from Obsidian on macOS fails with ENOENT because the
  // launchctl PATH does not include /opt/homebrew/bin. The explicit
  // override (`opts.npxPath`) lets tests skip detection entirely.
  let npxPath = opts?.npxPath ?? getDetectedNpxPath();
  if (!npxPath) {
    // detectNode hasn't run yet (or its cache was cleared); run it
    // once now so we have a path to use.
    await detectNode();
    npxPath = getDetectedNpxPath();
  }
  if (!npxPath) {
    return {
      ok: false,
      error: "npx not available — install Node.js from nodejs.org first.",
    };
  }

  try {
    // Quote the path so spaces survive the shell.
    const cmd = `"${npxPath}" -y mcp-remote@latest --help`;

    // Build the child env. `npx` is a shebang script that re-invokes
    // `node` via `env node`, which does a PATH lookup INSIDE the
    // child process. If Obsidian's inherited PATH lacks the Node bin
    // dir (the macOS launchctl gotcha), the inner lookup fails with
    // "env: node: No such file or directory". Prepend the detected
    // Node bin dir so the inner lookup succeeds.
    const nodeBinDir = getDetectedNodeBinDir();
    const env = {
      ...process.env,
      ...(nodeBinDir
        ? { PATH: `${nodeBinDir}:${process.env.PATH ?? ""}` }
        : {}),
    };

    const { stdout, stderr } = await runner(cmd, {
      timeout: PREWARM_TIMEOUT_MS,
      env,
    });

    // `mcp-remote` prints its help banner to stdout; some versions
    // include the version line ("mcp-remote 0.x.y"). Best-effort
    // parse — the success of the install is what matters, not the
    // version string.
    if (stderr) {
      if (isBenignMcpRemoteProbeError(stderr)) {
        // mcp-remote has no `--help`; probing it emits an
        // ERR_INVALID_URL / "Invalid URL" stack to stderr. That is the
        // expected behaviour of the probe, not a problem — log a clean
        // one-liner instead of echoing the raw trace, which in the
        // shipped build goes to `console` and reads as a fatal error
        // even though the pre-warm succeeded (#98).
        logger.debug(
          "preWarm: mcp-remote emitted its expected no-arguments probe error on stderr (benign — the package is cached)",
        );
      } else {
        logger.debug("preWarm: stderr from mcp-remote", {
          stderr: stderr.slice(0, 200),
        });
      }
    }
    const version = parseVersionFromHelp(stdout) ?? parseVersionFromHelp(stderr);
    const entry: PreWarmCacheEntry = {
      lastWarmedAt: new Date().toISOString(),
      ...(version ? { version } : {}),
    };
    await persistPreWarmCache(plugin, entry);
    return { ok: true, entry };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // `mcp-remote` does not implement `--help`/`--version`: it requires
    // a URL as the first positional argument and emits an Invalid URL
    // error otherwise. From npx's standpoint that is a non-zero exit,
    // but at this point the package HAS been downloaded into
    // ~/.npm/_npx/<hash>/node_modules/mcp-remote — the goal of the
    // pre-warm. Distinguish that case from real failures (network
    // errors, missing Node, package not found in registry) by looking
    // at the error text.
    if (isBenignMcpRemoteProbeError(message)) {
      // Deliberately do NOT echo `message` here: it carries the child
      // process's raw `Fatal error: TypeError: Invalid URL … at new URL
      // … ERR_INVALID_URL` stack. In the shipped build `logger` IS
      // `console`, so dumping that slice makes a *successful* pre-warm
      // look like a crash in the user's dev console (#98). The recovery
      // is expected and benign — a clean one-liner is enough.
      logger.debug(
        "preWarm: npx exited non-zero but mcp-remote was loaded — treating as success (mcp-remote has no --help flag; its probe rejection is expected and the package is now cached)",
      );
      const entry: PreWarmCacheEntry = {
        lastWarmedAt: new Date().toISOString(),
      };
      await persistPreWarmCache(plugin, entry);
      return { ok: true, entry };
    }

    return { ok: false, error: classifyError(message) };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Best-effort parse of the version from `--help` output. Tolerant of
 * unfamiliar shapes — a successful pre-warm is meaningful even if we
 * cannot read the version.
 */
function parseVersionFromHelp(stdout: string): string | undefined {
  const m = /mcp-remote[\s/@v]+(\d+\.\d+\.\d+(?:-[A-Za-z0-9.+]+)?)/i.exec(
    stdout,
  );
  return m?.[1];
}

/**
 * True when the text is the *expected* failure of probing `mcp-remote`
 * (it has no `--help`/`--version`; it requires a URL positional and
 * emits ERR_INVALID_URL / "Invalid URL" otherwise). By the time this
 * surfaces, npx has already cached the package — the pre-warm goal is
 * met. Used both to recover the catch path and to silence the
 * equivalent stderr noise on the success path (#98).
 */
function isBenignMcpRemoteProbeError(text: string): boolean {
  return (
    /mcp-remote/i.test(text) ||
    /ERR_INVALID_URL/i.test(text) ||
    /Invalid URL/i.test(text)
  );
}

function classifyError(message: string): string {
  if (/ENOENT|not found|not recognized/i.test(message)) {
    return "npx not available — install Node.js from nodejs.org first.";
  }
  if (/ETIMEDOUT|timed out/i.test(message)) {
    return "Timed out reaching the npm registry. Check your network and retry.";
  }
  if (/ENETUNREACH|getaddrinfo|EAI_AGAIN/i.test(message)) {
    return "Could not reach the npm registry. Check your network and retry.";
  }
  return `Pre-warm failed: ${message}`;
}
