import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import os from "os";

/**
 * Node.js presence + version detection.
 *
 * Background: Claude Desktop's bridge to the in-process HTTP MCP
 * server goes through `npx mcp-remote`. `npx` requires Node.js on
 * PATH. The Settings UI shows a green check-or-not-detected hint so
 * the user can install Node before they paste the Claude Desktop
 * config and discover the failure at first launch.
 *
 * **PATH gotcha on macOS**: Obsidian launched from Finder/Spotlight
 * inherits the minimal `launchctl` PATH, which does NOT include
 * `/opt/homebrew/bin` (Apple silicon) or `/usr/local/bin` (Intel) —
 * the canonical Node install locations. Plain `node --version` then
 * fails with ENOENT even when Node IS installed. To compensate, the
 * detector scans the well-known absolute paths in addition to the
 * PATH-based lookup. Same applies to `brew`.
 *
 * Read-only, no network. Spawns `node --version` once per session
 * (the cached result lasts until the next plugin load, which is
 * plenty for a UX hint — users rarely uninstall Node mid-session).
 *
 * Production callers use the default `runner` (the actual
 * `child_process.exec` wrapped in a promise). Tests inject a stubbed
 * runner so they do not depend on the host having Node on PATH.
 */

export type NodeDetectResult =
  | {
      found: true;
      /** Parsed version, e.g. "22.3.0". */
      version: string;
      /** Raw stdout including any trailing newline, for debug surfaces. */
      raw: string;
    }
  | {
      found: false;
      /** Human-readable failure cause for the UI hint. */
      error: string;
    };

// (file, args) shape — no shell. A binary path containing shell
// metacharacters (spaces, `;`, `$()`) cannot inject because `execFile`
// passes argv directly to the OS rather than through `/bin/sh -c`.
export type ExecRunner = (
  file: string,
  args: string[],
) => Promise<{
  stdout: string;
  stderr: string;
}>;

const defaultRunner: ExecRunner = promisify(execFile) as unknown as ExecRunner;

let cached: NodeDetectResult | null = null;
let cachedNodePath: string | null = null;

/**
 * Canonical absolute paths for `node` on each platform. Scanned when
 * the PATH-based lookup fails, which is the common case on macOS
 * Obsidian (launchctl PATH does not include Homebrew prefixes).
 *
 * Tests can override this list via the `candidatePaths` opt; the
 * default is platform-aware. Linux paths cover the most common
 * package-manager destinations.
 */
function defaultNodePaths(): string[] {
  const platform = os.platform();
  if (platform === "darwin") {
    return [
      "/opt/homebrew/bin/node", // Apple silicon Homebrew
      "/usr/local/bin/node", // Intel Homebrew + manual installer
      "/opt/homebrew/opt/node/bin/node", // brew --keg-only override
    ];
  }
  if (platform === "linux") {
    return [
      "/usr/bin/node",
      "/usr/local/bin/node",
      `${os.homedir()}/.local/bin/node`,
    ];
  }
  if (platform === "win32") {
    return [
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files (x86)\\nodejs\\node.exe",
    ];
  }
  return [];
}

/**
 * Detect Node.js. First tries `node --version` (PATH-based). If that
 * fails, scans canonical install paths and runs `<absolute>/node
 * --version` for each. Subsequent calls in the same plugin load return
 * the cached result.
 *
 * Args:
 *   forceRefresh: bypass the cache. Used by the "Verify again" button.
 *   runner: override the exec runner. Tests use this.
 *   candidatePaths: override the path scan. Tests use this.
 *   pathExists: override the fs probe. Tests use this.
 */
