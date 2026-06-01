import { describe, expect, test, beforeEach } from "bun:test";
import { searchVaultHandler, searchVaultSchema } from "./searchVault";
import {
  mockApp,
  resetMockVault,
  setMockDataviewState,
  setMockDataviewQueryImpl,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("search_vault tool", () => {
  test("schema declares the tool name", () => {
    expect(searchVaultSchema.get("name")?.toString()).toContain("search_vault");
  });

  // DQL path — delegates to executeDataviewQueryHandler in-process

  test("DQL: returns error when Dataview is not installed", async () => {
    setMockDataviewState("absent");
    const result = await searchVaultHandler({
      arguments: { query: 'TABLE FROM "Notes"' },
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/dataview_not_installed/i);
  });

  test("DQL: returns Dataview query result on success", async () => {
    setMockDataviewState("ready");
    setMockDataviewQueryImpl(async () => ({
      successful: true,
      value: { type: "table", headers: ["File"], values: [["note.md"]] },
    }));
    const result = await searchVaultHandler({
      arguments: { query: "TABLE FROM #tag" },
      app: mockApp(),
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text as string);
    expect(data.type).toBe("table");
    expect(data.headers).toEqual(["File"]);
  });

  // JsonLogic path — native MetadataCache iteration

  test("JsonLogic: returns error on invalid (non-JSON) rule", async () => {
    const result = await searchVaultHandler({
      arguments: { query: "not valid json", queryType: "jsonlogic" },
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/json/i);
  });

  test("JsonLogic: returns only files matching the frontmatter filter", async () => {
    setMockFile("notes/active.md", "content");
    setMockMetadata("notes/active.md", {
      frontmatter: { status: "active" },
      tags: [],
    });
    setMockFile("notes/archived.md", "content");
    setMockMetadata("notes/archived.md", {
      frontmatter: { status: "archived" },
      tags: [],
    });

    const result = await searchVaultHandler({
      arguments: {
        query: JSON.stringify({
          "==": [{ var: "frontmatter.status" }, "active"],
        }),
        queryType: "jsonlogic",
      },
      app: mockApp(),
    });

    expect(result.isError).toBeUndefined();
    const matches = JSON.parse(result.content[0].text as string) as Array<{
      path: string;
    }>;
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe("notes/active.md");
  });

  test("JsonLogic: returns all files when rule matches all", async () => {
    setMockFile("a.md", "");
    setMockFile("b.md", "");

    const result = await searchVaultHandler({
      arguments: {
        query: JSON.stringify(true),
        queryType: "jsonlogic",
      },
      app: mockApp(),
    });

    expect(result.isError).toBeUndefined();
    const matches = JSON.parse(result.content[0].text as string) as Array<{
      path: string;
    }>;
    expect(matches).toHaveLength(2);
  });
});
