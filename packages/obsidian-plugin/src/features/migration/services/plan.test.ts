import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { executeSteps, planMigration, type MigrationContext } from "./plan";
import { FORK_PLUGIN_ID } from "../../mcp-client-config/services/claudeDesktop";

/**
 * Tests for the migration planner + step executor.
 *
 * Strategy:
 *  - Each test builds a `MigrationContext` against a tmpdir-backed
 *    fake `data.json` and `claude_desktop_config.json`.
 *  - `os.homedir` is stubbed only for symmetry with the other tests
 *    in this module; both files are passed via explicit paths so
 *    no test depends on the real home.
 *  - `mutatePluginData` is faked with a closure over an in-memory
 *    record. Production wires it to `plugin.loadData/saveData`
 *    behind the existing settings mutex; the contract here is
 *    just "atomic load → modify → save", not the locking strategy.
 *
 * What we cover:
 *  1. `planMigration` returns only the applicable steps for each
 *     legacy state combination.
 *  2. Each step's `apply()` performs the expected side effect.
 *  3. `executeSteps` runs only the user-selected ids and returns one
 *     result per executed step.
 *  4. Failures in one step do not prevent the others from running.
 */

describe("planMigration", () => {
  const baseCtx = (state: MigrationContext["state"]): MigrationContext => ({
    state,
    port: 27200,
    token: "test-token",
    mutatePluginData: async () => {},
  });

  test("no legacy signals → empty plan", () => {
    const steps = planMigration(
      baseCtx({
        hasLegacySettingsKeys: false,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: false,
      }),
    );
    expect(steps).toEqual([]);
  });

  test("only Claude config legacy → only rewriteClaudeConfig step", () => {
    const steps = planMigration(
      baseCtx({
        hasLegacySettingsKeys: false,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: true,
      }),
    );
    expect(steps.map((s) => s.id)).toEqual(["rewriteClaudeConfig"]);
  });

  test("only legacy binary → only deleteLegacyBinary step", () => {
    const steps = planMigration(
      baseCtx({
        hasLegacySettingsKeys: false,
        hasLegacyBinary: true,
        legacyBinaryPath: "/tmp/fake-mcp-server",
        hasLegacyClaudeConfigEntry: false,
      }),
    );
    expect(steps.map((s) => s.id)).toEqual(["deleteLegacyBinary"]);
  });

  test("legacy binary detected but path missing → step omitted", () => {
    const steps = planMigration(
      baseCtx({
        hasLegacySettingsKeys: false,
        hasLegacyBinary: true,
        // legacyBinaryPath intentionally omitted — defensive: nothing
        // for the executor to act on.
        hasLegacyClaudeConfigEntry: false,
      }),
    );
    expect(steps.map((s) => s.id)).toEqual([]);
  });

  test("only legacy settings keys → only pruneLegacySettings step", () => {
    const steps = planMigration(
      baseCtx({
        hasLegacySettingsKeys: true,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: false,
      }),
    );
    expect(steps.map((s) => s.id)).toEqual(["pruneLegacySettings"]);
  });

  test("all three signals → all three steps in stable order", () => {
    const steps = planMigration(
      baseCtx({
        hasLegacySettingsKeys: true,
        hasLegacyBinary: true,
        legacyBinaryPath: "/tmp/x",
        hasLegacyClaudeConfigEntry: true,
      }),
    );
    expect(steps.map((s) => s.id)).toEqual([
      "rewriteClaudeConfig",
      "deleteLegacyBinary",
      "pruneLegacySettings",
    ]);
    // All steps default to enabled — modal pre-checks them.
    for (const s of steps) {
      expect(s.defaultEnabled).toBe(true);
    }
  });
});

describe("executeSteps — rewriteClaudeConfig", () => {
  let tmpRoot: string;
  let configPath: string;
  let homedirSpy: Mock<typeof os.homedir>;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-tools-plan-test-"));
    configPath = path.join(tmpRoot, "claude_desktop_config.json");
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpRoot);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  test("rewrites the legacy entry to the 0.4.0 shape", async () => {
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "obsidian-mcp-tools": {
            command: "/old/path/mcp-server",
            env: { OBSIDIAN_API_KEY: "k" },
          },
        },
      }),
    );

    const steps = planMigration({
      state: {
        hasLegacySettingsKeys: false,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: true,
        legacyClaudeConfigPath: configPath,
        legacyClaudeConfigEntryCommand: "/old/path/mcp-server",
      },
      port: 27200,
      token: "t",
      mutatePluginData: async () => {},
    });

    const results = await executeSteps(steps, ["rewriteClaudeConfig"]);
    expect(results).toEqual([{ id: "rewriteClaudeConfig", ok: true }]);

    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
    expect(parsed.mcpServers[FORK_PLUGIN_ID]).toEqual({
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:27200/mcp",
        "--header",
        "Authorization: Bearer t",
      ],
    });
    expect(parsed.mcpServers["obsidian-mcp-tools"]).toBeUndefined();
  });

  test("backs up the original Claude config to .backup", async () => {
    const original = JSON.stringify({
      mcpServers: { "obsidian-mcp-tools": { command: "/old" } },
    });
    await fsp.writeFile(configPath, original);

    const steps = planMigration({
      state: {
        hasLegacySettingsKeys: false,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: true,
        legacyClaudeConfigPath: configPath,
      },
      port: 27200,
      token: "t",
      mutatePluginData: async () => {},
    });

    await executeSteps(steps, ["rewriteClaudeConfig"]);

    const backup = await fsp.readFile(`${configPath}.backup`, "utf8");
    expect(backup).toBe(original);
  });

  test("returns ok=false on malformed config (does not throw out of executeSteps)", async () => {
    await fsp.writeFile(configPath, "{not-json");

    const steps = planMigration({
      state: {
        hasLegacySettingsKeys: false,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: true,
        legacyClaudeConfigPath: configPath,
      },
      port: 27200,
      token: "t",
      mutatePluginData: async () => {},
    });

    const results = await executeSteps(steps, ["rewriteClaudeConfig"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("rewriteClaudeConfig");
    expect(results[0]?.ok).toBe(false);
  });
});

