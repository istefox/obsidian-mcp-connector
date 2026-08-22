import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import {
  codexConfigSnippet,
  codexServerId,
  inspectCodexInstall,
  installCodexConfig,
  locateCodexConfig,
  type CodexConnection,
} from "./codexConfig";

const connection: CodexConnection = {
  vaultName: "Neon Hades-2",
  routeId: "123e4567-e89b-42d3-a456-426614174000",
  accessToken: "stable-broker-token",
  brokerPort: 27206,
};

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-codex-config-"));
  configPath = path.join(tempDir, "config.toml");
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe("Codex config snippet", () => {
  test("uses one stable broker URL instead of the live vault port or token", () => {
    expect(codexServerId(connection.vaultName)).toBe("obsidian_neonhades2");
    const snippet = codexConfigSnippet(connection);
    expect(snippet).toContain(
      'url = "http://127.0.0.1:27206/v1/123e4567-e89b-42d3-a456-426614174000/mcp"',
    );
    expect(snippet).toContain('Authorization = "Bearer stable-broker-token"');
    expect(snippet).not.toContain("27200");
  });

  test("refuses a vault name that cannot form a stable id", () => {
    expect(() => codexServerId("---")).toThrow();
  });
});

describe("Codex config location", () => {
  test("prefers an explicit CODEX_HOME", async () => {
    expect(
      await locateCodexConfig({ codexHome: tempDir, homeDir: "ignored" }),
    ).toEqual({
      located: true,
      configPath,
      source: "CODEX_HOME",
    });
  });

  test("refuses to guess when neither CODEX_HOME nor the default directory exists", async () => {
    const missingHome = path.join(tempDir, "missing-home");
    const result = await locateCodexConfig({
      codexHome: "",
      homeDir: missingHome,
    });
    expect(result.located).toBe(false);
  });
});

