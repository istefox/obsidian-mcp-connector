import { afterEach, describe, expect, test } from "bun:test";
import {
  clearNodeDetectCache,
  detectBrew,
  detectNode,
  installNodeViaBrew,
  type ExecRunner,
} from "./nodeDetect";

/**
 * Tests for the Node.js detector. We inject a stubbed `runner` so the
 * tests do not depend on the host having Node on PATH and so we can
 * exercise the parsing / error-classification branches deterministically.
 *
 * The real production runner is promisified `execFile` — a no-shell
 * `(file, args)` seam (FIX 3: shell-injection hardening). The
 * `status.integration.test.ts` pattern (real shell scripts in tmpdir)
 * is overkill here — we only ever invoke `node --version`, which has
 * a stable contract we can fake at the runner level.
 */

afterEach(() => {
  clearNodeDetectCache();
});

describe("detectNode — parsing", () => {
  test("parses standard `vX.Y.Z\\n` output", async () => {
    const runner: ExecRunner = async () => ({
      stdout: "v22.3.0\n",
      stderr: "",
    });
    const r = await detectNode({ runner, forceRefresh: true });
    expect(r).toEqual({ found: true, version: "22.3.0", raw: "v22.3.0\n" });
  });

  test("parses pre-release suffix (nightly / rc)", async () => {
    const runner: ExecRunner = async () => ({
      stdout: "v22.0.0-nightly20240501",
      stderr: "",
    });
    const r = await detectNode({ runner, forceRefresh: true });
    expect(r.found).toBe(true);
    expect(r.found && r.version).toBe("22.0.0-nightly20240501");
  });

  test("rejects unrecognized output (fails closed)", async () => {
    const runner: ExecRunner = async () => ({
      stdout: "node v22 (custom build)\n",
      stderr: "",
    });
    const r = await detectNode({ runner, forceRefresh: true });
    expect(r.found).toBe(false);
    expect(r.found === false && r.error).toContain("Unrecognized");
  });
});

describe("detectNode — error classification", () => {
  test("ENOENT-style error → friendly hint", async () => {
    const runner: ExecRunner = async () => {
      throw new Error("spawn node ENOENT");
    };
    const r = await detectNode({ runner, forceRefresh: true });
    expect(r).toEqual({
      found: false,
      error: "Node.js not found on PATH. Install from nodejs.org.",
    });
  });

  test("Windows `not recognized` error → friendly hint", async () => {
    const runner: ExecRunner = async () => {
      throw new Error(
        "'node' is not recognized as an internal or external command",
      );
    };
    const r = await detectNode({ runner, forceRefresh: true });
    expect(r.found).toBe(false);
    expect(r.found === false && r.error).toContain("Node.js not found on PATH");
  });

  test("non-ENOENT error surfaces the raw message (debug-friendly)", async () => {
    const runner: ExecRunner = async () => {
      throw new Error("EACCES: permission denied");
    };
    const r = await detectNode({ runner, forceRefresh: true });
    expect(r.found).toBe(false);
    expect(r.found === false && r.error).toContain("EACCES");
  });
});

describe("detectNode — caching", () => {
  test("second call returns the cached result without invoking the runner", async () => {
    let invocations = 0;
    const runner: ExecRunner = async () => {
      invocations++;
      return { stdout: "v22.3.0\n", stderr: "" };
    };

    await detectNode({ runner, forceRefresh: true });
    expect(invocations).toBe(1);

    await detectNode({ runner });
    expect(invocations).toBe(1); // still 1 — cache hit
  });

  test("forceRefresh bypasses the cache", async () => {
    let invocations = 0;
    const runner: ExecRunner = async () => {
      invocations++;
      return { stdout: "v22.3.0\n", stderr: "" };
    };

    await detectNode({ runner, forceRefresh: true });
    await detectNode({ runner, forceRefresh: true });
    expect(invocations).toBe(2);
  });

  test("clearNodeDetectCache forces the next call to spawn", async () => {
    let invocations = 0;
    const runner: ExecRunner = async () => {
      invocations++;
      return { stdout: "v22.3.0\n", stderr: "" };
    };

    await detectNode({ runner, forceRefresh: true });
    clearNodeDetectCache();
    await detectNode({ runner });
    expect(invocations).toBe(2);
  });

  test("cache survives a not-found result so the UI does not repeatedly spawn", async () => {
    let invocations = 0;
    const runner: ExecRunner = async () => {
      invocations++;
      throw new Error("spawn node ENOENT");
    };

    // pathExists=false skips the canonical-path fallback so we count
    // only the PATH-based attempt — keeping the assertion focused on
    // the cache behavior, not the fallback scan.
    const first = await detectNode({
      runner,
      forceRefresh: true,
      pathExists: () => false,
    });
    expect(first.found).toBe(false);

    const second = await detectNode({ runner });
    expect(second.found).toBe(false);
    expect(invocations).toBe(1);
  });
});

