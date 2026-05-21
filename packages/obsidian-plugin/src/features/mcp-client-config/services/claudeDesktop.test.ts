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
import {
  FORK_PLUGIN_ID,
  LEGACY_PLUGIN_ID,
  removeFromClaudeDesktopConfig,
  updateClaudeDesktopConfig,
} from "./claudeDesktop";

/**
 * Tests for the 0.4.0 Claude Desktop config writer.
 *
 * Uses a tmpdir per test acting as the fake HOME (only used here to keep
 * the stub aligned with the production code), with an explicit `configPath`
 * passed to every call so the tests are platform-independent.
 *
 * Invariants exercised below:
 *  1. Idempotent rewrite — running twice with the same inputs yields
 *     identical bytes (after the first write).
 *  2. Other `mcpServers` entries preserved across the rewrite.
 *  3. Legacy plugin config key removed when migrating.
 *  4. Backup file written before the first overwrite.
 *  5. Refuses to overwrite malformed JSON (data preservation).
 *  6. ENOENT → creates a new file with just the plugin entry.
 *  7. Removal helper drops both legacy and new keys cleanly.
 */

describe("updateClaudeDesktopConfig", () => {
  let tmpRoot: string;
  let configPath: string;
  let homedirSpy: Mock<typeof os.homedir>;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "mcp-tools-claude-cfg-"),
    );
    configPath = path.join(tmpRoot, "claude_desktop_config.json");
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpRoot);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  test("creates a new config file when none exists", async () => {
    await updateClaudeDesktopConfig({ port: 27200, token: "abc", configPath });

    const content = await fsp.readFile(configPath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers[FORK_PLUGIN_ID]).toEqual({
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:27200/mcp",
        "--header",
        "Authorization: Bearer abc",
      ],
    });
  });

  test("does NOT write a backup when the config did not exist", async () => {
    await updateClaudeDesktopConfig({ port: 27200, token: "abc", configPath });
    const backupExists = await fsp
      .stat(`${configPath}.backup`)
      .then(() => true)
      .catch(() => false);
    expect(backupExists).toBe(false);
  });

  test("preserves unrelated mcpServers entries", async () => {
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "other-mcp": { command: "/usr/local/bin/other", args: ["--flag"] },
          "another-mcp": { command: "node", args: ["/some/path.js"] },
        },
      }),
    );

    await updateClaudeDesktopConfig({ port: 27200, token: "tok", configPath });

    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
    expect(parsed.mcpServers["other-mcp"]).toEqual({
      command: "/usr/local/bin/other",
      args: ["--flag"],
    });
    expect(parsed.mcpServers["another-mcp"]).toEqual({
      command: "node",
      args: ["/some/path.js"],
    });
    expect(parsed.mcpServers[FORK_PLUGIN_ID]).toBeDefined();
  });

  test("removes legacy plugin config key by default", async () => {
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          [LEGACY_PLUGIN_ID]: {
            command: "/path/to/old-binary",
            env: { OBSIDIAN_API_KEY: "k" },
          },
          "other-mcp": { command: "/usr/bin/other" },
        },
      }),
    );

    await updateClaudeDesktopConfig({ port: 27200, token: "t", configPath });

    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
    expect(parsed.mcpServers[LEGACY_PLUGIN_ID]).toBeUndefined();
    expect(parsed.mcpServers[FORK_PLUGIN_ID]).toBeDefined();
    expect(parsed.mcpServers["other-mcp"]).toBeDefined();
  });

  test("removeLegacyKey=false preserves the legacy entry", async () => {
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          [LEGACY_PLUGIN_ID]: { command: "/path/to/old-binary" },
        },
      }),
    );

    await updateClaudeDesktopConfig({
      port: 27200,
      token: "t",
      configPath,
      removeLegacyKey: false,
    });

    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
    expect(parsed.mcpServers[LEGACY_PLUGIN_ID]).toBeDefined();
    expect(parsed.mcpServers[FORK_PLUGIN_ID]).toBeDefined();
  });

  test("writes a `.backup` file when overwriting an existing config", async () => {
    const original = JSON.stringify({
      mcpServers: {
        [LEGACY_PLUGIN_ID]: { command: "/orig-binary" },
      },
    });
    await fsp.writeFile(configPath, original);

    await updateClaudeDesktopConfig({ port: 27200, token: "t", configPath });

    const backupContent = await fsp.readFile(`${configPath}.backup`, "utf8");
    expect(backupContent).toBe(original);
  });

  test("backupBeforeWrite=false skips the backup", async () => {
    await fsp.writeFile(configPath, '{"mcpServers":{}}');

    await updateClaudeDesktopConfig({
      port: 27200,
      token: "t",
      configPath,
      backupBeforeWrite: false,
    });

    const backupExists = await fsp
      .stat(`${configPath}.backup`)
      .then(() => true)
      .catch(() => false);
    expect(backupExists).toBe(false);
  });

  test("idempotent: running twice produces identical content (modulo unchanged file)", async () => {
    await updateClaudeDesktopConfig({ port: 27200, token: "t", configPath });
    const first = await fsp.readFile(configPath, "utf8");

    await updateClaudeDesktopConfig({ port: 27200, token: "t", configPath });
    const second = await fsp.readFile(configPath, "utf8");

    expect(second).toBe(first);
  });

  test("refuses to overwrite malformed JSON (preserves user data)", async () => {
    await fsp.writeFile(configPath, "{not-valid-json");

    let threw = false;
    try {
      await updateClaudeDesktopConfig({ port: 27200, token: "t", configPath });
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/malformed/i);
    }
    expect(threw).toBe(true);

    // The original malformed file is untouched.
    const content = await fsp.readFile(configPath, "utf8");
    expect(content).toBe("{not-valid-json");
  });

  test("custom pluginId override is honored", async () => {
    await updateClaudeDesktopConfig({
      port: 27200,
      token: "t",
      pluginId: "custom-plugin-id",
      configPath,
    });

    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
    expect(parsed.mcpServers["custom-plugin-id"]).toBeDefined();
    expect(parsed.mcpServers[FORK_PLUGIN_ID]).toBeUndefined();
  });

  test("config file with empty mcpServers gets the new entry added", async () => {
    await fsp.writeFile(configPath, JSON.stringify({ mcpServers: {} }));
    await updateClaudeDesktopConfig({ port: 27200, token: "t", configPath });

    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
    expect(parsed.mcpServers[FORK_PLUGIN_ID]).toBeDefined();
  });

  test("config file without mcpServers key gets one added", async () => {
    // User-managed config that has only other keys.
    await fsp.writeFile(
      configPath,
      JSON.stringify({ globalShortcut: "Ctrl+Shift+M", theme: "dark" }),
    );

    await updateClaudeDesktopConfig({ port: 27200, token: "t", configPath });

    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
    expect(parsed.globalShortcut).toBe("Ctrl+Shift+M");
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers[FORK_PLUGIN_ID]).toBeDefined();
  });
});

