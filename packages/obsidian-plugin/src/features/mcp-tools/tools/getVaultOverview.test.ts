import { describe, expect, test, beforeEach } from "bun:test";
import {
  getVaultOverviewHandler,
  getVaultOverviewSchema,
} from "./getVaultOverview";
import {
  mockApp,
  resetMockVault,
  setMockActiveFile,
  setMockFile,
  setMockIgnored,
  setMockTags,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_vault_overview tool", () => {
  test("schema declares the tool name", () => {
    expect(getVaultOverviewSchema.get("name")?.toString()).toContain(
      "get_vault_overview",
    );
  });

  test("empty vault returns an all-empty snapshot", async () => {
    const result = await getVaultOverviewHandler({
      arguments: {},
      app: mockApp(),
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({
      activeFile: null,
      totalNotes: 0,
      topFolders: [],
      topTags: [],
      recentFiles: [],
    });
  });

  test("activeFile reflects the currently active note", async () => {
    setMockFile("a.md", "# A");
    setMockActiveFile("a.md");
    const result = await getVaultOverviewHandler({
      arguments: {},
      app: mockApp(),
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.activeFile).toBe("a.md");
  });

  test("totalNotes and topFolders count markdown files only", async () => {
    setMockFile("Projects/a.md", "# A");
    setMockFile("Projects/b.md", "# B");
    setMockFile("Daily/c.md", "# C");
    setMockFile("root.md", "# Root");
    setMockFile("attachments/img.png", "fake-bytes");
    const result = await getVaultOverviewHandler({
      arguments: {},
      app: mockApp(),
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.totalNotes).toBe(4);
    expect(parsed.topFolders).toEqual([
      { folder: "Projects", count: 2 },
      { folder: "(root)", count: 1 },
      { folder: "Daily", count: 1 },
    ]);
  });

  test("topFolders sorts by count desc with alphabetical tiebreak", async () => {
    setMockFile("Zeta/a.md", "# A");
    setMockFile("Alpha/b.md", "# B");
    const result = await getVaultOverviewHandler({
      arguments: {},
      app: mockApp(),
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.topFolders).toEqual([
      { folder: "Alpha", count: 1 },
      { folder: "Zeta", count: 1 },
    ]);
  });

  test("topTags respects the default and an explicit limit override", async () => {
    setMockTags({ "#a": 3, "#b": 7, "#c": 1 });
    const defaultResult = await getVaultOverviewHandler({
      arguments: {},
      app: mockApp(),
    });
    const defaultParsed = JSON.parse(
      (defaultResult.content[0] as { text: string }).text,
    );
    expect(defaultParsed.topTags).toEqual([
      { tag: "#b", count: 7 },
      { tag: "#a", count: 3 },
      { tag: "#c", count: 1 },
    ]);

    const limitedResult = await getVaultOverviewHandler({
      arguments: { topTagsLimit: 1 },
      app: mockApp(),
    });
    const limitedParsed = JSON.parse(
      (limitedResult.content[0] as { text: string }).text,
    );
    expect(limitedParsed.topTags).toEqual([{ tag: "#b", count: 7 }]);
  });

  test("recentFiles respects isUserIgnored exclusion and its limit override", async () => {
    setMockFile("a.md", "# A");
    setMockFile("b.md", "# B");
    setMockIgnored("b.md");
    const result = await getVaultOverviewHandler({
      arguments: { recentFilesLimit: 1 },
      app: mockApp(),
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.recentFiles).toHaveLength(1);
    expect(parsed.recentFiles[0].path).toBe("a.md");
  });
});
