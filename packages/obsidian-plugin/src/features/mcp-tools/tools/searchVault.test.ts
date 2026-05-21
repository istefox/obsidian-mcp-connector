import { describe, expect, test, beforeEach } from "bun:test";
import { searchVaultHandler, searchVaultSchema } from "./searchVault";
import {
  mockApp,
  mockPlugin,
  resetMockVault,
  setMockRequestUrl,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("search_vault tool", () => {
  test("schema declares the tool name", () => {
    expect(searchVaultSchema.get("name")?.toString()).toContain("search_vault");
  });

  test("returns informative error when Local REST API not available", async () => {
    const plugin = mockPlugin({
      localRestApi: {
        id: "obsidian-local-rest-api",
        name: "Local REST API",
        required: true,
        installed: false,
      },
      getLocalRestApiKey: () => undefined,
    } as never);
    const result = await searchVaultHandler({
      arguments: { query: 'TABLE FROM "Notes"' },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/local rest api|dataview|install/i);
  });

  test("delegates query to Local REST API when available", async () => {
    setMockRequestUrl("https://127.0.0.1:27124/search/", {
      status: 200,
      text: JSON.stringify([
        { filename: "a.md", result: { foo: 1 } },
        { filename: "b.md", result: { foo: 2 } },
      ]),
      headers: { "content-type": "application/json" },
    });
    const plugin = mockPlugin({
      localRestApi: {
        id: "obsidian-local-rest-api",
        name: "Local REST API",
        required: true,
        installed: true,
        api: {} as never, // truthy stub
      },
      getLocalRestApiKey: () => "fake-rest-api-key",
    } as never);

    const result = await searchVaultHandler({
      arguments: { query: 'TABLE FROM "Notes"' },
      app: mockApp(),
      plugin,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text as string);
    expect(
      Array.isArray(data) || (data.results && Array.isArray(data.results)),
    ).toBe(true);
  });

  // Fork issue #79: searchVault no longer hardcodes the LRA URL.
  // Routes through plugin.getLocalRestApiUrl() so a user with LRA on a
  // non-default port (e.g. 27124 occupied → LRA shifted to 27125) gets
  // a working tool instead of a hard connection error.
  test("routes the request through plugin.getLocalRestApiUrl()", async () => {
    setMockRequestUrl("https://127.0.0.1:27199/search/", {
      status: 200,
      text: JSON.stringify([{ filename: "x.md", result: { ok: true } }]),
      headers: { "content-type": "application/json" },
    });
    const plugin = mockPlugin({
      localRestApi: {
        id: "obsidian-local-rest-api",
        name: "Local REST API",
        required: true,
        installed: true,
        api: {} as never,
      },
      getLocalRestApiKey: () => "fake-rest-api-key",
      getLocalRestApiUrl: () => "https://127.0.0.1:27199",
    } as never);
    const result = await searchVaultHandler({
      arguments: { query: 'TABLE FROM "Notes"' },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBeUndefined();
    // Mock setup keys responses by URL — the assertion above only
    // succeeds if the handler dispatched against 27199, not 27124.
    const data = JSON.parse(result.content[0].text as string);
    expect(data[0]?.filename).toBe("x.md");
  });
});