export async function detectNode(opts?: {
  forceRefresh?: boolean;
  runner?: ExecRunner;
  candidatePaths?: string[];
  pathExists?: (path: string) => boolean;
}): Promise<NodeDetectResult> {
  if (!opts?.forceRefresh && cached !== null) return cached;
  const runner = opts?.runner ?? defaultRunner;
  const candidates = opts?.candidatePaths ?? defaultNodePaths();
  const probe = opts?.pathExists ?? existsSync;

  // 1. Try PATH-based lookup first — fastest on systems where it works.
  let lastError: string | null = null;
  try {
    const { stdout } = await runner("node", ["--version"]);
    const version = parseVersion(stdout);
    if (version) {
      cached = { found: true, version, raw: stdout };
      cachedNodePath = "node"; // PATH-based; npx will resolve via PATH too.
      return cached;
    }
    lastError = `Unrecognized output: ${stdout.slice(0, 80)}`;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  // 2. Fallback: scan canonical absolute paths. Avoids the launchctl
  // PATH gotcha on macOS Obsidian.
  for (const candidate of candidates) {
    if (!probe(candidate)) continue;
    try {
      // No-shell invocation: the absolute path is argv[0], not embedded
      // in a shell string, so spaces/metacharacters cannot break out.
      const { stdout } = await runner(candidate, ["--version"]);
      const version = parseVersion(stdout);
      if (version) {
        cached = { found: true, version, raw: stdout };
        cachedNodePath = candidate;
        return cached;
      }
    } catch {
      // Try the next candidate.
    }
  }

  cached = {
    found: false,
    error: classifyError(lastError ?? "node --version failed"),
  };
  cachedNodePath = null;
  return cached;
}

/**
 * Resolved absolute path of the Node binary (or `"node"` when the
 * PATH-based lookup worked) populated by the most recent
 * `detectNode()` call. Other parts of the plugin (notably the
 * `preWarm` action that runs `npx`) use this to construct an absolute
 * path to `npx` and avoid the launchctl PATH gotcha.
 */
export function getDetectedNodePath(): string | null {
  return cachedNodePath;
}

/**
 * Directory containing the detected node binary (e.g.
 * `/opt/homebrew/bin`). Returns null when not detected, or the empty
 * string when the path was the bare command `"node"` (in which case
 * the PATH inheritance is presumably fine).
 *
 * Used by callers that spawn shebang scripts like `npx`: those
 * scripts re-invoke `node` via `env`, which itself does a PATH lookup
 * inside the child. Prepending this directory to the child's PATH
 * ensures the inner lookup succeeds even when Obsidian's inherited
 * PATH is the minimal launchctl one.
 */
export function getDetectedNodeBinDir(): string | null {
  if (cachedNodePath === null) return null;
  if (cachedNodePath === "node") return "";
  // Strip the trailing /node or \node.exe.
  const m = /^(.*)[\\/](?:node(?:\.exe)?)$/i.exec(cachedNodePath);
  return m?.[1] ?? null;
}

/**
 * Derive the npx binary path from the cached Node path.
 *  - `"node"`         → `"npx"` (let the runner inherit PATH; if
 *                        Node was on PATH, npx will be too)
 *  - `"/abs/.../node"` → `"/abs/.../npx"` (or `npx.cmd` on Windows)
 *  - `null`           → `null` (no Node detected, do not call)
 */
export function getDetectedNpxPath(): string | null {
  if (cachedNodePath === null) return null;
  if (cachedNodePath === "node") return "npx";
  // Replace the trailing `node` (or `node.exe`) with the npx
  // counterpart. Use a regex so we don't accidentally chop a
  // path that happens to contain "node" elsewhere.
  return cachedNodePath.replace(/node(\.exe)?$/i, (_m, ext) =>
    ext ? "npx.cmd" : "npx",
  );
}

/**
 * Reset the in-memory cache. Tests use this between cases. Production
 * code does not need it — there is no API for the user to "uncache"
 * the result; restarting the plugin is the canonical refresh.
 */
export function clearNodeDetectCache(): void {
  cached = null;
  cachedNodePath = null;
  cachedBrew = null;
  cachedBrewPath = null;
}

// ---------------------------------------------------------------------------
// Homebrew detection (macOS only) — drives the optional "Install via
// Homebrew" UI affordance for users who do not have Node on PATH but
// do have brew. Same shape + caching strategy as detectNode.
// ---------------------------------------------------------------------------

export type BrewDetectResult =
  | { found: true; version: string }
  | { found: false };

let cachedBrew: BrewDetectResult | null = null;
let cachedBrewPath: string | null = null;

function defaultBrewPaths(): string[] {
  // brew is macOS-only by design (Linuxbrew exists but is uncommon
  // and lives at a different prefix). Scan the two stable macOS
  // prefixes; first match wins.
  return ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
}

export async function detectBrew(opts?: {
  forceRefresh?: boolean;
  runner?: ExecRunner;
  candidatePaths?: string[];
  pathExists?: (path: string) => boolean;
}): Promise<BrewDetectResult> {
  if (!opts?.forceRefresh && cachedBrew !== null) return cachedBrew;
  const runner = opts?.runner ?? defaultRunner;
  const candidates = opts?.candidatePaths ?? defaultBrewPaths();
  const probe = opts?.pathExists ?? existsSync;

  const tryParse = (stdout: string): BrewDetectResult => {
    const m = /Homebrew\s+(\d+\.\d+\.\d+)/.exec(stdout);
    return m
      ? { found: true, version: m[1]! }
      : { found: true, version: "unknown" };
  };

  // 1. PATH-based.
  try {
    const { stdout } = await runner("brew", ["--version"]);
    cachedBrew = tryParse(stdout);
    cachedBrewPath = "brew"; // PATH-based — let the install runner inherit PATH.
    return cachedBrew;
  } catch {
    // fall through
  }

  // 2. Canonical paths.
  for (const candidate of candidates) {
    if (!probe(candidate)) continue;
    try {
      const { stdout } = await runner(candidate, ["--version"]);
      cachedBrew = tryParse(stdout);
      cachedBrewPath = candidate;
      return cachedBrew;
    } catch {
      // try next
    }
  }

  cachedBrew = { found: false };
  cachedBrewPath = null;
  return cachedBrew;
}

/**
 * Resolved absolute brew binary path (or `"brew"` when PATH-based
 * works), populated by the most recent `detectBrew()`. The brew
 * install action uses this so it does not depend on the inherited
 * PATH containing /opt/homebrew/bin.
 */
export function getDetectedBrewPath(): string | null {
  return cachedBrewPath;
}

/**
 * Run `brew install node` and stream progress via the optional
 * `onLine` callback. Returns success / failure for the UI.
 *
 * brew typically does not require sudo for Homebrew-managed packages
 * (its prefix is user-writable). It does emit progress to stderr; we
 * stream BOTH stdout and stderr lines so the UI can show "Pouring node…"
 * and similar state hints.
 *
 * Production callers use `child_process.spawn` to get the line-by-line
 * stream; tests inject a `runner` that resolves quickly.
 */
export type BrewInstallNodeResult =
  | { ok: true; version: string }
  | { ok: false; error: string };

export type BrewInstallRunner = (opts: {
  onLine: (line: string) => void;
}) => Promise<{ stdout: string; stderr: string }>;

const defaultBrewInstallRunner: BrewInstallRunner = ({ onLine }) =>
  new Promise((resolve, reject) => {
    // Resolve the brew binary path from the most recent detectBrew()
    // call. Falls back to plain "brew" so this still works if invoked
    // before detection (then it'll succeed only if PATH happens to
    // include the Homebrew prefix).
    const brewBin = cachedBrewPath ?? "brew";
    // Lazy import: child_process is only loaded on demand to keep the
    // plugin bundle import-graph tight.
    import("child_process")
      .then(({ spawn }) => {
        const proc = spawn(brewBin, ["install", "node"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const pipeLines = (chunk: string, target: "out" | "err") => {
          if (target === "out") stdout += chunk;
          else stderr += chunk;
          chunk
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0)
            .forEach((l) => onLine(l));
        };
        proc.stdout?.on("data", (b: Buffer) => pipeLines(b.toString(), "out"));
        proc.stderr?.on("data", (b: Buffer) => pipeLines(b.toString(), "err"));
        proc.on("error", (err) => reject(err));
        proc.on("close", (code) => {
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(`brew install node exited with code ${code}`));
        });
      })
      .catch(reject);
  });

export async function installNodeViaBrew(opts?: {
  onLine?: (line: string) => void;
  runner?: BrewInstallRunner;
}): Promise<BrewInstallNodeResult> {
  const runner = opts?.runner ?? defaultBrewInstallRunner;
  const onLine = opts?.onLine ?? (() => {});
  try {
    await runner({ onLine });
    // Refresh node detection so the UI flips green without manual
    // "Verify again". The cache is cleared explicitly here so the
    // subsequent detectNode() spawns a fresh `node --version`.
    clearNodeDetectCache();
    const r = await detectNode();
    if (r.found) return { ok: true, version: r.version };
    return {
      ok: false,
      error:
        "Homebrew install completed but `node --version` still failed. You may need to restart Obsidian to pick up PATH changes.",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Parse the stdout of `node --version` into a bare semver string.
 * Examples:
 *   "v22.3.0\n" → "22.3.0"
 *   "v18.20.4"  → "18.20.4"
 *   "v22.0.0-nightly20240501"  → "22.0.0-nightly20240501"
 * Returns null if the output does not match the expected `vX.Y.Z[-pre]`
 * shape — the `node` binary may have been replaced with something
 * unexpected, so we fail closed.
 */
function parseVersion(stdout: string): string | null {
  const match = /v(\d+\.\d+\.\d+(?:-[A-Za-z0-9.+]+)?)/.exec(stdout.trim());
  return match?.[1] ?? null;
}

/**
 * Translate child_process.exec errors into a UI-friendly hint.
 * Common cases:
 *  - ENOENT / "command not found": Node is not on PATH.
 *  - non-zero exit code: present but broken (rare; surface raw).
 */
function classifyError(message: string): string {
  if (/ENOENT|not found|not recognized/i.test(message)) {
    return "Node.js not found on PATH. Install from nodejs.org.";
  }
  return `Failed to run "node --version": ${message}`;
}
