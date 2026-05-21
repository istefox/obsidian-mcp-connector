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
import { detectLegacyInstall, hasAnyLegacySignal } from "./detect";

/**
 * Tests for the migration legacy-install detector. Sandbox pattern:
 *
 * - Real tmpdir per test acting as the fake HOME and as the legacy
 *   binary install directory.
 * - `os.homedir()` is stubbed via spyOn (process.env.HOME does not
 *   round-trip through Bun/Node's homedir cache).
 * - Each test exercises one signal in isolation, plus a few
 *   combination tests for `hasAnyLegacySignal`.
 *
 * Platform note: `detectLegacyInstall` resolves `INSTALL_PATH[platform]`
 * for the binary probe, so the binary-detection tests are macOS-guarded
 * (the primary platform). The Claude-config-entry probe is platform-
 * independent because we always pass `claudeConfigPath` explicitly.
 */

describe("detectLegacyInstall", () => {
  let tmpRoot: string;
  let homedirSpy: Mock<typeof os.homedir>;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "mcp-tools-detect-test-"),
    );
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpRoot);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // No legacy state
  // -------------------------------------------------------------------------

  test("clean vault, no legacy state, no Claude config: all signals false", async () => {
    const state = await detectLegacyInstall({
      pluginData: { mcpTransport: { bearerToken: "t" } },
      claudeConfigPath: path.join(tmpRoot, "missing-config.json"),
      binaryInstallDirOverride: path.join(tmpRoot, "no-binary-here"),
    });

    expect(state.hasLegacySettingsKeys).toBe(false);
    expect(state.hasLegacyBinary).toBe(false);
    expect(state.hasLegacyClaudeConfigEntry).toBe(false);
    expect(hasAnyLegacySignal(state)).toBe(false);
  });

  test("null/undefined pluginData does not crash", async () => {
    const state = await detectLegacyInstall({
      pluginData: null,
      claudeConfigPath: path.join(tmpRoot, "missing.json"),
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });
    expect(state.hasLegacySettingsKeys).toBe(false);
    expect(hasAnyLegacySignal(state)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Signal 1: legacy settings keys
  // -------------------------------------------------------------------------

  test("installLocation key present → hasLegacySettingsKeys=true", async () => {
    const state = await detectLegacyInstall({
      pluginData: { installLocation: "system" },
      claudeConfigPath: path.join(tmpRoot, "missing.json"),
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });
    expect(state.hasLegacySettingsKeys).toBe(true);
    expect(hasAnyLegacySignal(state)).toBe(true);
  });

  test("platformOverride key present → hasLegacySettingsKeys=true", async () => {
    const state = await detectLegacyInstall({
      pluginData: {
        platformOverride: { platform: "macos", arch: "arm64" },
      },
      claudeConfigPath: path.join(tmpRoot, "missing.json"),
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });
    expect(state.hasLegacySettingsKeys).toBe(true);
  });

  test("only 0.4.0 keys (mcpTransport, semanticSearch) → hasLegacySettingsKeys=false", async () => {
    const state = await detectLegacyInstall({
      pluginData: {
        mcpTransport: { bearerToken: "abc" },
        semanticSearch: { provider: "auto" },
      },
      claudeConfigPath: path.join(tmpRoot, "missing.json"),
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });
    expect(state.hasLegacySettingsKeys).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Signal 2: legacy binary on disk
  // -------------------------------------------------------------------------

  test("legacy binary present at install path → hasLegacyBinary=true + path populated", async () => {
    if (os.platform() !== "darwin" && os.platform() !== "linux") {
      // The binary name on Windows is mcp-server.exe — same logic but
      // we'd need to write a .exe stub. Skip for simplicity.
      return;
    }
    const installDir = path.join(tmpRoot, "legacy-bin");
    await fsp.mkdir(installDir, { recursive: true });
    const binaryPath = path.join(installDir, "mcp-server");
    await fsp.writeFile(binaryPath, "#!/bin/sh\necho stub\n", { mode: 0o755 });

    const state = await detectLegacyInstall({
      pluginData: {},
      claudeConfigPath: path.join(tmpRoot, "missing.json"),
      binaryInstallDirOverride: installDir,
    });

    expect(state.hasLegacyBinary).toBe(true);
    expect(state.legacyBinaryPath).toBe(binaryPath);
    expect(hasAnyLegacySignal(state)).toBe(true);
  });

  test("install dir exists but no binary → hasLegacyBinary=false", async () => {
    if (os.platform() !== "darwin" && os.platform() !== "linux") return;
    const installDir = path.join(tmpRoot, "empty-install-dir");
    await fsp.mkdir(installDir, { recursive: true });

    const state = await detectLegacyInstall({
      pluginData: {},
      claudeConfigPath: path.join(tmpRoot, "missing.json"),
      binaryInstallDirOverride: installDir,
    });

    expect(state.hasLegacyBinary).toBe(false);
    expect(state.legacyBinaryPath).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Signal 3: legacy Claude Desktop config entry
  // -------------------------------------------------------------------------

  test("Claude config has legacy entry (command=path to binary) → hasLegacyClaudeConfigEntry=true", async () => {
    const configPath = path.join(tmpRoot, "claude_desktop_config.json");
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "mcp-tools-istefox": {
            command:
              "/Users/u/Library/Application Support/obsidian-mcp-tools/bin/mcp-server",
            env: { OBSIDIAN_API_KEY: "k" },
          },
        },
      }),
    );

    const state = await detectLegacyInstall({
      pluginData: {},
      claudeConfigPath: configPath,
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });

    expect(state.hasLegacyClaudeConfigEntry).toBe(true);
    expect(state.legacyClaudeConfigPath).toBe(configPath);
    expect(state.legacyClaudeConfigEntryCommand).toContain("mcp-server");
  });

  test("Claude config has 0.4.0 entry (npx + mcp-remote) → hasLegacyClaudeConfigEntry=false", async () => {
    const configPath = path.join(tmpRoot, "claude_desktop_config.json");
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "mcp-tools-istefox": {
            command: "npx",
            args: [
              "-y",
              "mcp-remote",
              "http://127.0.0.1:27200/mcp",
              "--header",
              "Authorization: Bearer xxx",
            ],
          },
        },
      }),
    );

    const state = await detectLegacyInstall({
      pluginData: {},
      claudeConfigPath: configPath,
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });

    expect(state.hasLegacyClaudeConfigEntry).toBe(false);
  });

  test("Claude config has the entry with command=npx but args missing mcp-remote → still legacy", async () => {
    // Defensive: someone hand-edited the config to use npx but for an
    // entirely different package. We must not silently treat that as
    // "already migrated", or we'd skip the rewrite.
    const configPath = path.join(tmpRoot, "claude_desktop_config.json");
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "mcp-tools-istefox": {
            command: "npx",
            args: ["-y", "some-other-package"],
          },
        },
      }),
    );

    const state = await detectLegacyInstall({
      pluginData: {},
      claudeConfigPath: configPath,
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });

    expect(state.hasLegacyClaudeConfigEntry).toBe(true);
  });

  test("plugin entry missing from mcpServers → hasLegacyClaudeConfigEntry=false", async () => {
    const configPath = path.join(tmpRoot, "claude_desktop_config.json");
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "some-other-mcp": { command: "/usr/local/bin/other" },
        },
      }),
    );

    const state = await detectLegacyInstall({
      pluginData: {},
      claudeConfigPath: configPath,
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });

    expect(state.hasLegacyClaudeConfigEntry).toBe(false);
    // configPath is still surfaced so the modal can show it as "found
    // but not a legacy entry" — useful in "Learn more".
    expect(state.legacyClaudeConfigPath).toBe(configPath);
  });

  test("malformed Claude config (invalid JSON) → no false positive, hasLegacy=false", async () => {
    const configPath = path.join(tmpRoot, "claude_desktop_config.json");
    await fsp.writeFile(configPath, "{not-json}");

    const state = await detectLegacyInstall({
      pluginData: {},
      claudeConfigPath: configPath,
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });

    expect(state.hasLegacyClaudeConfigEntry).toBe(false);
  });

  test("missing Claude config file → hasLegacyClaudeConfigEntry=false (treated as never configured)", async () => {
    const state = await detectLegacyInstall({
      pluginData: {},
      claudeConfigPath: path.join(tmpRoot, "does-not-exist.json"),
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });

    expect(state.hasLegacyClaudeConfigEntry).toBe(false);
    expect(hasAnyLegacySignal(state)).toBe(false);
  });

  test("entry under legacy `obsidian-mcp-tools` key → hasLegacyClaudeConfigEntry=true (key migration needed)", async () => {
    // 0.3.x wrote the entry under the legacy key. Even
    // if the payload shape were 0.4.0-compatible, the key itself must
    // migrate to mcp-tools-istefox.
    const configPath = path.join(tmpRoot, "claude_desktop_config.json");
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "obsidian-mcp-tools": {
            command: "/path/to/binary",
            env: { OBSIDIAN_API_KEY: "k" },
          },
        },
      }),
    );

    const state = await detectLegacyInstall({
      pluginData: {},
      claudeConfigPath: configPath,
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });

    expect(state.hasLegacyClaudeConfigEntry).toBe(true);
    expect(state.legacyClaudeConfigEntryCommand).toBe("/path/to/binary");
  });

  test("legacy key takes precedence even if both keys present", async () => {
    const configPath = path.join(tmpRoot, "claude_desktop_config.json");
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "obsidian-mcp-tools": { command: "/legacy/path" },
          "mcp-tools-istefox": {
            command: "npx",
            args: [
              "-y",
              "mcp-remote",
              "http://127.0.0.1:27200/mcp",
              "--header",
              "Authorization: Bearer x",
            ],
          },
        },
      }),
    );

    const state = await detectLegacyInstall({
      pluginData: {},
      claudeConfigPath: configPath,
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });

    // Legacy key still present → migration needed (deletion of the
    // stale key, not rewrite of the new one).
    expect(state.hasLegacyClaudeConfigEntry).toBe(true);
    expect(state.legacyClaudeConfigEntryCommand).toBe("/legacy/path");
  });

  test("custom pluginId override is honored", async () => {
    const configPath = path.join(tmpRoot, "claude_desktop_config.json");
    await fsp.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          "mcp-tools-custom": {
            command: "/path/to/legacy-binary",
          },
        },
      }),
    );

    const state = await detectLegacyInstall({
      pluginData: {},
      pluginId: "mcp-tools-custom",
      claudeConfigPath: configPath,
      binaryInstallDirOverride: path.join(tmpRoot, "nope"),
    });

    expect(state.hasLegacyClaudeConfigEntry).toBe(true);
    expect(state.legacyClaudeConfigEntryCommand).toBe("/path/to/legacy-binary");
  });

  // -------------------------------------------------------------------------
  // hasAnyLegacySignal — combination
  // -------------------------------------------------------------------------

  test("hasAnyLegacySignal: any single signal returns true", () => {
    expect(
      hasAnyLegacySignal({
        hasLegacySettingsKeys: true,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: false,
      }),
    ).toBe(true);

    expect(
      hasAnyLegacySignal({
        hasLegacySettingsKeys: false,
        hasLegacyBinary: true,
        hasLegacyClaudeConfigEntry: false,
      }),
    ).toBe(true);

    expect(
      hasAnyLegacySignal({
        hasLegacySettingsKeys: false,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: true,
      }),
    ).toBe(true);
  });

  test("hasAnyLegacySignal: all false returns false", () => {
    expect(
      hasAnyLegacySignal({
        hasLegacySettingsKeys: false,
        hasLegacyBinary: false,
        hasLegacyClaudeConfigEntry: false,
      }),
    ).toBe(false);
  });
});
