import { describe, expect, test, beforeEach } from "bun:test";
import {
  deleteVaultFileHandler,
  deleteVaultFileSchema,
} from "./deleteVaultFile";
import {
  mockApp,
  mockPlugin,
  resetMockVault,
  setMockFile,
  setMockFolder,
  getMockFolders,
  getMockTrashedPaths,
  getMockDeletedPaths,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("delete_vault_file tool", () => {
  test("schema declares the tool name", () => {
    expect(deleteVaultFileSchema.get("name")?.toString()).toContain(
      "delete_vault_file",
    );
  });

  test("deletes existing file", async () => {
    setMockFile("trash.md", "junk");
    const app = mockApp();
    const result = await deleteVaultFileHandler({
      arguments: { path: "trash.md" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(app.vault.getAbstractFileByPath("trash.md")).toBeNull();
  });

  test("routes deletion through fileManager.trashFile, honouring the vault 'Deleted files' setting (not a permanent unlink)", async () => {
    setMockFile("notes/keepme.md", "valuable");
    const app = mockApp();

    await deleteVaultFileHandler({
      arguments: { path: "notes/keepme.md" },
      app,
    });

    expect(getMockTrashedPaths()).toContain("notes/keepme.md");
    expect(getMockDeletedPaths()).not.toContain("notes/keepme.md");
  });

  test("returns error when path not found", async () => {
    const app = mockApp();
    const result = await deleteVaultFileHandler({
      arguments: { path: "nope.md" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  test("refuses a folder path: directories go through delete_vault_directory", async () => {
    setMockFolder("Archive");
    setMockFile("Archive/a.md", "x");
    const app = mockApp();
    const result = await deleteVaultFileHandler({
      arguments: { path: "Archive" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not_a_file");
    expect(result.content[0].text).toContain("delete_vault_directory");
    expect(getMockFolders()).toEqual(["Archive"]);
    expect(app.vault.getAbstractFileByPath("Archive/a.md")).not.toBeNull();
    expect(getMockTrashedPaths()).toEqual([]);
  });

  test("expectedContent matching the file: deletes", async () => {
    setMockFile("notes/a.md", "hello\n");
    const app = mockApp();
    const result = await deleteVaultFileHandler({
      arguments: { path: "notes/a.md", expectedContent: "hello\n" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(app.vault.getAbstractFileByPath("notes/a.md")).toBeNull();
  });

  test("expectedContent mismatch: refuses with stale_precondition and keeps the file", async () => {
    setMockFile("notes/a.md", "hello, edited since\n");
    const app = mockApp();
    const result = await deleteVaultFileHandler({
      arguments: { path: "notes/a.md", expectedContent: "hello\n" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("stale_precondition");
    expect(result.content[0].text).toContain("get_vault_file");
    expect(app.vault.getAbstractFileByPath("notes/a.md")).not.toBeNull();
    expect(getMockTrashedPaths()).toEqual([]);
  });

  test("requireWritePreconditions on: refuses a delete without expectedContent", async () => {
    setMockFile("notes/a.md", "x");
    const plugin = mockPlugin({
      loadData: async () => ({ mcpTools: { requireWritePreconditions: true } }),
    });
    const result = await deleteVaultFileHandler({
      arguments: { path: "notes/a.md" },
      app: plugin.app,
      plugin,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("stale_precondition");
    expect(result.content[0].text).toMatch(/expectedContent/);
    expect(plugin.app.vault.getAbstractFileByPath("notes/a.md")).not.toBeNull();
  });

  test("requireWritePreconditions on: deletes when expectedContent matches", async () => {
    setMockFile("notes/a.md", "x");
    const plugin = mockPlugin({
      loadData: async () => ({ mcpTools: { requireWritePreconditions: true } }),
    });
    const result = await deleteVaultFileHandler({
      arguments: { path: "notes/a.md", expectedContent: "x" },
      app: plugin.app,
      plugin,
    });
    expect(result.isError).toBeUndefined();
    expect(plugin.app.vault.getAbstractFileByPath("notes/a.md")).toBeNull();
  });
});
