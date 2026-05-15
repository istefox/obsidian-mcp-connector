import { describe, expect, test, spyOn } from "bun:test";
import {
  getPreWarmCache,
  preWarm,
  type ExecRunner,
} from "./preWarm";
import { logger } from "$/shared/logger";

/** Regex for the scary child-process stack trace we must NOT echo. */
const SCARY_NOISE =
  /ERR_INVALID_URL|Fatal error|TypeError: Invalid URL|at new URL/;

/**
 * Capture every `logger.debug` argument (message + meta) during `fn`
 * as a single flattened JSON string, so a test can assert the recovery
 * path does not leak the raw mcp-remote stack trace to the (prod =
 * console) logger.
 */
async function captureDebugDuring(fn: () => Promise<void>): Promise<string> {
  const calls: unknown[][] = [];
  const spy = spyOn(logger, "debug").mockImplementation(
    (...args: unknown[]) => {
      calls.push(args);
    },
  );
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return JSON.stringify(calls);
}

/**
 * Tests for the mcp-remote pre-warm runner + cache persistence.
 *
 * `preWarm` is exercised through a stubbed runner so tests do not
 * depend on the npm registry or on Node being installed. The cache
 * shape is the contract — UI binds to those fields directly.
 */

type StoredData = Record<string, unknown> | null;

function fakePlugin(initial: StoredData = {}) {
  let data: StoredData = initial;
  return {
    async loadData() {
      return data;
    },
    async saveData(next: unknown) {
      data = next as StoredData;
    },
    get _data() {
      return data;
    },
  };
}