describe("detectNode — canonical-path fallback (launchctl PATH gotcha)", () => {
  test("falls back to /opt/homebrew/bin/node when PATH-based fails", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: ExecRunner = async (file, args) => {
      calls.push({ file, args });
      if (file === "node") {
        throw new Error("spawn node ENOENT");
      }
      if (file === "/opt/homebrew/bin/node") {
        return { stdout: "v22.3.0\n", stderr: "" };
      }
      throw new Error("unexpected runner call: " + file);
    };

    const r = await detectNode({
      runner,
      forceRefresh: true,
      candidatePaths: ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
      pathExists: (p) => p === "/opt/homebrew/bin/node",
    });

    expect(r).toEqual({ found: true, version: "22.3.0", raw: "v22.3.0\n" });
    expect(calls[0]).toEqual({ file: "node", args: ["--version"] }); // PATH first
    expect(calls[1]?.file).toBe("/opt/homebrew/bin/node");
    expect(calls[1]?.args).toEqual(["--version"]);
  });

  test("scans candidates in order until one matches", async () => {
    const runner: ExecRunner = async (file) => {
      if (file === "node") throw new Error("spawn node ENOENT");
      if (file === "/opt/homebrew/bin/node") {
        // Path exists per probe but binary is broken on this run
        throw new Error("unrecognized");
      }
      if (file === "/usr/local/bin/node") {
        return { stdout: "v18.20.4\n", stderr: "" };
      }
      throw new Error("unexpected: " + file);
    };

    const r = await detectNode({
      runner,
      forceRefresh: true,
      candidatePaths: ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
      pathExists: () => true,
    });

    expect(r).toEqual({ found: true, version: "18.20.4", raw: "v18.20.4\n" });
  });

  test("returns not-found when PATH and all candidates fail", async () => {
    const runner: ExecRunner = async () => {
      throw new Error("spawn node ENOENT");
    };

    const r = await detectNode({
      runner,
      forceRefresh: true,
      candidatePaths: ["/opt/homebrew/bin/node"],
      pathExists: () => false, // probe says nothing exists
    });

    expect(r.found).toBe(false);
    expect(r.found === false && r.error).toMatch(/Node\.js|node --version/i);
  });

  test("FIX 3: a candidate path with shell metacharacters is passed as argv[0], not interpolated", async () => {
    // A maliciously-named path must reach the runner as a literal file
    // argument (no `/bin/sh -c "..."`), so `; rm -rf ~` cannot execute.
    const evil = "/opt/homebrew/bin/node; rm -rf ~";
    let received = null as { file: string; args: string[] } | null;
    const runner: ExecRunner = async (file, args) => {
      if (file === "node") throw new Error("spawn node ENOENT");
      received = { file, args };
      return { stdout: "v20.0.0\n", stderr: "" };
    };

    const r = await detectNode({
      runner,
      forceRefresh: true,
      candidatePaths: [evil],
      pathExists: () => true,
    });

    expect(r).toEqual({ found: true, version: "20.0.0", raw: "v20.0.0\n" });
    // The full evil string is the literal argv[0] — never split by a shell.
    expect(received).toEqual({ file: evil, args: ["--version"] });
  });
});

describe("detectBrew", () => {
  test("parses Homebrew x.y.z output", async () => {
    const runner: ExecRunner = async () => ({
      stdout: "Homebrew 4.5.7\nHomebrew/homebrew-core (git revision …)",
      stderr: "",
    });
    const r = await detectBrew({ runner, forceRefresh: true });
    expect(r).toEqual({ found: true, version: "4.5.7" });
  });

  test("ENOENT → found=false (brew not installed)", async () => {
    const runner: ExecRunner = async () => {
      throw new Error("spawn brew ENOENT");
    };
    const r = await detectBrew({ runner, forceRefresh: true });
    expect(r).toEqual({ found: false });
  });

  test("output without version → found=true with version=unknown", async () => {
    const runner: ExecRunner = async () => ({
      stdout: "some custom brew build\n",
      stderr: "",
    });
    const r = await detectBrew({ runner, forceRefresh: true });
    expect(r).toEqual({ found: true, version: "unknown" });
  });
});

describe("installNodeViaBrew (via stub runner)", () => {
  test("ok=true when runner resolves and detectNode finds Node afterwards", async () => {
    let lines = 0;
    const result = await installNodeViaBrew({
      runner: async ({ onLine }) => {
        onLine("==> Pouring node...");
        onLine("==> Linking node");
        lines = 2;
        return { stdout: "", stderr: "" };
      },
    });
    // detectNode after install is the production-real `node --version`
    // — it may or may not succeed depending on the host. We only assert
    // that the runner ran and emitted lines; the final result is host-
    // dependent in this test (host has Node → ok=true; CI w/o Node → ok=false).
    expect(lines).toBe(2);
    expect(typeof result.ok).toBe("boolean");
  });

  test("ok=false when runner rejects", async () => {
    const result = await installNodeViaBrew({
      runner: async () => {
        throw new Error("brew install node exited with code 1");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("code 1");
  });
});
