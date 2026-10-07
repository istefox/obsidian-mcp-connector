import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import * as codexModule from "./codexConfig";
import {
  CODEX_STARTUP_TIMEOUT_SEC,
  CODEX_TOKEN_ENV_VAR,
  CodexInstallError,
  codexConfigSnippet,
  codexEntryFor,
  codexMcpAddCommand,
  inspectCodexInstall,
  installCodexConfig,
  locateCodexHome,
  locateCodexProject,
  type CodexConnection,
  type CodexInstallInput,
  type CodexInstallTarget,
} from "./codexConfig";
import {
  CLAUDE_CODE_TOKEN_ENV_VAR,
  parseClaudeCodeProjectPath,
  vaultServerId,
} from "./generators";

const connection: CodexConnection = {
  serverId: "obsidian_neon_hades_2",
  accessToken: "row-vault-token",
  url: "http://127.0.0.1:27200/v1/123e4567-e89b-42d3-a456-426614174000/mcp",
};

describe("Codex config snippet", () => {
  test("names the entry with the given per-vault key, no route ID", () => {
    expect(codexConfigSnippet(connection).split("\n")[0]).toBe(
      "[mcp_servers.obsidian_neon_hades_2]",
    );
  });

  test("uses the given broker URL and the row's vault token", () => {
    const snippet = codexConfigSnippet(connection);
    expect(snippet).toContain(
      'url = "http://127.0.0.1:27200/v1/123e4567-e89b-42d3-a456-426614174000/mcp"',
    );
    expect(snippet).toContain('Authorization = "Bearer row-vault-token"');
    expect(snippet).not.toContain("27200/mcp");
  });

  test("env-var mode writes the variable name, not the token", () => {
    const snippet = codexConfigSnippet({
      ...connection,
      bearerTokenEnvVar: "OBSIDIAN_MCP_TOKEN",
    });
    expect(snippet).toContain('bearer_token_env_var = "OBSIDIAN_MCP_TOKEN"');
    expect(snippet).not.toContain("http_headers");
    expect(snippet).not.toContain("row-vault-token");
    const parsed = Bun.TOML.parse(snippet) as {
      mcp_servers: { obsidian_neon_hades_2: Record<string, unknown> };
    };
    expect(parsed.mcp_servers.obsidian_neon_hades_2.bearer_token_env_var).toBe(
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

  test("refuses an entry key a TOML table header cannot carry", () => {
    expect(() =>
      codexConfigSnippet({ ...connection, serverId: "a.b]" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fixtures shared by the generator, location and installer suites below
// ---------------------------------------------------------------------------

const VAULT_NAME = "Neon Hades-2";
const KEY = vaultServerId(VAULT_NAME);
const ROUTE = "123e4567-e89b-42d3-a456-426614174000";
const ROUTE_HEX = ROUTE.replace(/-/g, "");
const OTHER_ROUTE = "9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const TOKEN = "row-vault-token";
const ROUTE_CREDENTIAL = "route-credential-secret-0123456789abcdef";
const BROKER_URL = `http://127.0.0.1:27200/v1/${ROUTE}/mcp`;
const LEGACY_URL = `http://127.0.0.1:27206/v1/${ROUTE}/mcp`;
const DIRECT_URL = "http://127.0.0.1:27203/mcp";

let tempDir = "";
let configPath = "";

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-codex-config-"));
  configPath = path.join(tempDir, "config.toml");
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

type Parsed = { mcp_servers: Record<string, Record<string, unknown>> };

function parsed(text: string): Parsed {
  return Bun.TOML.parse(text) as Parsed;
}

/** One line per path in `dir`: files with their bytes, folders, links with their target. */
async function snapshotTree(dir: string, prefix = ""): Promise<string[]> {
  const lines: string[] = [];
  for (const entry of await fsp.readdir(dir)) {
    const full = path.join(dir, entry);
    const name = `${prefix}${entry}`;
    const stat = await fsp.lstat(full);
    if (stat.isSymbolicLink())
      lines.push(`${name} -> ${await fsp.readlink(full)}`);
    else if (stat.isDirectory()) {
      lines.push(`${name}/`);
      lines.push(...(await snapshotTree(full, `${name}/`)));
    } else lines.push(`${name}: ${await fsp.readFile(full, "utf8")}`);
  }
  return lines.sort();
}

// ---------------------------------------------------------------------------
// Task 1: generators and locations (R-02, R-03, R-05, R-08)
// ---------------------------------------------------------------------------

describe("Codex entry generator", () => {
  test("constants: a 30 second startup timeout and the shared token variable (R-02)", () => {
    expect(CODEX_STARTUP_TIMEOUT_SEC).toBe(30);
    expect(CODEX_TOKEN_ENV_VAR).toBe("OBSIDIAN_MCP_TOKEN");
    expect(CODEX_TOKEN_ENV_VAR).toBe(CLAUDE_CODE_TOKEN_ENV_VAR);
  });

  test("literal form: url, row token header, enabled, required and a 30 second timeout (R-02)", () => {
    const entry = codexEntryFor({
      serverId: KEY,
      url: BROKER_URL,
      token: TOKEN,
      tokenForm: "literal",
    });
    expect(Bun.TOML.parse(codexConfigSnippet(entry))).toEqual({
      mcp_servers: {
        [KEY]: {
          url: BROKER_URL,
          http_headers: { Authorization: `Bearer ${TOKEN}` },
          enabled: true,
          required: false,
          startup_timeout_sec: 30,
        },
      },
    });
  });

  test("env form: names the variable, no header, and the token is absent from the text (R-02)", () => {
    const snippet = codexConfigSnippet(
      codexEntryFor({
        serverId: KEY,
        url: BROKER_URL,
        token: TOKEN,
        tokenForm: "env",
      }),
    );
    const table = parsed(snippet).mcp_servers[KEY];
    expect(table.bearer_token_env_var).toBe("OBSIDIAN_MCP_TOKEN");
    expect(table).not.toHaveProperty("http_headers");
    expect(table).toMatchObject({
      url: BROKER_URL,
      enabled: true,
      required: false,
      startup_timeout_sec: 30,
    });
    expect(snippet).not.toContain(TOKEN);
  });

  test("the key is the vault's plain key and holds no route hex (R-02)", () => {
    const entry = codexEntryFor({
      serverId: vaultServerId(VAULT_NAME),
      url: BROKER_URL,
      token: TOKEN,
      tokenForm: "literal",
    });
    expect(entry.serverId).toBe(vaultServerId(VAULT_NAME));
    expect(entry.serverId).not.toContain(ROUTE_HEX);
    expect(codexConfigSnippet(entry).split("\n")[0]).toBe(
      `[mcp_servers.${vaultServerId(VAULT_NAME)}]`,
    );
  });

  test.each([
    ["broker", BROKER_URL],
    ["fixed", "http://127.0.0.1:27200/mcp"],
    ["direct", DIRECT_URL],
  ])("a %s URL passes through unchanged (R-02)", (_kind, url) => {
    const entry = codexEntryFor({
      serverId: KEY,
      url,
      token: TOKEN,
      tokenForm: "literal",
    });
    expect(entry.url).toBe(url);
    expect(entry.accessToken).toBe(TOKEN);
    expect(parsed(codexConfigSnippet(entry)).mcp_servers[KEY].url).toBe(url);
  });
});

describe("codex mcp add command", () => {
  test("is exactly the documented command, with the variable flag and no token (R-03)", () => {
    const command = codexMcpAddCommand({
      serverId: "obsidian_neon_hades_2",
      url: BROKER_URL,
    });
    expect(command).toBe(
      "codex mcp add 'obsidian_neon_hades_2' --url 'http://127.0.0.1:27200/v1/123e4567-e89b-42d3-a456-426614174000/mcp' --bearer-token-env-var OBSIDIAN_MCP_TOKEN",
    );
    expect(command).not.toContain("Bearer");
    expect(command).not.toContain(TOKEN);
  });

  test("splits into eight words when a single-quoted span is one word (R-03)", () => {
    // The plan says "seven words"; the exact string it pins has eight:
    // codex, mcp, add, '<key>', --url, '<url>', --bearer-token-env-var, VAR.
    const command = codexMcpAddCommand({ serverId: KEY, url: BROKER_URL });
    const words = command.match(/'[^']*'|\S+/g) ?? [];
    expect(words).toEqual([
      "codex",
      "mcp",
      "add",
      `'${KEY}'`,
      "--url",
      `'${BROKER_URL}'`,
      "--bearer-token-env-var",
      "OBSIDIAN_MCP_TOKEN",
    ]);
  });

  test.each(["a.b", "a]b", "a b", "-leading"])(
    "refuses the key %p (R-03)",
    (serverId) => {
      // Positive control: the same call with a valid key does not throw
      expect(() =>
        codexMcpAddCommand({ serverId: KEY, url: BROKER_URL }),
      ).not.toThrow();
      expect(() => codexMcpAddCommand({ serverId, url: BROKER_URL })).toThrow();
    },
  );

  test.each([
    ["a single quote", "http://127.0.0.1:27200/v1/x'y/mcp"],
    ["a typographic quote", "http://127.0.0.1:27200/v1/x\u2019y/mcp"],
    ["a space", "http://127.0.0.1:27200/v1/x y/mcp"],
    ["a tab", "http://127.0.0.1:27200/v1/x\ty/mcp"],
    ["a line break", "http://127.0.0.1:27200/v1/x\ny/mcp"],
  ])("refuses a URL with %s (R-03)", (_label, url) => {
    // Positive control: a valid URL does not throw
    expect(() =>
      codexMcpAddCommand({ serverId: KEY, url: BROKER_URL }),
    ).not.toThrow();
    expect(() => codexMcpAddCommand({ serverId: KEY, url })).toThrow();
  });
});

describe("Codex home location", () => {
  test("an existing CODEX_HOME is used, resolved to its real path (R-05)", async () => {
    const result = await locateCodexHome({
      env: { CODEX_HOME: tempDir },
      homeDir: "ignored",
    });
    const real = await fsp.realpath(tempDir);
    expect(result).toEqual({
      located: true,
      codexHome: real,
      configPath: path.join(real, "config.toml"),
      source: "CODEX_HOME",
      exists: true,
    });
  });

  test("a CODEX_HOME reached through a link resolves to the target (R-05)", async () => {
    const target = path.join(tempDir, "real-home");
    const link = path.join(tempDir, "linked-home");
    await fsp.mkdir(target);
    await fsp.symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await locateCodexHome({ env: { CODEX_HOME: link } });
    expect(result.located).toBe(true);
    if (!result.located) return;
    expect(result.codexHome).toBe(await fsp.realpath(target));
    expect(result.configPath).toBe(
      path.join(await fsp.realpath(target), "config.toml"),
    );
  });

  test("a relative, missing or file-valued CODEX_HOME is not located, with a reason (R-05)", async () => {
    const file = path.join(tempDir, "a-file");
    await fsp.writeFile(file, "x");
    for (const value of [
      "relative/path",
      path.join(tempDir, "does-not-exist"),
      file,
    ]) {
      const result = await locateCodexHome({ env: { CODEX_HOME: value } });
      expect(result.located).toBe(false);
      if (!result.located) expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("an empty CODEX_HOME falls back to the default (R-05)", async () => {
    await fsp.mkdir(path.join(tempDir, ".codex"));
    const result = await locateCodexHome({
      env: { CODEX_HOME: "" },
      homeDir: tempDir,
    });
    expect(result).toMatchObject({
      located: true,
      source: "default",
      exists: true,
    });
  });

  test("an existing <home>/.codex is the default home (R-05)", async () => {
    await fsp.mkdir(path.join(tempDir, ".codex"));
    const result = await locateCodexHome({ env: {}, homeDir: tempDir });
    expect(result).toEqual({
      located: true,
      codexHome: path.join(tempDir, ".codex"),
      configPath: path.join(tempDir, ".codex", "config.toml"),
      source: "default",
      exists: true,
    });
  });

  test("a missing <home>/.codex is located but absent, and nothing is created (R-05)", async () => {
    const result = await locateCodexHome({ env: {}, homeDir: tempDir });
    expect(result).toMatchObject({
      located: true,
      source: "default",
      exists: false,
    });
    expect(await fsp.readdir(tempDir)).toEqual([]);
  });

  test("a file named .codex is not located (R-05)", async () => {
    await fsp.writeFile(path.join(tempDir, ".codex"), "x");
    const result = await locateCodexHome({ env: {}, homeDir: tempDir });
    expect(result.located).toBe(false);
  });

  test("an empty home directory is not located (R-05)", async () => {
    const result = await locateCodexHome({ env: {}, homeDir: "" });
    expect(result.located).toBe(false);
  });

  test("win32 builds the %USERPROFILE%\\.codex path (R-05)", async () => {
    const result = await locateCodexHome({
      env: {},
      homeDir: "C:\\Users\\me",
      platform: "win32",
    });
    expect(result.located).toBe(true);
    if (!result.located) return;
    expect(result.configPath).toBe("C:\\Users\\me\\.codex\\config.toml");
    expect(result.codexHome).toBe("C:\\Users\\me\\.codex");
    expect(result.source).toBe("default");
  });
});

describe("Codex project location", () => {
  test("an empty path means no project (R-08)", async () => {
    const result = await locateCodexProject("");
    expect(result.located).toBe(false);
    if (!result.located) expect(result.reason).toMatch(/no project path/i);
  });

  test.each([
    ["a relative path", "relative/project"],
    ["a quote", "/tmp/it's"],
    ["a wildcard", "/tmp/a*b"],
  ])("%s gives the shared validation's error (R-08)", async (_label, input) => {
    const expected = parseClaudeCodeProjectPath(input);
    expect(expected.ok).toBe(false);
    const result = await locateCodexProject(input);
    expect(result.located).toBe(false);
    if (!result.located && !expected.ok)
      expect(result.reason).toBe(expected.error);
  });

  test("a missing folder and a file are refused (R-08)", async () => {
    const file = path.join(tempDir, "a-file");
    await fsp.writeFile(file, "x");
    expect((await locateCodexProject(path.join(tempDir, "nope"))).located).toBe(
      false,
    );
    expect((await locateCodexProject(file)).located).toBe(false);
  });

  test("a folder without .codex is located and nothing is created (R-08)", async () => {
    const result = await locateCodexProject(tempDir);
    expect(result.located).toBe(true);
    if (!result.located) return;
    expect(result.codexDirExists).toBe(false);
    expect(result.configPath.endsWith(path.join(".codex", "config.toml"))).toBe(
      true,
    );
    expect(await fsp.readdir(tempDir)).toEqual([]);
  });

  test("a folder with a real .codex folder reports it (R-08)", async () => {
    await fsp.mkdir(path.join(tempDir, ".codex"));
    const result = await locateCodexProject(tempDir);
    expect(result.located).toBe(true);
    if (result.located) expect(result.codexDirExists).toBe(true);
  });

  test("a .codex file is refused (R-08, R-05)", async () => {
    await fsp.writeFile(path.join(tempDir, ".codex"), "x");
    expect((await locateCodexProject(tempDir)).located).toBe(false);
  });

  describe.skipIf(process.platform === "win32")(".codex as a link", () => {
    test("is refused (R-08, R-05)", async () => {
      const outside = await fsp.mkdtemp(
        path.join(os.tmpdir(), "mcp-codex-out-"),
      );
      try {
        await fsp.symlink(outside, path.join(tempDir, ".codex"), "dir");
        expect((await locateCodexProject(tempDir)).located).toBe(false);
        expect(await fsp.readdir(outside)).toEqual([]);
      } finally {
        await fsp.rm(outside, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Task 3: the installer suite, ported from 4a40dc6^ and adapted to the
// (input, target, { expectedRevision }) shape and to ADR-0028
// ---------------------------------------------------------------------------

/**
 * The preview's revision is the SHA-256 of the file's bytes, or of its
 * absence. A refusal test cannot ask the preview for it (the preview
 * refuses too), so it computes it with the formula the pre-4a40dc6
 * installer used and ADR-0028 D9 keeps.
 */
function revisionOf(raw: string | null): string {
  return createHash("sha256")
    .update(raw === null ? "missing\0" : `present\0${raw}`, "utf8")
    .digest("hex");
}

function inputFor(
  over: Partial<{
    serverId: string;
    url: string;
    token: string;
    tokenForm: "literal" | "env";
    routeId: string | null;
  }> = {},
): CodexInstallInput {
  const { routeId = ROUTE, ...rest } = over;
  return {
    ...codexEntryFor({
      serverId: KEY,
      url: BROKER_URL,
      token: TOKEN,
      tokenForm: "literal",
      ...rest,
    }),
    routeId,
  };
}

function userTarget(): CodexInstallTarget {
  return { scope: "user", configPath };
}

function preview(input = inputFor(), target = userTarget()) {
  return inspectCodexInstall(input, target);
}

async function install(
  input = inputFor(),
  target = userTarget(),
  opts: { afterWrite?: () => Promise<void> } = {},
) {
  const planned = await inspectCodexInstall(input, target);
  return installCodexConfig(input, target, {
    expectedRevision: planned.revision,
    ...opts,
  });
}

/** Both inspect and install refuse, the bytes stay and nothing else lands. */
async function expectRefused(
  previous: string,
  pattern: RegExp,
  input = inputFor(),
) {
  await fsp.writeFile(configPath, previous, "utf8");
  await expect(preview(input)).rejects.toThrow(pattern);
  await expect(
    installCodexConfig(input, userTarget(), {
      expectedRevision: revisionOf(previous),
    }),
  ).rejects.toThrow(pattern);
  expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
  expect(await fsp.readdir(tempDir)).toEqual(["config.toml"]);
}

const OWN_URL_LINE = `url = ${JSON.stringify(BROKER_URL)}`;

function legacyEntry(key: string, extra: string[] = []): string {
  return [
    `[mcp_servers.${key}]`,
    `url = ${JSON.stringify(LEGACY_URL)}`,
    `http_headers = { Authorization = "Bearer ${ROUTE_CREDENTIAL}" }`,
    "enabled = true",
    "required = false",
    ...extra,
    "",
  ].join("\n");
}

describe("explicit Codex config installer", () => {
  test.each(["inline", "dotted"])(
    "refuses %s entries under the server parent table before name migration",
    async (form) => {
      const oldId = `obsidian_${ROUTE_HEX}`;
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
        await expectRefused(previous, /inline or dotted server tables/);
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
    const planned = await preview();
    expect(planned.action).toBe("add");
    expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
    const result = await install();
    expect(result.action).toBe("add");
    expect(await fsp.readFile(result.backupPath!, "utf8")).toBe(previous);
    const written = await fsp.readFile(configPath, "utf8");
    expect(written.startsWith(previous)).toBe(true);
    expect(parsed(written)).toMatchObject(Bun.TOML.parse(previous));
    expect(Object.keys(parsed(written).mcp_servers)).toEqual([
      "other",
      planned.serverId,
    ]);
  });

  test("refuses inline server tables and entries with unrecognized keys", async () => {
    await expectRefused(
      'mcp_servers = { existing = { url = "http://localhost" } }\n',
      /Copy the snippet/,
    );
    await expectRefused(
      `[mcp_servers.${KEY}]\n${OWN_URL_LINE}\nnot_a_real_codex_key = ["read_only"]\n`,
      /Copy the snippet/,
    );
  });

  test("refuses an unrecognized quoted table without deleting unrelated configuration", async () => {
    await expectRefused(
      `[mcp_servers.${KEY}]\n${OWN_URL_LINE}\n[mcp_servers."other]name"]\nurl = "preserve-me"\n`,
      /unsupported table/,
    );
  });

  test("replaces an entry that sets Codex's genuine extra config keys instead of refusing", async () => {
    const previous = `[mcp_servers.${KEY}]\n${OWN_URL_LINE}\nenabled_tools = ["read_only"]\nstartup_timeout_sec = 5\n[mcp_servers.${KEY}.oauth]\nclient_id = "keep-me"\n`;
    await fsp.writeFile(configPath, previous, "utf8");

    expect((await preview()).action).toBe("replace");
    await install();

    const written = await fsp.readFile(configPath, "utf8");
    expect(written).toContain(`[mcp_servers.${KEY}.oauth]`);
    expect(written).toContain('client_id = "keep-me"');
    // The replace must not silently discard the keys it tolerates
    expect(written).toContain('enabled_tools = ["read_only"]');
    expect(written).toContain("startup_timeout_sec = 5");
  });

  test("carries Codex policy keys through a replace instead of discarding them", async () => {
    const previous = [
      `[mcp_servers.${KEY}]`,
      OWN_URL_LINE,
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

    expect((await preview()).action).toBe("replace");
    await install();

    const written = await fsp.readFile(configPath, "utf8");
    expect(written).not.toContain("old.js");
    expect(written).not.toContain("cwd");
    expect(written).not.toContain("bearer_token_env_var");
    expect(written).not.toContain("env_http_headers");
    expect(written).not.toContain("http_headers_helper");
    expect(written).not.toContain("env_vars");
    expect(parsed(written).mcp_servers[KEY]).toMatchObject({
      url: BROKER_URL,
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
      `[mcp_servers.${KEY}]`,
      OWN_URL_LINE,
      'auth = "ema_auth"',
      'scopes = ["a", "b"]',
      'oauth_resource = "https://example/resource"',
      `[mcp_servers.${KEY}.oauth]`,
      'client_id = "keep-me"',
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");

    await install();
    const written = await fsp.readFile(configPath, "utf8");

    expect(written).toContain('auth = "ema_auth"');
    expect(written).toContain('oauth_resource = "https://example/resource"');
    expect(written).toContain(`[mcp_servers.${KEY}.oauth]`);
    expect(written).toContain('client_id = "keep-me"');
    expect(written.indexOf('auth = "ema_auth"')).toBeLessThan(
      written.indexOf(`[mcp_servers.${KEY}.oauth]`),
    );
    expect(Bun.TOML.parse(written)).toBeDefined();
  });

  test("preserves a multi-line array value verbatim, including its inline comment", async () => {
    const previous = [
      `[mcp_servers.${KEY}]`,
      OWN_URL_LINE,
      "enabled_tools = [",
      '  "read_only", # keep this note',
      '  "search",',
      "]",
      'disabled_tools = ["danger"]',
      "",
      `[mcp_servers.${KEY}.tools.get_vault_file]`,
      'approval_mode = "approve"',
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");

    await install();
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
    expect(written).toContain(`[mcp_servers.${KEY}.tools.get_vault_file]`);
    expect(parsed(written).mcp_servers[KEY].enabled_tools).toEqual([
      "read_only",
      "search",
    ]);
  });

  test("is idempotent after a replace that preserves policy keys", async () => {
    const previous = [
      `[mcp_servers.${KEY}]`,
      OWN_URL_LINE,
      "enabled_tools = [",
      '  "read_only",',
      "]",
      "startup_timeout_sec = 5",
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");

    await install();
    const first = await fsp.readFile(configPath, "utf8");
    const second = await install();
    expect(second.action).toBe("unchanged");
    expect(await fsp.readFile(configPath, "utf8")).toBe(first);
  });

  test("still refuses an unrecognized root key, including a multi-line one", async () => {
    for (const tail of ["mystery = [\n  1,\n]\n", "mystery = [\n  1,\n"]) {
      await expectRefused(
        `[mcp_servers.${KEY}]\n${OWN_URL_LINE}\n${tail}`,
        /Copy the snippet/,
      );
    }
  });

  test("previews and adds one entry without touching config automatically", async () => {
    const planned = await preview();
    expect(planned.action).toBe("add");
    expect(planned.scope).toBe("user");
    expect(planned.configPath).toBe(configPath);
    expect(planned.serverId).toBe(KEY);
    expect(planned.url).toBe(BROKER_URL);
    expect(planned.tokenForm).toBe("literal");
    expect(planned.createsFile).toBe(true);
    expect(planned.createsDirectory).toBe(false);
    expect(await fsp.stat(configPath).catch(() => null)).toBeNull();

    const result = await install();
    expect(result.action).toBe("add");
    expect(Bun.TOML.parse(await fsp.readFile(configPath, "utf8"))).toEqual({
      mcp_servers: {
        [KEY]: {
          url: BROKER_URL,
          http_headers: { Authorization: `Bearer ${TOKEN}` },
          enabled: true,
          required: false,
          startup_timeout_sec: 30,
        },
      },
    });
  });

  test("a preview in a missing Codex home creates no folder, lock or backup", async () => {
    const missingHome = path.join(tempDir, "missing-home");
    const planned = await preview(inputFor(), {
      scope: "user",
      configPath: path.join(missingHome, "config.toml"),
    });
    expect(planned.action).toBe("add");
    expect(planned.createsFile).toBe(true);
    expect(planned.createsDirectory).toBe(true);
    expect(await fsp.readdir(tempDir)).toEqual([]);
  });

  test("a preview in a project without .codex creates no folder, lock or backup", async () => {
    const project = path.join(tempDir, "project");
    await fsp.mkdir(project);
    const planned = await preview(inputFor({ tokenForm: "env" }), {
      scope: "project",
      configPath: path.join(project, ".codex", "config.toml"),
    });
    expect(planned.action).toBe("add");
    expect(planned.createsDirectory).toBe(true);
    expect(await fsp.readdir(project)).toEqual([]);
  });

  test("refuses a write when the config changed after its preview", async () => {
    await fsp.writeFile(configPath, 'model = "gpt-5"\n', "utf8");
    const planned = await preview();
    const changed = 'model = "gpt-5.1"\n';
    await fsp.writeFile(configPath, changed, "utf8");

    await expect(
      installCodexConfig(inputFor(), userTarget(), {
        expectedRevision: planned.revision,
      }),
    ).rejects.toThrow(/changed after the preview/);
    expect(await fsp.readFile(configPath, "utf8")).toBe(changed);
    expect(await fsp.readdir(tempDir)).toEqual(["config.toml"]);
  });

  test("an empty expected revision is refused and writes nothing", async () => {
    const previous = 'model = "gpt-5"\n';
    await fsp.writeFile(configPath, previous, "utf8");
    await expect(
      installCodexConfig(inputFor(), userTarget(), { expectedRevision: "" }),
    ).rejects.toThrow();
    expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
    expect(await fsp.readdir(tempDir)).toEqual(["config.toml"]);
  });

  test("replaces an earlier entry on this route while preserving unrelated TOML", async () => {
    const previous = [
      'model = "gpt-5"',
      "",
      `[mcp_servers.${KEY}]`,
      OWN_URL_LINE,
      'args = ["old-bridge.js"]',
      "",
      `[mcp_servers.${KEY}.env]`,
      'TOKEN = "old"',
      "",
      `[mcp_servers.${KEY}.tools.get_vault_file]`,
      'approval_mode = "approve"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    await fsp.writeFile(configPath, previous, "utf8");

    expect((await preview()).action).toBe("replace");
    const result = await install();
    expect(result.action).toBe("replace");
    expect(result.backupPath).toBeDefined();
    expect(await fsp.readFile(result.backupPath!, "utf8")).toBe(previous);

    const written = await fsp.readFile(configPath, "utf8");
    expect(written).toContain('model = "gpt-5"');
    expect(written).toContain("[mcp_servers.other]");
    expect(written).not.toContain("old-bridge.js");
    expect(written).not.toContain(`${KEY}.env`);
    expect(written).toContain(`[mcp_servers.${KEY}.tools.get_vault_file]`);
    expect(written).toContain('approval_mode = "approve"');
    expect(Bun.TOML.parse(written)).toBeDefined();
  });

  test("is idempotent and preserves CRLF", async () => {
    await fsp.writeFile(
      configPath,
      '[mcp_servers.other]\r\ncommand = "other"\r\n',
      "utf8",
    );
    await install();
    const first = await fsp.readFile(configPath, "utf8");
    const second = await install();
    expect(second.action).toBe("unchanged");
    expect(await fsp.readFile(configPath, "utf8")).toBe(first);
    expect(first.replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("preserves a UTF-8 BOM while replacing the first table", async () => {
    await fsp.writeFile(
      configPath,
      `\uFEFF[mcp_servers.${KEY}]\n${OWN_URL_LINE}\n`,
      "utf8",
    );
    await install();
    expect((await fsp.readFile(configPath, "utf8")).startsWith("\uFEFF")).toBe(
      true,
    );
  });

  test("refuses ambiguous duplicate entries and a config that is not a regular file", async () => {
    await expectRefused(
      `[mcp_servers.${KEY}]\n${OWN_URL_LINE}\n[mcp_servers.${KEY}]\n${OWN_URL_LINE}\n`,
      /ambiguous/,
    );
    await expectRefused(
      `[mcp_servers.${KEY}]\n${OWN_URL_LINE}\n[mcp_servers.${KEY}.custom]\nvalue = true\n`,
      /ambiguous/,
    );

    await fsp.rm(configPath);
    await fsp.mkdir(configPath);
    await expect(preview()).rejects.toThrow(/not a regular file/);
  });

  describe.skipIf(process.platform === "win32")("config.toml as a link", () => {
    test("is refused and its target is unchanged", async () => {
      const real = path.join(tempDir, "real.toml");
      const content = 'model = "gpt-5"\n';
      await fsp.writeFile(real, content, "utf8");
      await fsp.symlink(real, configPath);

      await expect(preview()).rejects.toThrow(/symbolic link/);
      await expect(
        installCodexConfig(inputFor(), userTarget(), {
          expectedRevision: revisionOf(content),
        }),
      ).rejects.toThrow(/symbolic link/);
      expect(await fsp.readFile(real, "utf8")).toBe(content);
      expect((await fsp.readdir(tempDir)).sort()).toEqual([
        "config.toml",
        "real.toml",
      ]);
    });
  });

  test("allows unrelated multiline strings and ignores headers inside them", async () => {
    const previous = [
      'instructions = """',
      "Keep this apparent table as instruction text:",
      `[mcp_servers.${KEY}]`,
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

    expect((await preview()).action).toBe("add");
    await install();

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

    expect((await preview()).action).toBe("add");
    await install();

    const written = await fsp.readFile(configPath, "utf8");
    expect(written).toContain("matrix = [");
    expect(written).toContain("[mcp_servers.other]");
    expect(Bun.TOML.parse(written)).toBeDefined();
  });

  test("still refuses a genuinely unrecognized table header", async () => {
    await expectRefused(
      '[not.a.valid header\ncommand = "other"\n',
      /unsupported table/,
    );
  });

  test("refuses a multiline string inside the entry being replaced", async () => {
    await expectRefused(
      [
        `[mcp_servers.${KEY}]`,
        OWN_URL_LINE,
        'instructions = """',
        "Do not discard this text.",
        '"""',
        "",
      ].join("\n"),
      new RegExp(`multiline string in '${KEY}'`),
    );
  });

  test("never rolls back over a concurrent editor's replacement (file pre-existed)", async () => {
    const previous = 'model = "gpt-5"\n';
    await fsp.writeFile(configPath, previous, "utf8");
    const concurrentReplacement = 'model = "gpt-5.1"\nconcurrent = true\n';

    await expect(
      install(inputFor(), userTarget(), {
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
      install(inputFor(), userTarget(), {
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

    await install();

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

    await Promise.all([install(), release]);

    expect(ownerStillHeldLock).toBe(true);
  });

  test("no lock file remains after a success", async () => {
    await fsp.writeFile(configPath, 'model = "gpt-5"\n', "utf8");
    await install();
    const names = await fsp.readdir(tempDir);
    expect(names.filter((name) => name.endsWith(".lock"))).toEqual([]);
  });
});

describe("Codex install with token and timeout options", () => {
  test("switching to env-var mode replaces the static header and keeps policy keys", async () => {
    await fsp.writeFile(
      configPath,
      [
        `[mcp_servers.${KEY}]`,
        OWN_URL_LINE,
        'http_headers = { Authorization = "Bearer old" }',
        'enabled_tools = ["read_only"]',
        "",
      ].join("\n"),
      "utf8",
    );
    await install(inputFor({ tokenForm: "env" }));
    const written = await fsp.readFile(configPath, "utf8");
    expect(written).toContain('bearer_token_env_var = "OBSIDIAN_MCP_TOKEN"');
    expect(written).not.toContain("http_headers");
    expect(written).not.toContain(TOKEN);
    expect(written).toContain('enabled_tools = ["read_only"]');
    Bun.TOML.parse(written);
  });

  test("an existing startup_timeout_sec stays, once, even though the entry states 30 (ADR-0028 D4)", async () => {
    await fsp.writeFile(
      configPath,
      `[mcp_servers.${KEY}]\n${OWN_URL_LINE}\nstartup_timeout_sec = 5\n`,
      "utf8",
    );
    await install();
    const written = await fsp.readFile(configPath, "utf8");
    expect(written.match(/startup_timeout_sec/g)).toHaveLength(1);
    expect(parsed(written).mcp_servers[KEY].startup_timeout_sec).toBe(5);
  });

  test("an existing startup_timeout_sec is kept when the input states none", async () => {
    await fsp.writeFile(
      configPath,
      `[mcp_servers.${KEY}]\n${OWN_URL_LINE}\nstartup_timeout_sec = 5\n`,
      "utf8",
    );
    await install({ ...inputFor(), startupTimeoutSec: undefined });
    expect(await fsp.readFile(configPath, "utf8")).toContain(
      "startup_timeout_sec = 5",
    );
  });

  test("an entry without a startup_timeout_sec gets 30", async () => {
    await fsp.writeFile(
      configPath,
      `[mcp_servers.${KEY}]\n${OWN_URL_LINE}\nenabled_tools = ["read_only"]\n`,
      "utf8",
    );
    await install();
    expect(
      parsed(await fsp.readFile(configPath, "utf8")).mcp_servers[KEY]
        .startup_timeout_sec,
    ).toBe(30);
  });
});

describe("entries on the old broker port", () => {
  test("this vault's plain-key entry on 27206 is replaced with the current endpoint", async () => {
    await fsp.writeFile(configPath, legacyEntry(KEY), "utf8");
    const before = await fsp.readFile(configPath, "utf8");
    const planned = await preview();
    expect(planned.action).toBe("replace");
    expect(planned.previousUrl).toBe(LEGACY_URL);
    expect(await fsp.readFile(configPath, "utf8")).toBe(before);

    await installCodexConfig(inputFor(), userTarget(), {
      expectedRevision: planned.revision,
    });
    expect((await preview()).action).toBe("unchanged");
    const written = await fsp.readFile(configPath, "utf8");
    expect(written).toContain("http://127.0.0.1:27200/v1/");
    expect(written).not.toContain("27206");
  });

  test("a UUID-only entry on 27206 migrates, and another server on 27206 is ignored", async () => {
    const oldId = `obsidian_${ROUTE_HEX}`;
    await fsp.writeFile(
      configPath,
      `${legacyEntry(oldId)}\n[mcp_servers.other]\nurl = "${LEGACY_URL}"\n`,
    );
    const planned = await preview();
    expect(planned.action).toBe("migrate");
    expect(planned.previousServerId).toBe(oldId);
    expect(planned.previousUrl).toBe(LEGACY_URL);

    await fsp.writeFile(
      configPath,
      `[mcp_servers.other]\nurl = "${LEGACY_URL}"\n`,
    );
    expect((await preview()).action).toBe("add");
  });
});

describe("entry ownership (ADR-0028 D3, R-06)", () => {
  test("a plain-key entry on another route is refused, naming the key and the other vault", async () => {
    const previous = `[mcp_servers.${KEY}]\nurl = "http://127.0.0.1:27200/v1/${OTHER_ROUTE}/mcp"\nhttp_headers = { Authorization = "Bearer someone-else" }\nenabled_tools = ["read_only"]\n`;
    await fsp.writeFile(configPath, previous, "utf8");
    for (const attempt of [
      () => preview(),
      () =>
        installCodexConfig(inputFor(), userTarget(), {
          expectedRevision: revisionOf(previous),
        }),
    ]) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).not.toBeNull();
      expect(error!.message).toContain(KEY);
      expect(error!.message).toMatch(/another vault/i);
    }
    expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
    expect(await fsp.readdir(tempDir)).toEqual(["config.toml"]);
  });

  test("a plain-key entry on this route, on any port, is replaced", async () => {
    await fsp.writeFile(
      configPath,
      `[mcp_servers.${KEY}]\nurl = "http://127.0.0.1:27205/v1/${ROUTE}/mcp"\nenabled = false\n`,
      "utf8",
    );
    expect((await preview()).action).toBe("replace");
    await install();
    expect(
      parsed(await fsp.readFile(configPath, "utf8")).mcp_servers[KEY],
    ).toMatchObject({
      url: BROKER_URL,
      enabled: true,
    });
  });

  test("a direct entry equal to the installed URL is replaced", async () => {
    await fsp.writeFile(
      configPath,
      `[mcp_servers.${KEY}]\nurl = "${DIRECT_URL}"\nenabled = false\n`,
      "utf8",
    );
    const input = inputFor({ url: DIRECT_URL });
    expect((await preview(input)).action).toBe("replace");
    await install(input);
    expect(
      parsed(await fsp.readFile(configPath, "utf8")).mcp_servers[KEY].enabled,
    ).toBe(true);
  });

  test("a direct entry on another port whose static bearer is the row token is replaced", async () => {
    await fsp.writeFile(
      configPath,
      `[mcp_servers.${KEY}]\nurl = "http://127.0.0.1:27204/mcp"\nhttp_headers = { Authorization = "Bearer ${TOKEN}" }\n`,
      "utf8",
    );
    expect((await preview()).action).toBe("replace");
    await install();
    expect(
      parsed(await fsp.readFile(configPath, "utf8")).mcp_servers[KEY].url,
    ).toBe(BROKER_URL);
  });

  test("a direct entry on another port with another bearer is refused as unattributable", async () => {
    await expectRefused(
      `[mcp_servers.${KEY}]\nurl = "http://127.0.0.1:27204/mcp"\nhttp_headers = { Authorization = "Bearer someone-else" }\n`,
      /.+/,
    );
  });

  test("a stdio entry under the plain key is refused", async () => {
    await expectRefused(
      `[mcp_servers.${KEY}]\ncommand = "node"\nargs = ["bridge.js"]\n`,
      /.+/,
    );
  });
});

describe("migration of earlier entries (ADR-0028 D4, R-07, R-10)", () => {
  test.each([`obsidian_${ROUTE_HEX}`, `${KEY}_${ROUTE_HEX}`])(
    "entry %s on the old port migrates to the plain key, keeping policy and sub-tables",
    async (oldKey) => {
      const previous = legacyEntry(oldKey, [
        'enabled_tools = ["read_only"]',
        'default_tools_approval_mode = "approve"',
        "",
        `[mcp_servers.${oldKey}.tools.read_file]`,
        'approval_mode = "approve"',
        "",
        `[mcp_servers.${oldKey}.oauth]`,
        'client_id = "keep-me"',
      ]);
      await fsp.writeFile(configPath, previous, "utf8");

      const planned = await preview();
      expect(planned.action).toBe("migrate");
      expect(planned.serverId).toBe(KEY);
      expect(planned.previousServerId).toBe(oldKey);
      expect(planned.previousUrl).toBe(LEGACY_URL);
      expect(await fsp.readFile(configPath, "utf8")).toBe(previous);

      const result = await installCodexConfig(inputFor(), userTarget(), {
        expectedRevision: planned.revision,
      });
      expect(result.action).toBe("migrate");
      expect(result.previousServerId).toBe(oldKey);
      expect(await fsp.readFile(result.backupPath!, "utf8")).toBe(previous);

      const written = await fsp.readFile(configPath, "utf8");
      const { mcp_servers } = parsed(written);
      expect(Object.keys(mcp_servers)).toEqual([KEY]);
      expect(mcp_servers[KEY]).toMatchObject({
        url: BROKER_URL,
        http_headers: { Authorization: `Bearer ${TOKEN}` },
        enabled: true,
        required: false,
        enabled_tools: ["read_only"],
        default_tools_approval_mode: "approve",
        startup_timeout_sec: 30,
        tools: { read_file: { approval_mode: "approve" } },
        oauth: { client_id: "keep-me" },
      });
      // R-10: the route credential never survives a migration
      expect(written).not.toContain(ROUTE_CREDENTIAL);
      expect((await preview()).action).toBe("unchanged");
    },
  );

  test("a user-named key whose URL carries this route migrates", async () => {
    await fsp.writeFile(
      configPath,
      `[mcp_servers.my_obsidian]\nurl = "${BROKER_URL}"\nhttp_headers = { Authorization = "Bearer ${ROUTE_CREDENTIAL}" }\nenabled_tools = ["read_only"]\n`,
      "utf8",
    );
    const planned = await preview();
    expect(planned.action).toBe("migrate");
    expect(planned.previousServerId).toBe("my_obsidian");
    await install();
    const written = await fsp.readFile(configPath, "utf8");
    expect(Object.keys(parsed(written).mcp_servers)).toEqual([KEY]);
    expect(parsed(written).mcp_servers[KEY].enabled_tools).toEqual([
      "read_only",
    ]);
    expect(written).not.toContain(ROUTE_CREDENTIAL);
  });

  test("a direct entry on 27206 under another key is left alone", async () => {
    const previous = `[mcp_servers.something_else]\nurl = "http://127.0.0.1:27206/mcp"\n`;
    await fsp.writeFile(configPath, previous, "utf8");
    expect((await preview()).action).toBe("add");
    await install();
    const written = await fsp.readFile(configPath, "utf8");
    expect(written.startsWith(previous)).toBe(true);
    expect(Object.keys(parsed(written).mcp_servers).sort()).toEqual(
      [KEY, "something_else"].sort(),
    );
  });

  test("migration renames nested headers without changing values, comments or CRLF", async () => {
    const oldId = `obsidian_${ROUTE_HEX}`;
    const previous = [
      `\uFEFF[ mcp_servers.'${oldId}' ] # Keep header comment`,
      `url = "${LEGACY_URL}"`,
      "enabled = false",
      "required = true",
      `name = '${oldId}' # This value is not a table key`,
      "",
      `[mcp_servers.'${oldId}'.http_headers]`,
      `Authorization = "Bearer ${ROUTE_CREDENTIAL}"`,
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
    const result = await install();
    const written = await fsp.readFile(configPath, "utf8");
    expect(result.action).toBe("migrate");
    expect(written.startsWith("\uFEFF")).toBe(true);
    expect(written.replace(/\r\n/g, "")).not.toContain("\n");
    const { mcp_servers } = parsed(written);
    expect(mcp_servers[oldId]).toBeUndefined();
    expect(mcp_servers[KEY]).toMatchObject({
      url: BROKER_URL,
      // The snippet's values win for the keys it states
      enabled: true,
      required: false,
      name: oldId,
      http_headers: { Authorization: `Bearer ${TOKEN}` },
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
    expect(mcp_servers.other).toEqual({ name: oldId });
    expect(written).not.toContain(ROUTE_CREDENTIAL);
    expect(await fsp.readFile(result.backupPath!, "utf8")).toBe(previous);
  });

  test.each(['a"b', String.raw`C:\x`, "read.file"])(
    "migration preserves the spelling of nested key %s and allows later installs",
    async (toolName) => {
      const oldId = `obsidian_${ROUTE_HEX}`;
      const previous = `${legacyEntry(oldId)}\n[ 'mcp_servers' . '${oldId}' . tools . '${toolName}' ] # Preserve this spelling\napproval_mode = "approve"\n`;
      await fsp.writeFile(configPath, previous, "utf8");
      const result = await install();
      const written = await fsp.readFile(configPath, "utf8");
      expect(result.action).toBe("migrate");
      expect(written).toContain(
        `[ 'mcp_servers' . ${KEY} . tools . '${toolName}' ] # Preserve this spelling`,
      );
      const tools = parsed(written).mcp_servers[KEY].tools as Record<
        string,
        { approval_mode: string }
      >;
      expect(tools[toolName].approval_mode).toBe("approve");
      expect((await preview()).action).toBe("unchanged");
      expect((await install()).action).toBe("unchanged");
      expect(await fsp.readFile(configPath, "utf8")).toBe(written);
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
      const oldId = `obsidian_${ROUTE_HEX}`;
      const oldEntry = legacyEntry(oldId);
      const previous =
        scenario === "duplicate roots"
          ? `${oldEntry}\n${oldEntry}\n`
          : scenario === "nested table without root"
            ? `[mcp_servers.${oldId}.tools.read_file]\napproval_mode = "approve"\n`
            : scenario === "array table"
              ? `[[mcp_servers.${oldId}]]\nurl = "http://synthetic"\n`
              : `${oldEntry}\n${codexConfigSnippet(inputFor())}\n`;
      await expectRefused(previous, /ambiguous|both/);
    },
  );

  test("a legacy entry next to a plain one is refused with both keys named", async () => {
    const oldId = `obsidian_${ROUTE_HEX}`;
    const previous = `${legacyEntry(oldId)}\n${codexConfigSnippet(inputFor())}\n`;
    await fsp.writeFile(configPath, previous, "utf8");
    const error = await preview().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain(oldId);
    expect(error!.message).toContain(KEY);
    expect(await fsp.readFile(configPath, "utf8")).toBe(previous);
  });
});

describe("project installs (ADR-0028 D6, R-08, R-05)", () => {
  let projectDir = "";
  let projectConfig = "";

  beforeEach(async () => {
    projectDir = path.join(tempDir, "project");
    await fsp.mkdir(projectDir);
    projectConfig = path.join(projectDir, ".codex", "config.toml");
  });

  const projectTarget = (): CodexInstallTarget => ({
    scope: "project",
    configPath: projectConfig,
  });

  test("a literal token is refused before any write", async () => {
    await expect(
      installCodexConfig(inputFor({ tokenForm: "literal" }), projectTarget(), {
        expectedRevision: revisionOf(null),
      }),
    ).rejects.toThrow();
    expect(await fsp.readdir(projectDir)).toEqual([]);
  });

  test("the env form writes the project file without the token", async () => {
    const input = inputFor({ tokenForm: "env" });
    const planned = await inspectCodexInstall(input, projectTarget());
    expect(planned.scope).toBe("project");
    expect(planned.createsFile).toBe(true);
    expect(planned.createsDirectory).toBe(true);
    expect(await fsp.readdir(projectDir)).toEqual([]);

    const result = await installCodexConfig(input, projectTarget(), {
      expectedRevision: planned.revision,
    });
    expect(result.action).toBe("add");
    const written = await fsp.readFile(projectConfig, "utf8");
    expect(parsed(written).mcp_servers[KEY]).toMatchObject({
      url: BROKER_URL,
      bearer_token_env_var: "OBSIDIAN_MCP_TOKEN",
    });
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain("http_headers");
    expect(
      (await fsp.stat(path.join(projectDir, ".codex"))).isDirectory(),
    ).toBe(true);
  });

  test("replacing a project entry that held a literal token leaves no token in the file", async () => {
    await fsp.mkdir(path.dirname(projectConfig));
    await fsp.writeFile(
      projectConfig,
      `[mcp_servers.${KEY}]\n${OWN_URL_LINE}\nhttp_headers = { Authorization = "Bearer committed-secret" }\nenabled_tools = ["read_only"]\n`,
      "utf8",
    );
    const input = inputFor({ tokenForm: "env" });
    const planned = await inspectCodexInstall(input, projectTarget());
    expect(planned.action).toBe("replace");
    await installCodexConfig(input, projectTarget(), {
      expectedRevision: planned.revision,
    });
    const written = await fsp.readFile(projectConfig, "utf8");
    expect(written).not.toContain("committed-secret");
    expect(written).not.toContain("http_headers");
    expect(written).toContain('enabled_tools = ["read_only"]');
  });

  describe.skipIf(process.platform === "win32")(".codex as a link", () => {
    test("is refused and the link's target gains no lock, backup or config", async () => {
      const outside = path.join(tempDir, "outside");
      await fsp.mkdir(outside);
      await fsp.symlink(outside, path.join(projectDir, ".codex"), "dir");
      const input = inputFor({ tokenForm: "env" });

      await expect(
        inspectCodexInstall(input, projectTarget()),
      ).rejects.toThrow();
      await expect(
        installCodexConfig(input, projectTarget(), {
          expectedRevision: revisionOf(null),
        }),
      ).rejects.toThrow();
      expect(await fsp.readdir(outside)).toEqual([]);
    });
  });
});

describe.skipIf(process.platform === "win32")(
  "modes of created files (R-05)",
  () => {
    test("a missing user Codex home is created 0700 and its config 0600", async () => {
      const home = path.join(tempDir, "fresh", ".codex");
      const target: CodexInstallTarget = {
        scope: "user",
        configPath: path.join(home, "config.toml"),
      };
      const planned = await inspectCodexInstall(inputFor(), target);
      expect(planned.createsDirectory).toBe(true);
      await installCodexConfig(inputFor(), target, {
        expectedRevision: planned.revision,
      });
      expect((await fsp.stat(home)).mode & 0o777).toBe(0o700);
      expect((await fsp.stat(target.configPath)).mode & 0o777).toBe(0o600);
    });

    test("an existing config keeps its mode", async () => {
      await fsp.writeFile(configPath, 'model = "gpt-5"\n', "utf8");
      await fsp.chmod(configPath, 0o640);
      await install();
      expect((await fsp.stat(configPath)).mode & 0o777).toBe(0o640);
    });
  },
);

describe("what changes the file system (R-12)", () => {
  test("no exported function other than installCodexConfig writes anything", async () => {
    // Guard: a new exported function must be added to this list on purpose,
    // so the loop below calls it.
    const functions = Object.entries(codexModule)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual([
      "CodexInstallError",
      "codexConfigSnippet",
      "codexEntryFor",
      "codexMcpAddCommand",
      "inspectCodexInstall",
      "installCodexConfig",
      "locateCodexHome",
      "locateCodexProject",
    ]);
    expect(new CodexInstallError("x")).toBeInstanceOf(Error);

    const home = path.join(tempDir, "home");
    const project = path.join(tempDir, "project");
    await fsp.mkdir(home);
    await fsp.mkdir(project);
    const before = await snapshotTree(tempDir);

    codexConfigSnippet(connection);
    codexEntryFor({
      serverId: KEY,
      url: BROKER_URL,
      token: TOKEN,
      tokenForm: "literal",
    });
    codexMcpAddCommand({ serverId: KEY, url: BROKER_URL });
    await locateCodexHome({ env: {}, homeDir: home });
    await locateCodexHome({ env: { CODEX_HOME: tempDir } });
    await locateCodexProject(project);
    await inspectCodexInstall(inputFor(), {
      scope: "user",
      configPath: path.join(home, ".codex", "config.toml"),
    });
    await inspectCodexInstall(inputFor({ tokenForm: "env" }), {
      scope: "project",
      configPath: path.join(project, ".codex", "config.toml"),
    });

    expect(await snapshotTree(tempDir)).toEqual(before);
  });
});
