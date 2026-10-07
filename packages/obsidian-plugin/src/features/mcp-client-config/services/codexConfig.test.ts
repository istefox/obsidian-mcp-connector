import { describe, expect, test } from "bun:test";
import { codexConfigSnippet, type CodexConnection } from "./codexConfig";

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
