import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockIgnored,
} from "$/test-setup";
import {
  listVaultFoldersHandler,
  listVaultFoldersSchema,
} from "./listVaultFolders";

beforeEach(() => resetMockVault());

function addFolder(path: string): void {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    setMockFolder(parts.slice(0, i).join("/"));
  }
}

function addFile(path: string, content = ""): void {
  const slash = path.lastIndexOf("/");
  if (slash !== -1) addFolder(path.slice(0, slash));
  setMockFile(path, content);
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("list_vault_folders tool", () => {
  test("schema declares the tool name", () => {
    expect(listVaultFoldersSchema.get("name")?.toString()).toContain(
      "list_vault_folders",
    );
  });

  test("empty vault returns an empty page", async () => {
    const result = await listVaultFoldersHandler({
      arguments: {},
      app: mockApp(),
    });

    expect(parse(result)).toEqual({ folders: [], total: 0, offset: 0 });
  });

  test("returns only direct children by default", async () => {
    addFolder("Projects/2026/Q2");
    addFolder("Daily");

    const result = await listVaultFoldersHandler({
      arguments: {},
      app: mockApp(),
    });

    expect(parse(result).folders).toEqual([
      { path: "Daily", empty: true },
      { path: "Projects", empty: false },
    ]);
    expect(parse(result).total).toBe(2);
  });

  test("recursive returns the whole subtree without the directory itself", async () => {
    addFolder("Projects/2026/Q2");

    const result = await listVaultFoldersHandler({
      arguments: { directory: "Projects", recursive: true },
      app: mockApp(),
    });

    expect(parse(result).folders).toEqual([
      { path: "Projects/2026", empty: false },
      { path: "Projects/2026/Q2", empty: true },
    ]);
  });

  test("directory scopes the listing to direct children", async () => {
    addFolder("Projects/2026/Q2");
    addFolder("Daily");

    const result = await listVaultFoldersHandler({
      arguments: { directory: "Projects" },
      app: mockApp(),
    });

    expect(parse(result).folders).toEqual([
      { path: "Projects/2026", empty: false },
    ]);
  });

  test("marks a folder with only files as non-empty", async () => {
    addFile("WithFile/a.md");

    const result = await listVaultFoldersHandler({
      arguments: {},
      app: mockApp(),
    });

    expect(parse(result).folders).toEqual([{ path: "WithFile", empty: false }]);
  });

  test("an excluded file does not make its folder non-empty", async () => {
    addFile("Hidden/a.md");
    setMockIgnored("Hidden/a.md");

    const result = await listVaultFoldersHandler({
      arguments: {},
      app: mockApp(),
    });

    expect(parse(result).folders).toEqual([{ path: "Hidden", empty: true }]);
  });

  test("an excluded folder hides its descendants", async () => {
    addFolder("Secret/Public");
    addFile("Secret/Public/a.md");
    setMockIgnored("Secret/");

    const result = await listVaultFoldersHandler({
      arguments: {},
      app: mockApp(),
    });

    expect(parse(result)).toEqual({ folders: [], total: 0, offset: 0 });
  });

  test("reports a missing directory", async () => {
    const result = await listVaultFoldersHandler({
      arguments: { directory: "Missing" },
      app: mockApp(),
    });

    expect(result.isError).toBe(true);
    expect(parse(result).errorCode).toBe("folder_not_found");
  });

  test("reports a file path as not a directory", async () => {
    addFile("note.md");

    const result = await listVaultFoldersHandler({
      arguments: { directory: "note.md" },
      app: mockApp(),
    });

    expect(result.isError).toBe(true);
    expect(parse(result).errorCode).toBe("not_a_directory");
  });

  test("supports offset and limit and reports truncation", async () => {
    addFolder("A");
    addFolder("B");
    addFolder("C");

    const result = await listVaultFoldersHandler({
      arguments: { offset: 1, limit: 1 },
      app: mockApp(),
    });

    expect(parse(result)).toEqual({
      folders: [{ path: "B", empty: true }],
      total: 3,
      offset: 1,
      truncated: true,
    });
  });

  test("treats a trailing slash as the same directory", async () => {
    addFolder("Notes/Sub");

    const withoutSlash = await listVaultFoldersHandler({
      arguments: { directory: "Notes" },
      app: mockApp(),
    });
    const withSlash = await listVaultFoldersHandler({
      arguments: { directory: "Notes/" },
      app: mockApp(),
    });

    expect(parse(withSlash)).toEqual(parse(withoutSlash));
  });
});
