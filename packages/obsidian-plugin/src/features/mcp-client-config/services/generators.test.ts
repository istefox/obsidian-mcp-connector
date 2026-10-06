import { describe, expect, test } from "bun:test";
import {
  claudeCodeAddCommand,
  CLAUDE_CODE_TOKEN_ENV_VAR,
  claudeCodeConfig,
  claudeCodeEnvConfig,
  claudeCodeProjectAddCommand,
  claudeDesktopConfig,
  clineConfig,
  parseClaudeCodeProjectPath,
  streamableHttpConfig,
  vaultServerId,
  wrapInMcpServers,
} from "./generators";
import { codexServerId } from "./codexConfig";
import { FORK_PLUGIN_ID } from "./claudeDesktop";

/**
 * Generators are pure functions — these tests are structural
 * comparisons against the documented shapes (design D6). No
 * filesystem, no clipboard, no UI.
 */

const URL = "http://127.0.0.1:27200/mcp";
const TOKEN = "abc123";

describe("claudeDesktopConfig", () => {
  test("emits the npx mcp-remote bridge shape", () => {
    expect(claudeDesktopConfig({ url: URL, token: TOKEN })).toEqual({
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        URL,
        "--header",
        `Authorization: Bearer ${TOKEN}`,
      ],
    });
  });

  test("token interpolation is literal (no escaping)", () => {
    const out = claudeDesktopConfig({ url: URL, token: "tok with space" });
    expect(out.args[4]).toBe("Authorization: Bearer tok with space");
  });
});