describe("explicit Codex config installer", () => {
  test("previews and adds one entry without touching config automatically", async () => {
    const preview = await inspectCodexInstall(connection, { configPath });
    expect(preview.action).toBe("add");
    expect(await fsp.stat(configPath).catch(() => null)).toBeNull();

    const result = await installCodexConfig(connection, { configPath });
    expect(result.action).toBe("add");
    const written = await fsp.readFile(configPath, "utf8");
    expect(Bun.TOML.parse(written)).toEqual({
      mcp_servers: {
        obsidian_neonhades2: {
          url: "http://127.0.0.1:27206/v1/123e4567-e89b-42d3-a456-426614174000/mcp",
          http_headers: { Authorization: "Bearer stable-broker-token" },
          enabled: true,
          required: false,
        },
      },
    });
  });

  test("refuses a write when the config changed after its preview", async () => {
    await fsp.writeFile(configPath, 'model = "gpt-5"\n', "utf8");
    const preview = await inspectCodexInstall(connection, { configPath });
    const changed = 'model = "gpt-5.1"\n';
    await fsp.writeFile(configPath, changed, "utf8");

    await expect(
      installCodexConfig(connection, {
        configPath,
        expectedRevision: preview.revision,
      }),
    ).rejects.toThrow(/changed after the preview/);
    expect(await fsp.readFile(configPath, "utf8")).toBe(changed);
  });

  test("identifies and replaces an earlier entry while preserving unrelated TOML", async () => {
    const previous = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.obsidian_neonhades2]",
      'command = "node"',
      'args = ["old-bridge.js"]',
      "",
      "[mcp_servers.obsidian_neonhades2.env]",
      'TOKEN = "old"',
      "",
      "[mcp_servers.obsidian_neonhades2.tools.get_vault_file]",
      'approval_mode = "approve"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");

    const preview = await inspectCodexInstall(connection, { configPath });
    expect(preview.action).toBe("replace");
    const result = await installCodexConfig(connection, { configPath });
    expect(result.action).toBe("replace");
    expect(result.backupPath).toBeDefined();
    expect(await fsp.readFile(result.backupPath!, "utf8")).toBe(previous);

    const written = await fsp.readFile(configPath, "utf8");
    expect(written).toContain('model = "gpt-5"');
    expect(written).toContain("[mcp_servers.other]");
    expect(written).not.toContain("old-bridge.js");
    expect(written).not.toContain("obsidian_neonhades2.env");
    expect(written).toContain(
      "[mcp_servers.obsidian_neonhades2.tools.get_vault_file]",
    );
    expect(written).toContain('approval_mode = "approve"');
    expect(Bun.TOML.parse(written)).toBeDefined();
  });

  test("is idempotent and preserves CRLF", async () => {
    await fsp.writeFile(
      configPath,
      '[mcp_servers.other]\r\ncommand = "other"\r\n',
      "utf8",
    );
    await installCodexConfig(connection, { configPath });
    const first = await fsp.readFile(configPath, "utf8");
    const second = await installCodexConfig(connection, { configPath });
    expect(second.action).toBe("unchanged");
    expect(await fsp.readFile(configPath, "utf8")).toBe(first);
    expect(first.replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("preserves a UTF-8 BOM while replacing the first table", async () => {
    await fsp.writeFile(
      configPath,
      '\uFEFF[mcp_servers.obsidian_neonhades2]\nurl = "http://old"\n',
      "utf8",
    );
    await installCodexConfig(connection, { configPath });
    expect((await fsp.readFile(configPath, "utf8")).startsWith("\uFEFF")).toBe(
      true,
    );
  });

  test("refuses ambiguous duplicate entries", async () => {
    await fsp.writeFile(
      configPath,
      "[mcp_servers.obsidian_neonhades2]\nurl = 'a'\n[mcp_servers.obsidian_neonhades2]\nurl = 'b'\n",
      "utf8",
    );
    await expect(
      inspectCodexInstall(connection, { configPath }),
    ).rejects.toThrow(/ambiguous/);

    await fsp.writeFile(
      configPath,
      "[mcp_servers.obsidian_neonhades2]\nurl = 'a'\n[mcp_servers.obsidian_neonhades2.custom]\nvalue = true\n",
      "utf8",
    );
    await expect(
      inspectCodexInstall(connection, { configPath }),
    ).rejects.toThrow(/ambiguous/);

    await fsp.rm(configPath);
    await fsp.mkdir(configPath);
    await expect(
      inspectCodexInstall(connection, { configPath }),
    ).rejects.toThrow(/not a regular file/);
  });

  test("allows unrelated multiline strings and ignores headers inside them", async () => {
    const previous = [
      'instructions = """',
      "Keep this apparent table as instruction text:",
      "[mcp_servers.obsidian_neonhades2]",
      'url = "http://not-a-table"',
      '"""',
      "literal_instructions = '''",
      "[mcp_servers.also_not_a_table]",
      "'''",
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");

    const preview = await inspectCodexInstall(connection, { configPath });
    expect(preview.action).toBe("add");
    await installCodexConfig(connection, { configPath });

    const written = await fsp.readFile(configPath, "utf8");
    expect(written).toContain(previous.trimEnd());
    expect(Bun.TOML.parse(written)).toBeDefined();
  });

  test("refuses a multiline string inside the entry being replaced", async () => {
    await fsp.writeFile(
      configPath,
      [
        "[mcp_servers.obsidian_neonhades2]",
        'instructions = """',
        "Do not discard this text.",
        '"""',
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(
      inspectCodexInstall(connection, { configPath }),
    ).rejects.toThrow(/multiline string in 'obsidian_neonhades2'/);
  });

  test("recovers a stale legacy lock before installing", async () => {
    const lockPath = `${configPath}.obsidian-mcp.lock`;
    await fsp.writeFile(configPath, 'model = "gpt-5"\n', "utf8");
    await fsp.writeFile(lockPath, "legacy-lock-id", "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    await fsp.utimes(lockPath, staleTime, staleTime);

    await installCodexConfig(connection, { configPath });

    expect(await fsp.stat(lockPath).catch(() => null)).toBeNull();
    expect(
      Bun.TOML.parse(await fsp.readFile(configPath, "utf8")),
    ).toBeDefined();
  });

  test("waits for a fresh lock instead of deleting it", async () => {
    const lockPath = `${configPath}.obsidian-mcp.lock`;
    const owner = JSON.stringify({
      version: 1,
      lockId: "another-writer",
      createdAt: new Date().toISOString(),
    });
    await fsp.writeFile(lockPath, owner, "utf8");
    let ownerStillHeldLock = false;
    const release = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void (async () => {
          try {
            ownerStillHeldLock =
              (await fsp.readFile(lockPath, "utf8")) === owner;
            await fsp.rm(lockPath);
            resolve();
          } catch (error) {
            reject(error);
          }
        })();
      }, 100);
    });

    await Promise.all([
      installCodexConfig(connection, { configPath }),
      release,
    ]);

    expect(ownerStillHeldLock).toBe(true);
  });
});