describe("preWarm — success path", () => {
  test("returns ok=true and persists lastWarmedAt + version (when parseable)", async () => {
    const p = fakePlugin({});
    const runner: ExecRunner = async () => ({
      stdout:
        "mcp-remote 1.2.3 - Remote MCP server proxy\n\nUsage: mcp-remote <url>\n",
      stderr: "",
    });

    const result = await preWarm(p, { runner, npxPath: "npx" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.entry.version).toBe("1.2.3");
    expect(result.ok && typeof result.entry.lastWarmedAt).toBe("string");

    // Cache round-trips through the plugin data.
    const cached = await getPreWarmCache(p);
    expect(cached).not.toBeNull();
    expect(cached?.version).toBe("1.2.3");
    expect(cached?.lastWarmedAt).toBe(
      result.ok ? result.entry.lastWarmedAt : "",
    );
  });

  test("succeeds even when version cannot be parsed", async () => {
    const p = fakePlugin({});
    const runner: ExecRunner = async () => ({
      stdout: "Help text without version line\n",
      stderr: "",
    });

    const result = await preWarm(p, { runner, npxPath: "npx" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.entry.version).toBeUndefined();
    expect(result.ok && result.entry.lastWarmedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  test("preserves other plugin data slices when persisting", async () => {
    const p = fakePlugin({
      mcpTransport: { bearerToken: "tok" },
      mcpClientConfig: { autoWriteClaudeDesktopConfig: true },
      semanticSearch: { provider: "auto" },
    });
    const runner: ExecRunner = async () => ({
      stdout: "mcp-remote 1.0.0",
      stderr: "",
    });

    await preWarm(p, { runner, npxPath: "npx" });

    const data = p._data as Record<string, unknown>;
    expect(data.mcpTransport).toEqual({ bearerToken: "tok" });
    expect(
      (data.mcpClientConfig as Record<string, unknown>)
        .autoWriteClaudeDesktopConfig,
    ).toBe(true);
    expect(data.semanticSearch).toEqual({ provider: "auto" });
  });

  test("re-running updates lastWarmedAt without losing the version", async () => {
    const p = fakePlugin({});
    const runner: ExecRunner = async () => ({
      stdout: "mcp-remote 1.0.0",
      stderr: "",
    });

    const first = await preWarm(p, { runner, npxPath: "npx" });
    expect(first.ok).toBe(true);
    const firstAt = first.ok ? first.entry.lastWarmedAt : "";

    // Spin a tick so the ISO string differs.
    await new Promise((r) => setTimeout(r, 5));

    const second = await preWarm(p, { runner, npxPath: "npx" });
    expect(second.ok).toBe(true);
    expect(second.ok && second.entry.lastWarmedAt).not.toBe(firstAt);
    expect(second.ok && second.entry.version).toBe("1.0.0");
  });
});

describe("preWarm — error classification", () => {
  test("npx not found → friendly Node hint", async () => {
    const p = fakePlugin({});
    const runner: ExecRunner = async () => {
      throw new Error("spawn npx ENOENT");
    };

    const result = await preWarm(p, { runner, npxPath: "npx" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Node\.js/i);
  });

  test("network timeout → retry hint", async () => {
    const p = fakePlugin({});
    const runner: ExecRunner = async () => {
      throw new Error("connect ETIMEDOUT 1.2.3.4:443");
    };

    const result = await preWarm(p, { runner, npxPath: "npx" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/network|registry/i);
  });

  test("DNS failure → registry hint", async () => {
    const p = fakePlugin({});
    const runner: ExecRunner = async () => {
      throw new Error("getaddrinfo EAI_AGAIN registry.npmjs.org");
    };

    const result = await preWarm(p, { runner, npxPath: "npx" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("npm registry");
  });

  test("mcp-remote rejecting --help (Invalid URL) is treated as success — package is in cache", async () => {
    // Reproduces the real-world behavior observed at run time:
    // `mcp-remote@latest --help` does not implement --help, so it
    // throws ERR_INVALID_URL. By the time that happens, npx has
    // already downloaded the package into ~/.npm/_npx — the goal of
    // pre-warm. We must NOT report failure to the user.
    const p = fakePlugin({});
    const runner: ExecRunner = async () => {
      throw new Error(
        'Command failed: "/opt/homebrew/bin/npx" -y mcp-remote@latest --help\n' +
          "[46042] Fatal error: TypeError: Invalid URL\n" +
          "    at new URL (node:internal/url:819:25)\n" +
          "    at parseCommandLineArgs (file:///.../mcp-remote/dist/chunk-…) {\n" +
          "  code: 'ERR_INVALID_URL',\n" +
          "  input: '--help'\n" +
          "}",
      );
    };

    const result = await preWarm(p, { runner, npxPath: "npx" });
    expect(result.ok).toBe(true);
    // Cache populated with timestamp; version may be missing because
    // mcp-remote did not print a banner this time.
    const cached = await getPreWarmCache(p);
    expect(cached?.lastWarmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("error path does NOT update the cache (preserves last good result)", async () => {
    const p = fakePlugin({
      mcpClientConfig: {
        mcpRemotePreWarm: {
          lastWarmedAt: "2026-01-01T00:00:00.000Z",
          version: "1.0.0",
        },
      },
    });
    const runner: ExecRunner = async () => {
      throw new Error("spawn npx ENOENT");
    };

    await preWarm(p, { runner, npxPath: "npx" });

    const cached = await getPreWarmCache(p);
    expect(cached?.lastWarmedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(cached?.version).toBe("1.0.0");
  });
});

describe("preWarm — #98 benign mcp-remote probe error is not surfaced as noise", () => {
  const benignThrow = () => {
    throw new Error(
      'Command failed: "/opt/homebrew/bin/npx" -y mcp-remote@latest --help\n' +
        "[46042] Fatal error: TypeError: Invalid URL\n" +
        "    at new URL (node:internal/url:819:25)\n" +
        "    at parseCommandLineArgs (file:///.../mcp-remote/dist/chunk-…) {\n" +
        "  code: 'ERR_INVALID_URL',\n" +
        "  input: '--help'\n" +
        "}",
    );
  };

  test("recovery branch does not echo the raw stack trace into the logger", async () => {
    const p = fakePlugin({});
    const runner: ExecRunner = async () => benignThrow();

    let result: Awaited<ReturnType<typeof preWarm>> | undefined;
    const logged = await captureDebugDuring(async () => {
      result = await preWarm(p, { runner, npxPath: "npx" });
    });

    // Recovery semantics unchanged: still treated as success.
    expect(result?.ok).toBe(true);
    // But the scary child-process trace must not reach the logger
    // (which is `console` in the shipped/prod build — #98).
    expect(logged).not.toMatch(SCARY_NOISE);
  });

  test("success path with benign stderr does not echo the scary trace", async () => {
    const p = fakePlugin({});
    const runner: ExecRunner = async () => ({
      stdout: "mcp-remote 1.2.3 - Remote MCP server proxy\n",
      stderr:
        "[46042] Fatal error: TypeError: Invalid URL\n" +
        "    at new URL (node:internal/url:819:25)\n" +
        "  code: 'ERR_INVALID_URL', input: '--help'",
    });

    let result: Awaited<ReturnType<typeof preWarm>> | undefined;
    const logged = await captureDebugDuring(async () => {
      result = await preWarm(p, { runner, npxPath: "npx" });
    });

    expect(result?.ok).toBe(true);
    expect(logged).not.toMatch(SCARY_NOISE);
  });

  test("a genuinely unexpected stderr is still logged for diagnostics", async () => {
    const p = fakePlugin({});
    const runner: ExecRunner = async () => ({
      stdout: "mcp-remote 1.2.3\n",
      stderr: "npm warn deprecated something@1.0.0: please upgrade",
    });

    const logged = await captureDebugDuring(async () => {
      await preWarm(p, { runner, npxPath: "npx" });
    });

    // Non-benign stderr is preserved (not over-suppressed).
    expect(logged).toMatch(/deprecated something/);
  });
});

describe("getPreWarmCache", () => {
  test("returns null on missing slice", async () => {
    const p = fakePlugin({});
    expect(await getPreWarmCache(p)).toBeNull();
  });

  test("returns null on malformed entry (defensive)", async () => {
    const p = fakePlugin({
      mcpClientConfig: { mcpRemotePreWarm: { lastWarmedAt: 12345 } },
    });
    expect(await getPreWarmCache(p)).toBeNull();
  });

  test("returns the entry verbatim when valid", async () => {
    const p = fakePlugin({
      mcpClientConfig: {
        mcpRemotePreWarm: {
          lastWarmedAt: "2026-04-26T18:00:00.000Z",
          version: "1.2.3",
        },
      },
    });
    expect(await getPreWarmCache(p)).toEqual({
      lastWarmedAt: "2026-04-26T18:00:00.000Z",
      version: "1.2.3",
    });
  });
});
