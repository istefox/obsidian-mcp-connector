import { describe, expect, spyOn, test } from "bun:test";
import type McpToolsPlugin from "$/main";
import { registerTools as registerDesktopTools } from "$/features/mcp-tools";
import { ToolRegistryClass } from "$/features/mcp-transport/services/toolRegistry";
import { logger } from "$/shared/logger";
import { mockApp } from "$/test-setup";
import { registerTools as registerHeadlessTools } from "./registerTools";
import { DESKTOP_ONLY_TOOLS as DESKTOP_ONLY } from "./toolSets";

/** Tools only the headless server has. */
const HEADLESS_ONLY: string[] = [];

type Host = {
  semanticSearchState?: unknown;
  semanticGate?: () => Promise<string | undefined>;
};

async function listTools(
  register: typeof registerDesktopTools,
  host: Host = {},
) {
  const registry = new ToolRegistryClass();
  await register(registry, {
    app: mockApp(),
    plugin: host as McpToolsPlugin,
    pluginVersion: "0.0.0-test",
  });
  return registry.list().tools;
}

describe("headless tool set", () => {
  test("is the desktop set minus the desktop-only tools, plus nothing", async () => {
    const desktop = (
      await listTools(registerDesktopTools, { semanticSearchState: {} })
    ).map((t) => t.name);
    const headless = (
      await listTools(registerHeadlessTools, {
        semanticGate: async () => undefined,
      })
    ).map((t) => t.name);

    for (const name of DESKTOP_ONLY) expect(desktop).toContain(name);
    const expected = desktop
      .filter((n) => !DESKTOP_ONLY.includes(n))
      .concat(HEADLESS_ONLY);
    expect(headless).toEqual(expected);
  });

  test("shares every schema, description, annotation and title with the desktop", async () => {
    const desktop = await listTools(registerDesktopTools, {
      semanticSearchState: {},
    });
    const headless = await listTools(registerHeadlessTools, {
      semanticGate: async () => undefined,
    });
    expect(headless.length).toBeGreaterThan(30);
    for (const tool of headless) {
      expect(tool).toEqual(desktop.find((t) => t.name === tool.name)!);
    }
  });

  test("search_vault_smart is listed when semantic search is on, and not otherwise", async () => {
    const without = (await listTools(registerHeadlessTools)).map((t) => t.name);
    expect(without).not.toContain("search_vault_smart");
    const withGate = (
      await listTools(registerHeadlessTools, {
        semanticGate: async () => undefined,
      })
    ).map((t) => t.name);
    expect(withGate).toContain("search_vault_smart");
    expect(withGate.filter((n) => n !== "search_vault_smart")).toEqual(without);
  });
});

describe("search_vault_smart errors", () => {
  const cachePath = "/tmp/cache/obsidian-mcp-connector/models/config.json";

  async function smartSearch(
    provider: { isReady(): boolean; search(): Promise<never> },
    state: Record<string, unknown> = {},
  ) {
    const registry = new ToolRegistryClass();
    await registerHeadlessTools(registry, {
      // Its own vault, so the file count does not depend on what an earlier
      // test left in the shared mock.
      app: { vault: { getMarkdownFiles: () => [] } } as never,
      plugin: {
        semanticGate: async () => undefined,
        semanticSearchState: {
          provider,
          settings: { provider: "native" },
          nativeIndexBuildInProgress: false,
          ...state,
        },
      } as unknown as McpToolsPlugin,
      pluginVersion: "0.0.0-test",
    });
    const result = (await registry.dispatch(
      { name: "search_vault_smart", arguments: { query: "anything" } },
      {} as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    return {
      isError: result.isError,
      body: JSON.parse(result.content[0].text) as Record<string, unknown>,
    };
  }

  /**
   * What the shared handler gets from a failing provider, and what the client
   * may read of it: the code the message starts with, never any other part.
   */
  test.each([
    {
      name: "a cache path with a space",
      message:
        "EACCES: permission denied, open '/home/jane/Private Cache/obsidian-mcp-connector/models/Xenova/all-MiniLM-L6-v2/config.json'",
      code: "EACCES",
      leaked: ["Private", "Cache", "jane", "Xenova", "config.json", "/home"],
    },
    {
      name: "a Windows path with a space",
      message:
        "EPERM: operation not permitted, open 'C:\\Users\\Jane Doe\\AppData\\Local\\cache\\models\\config.json'",
      code: "EPERM",
      leaked: ["Jane", "Doe", "AppData", "Users", "config.json", "C:"],
    },
    {
      name: "a file URL",
      message:
        "Cannot find module 'file:///tmp/cache/models/config.mjs' imported from /tmp/cache/x.js",
      code: undefined,
      leaked: ["file:", "tmp", "cache", "models", "config.mjs", "module"],
    },
    {
      name: "a message with no code and a path",
      message: "failed to read the model next to /srv/secret dir/models",
      code: undefined,
      leaked: ["srv", "secret", "models", "failed to read"],
    },
  ])(
    "a search that fails on $name tells the client the failure and nothing else",
    async ({ message, code, leaked }) => {
      const logged: unknown[] = [];
      const spy = spyOn(logger, "error").mockImplementation(
        (_message: string, fields?: unknown) => {
          logged.push(fields);
        },
      );
      try {
        const { isError, body } = await smartSearch({
          isReady: () => true,
          search: async () => {
            throw Object.assign(new Error(message), code ? { code } : {});
          },
        });
        expect(isError).toBe(true);
        expect(body.errorCode).toBe("semantic_search_failed");
        expect(body.error).toBe(
          `Semantic search failed${code ? ` (${code})` : ""}. Details are in the server log.`,
        );
        for (const part of leaked)
          expect(JSON.stringify(body)).not.toContain(part);
        // The whole message stays with the operator.
        expect(logged).toEqual([
          { error: `Semantic search failed: ${message}` },
        ]);
      } finally {
        spy.mockRestore();
      }
    },
  );

  test("leaves the fields of an error that names no path as they are", async () => {
    const { body } = await smartSearch(
      { isReady: () => false, search: async () => Promise.reject() },
      { pendingProvider: "embedding-gemma" },
    );
    expect(body).toMatchObject({
      errorCode: "index_building",
      filesIndexed: 0,
      filesTotal: 0,
      percent: 0,
      retryAfterSeconds: null,
    });
    expect(String(body.error)).toContain('"embedding-gemma" index');
  });
});
