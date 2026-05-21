import { describe, expect, test, beforeEach } from "bun:test";
import { listVaultFilesHandler, listVaultFilesSchema } from "./listVaultFiles";
import { mockApp, resetMockVault, setMockFile } from "$/test-setup";

beforeEach(() => resetMockVault());

describe("list_vault_files tool", () => {
  test("schema declares the tool name", () => {
    expect(listVaultFilesSchema.get("name")?.toString()).toContain(
      "list_vault_files",
    );
  });

  test("returns all files when no directory specified", async () => {
    setMockFile("a.md", "");
    setMockFile("Notes/b.md", "");
    setMockFile("Notes/sub/c.md", "");

    const result = await listVaultFilesHandler({
      arguments: {},
      app: mockApp(),
    });

    const data = JSON.parse(result.content[0].text as string);
    expect(data.files).toHaveLength(3);
    expect(data.files).toContain("a.md");
    expect(data.files).toContain("Notes/b.md");
    expect(data.files).toContain("Notes/sub/c.md");
  });

  test("filters by directory prefix when specified", async () => {
    setMockFile("a.md", "");
    setMockFile("Notes/b.md", "");
    setMockFile("Notes/sub/c.md", "");

    const result = await listVaultFilesHandler({
      arguments: { directory: "Notes" },
      app: mockApp(),
    });

    const data = JSON.parse(result.content[0].text as string);
    expect(data.files).toContain("Notes/b.md");
    expect(data.files).toContain("Notes/sub/c.md");
    expect(data.files).not.toContain("a.md");
  });

  test("returns empty array when no files match", async () => {
    setMockFile("a.md", "");
    const result = await listVaultFilesHandler({
      arguments: { directory: "Empty" },
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.files).toEqual([]);
  });

  test("treats trailing slash on directory as same prefix", async () => {
    setMockFile("Notes/x.md", "");
    const r1 = await listVaultFilesHandler({
      arguments: { directory: "Notes" },
      app: mockApp(),
    });
    const r2 = await listVaultFilesHandler({
      arguments: { directory: "Notes/" },
      app: mockApp(),
    });
    expect(JSON.parse(r1.content[0].text as string).files).toEqual(
      JSON.parse(r2.content[0].text as string).files,
    );
  });
});