describe("executeSteps — deleteLegacyBinary", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-tools-plan-bin-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  test("removes the binary", async () => {
    const binaryPath = path.join(tmpRoot, "mcp-server");
    await fsp.writeFile(binaryPath, "stub", { mode: 0o755 });

    const steps = planMigration({
      state: {
        hasLegacySettingsKeys: false,
        hasLegacyBinary: true,
        legacyBinaryPath: binaryPath,
        hasLegacyClaudeConfigEntry: false,
      },
      port: 27200,
      token: "t",
      mutatePluginData: async () => {},
    });

    const results = await executeSteps(steps, ["deleteLegacyBinary"]);
    expect(results).toEqual([{ id: "deleteLegacyBinary", ok: true }]);

    const exists = await fsp
      .stat(binaryPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test("idempotent: re-running on a missing binary still returns ok (force=true)", async () => {
    const binaryPath = path.join(tmpRoot, "never-existed");

    const steps = planMigration({
      state: {
        hasLegacySettingsKeys: false,
        hasLegacyBinary: true,
        legacyBinaryPath: binaryPath,
        hasLegacyClaudeConfigEntry: false,
      },
      port: 27200,
      token: "t",
      mutatePluginData: async () => {},
    });

    const results = await executeSteps(steps, ["deleteLegacyBinary"]);
    expect(results[0]?.ok).toBe(true);
  });
});

describe("executeSteps — pruneLegacySettings", () => {
  test("strips installLocation and platformOverride from data, preserves other keys", async () => {
    const data: Record<string, unknown> = {
      installLocation: "system",
      platformOverride: { platform: "macos" },
      mcpTransport: { bearerToken: "tok" },
      semanticSearch: { provider: "auto" },
      commandPermissions: { enabled: false, allowed: [] },
    };

    const mutate = async (m: (d: Record<string, unknown>) => void) => {
      m(data);
    };

    const steps = planMigration({
      state: {
        hasLegacySettingsKeys: true,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: false,
      },
      port: 27200,
      token: "t",
      mutatePluginData: mutate,
    });

    const results = await executeSteps(steps, ["pruneLegacySettings"]);
    expect(results).toEqual([{ id: "pruneLegacySettings", ok: true }]);

    expect(data.installLocation).toBeUndefined();
    expect(data.platformOverride).toBeUndefined();
    expect(data.mcpTransport).toEqual({ bearerToken: "tok" });
    expect(data.semanticSearch).toEqual({ provider: "auto" });
    expect(data.commandPermissions).toEqual({ enabled: false, allowed: [] });
  });

  test("propagates errors from the mutate callback as ok=false", async () => {
    const mutate = async () => {
      throw new Error("settings lock held");
    };

    const steps = planMigration({
      state: {
        hasLegacySettingsKeys: true,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: false,
      },
      port: 27200,
      token: "t",
      mutatePluginData: mutate,
    });

    const results = await executeSteps(steps, ["pruneLegacySettings"]);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.ok === false && results[0]?.error).toContain("lock");
  });
});

describe("executeSteps — selection + isolation", () => {
  test("only runs steps whose id is in the selected list", async () => {
    let mutateCalled = false;
    const mutate = async (m: (d: Record<string, unknown>) => void) => {
      mutateCalled = true;
      m({});
    };

    const steps = planMigration({
      state: {
        hasLegacySettingsKeys: true,
        hasLegacyBinary: true,
        legacyBinaryPath: "/tmp/never-existed-pruning",
        hasLegacyClaudeConfigEntry: false,
      },
      port: 27200,
      token: "t",
      mutatePluginData: mutate,
    });
    expect(steps.map((s) => s.id)).toEqual([
      "deleteLegacyBinary",
      "pruneLegacySettings",
    ]);

    const results = await executeSteps(steps, ["pruneLegacySettings"]);
    expect(results.map((r) => r.id)).toEqual(["pruneLegacySettings"]);
    expect(mutateCalled).toBe(true);
  });

  test("a failure in one step does not skip the others", async () => {
    const tmpRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "mcp-tools-plan-iso-"),
    );
    const binaryPath = path.join(tmpRoot, "mcp-server");
    await fsp.writeFile(binaryPath, "stub", { mode: 0o755 });

    let pruneCalled = false;
    const failingMutate = async () => {
      pruneCalled = true;
      throw new Error("boom");
    };

    const steps = planMigration({
      state: {
        hasLegacySettingsKeys: true,
        hasLegacyBinary: true,
        legacyBinaryPath: binaryPath,
        hasLegacyClaudeConfigEntry: false,
      },
      port: 27200,
      token: "t",
      mutatePluginData: failingMutate,
    });

    const results = await executeSteps(steps, [
      "pruneLegacySettings",
      "deleteLegacyBinary",
    ]);

    // Both ran. Order follows the plan, not the selection.
    expect(results.map((r) => r.id)).toEqual([
      "deleteLegacyBinary",
      "pruneLegacySettings",
    ]);
    expect(pruneCalled).toBe(true);
    // Binary deletion succeeded.
    const exists = await fsp
      .stat(binaryPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);

    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });
});