describe("removeFromClaudeDesktopConfig", () => {
  let tmpRoot: string;
  let configPath: string;
  let homedirSpy: Mock<typeof os.homedir>;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-tools-claude-rm-"));
    configPath = path.join(tmpRoot, "claude_desktop_config.json");
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpRoot);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  test("removes both legacy and new entries", async () => {
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          [LEGACY_PLUGIN_ID]: { command: "/old" },
          [FORK_PLUGIN_ID]: { command: "npx", args: ["mcp-remote"] },
          "other-mcp": { command: "/keep" },
        },
      }),
    );

    await removeFromClaudeDesktopConfig({ configPath });

    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8"));
    expect(parsed.mcpServers[LEGACY_PLUGIN_ID]).toBeUndefined();
    expect(parsed.mcpServers[FORK_PLUGIN_ID]).toBeUndefined();
    expect(parsed.mcpServers["other-mcp"]).toEqual({ command: "/keep" });
  });

  test("no-op when config file is missing", async () => {
    // Missing file path — should not throw, should not create anything.
    await removeFromClaudeDesktopConfig({
      configPath: path.join(tmpRoot, "missing.json"),
    });
    // Nothing to assert — survival is the assertion.
  });

  test("no-op on malformed config (preserves the file)", async () => {
    await fsp.writeFile(configPath, "{garbage");
    await removeFromClaudeDesktopConfig({ configPath });
    const content = await fsp.readFile(configPath, "utf8");
    expect(content).toBe("{garbage");
  });
});
