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
  serverId: "obsidian_neonhades2",
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
  test("new entries include the vault name without colliding display names", () => {
    expect(codexServerId("Vault-A", connection.routeId)).not.toBe(
      codexServerId("Vault A", "123e4567-e89b-42d3-a456-426614174001"),
    );
    expect(codexServerId("Vault-A", connection.routeId)).toBe(
      "obsidian_vault_a_123e4567e89b42d3a456426614174000",
    );
  });
  test("new snippets name the vault in the copied TOML header", () => {
    const snippet = codexConfigSnippet({
      ...connection,
      vaultName: "My Vault",
      serverId: undefined,
    });
    expect(snippet.split("\n")[0]).toBe(
      "[mcp_servers.obsidian_my_vault_123e4567e89b42d3a456426614174000]",
    );
  });
  test("route identity keeps names without ASCII alphanumerics usable", () => {
    expect(codexServerId("日記", connection.routeId)).toBe(
      "obsidian_vault_123e4567e89b42d3a456426614174000",
    );
  });
  test("long vault names leave room for readable Codex tool names", () => {
    const vaultName = "A".repeat(80);
    const serverId = codexServerId(vaultName, connection.routeId);
    expect(serverId).toBe(
      `obsidian_${"a".repeat(32)}_123e4567e89b42d3a456426614174000`,
    );
    expect(
      `mcp__${serverId}__create_vault_binary_file`.length,
    ).toBeLessThanOrEqual(128);
  });
  test("uses one stable broker URL instead of the live vault port or token", () => {
    expect(codexServerId(connection.vaultName)).toBe("obsidian_neonhades2");
    const snippet = codexConfigSnippet(connection);
    expect(snippet).toContain(
      'url = "http://127.0.0.1:27206/v1/123e4567-e89b-42d3-a456-426614174000/mcp"',
    );
    expect(snippet).toContain('Authorization = "Bearer stable-broker-token"');
    expect(snippet).not.toContain("27200");
  });

  test("env-var mode writes the variable name, not the token", () => {
    const snippet = codexConfigSnippet({
      ...connection,
      bearerTokenEnvVar: "OBSIDIAN_MCP_TOKEN",
    });
    expect(snippet).toContain('bearer_token_env_var = "OBSIDIAN_MCP_TOKEN"');
    expect(snippet).not.toContain("http_headers");
    expect(snippet).not.toContain("stable-broker-token");
    const parsed = Bun.TOML.parse(snippet) as {
      mcp_servers: { obsidian_neonhades2: Record<string, unknown> };
    };
    expect(parsed.mcp_servers.obsidian_neonhades2.bearer_token_env_var).toBe(
      "OBSIDIAN_MCP_TOKEN",
    );
  });

  test("refuses an environment variable name that is not an identifier", () => {
    expect(() =>
      codexConfigSnippet({ ...connection, bearerTokenEnvVar: 'X"; rm' }),
    ).toThrow();
  });

  test("startupTimeoutSec is emitted only when asked for", () => {
    expect(codexConfigSnippet(connection)).not.toContain("startup_timeout_sec");
    expect(
      codexConfigSnippet({ ...connection, startupTimeoutSec: 30 }),
    ).toContain("startup_timeout_sec = 30");
    expect(() =>
      codexConfigSnippet({ ...connection, startupTimeoutSec: 0 }),
    ).toThrow();
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
  test.each(["inline", "dotted"])(
    "refuses %s entries under the server parent table before name migration",
    async (form) => {
      const oldId = `obsidian_${connection.routeId.replace(/-/g, "")}`;
      const namedConnection = { ...connection, serverId: undefined };
      const body =
        form === "inline"
          ? `'${oldId}' = { url = "http://synthetic", enabled_tools = ["read_only"], default_tools_approval_mode = "approve" }`
          : `'${oldId}'.url = "http://synthetic"\n'${oldId}'.enabled_tools = ["read_only"]\n'${oldId}'.default_tools_approval_mode = "approve"`;
      for (const header of [
        "[mcp_servers]",
        '[ "mcp_servers" ]',
        "[ 'mcp_servers' ]",
      ]) {
        const previous = `model = "synthetic-model"\n${header}\n${body}\n`;
        expect(Bun.TOML.parse(previous)).toMatchObject({
          mcp_servers: {
            [oldId]: {
              enabled_tools: ["read_only"],
              default_tools_approval_mode: "approve",
            },
          },
        });
        await fsp.writeFile(configPath, previous, "utf8");
        await expect(
          inspectCodexInstall(namedConnection, { configPath }),
        ).rejects.toThrow(/inline or dotted server tables/);
        await expect(
          installCodexConfig(namedConnection, { configPath }),
        ).rejects.toThrow(/inline or dotted server tables/);
        expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
        expect(await fsp.readdir(tempDir)).toEqual(["config.toml"]);
      }
    },
  );

  test("permits an empty server parent table and ignores unrelated lookalikes", async () => {
    const previous = [
      "[mcp_servers]",
      '# existing = { url = "http://synthetic" }',
      "",
      "[mcp_servers.other]",
      'url = "http://synthetic"',
      "",
      "[features]",
      "mcp_servers = { unrelated = true }",
      "documentation = '''",
      "[mcp_servers]",
      'existing = { url = "http://synthetic" }',
      "'''",
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");
    const preview = await inspectCodexInstall(connection, { configPath });
    expect(preview.action).toBe("add");
    expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
    const result = await installCodexConfig(connection, { configPath });
    expect(result.action).toBe("add");
    expect(await fsp.readFile(result.backupPath!, "utf8")).toBe(previous);
    const written = await fsp.readFile(configPath, "utf8");
    const parsed = Bun.TOML.parse(written) as {
      mcp_servers: Record<string, unknown>;
    };
    expect(written.startsWith(previous)).toBe(true);
    expect(parsed).toMatchObject(Bun.TOML.parse(previous));
    expect(Object.keys(parsed.mcp_servers)).toEqual([
      "other",
      preview.serverId,
    ]);
  });

  test("refuses inline server tables and preserves additional entry policies", async () => {
    for (const previous of [
      'mcp_servers = { existing = { url = "http://localhost" } }\n',
      '[mcp_servers.obsidian_neonhades2]\nurl = "old"\nnot_a_real_codex_key = ["read_only"]\n',
    ]) {
      await fsp.writeFile(configPath, previous);
      await expect(
        installCodexConfig(connection, { configPath }),
      ).rejects.toThrow(/Copy the snippet/);
      expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
    }
  });
  test("refuses an unrecognized quoted table without deleting unrelated configuration", async () => {
    const previous =
      '[mcp_servers.obsidian_neonhades2]\nurl = "old"\n[mcp_servers."other]name"]\nurl = "preserve-me"\n';
    await fsp.writeFile(configPath, previous);
    await expect(
      installCodexConfig(connection, { configPath }),
    ).rejects.toThrow(/unsupported table/);
    expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
  });
  test("replaces an entry that sets Codex's genuine extra config keys instead of refusing", async () => {
    const previous =
      '[mcp_servers.obsidian_neonhades2]\nurl = "old"\nenabled_tools = ["read_only"]\nstartup_timeout_sec = 5\n[mcp_servers.obsidian_neonhades2.oauth]\nclient_id = "keep-me"\n';
    await fsp.writeFile(configPath, previous, "utf8");

    const preview = await inspectCodexInstall(connection, { configPath });
    expect(preview.action).toBe("replace");
    await installCodexConfig(connection, { configPath });

    const written = await fsp.readFile(configPath, "utf8");
    expect(written).toContain("[mcp_servers.obsidian_neonhades2.oauth]");
    expect(written).toContain('client_id = "keep-me"');
    // The regression this guards: ownedKeys accepting these root keys must not
    // mean the replace silently discards them.
    expect(written).toContain('enabled_tools = ["read_only"]');
    expect(written).toContain("startup_timeout_sec = 5");
  });

  test("carries Codex policy keys through a replace instead of discarding them", async () => {
    const previous = [
      "[mcp_servers.obsidian_neonhades2]",
      'command = "node"',
      'args = ["old.js"]',
      'cwd = "/tmp"',
      'env_http_headers = { A = "B" }',
      'bearer_token_env_var = "TOK"',
      'http_headers_helper = "get-headers"',
      'env_vars = [{ name = "X" }]',
      'environment_id = "env-1"',
      "startup_timeout_sec = 5",
      "startup_timeout_ms = 900",
      'startup_readiness = "cached_catalog"',
      "tool_timeout_sec = 30",
      "tool_input_schema_max_bytes = 8000",
      "supports_parallel_tool_calls = true",
      'default_tools_approval_mode = "on_request"',
      'enabled_tools = ["read_only"]',
      'disabled_tools = ["danger"]',
      'scopes = ["a", "b"]',
      'name = "Old Name"',
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");

    const preview = await inspectCodexInstall(connection, { configPath });
    expect(preview.action).toBe("replace");
    await installCodexConfig(connection, { configPath });

    const written = await fsp.readFile(configPath, "utf8");
    expect(written).not.toContain("command");
    expect(written).not.toContain("old.js");
    expect(written).not.toContain("cwd");
    expect(written).not.toContain("bearer_token_env_var");
    expect(written).not.toContain("env_http_headers");
    expect(written).not.toContain("http_headers_helper");
    expect(written).not.toContain("env_vars");
    const parsed = Bun.TOML.parse(written) as {
      mcp_servers: { obsidian_neonhades2: Record<string, unknown> };
    };
    expect(parsed.mcp_servers.obsidian_neonhades2).toMatchObject({
      url: "http://127.0.0.1:27206/v1/123e4567-e89b-42d3-a456-426614174000/mcp",
      enabled: true,
      required: false,
      environment_id: "env-1",
      startup_timeout_sec: 5,
      startup_timeout_ms: 900,
      startup_readiness: "cached_catalog",
      tool_timeout_sec: 30,
      tool_input_schema_max_bytes: 8000,
      supports_parallel_tool_calls: true,
      default_tools_approval_mode: "on_request",
      enabled_tools: ["read_only"],
      disabled_tools: ["danger"],
      scopes: ["a", "b"],
      name: "Old Name",
    });
  });

  test("keeps an OAuth pairing intact across a replace", async () => {
    const previous = [
      "[mcp_servers.obsidian_neonhades2]",
      'url = "http://old"',
      'auth = "ema_auth"',
      'scopes = ["a", "b"]',
      'oauth_resource = "https://example/resource"',
      "[mcp_servers.obsidian_neonhades2.oauth]",
      'client_id = "keep-me"',
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");

    await installCodexConfig(connection, { configPath });
    const written = await fsp.readFile(configPath, "utf8");

    expect(written).toContain('auth = "ema_auth"');
    expect(written).toContain('oauth_resource = "https://example/resource"');
    expect(written).toContain("[mcp_servers.obsidian_neonhades2.oauth]");
    expect(written).toContain('client_id = "keep-me"');
    expect(written.indexOf('auth = "ema_auth"')).toBeLessThan(
      written.indexOf("[mcp_servers.obsidian_neonhades2.oauth]"),
    );
    expect(Bun.TOML.parse(written)).toBeDefined();
  });

  test("preserves a multi-line array value verbatim, including its inline comment", async () => {
    const previous = [
      "[mcp_servers.obsidian_neonhades2]",
      'url = "http://old"',
      "enabled_tools = [",
      '  "read_only", # keep this note',
      '  "search",',
      "]",
      'disabled_tools = ["danger"]',
      "",
      "[mcp_servers.obsidian_neonhades2.tools.get_vault_file]",
      'approval_mode = "approve"',
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");

    await installCodexConfig(connection, { configPath });
    const written = await fsp.readFile(configPath, "utf8");

    expect(written).toContain(
      [
        "enabled_tools = [",
        '  "read_only", # keep this note',
        '  "search",',
        "]",
      ].join("\n"),
    );
    expect(written.split("# keep this note")).toHaveLength(2);
    expect(written).toContain(
      "[mcp_servers.obsidian_neonhades2.tools.get_vault_file]",
    );
    const parsed = Bun.TOML.parse(written) as {
      mcp_servers: { obsidian_neonhades2: { enabled_tools: string[] } };
    };
    expect(parsed.mcp_servers.obsidian_neonhades2.enabled_tools).toEqual([
      "read_only",
      "search",
    ]);
  });

  test("is idempotent after a replace that preserves policy keys", async () => {
    const previous = [
      "[mcp_servers.obsidian_neonhades2]",
      'url = "http://old"',
      "enabled_tools = [",
      '  "read_only",',
      "]",
      "startup_timeout_sec = 5",
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");

    await installCodexConfig(connection, { configPath });
    const first = await fsp.readFile(configPath, "utf8");
    const second = await installCodexConfig(connection, { configPath });
    expect(second.action).toBe("unchanged");
    expect(await fsp.readFile(configPath, "utf8")).toBe(first);
  });

  test("still refuses an unrecognized root key, including a multi-line one", async () => {
    for (const previous of [
      '[mcp_servers.obsidian_neonhades2]\nurl = "old"\nmystery = [\n  1,\n]\n',
      '[mcp_servers.obsidian_neonhades2]\nurl = "old"\nmystery = [\n  1,\n',
    ]) {
      await fsp.writeFile(configPath, previous, "utf8");
      await expect(
        installCodexConfig(connection, { configPath }),
      ).rejects.toThrow(/Copy the snippet/);
      expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
    }
  });

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

  test("installing a readable entry migrates the UUID-only entry and its policy", async () => {
    const oldId = "obsidian_123e4567e89b42d3a456426614174000";
    const namedId = "obsidian_neon_hades_2_123e4567e89b42d3a456426614174000";
    const previous = `${codexConfigSnippet({ ...connection, serverId: oldId })}\nenabled_tools = ["read_only"]\ndisabled_tools = ["write_file"]\ndefault_tools_approval_mode = "approve"\n\n[mcp_servers.${oldId}.tools.read_only]\napproval_mode = "approve"\n`;
    const namedConnection = { ...connection, serverId: undefined };
    await fsp.writeFile(configPath, previous, "utf8");

    const preview = await inspectCodexInstall(namedConnection, { configPath });
    expect(preview.serverId).toBe(namedId);
    expect(preview.action).toBe("migrate");
    expect(preview.previousServerId).toBe(oldId);
    expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
    const result = await installCodexConfig(namedConnection, {
      configPath,
      expectedRevision: preview.revision,
    });
    expect(await fsp.readFile(result.backupPath!, "utf8")).toBe(previous);
    const written = await fsp.readFile(configPath, "utf8");
    expect(result.action).toBe("migrate");
    expect(result.previousServerId).toBe(oldId);
    expect(written).toBe(previous.split(oldId).join(namedId));
    const parsed = Bun.TOML.parse(written) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp_servers[oldId]).toBeUndefined();
    expect(Object.keys(parsed.mcp_servers)).toEqual([namedId]);
    expect(parsed.mcp_servers[namedId]).toMatchObject({
      url: `http://127.0.0.1:27206/v1/${connection.routeId}/mcp`,
      http_headers: { Authorization: `Bearer ${connection.accessToken}` },
      enabled_tools: ["read_only"],
      disabled_tools: ["write_file"],
      default_tools_approval_mode: "approve",
      tools: { read_only: { approval_mode: "approve" } },
    });
    expect(
      (await inspectCodexInstall(namedConnection, { configPath })).action,
    ).toBe("unchanged");
  });

  test("migration renames quoted nested headers without changing values, comments or CRLF", async () => {
    const oldId = `obsidian_${connection.routeId.replace(/-/g, "")}`;
    const namedConnection = { ...connection, serverId: undefined };
    const namedId = codexServerId(connection.vaultName, connection.routeId);
    const previous = [
      `\uFEFF[ mcp_servers.'${oldId}' ] # Keep header comment`,
      `url = "http://127.0.0.1:27206/v1/${connection.routeId}/mcp"`,
      "enabled = false",
      "required = true",
      `name = '${oldId}' # This value is not a table key`,
      "",
      `[mcp_servers.'${oldId}'.http_headers]`,
      `Authorization = "Bearer ${connection.accessToken}"`,
      `[mcp_servers.'${oldId}'.tools.'read.file']`,
      'approval_mode = "approve"',
      'description = """',
      `[mcp_servers.${oldId}.tools.fake]`,
      '"""',
      `[mcp_servers.'${oldId}'.oauth]`,
      'resource = "synthetic-resource"',
      "[mcp_servers.other]",
      `name = '${oldId}'`,
      "",
    ].join("\r\n");
    await fsp.writeFile(configPath, previous, "utf8");
    const result = await installCodexConfig(namedConnection, { configPath });
    const written = await fsp.readFile(configPath, "utf8");
    expect(result.action).toBe("migrate");
    expect(
      written.startsWith(
        `\uFEFF[ mcp_servers.${namedId} ] # Keep header comment`,
      ),
    ).toBe(true);
    expect(written.replace(/\r\n/g, "")).not.toContain("\n");
    const parsed = Bun.TOML.parse(written) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp_servers[oldId]).toBeUndefined();
    expect(parsed.mcp_servers[namedId]).toMatchObject({
      enabled: false,
      required: true,
      name: oldId,
      http_headers: { Authorization: `Bearer ${connection.accessToken}` },
      tools: {
        "read.file": {
          approval_mode: "approve",
          description: expect.stringContaining(
            `[mcp_servers.${oldId}.tools.fake]`,
          ),
        },
      },
      oauth: { resource: "synthetic-resource" },
    });
    expect(parsed.mcp_servers.other).toEqual({ name: oldId });
    expect(await fsp.readFile(result.backupPath!, "utf8")).toBe(previous);
  });

  test.each(['a"b', String.raw`C:\x`, "read.file"])(
    "migration preserves the spelling of nested key %s and allows later installs",
    async (toolName) => {
      const oldId = `obsidian_${connection.routeId.replace(/-/g, "")}`;
      const namedConnection = { ...connection, serverId: undefined };
      const namedId = codexServerId(connection.vaultName, connection.routeId);
      const previous = `${codexConfigSnippet({ ...connection, serverId: oldId })}\n[ 'mcp_servers' . '${oldId}' . tools . '${toolName}' ] # Preserve this spelling\napproval_mode = "approve"\n`;
      await fsp.writeFile(configPath, previous, "utf8");
      const result = await installCodexConfig(namedConnection, { configPath });
      const written = await fsp.readFile(configPath, "utf8");
      expect(result.action).toBe("migrate");
      expect(written).toContain(
        `[ 'mcp_servers' . ${namedId} . tools . '${toolName}' ] # Preserve this spelling`,
      );
      const parsed = Bun.TOML.parse(written) as {
        mcp_servers: Record<
          string,
          { tools: Record<string, { approval_mode: string }> }
        >;
      };
      expect(parsed.mcp_servers[namedId].tools[toolName].approval_mode).toBe(
        "approve",
      );
      expect(
        (await inspectCodexInstall(namedConnection, { configPath })).action,
      ).toBe("replace");
      expect(
        (await installCodexConfig(namedConnection, { configPath })).action,
      ).toBe("replace");
      const refreshed = await fsp.readFile(configPath, "utf8");
      expect(refreshed).toContain(
        `[ 'mcp_servers' . ${namedId} . tools . '${toolName}' ] # Preserve this spelling`,
      );
      expect(Bun.TOML.parse(refreshed)).toEqual(parsed);
      expect(
        (await installCodexConfig(namedConnection, { configPath })).action,
      ).toBe("unchanged");
    },
  );

  test.each([
    "duplicate roots",
    "nested table without root",
    "array table",
    "old and new entries",
  ])(
    "refuses ambiguous migration with %s without changing the file",
    async (scenario) => {
      const oldId = `obsidian_${connection.routeId.replace(/-/g, "")}`;
      const namedConnection = { ...connection, serverId: undefined };
      const oldSnippet = codexConfigSnippet({ ...connection, serverId: oldId });
      const previous =
        scenario === "duplicate roots"
          ? `${oldSnippet}\n${oldSnippet}\n`
          : scenario === "nested table without root"
            ? `[mcp_servers.${oldId}.tools.read_file]\napproval_mode = "approve"\n`
            : scenario === "array table"
              ? `[[mcp_servers.${oldId}]]\nurl = "http://synthetic"\n`
              : `${oldSnippet}\n${codexConfigSnippet(namedConnection)}\n`;
      await fsp.writeFile(configPath, previous, "utf8");
      await expect(
        inspectCodexInstall(namedConnection, { configPath }),
      ).rejects.toThrow(/ambiguous|both/);
      await expect(
        installCodexConfig(namedConnection, { configPath }),
      ).rejects.toThrow(/ambiguous|both/);
      expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
      expect(await fsp.readdir(tempDir)).toEqual(["config.toml"]);
    },
  );

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

  test("tolerates a multi-line array literal elsewhere in the file", async () => {
    const previous = [
      "matrix = [",
      "  [1, 2],",
      "  [3, 4],",
      "]",
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
    expect(written).toContain("matrix = [");
    expect(written).toContain("[mcp_servers.other]");
    expect(Bun.TOML.parse(written)).toBeDefined();
  });

  test("still refuses a genuinely unrecognized table header", async () => {
    const previous = '[not.a.valid header\ncommand = "other"\n';
    await fsp.writeFile(configPath, previous, "utf8");
    await expect(
      inspectCodexInstall(connection, { configPath }),
    ).rejects.toThrow(/unsupported table/);
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

  test("never rolls back over a concurrent editor's replacement (file pre-existed)", async () => {
    const previous = 'model = "gpt-5"\n';
    await fsp.writeFile(configPath, previous, "utf8");
    const concurrentReplacement = 'model = "gpt-5.1"\nconcurrent = true\n';

    await expect(
      installCodexConfig(connection, {
        configPath,
        afterWrite: async () => {
          await fsp.writeFile(configPath, concurrentReplacement, "utf8");
        },
      }),
    ).rejects.toMatchObject({
      backupPath: expect.any(String),
    });

    expect(await fsp.readFile(configPath, "utf8")).toBe(concurrentReplacement);
  });

  test("never rolls back over a concurrent editor's replacement (file did not exist)", async () => {
    const concurrentReplacement = '[mcp_servers.other]\ncommand = "other"\n';

    await expect(
      installCodexConfig(connection, {
        configPath,
        afterWrite: async () => {
          await fsp.writeFile(configPath, concurrentReplacement, "utf8");
        },
      }),
    ).rejects.toThrow();

    expect(await fsp.readFile(configPath, "utf8")).toBe(concurrentReplacement);
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

describe("Codex install with token and timeout options", () => {
  test("switching to env-var mode replaces the static header and keeps policy keys", async () => {
    await fsp.writeFile(
      configPath,
      [
        "[mcp_servers.obsidian_neonhades2]",
        'url = "old"',
        'http_headers = { Authorization = "Bearer old" }',
        'enabled_tools = ["read_only"]',
        "",
      ].join("\n"),
      "utf8",
    );
    const env = { ...connection, bearerTokenEnvVar: "OBSIDIAN_MCP_TOKEN" };
    await installCodexConfig(env, { configPath });
    const written = await fsp.readFile(configPath, "utf8");
    expect(written).toContain('bearer_token_env_var = "OBSIDIAN_MCP_TOKEN"');
    expect(written).not.toContain("http_headers");
    expect(written).not.toContain("stable-broker-token");
    expect(written).toContain('enabled_tools = ["read_only"]');
    Bun.TOML.parse(written);
  });

  test("an explicit startupTimeoutSec overrides the old value without duplicating the key", async () => {
    await fsp.writeFile(
      configPath,
      '[mcp_servers.obsidian_neonhades2]\nurl = "old"\nstartup_timeout_sec = 5\n',
      "utf8",
    );
    await installCodexConfig(
      { ...connection, startupTimeoutSec: 30 },
      { configPath },
    );
    const written = await fsp.readFile(configPath, "utf8");
    expect(written.match(/startup_timeout_sec/g)).toHaveLength(1);
    const parsed = Bun.TOML.parse(written) as {
      mcp_servers: { obsidian_neonhades2: Record<string, unknown> };
    };
    expect(parsed.mcp_servers.obsidian_neonhades2.startup_timeout_sec).toBe(30);
  });

  test("without the option an existing startup_timeout_sec is kept", async () => {
    await fsp.writeFile(
      configPath,
      '[mcp_servers.obsidian_neonhades2]\nurl = "old"\nstartup_timeout_sec = 5\n',
      "utf8",
    );
    await installCodexConfig(connection, { configPath });
    expect(await fsp.readFile(configPath, "utf8")).toContain(
      "startup_timeout_sec = 5",
    );
  });
});
