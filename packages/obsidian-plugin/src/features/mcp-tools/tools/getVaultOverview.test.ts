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
  setMockMetadata,
  setMockTags,
} from "$/test-setup";
import { createGuardedApp } from "$/shared/guardedApp";
import { compilePolicy } from "$/shared/pathPolicy";

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

  // ADR-0020 D10: topTags goes through the same getTagCounts rebuild as
  // list_tags, so a tag confined to an excluded folder must be absent
  // from the overview too, not present with count 0.
  test("topTags omits a tag confined to an excluded folder", async () => {
    setMockFile("Secret/canary.md", "secret body");
    setMockMetadata("Secret/canary.md", {
      tags: [{ tag: "#canary-secret" }],
    });
    setMockFile("Public/note.md", "public body");
    setMockMetadata("Public/note.md", { tags: [{ tag: "#project" }] });

    const guarded = createGuardedApp(mockApp(), () =>
      compilePolicy(["Secret"]),
    );
    const result = await getVaultOverviewHandler({
      arguments: {},
      app: guarded,
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    const tags = parsed.topTags.map((t: { tag: string }) => t.tag);
    expect(tags).not.toContain("#canary-secret");
    expect(tags).toContain("#project");
  });
});