describe("claudeCodeConfig", () => {
  test("emits the native HTTP shape", () => {
    expect(claudeCodeConfig({ url: URL, token: TOKEN })).toEqual({
      type: "http",
      url: URL,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });
});

describe("claudeCodeAddCommand", () => {
  test("emits the documented one-liner at user scope by default", () => {
    expect(claudeCodeAddCommand({ url: URL, token: TOKEN })).toBe(
      `claude mcp add --transport http --scope user ${FORK_PLUGIN_ID} ${URL} --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  test("honours the scope and a custom entry id", () => {
    expect(
      claudeCodeAddCommand(
        { url: URL, token: TOKEN, pluginId: "vault-a" },
        "project",
      ),
    ).toBe(
      `claude mcp add --transport http --scope project vault-a ${URL} --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  test("escapes the characters a double-quoted shell string still interprets", () => {
    const out = claudeCodeAddCommand({ url: URL, token: 'a"b$c`d\\e' });
    expect(
      out.endsWith('--header "Authorization: Bearer a\\"b\\$c\\`d\\\\e"'),
    ).toBe(true);
  });
});

describe("claudeCodeProjectAddCommand", () => {
  const input = { url: URL, token: TOKEN, pluginId: "vault-a" };
  const tail = `--transport http --scope local vault-a ${URL} --header "Authorization: Bearer ${TOKEN}"`;

  test("with no project path, copies the user-scope command unchanged", () => {
    expect(claudeCodeProjectAddCommand(input, "")).toBe(
      claudeCodeAddCommand(input),
    );
    expect(claudeCodeProjectAddCommand(input, "   ")).toBe(
      claudeCodeAddCommand(input),
    );
  });

  test("enters a Windows path with spaces and registers at local scope", () => {
    expect(
      claudeCodeProjectAddCommand(input, "  C:\\Users\\Me\\My Projects\\app "),
    ).toBe(`cd 'C:\\Users\\Me\\My Projects\\app' && claude mcp add ${tail}`);
  });

  test("enters a POSIX path, keeping shell metacharacters literal", () => {
    expect(claudeCodeProjectAddCommand(input, "/home/me/$work & play")).toBe(
      `cd '/home/me/$work & play' && claude mcp add ${tail}`,
    );
  });

  test("rejects a path it cannot quote or that is not absolute", () => {
    expect(() => claudeCodeProjectAddCommand(input, "projects/app")).toThrow(
      "absolute",
    );
    expect(() => claudeCodeProjectAddCommand(input, "/tmp/it's")).toThrow(
      "single quote",
    );
  });
});

describe("parseClaudeCodeProjectPath", () => {
  test.each([
    "/",
    "/home/me/app",
    "C:\\Projects\\app",
    "c:/Projects/app",
    "\\\\server\\share\\app",
  ])("accepts the absolute path %p", (path) => {
    expect(parseClaudeCodeProjectPath(path)).toEqual({ ok: true, path });
  });

  test.each([
    "app",
    "./app",
    "~/app",
    "C:app",
    "\\Projects\\app",
    "\\\\server",
  ])("rejects the non-absolute path %p", (path) => {
    expect(parseClaudeCodeProjectPath(path).ok).toBe(false);
  });

  test.each(["/tmp/it's", "C:\\it\u2019s", "/tmp/a\nb", "/tmp/a\rb"])(
    "rejects %p, which a single-quoted string cannot carry",
    (path) => {
      expect(parseClaudeCodeProjectPath(path)).toEqual({
        ok: false,
        error:
          "The project path cannot contain a single quote or a line break.",
      });
    },
  );

  test.each(["C:\\app[1]", "/srv/app]", "/srv/*", "C:\\app?"])(
    "rejects %p, which PowerShell's cd expands as a wildcard",
    (path) => {
      expect(parseClaudeCodeProjectPath(path)).toEqual({
        ok: false,
        error: "The project path cannot contain [, ], * or ?.",
      });
    },
  );
});

describe("clineConfig", () => {
  test("emits Cline's camelCase transport type", () => {
    expect(clineConfig({ url: URL, token: TOKEN })).toEqual({
      type: "streamableHttp",
      url: URL,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });
});

describe("streamableHttpConfig", () => {
  test("emits the streamable-http shape (Cursor/Cline/Continue/etc.)", () => {
    expect(streamableHttpConfig({ url: URL, token: TOKEN })).toEqual({
      type: "streamable-http",
      url: URL,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });
});

describe("vaultServerId", () => {
  test("keys each vault by its name, words joined by underscores", () => {
    expect(vaultServerId("My Vault")).toBe("obsidian_my_vault");
    expect(vaultServerId("Neon Hades-2")).toBe("obsidian_neon_hades_2");
    expect(vaultServerId("  My   Vault! ")).toBe("obsidian_my_vault");
    expect(vaultServerId("Work")).not.toBe(vaultServerId("Personal"));
  });

  test("leaves the Codex id in its merged form", () => {
    // Codex's vault-named entries predate the route id and already sit in
    // users' config.toml under this name.
    expect(codexServerId("My Vault")).toBe("obsidian_myvault");
  });

  test("a name with no ASCII alphanumerics still gets a key of its own", () => {
    expect(vaultServerId("日記")).toMatch(/^obsidian_[a-z0-9]{6}$/);
    expect(vaultServerId("日記")).not.toBe(vaultServerId("日本"));
    expect(vaultServerId("日記")).toBe(vaultServerId("日記"));
  });

  test("a name that loses characters is told apart from its ASCII twin", () => {
    expect(vaultServerId("Società")).toMatch(/^obsidian_societ_[a-z0-9]{6}$/);
    expect(vaultServerId("Società")).not.toBe(vaultServerId("Societ"));
    expect(vaultServerId("Societ")).toBe("obsidian_societ");
  });

  test("an ASCII-only name keeps the plain form", () => {
    expect(vaultServerId("My Vault!")).toBe("obsidian_my_vault");
    expect(vaultServerId("")).toBe("obsidian");
  });
});

describe("wrapInMcpServers", () => {
  test("custom plugin id is honored", () => {
    const inner = { command: "npx", args: [] };
    const wrapped = wrapInMcpServers(inner, "custom-id");
    expect(wrapped).toEqual({
      mcpServers: { "custom-id": inner },
    });
  });

  test("composes with the generators to build a copy-paste block", () => {
    const wrapped = wrapInMcpServers(
      claudeCodeConfig({ url: URL, token: TOKEN }),
      vaultServerId("My Vault"),
    );
    expect(wrapped).toEqual({
      mcpServers: {
        obsidian_my_vault: {
          type: "http",
          url: URL,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    });
  });
});

describe("claudeCodeEnvConfig", () => {
  test("references the token by environment variable, never by value", () => {
    const entry = claudeCodeEnvConfig({ url: URL });
    expect(CLAUDE_CODE_TOKEN_ENV_VAR).toBe("OBSIDIAN_MCP_TOKEN");
    expect(entry).toEqual({
      type: "http",
      url: URL,
      headers: { Authorization: "Bearer ${OBSIDIAN_MCP_TOKEN}" },
    });
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });
});
