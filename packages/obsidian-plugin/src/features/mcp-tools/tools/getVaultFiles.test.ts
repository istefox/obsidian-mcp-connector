import { describe, expect, test, beforeEach } from "bun:test";
import { getVaultFilesHandler, getVaultFilesSchema } from "./getVaultFiles";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_vault_files tool", () => {
  test("schema declares the tool name", () => {
    expect(getVaultFilesSchema.get("name")?.toString()).toContain(
      "get_vault_files",
    );
  });

  test("returns one text result per path, in input order", async () => {
    setMockFile("a.md", "# A");
    setMockFile("b.md", "# B");
    const result = await getVaultFilesHandler({
      arguments: { paths: ["b.md", "a.md"] },
      app: mockApp(),
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.results).toEqual([
      { path: "b.md", content: "# B" },
      { path: "a.md", content: "# A" },
    ]);
  });

  test("format=json returns content+frontmatter+tags+stat per file", async () => {
    setMockFile("a.md", "---\ntags: [foo]\n---\n# Body");
    setMockMetadata("a.md", { frontmatter: { tags: ["foo"] } });
    const result = await getVaultFilesHandler({
      arguments: { paths: ["a.md"], format: "json" },
      app: mockApp(),
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].path).toBe("a.md");
    expect(parsed.results[0].frontmatter).toEqual({ tags: ["foo"] });
    expect(parsed.results[0].tags).toEqual(["foo"]);
    expect(parsed.results[0].stat).toEqual({
      ctime: 0,
      mtime: 0,
      size: "---\ntags: [foo]\n---\n# Body".length,
    });
  });

  test("a missing path becomes a per-entry error, batch still succeeds", async () => {
    setMockFile("a.md", "# A");
    const result = await getVaultFilesHandler({
      arguments: { paths: ["a.md", "missing.md"] },
      app: mockApp(),
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.results[0]).toEqual({ path: "a.md", content: "# A" });
    expect(parsed.results[1].reason).toBe("not_found");
    expect(parsed.results[1].error).toMatch(/not found/i);
  });

  test("a folder path becomes a not_a_file per-entry error", async () => {
    setMockFolder("Notes");
    const result = await getVaultFilesHandler({
      arguments: { paths: ["Notes"] },
      app: mockApp(),
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.results[0].reason).toBe("not_a_file");
  });

  test("a binary file becomes a binary_unsupported per-entry error", async () => {
    setMockFile("a.md", "# A");
    setMockFile("img/pic.png", "fake-png-bytes");
    const result = await getVaultFilesHandler({
      arguments: { paths: ["a.md", "img/pic.png"] },
      app: mockApp(),
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.results[0]).toEqual({ path: "a.md", content: "# A" });
    expect(parsed.results[1].reason).toBe("binary_unsupported");
    expect(parsed.results[1].error).toMatch(/get_vault_file/);
  });

  test("duplicate input path produces duplicate output entries", async () => {
    setMockFile("a.md", "# A");
    const result = await getVaultFilesHandler({
      arguments: { paths: ["a.md", "a.md"] },
      app: mockApp(),
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.results).toEqual([
      { path: "a.md", content: "# A" },
      { path: "a.md", content: "# A" },
    ]);
  });

  test("empty paths array is a top-level error", async () => {
    const result = await getVaultFilesHandler({
      arguments: { paths: [] },
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.errorCode).toBe("invalid_arguments");
  });

  test("more than 20 paths is a top-level error", async () => {
    const paths = Array.from({ length: 21 }, (_, i) => `note-${i}.md`);
    const result = await getVaultFilesHandler({
      arguments: { paths },
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.errorCode).toBe("too_many_paths");
    expect(parsed.received).toBe(21);
  });
});
