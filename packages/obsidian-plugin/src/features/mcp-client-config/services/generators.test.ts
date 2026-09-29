import { describe, expect, test } from "bun:test";
import {
  claudeCodeAddCommand,
  claudeCodeConfig,
  claudeDesktopConfig,
  clineConfig,
  streamableHttpConfig,
  vaultServerId,
  wrapInMcpServers,
} from "./generators";
import { codexServerId } from "./codexConfig";

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

  test("falls back to a plain key when the name has no ASCII alphanumerics", () => {
    expect(vaultServerId("日記")).toBe("obsidian");
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
