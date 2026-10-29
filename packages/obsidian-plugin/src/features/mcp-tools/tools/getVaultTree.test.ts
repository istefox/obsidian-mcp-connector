import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockIgnored,
} from "$/test-setup";
import { getVaultTreeHandler, getVaultTreeSchema } from "./getVaultTree";

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

describe("get_vault_tree tool", () => {
  test("schema declares the tool name", () => {
    expect(getVaultTreeSchema.get("name")?.toString()).toContain(
      "get_vault_tree",
    );
  });

  test("empty vault returns the root node", async () => {
    const result = await getVaultTreeHandler({
      arguments: {},
      app: mockApp(),
    });

    expect(parse(result)).toEqual({
      root: {
        path: "",
        empty: true,
        children: [],
      },
      totalFolders: 1,
    });
  });

  test("builds the nested hierarchy and marks empty folders", async () => {
    addFolder("Projects/2026/Q2");
    addFolder("Projects/Empty");
    addFile("Projects/2026/a.md");
    addFile("root.md");

    const result = await getVaultTreeHandler({
      arguments: {},
      app: mockApp(),
    });

    expect(parse(result)).toEqual({
      root: {
        path: "",
        empty: false,
        children: [
          {
            path: "Projects",
            empty: false,
            children: [
              {
                path: "Projects/2026",
                empty: false,
                children: [
                  {
                    path: "Projects/2026/Q2",
                    empty: true,
                    children: [],
                  },
                ],
              },
              {
                path: "Projects/Empty",
                empty: true,
                children: [],
              },
            ],
          },
        ],
      },
      totalFolders: 5,
    });
  });

  test("includeFiles adds only direct child file names", async () => {
    addFolder("Projects/2026");
    addFile("Projects/a.md");
    addFile("Projects/2026/b.md");
    addFile("root.md");

    const result = await getVaultTreeHandler({
      arguments: { includeFiles: true },
      app: mockApp(),
    });
    const data = parse(result);

    expect(data.root.files).toEqual(["root.md"]);
    expect(data.root.children[0].files).toEqual(["a.md"]);
    expect(data.root.children[0].children[0].files).toEqual(["b.md"]);
  });

  test("caps returned file names at 2000 and reports filesTruncated", async () => {
    for (let i = 0; i < 2001; i++) addFile(`f-${i}.md`);

    const result = await getVaultTreeHandler({
      arguments: { includeFiles: true },
      app: mockApp(),
    });
    const data = parse(result);

    expect(data.root.files).toHaveLength(2000);
    expect(data.filesTruncated).toBe(true);
  });

  test("does not set filesTruncated at exactly 2000 file names", async () => {
    for (let i = 0; i < 2000; i++) addFile(`f-${i}.md`);

    const result = await getVaultTreeHandler({
      arguments: { includeFiles: true },
      app: mockApp(),
    });
    const data = parse(result);

    expect(data.root.files).toHaveLength(2000);
    expect(data.filesTruncated).toBeUndefined();
  });

  test("path scopes the tree to a subtree", async () => {
    addFolder("Projects/2026");
    addFolder("Other");

    const result = await getVaultTreeHandler({
      arguments: { path: "Projects/" },
      app: mockApp(),
    });
    const data = parse(result);

    expect(data.root).toMatchObject({
      path: "Projects",
    });
    expect(data.root.children.map((c: { path: string }) => c.path)).toEqual([
      "Projects/2026",
    ]);
    expect(data.totalFolders).toBe(2);
  });

  test("depth limits the returned levels", async () => {
    addFolder("A/B/C");

    const rootOnly = await getVaultTreeHandler({
      arguments: { depth: 0 },
      app: mockApp(),
    });
    const oneLevel = await getVaultTreeHandler({
      arguments: { depth: 1 },
      app: mockApp(),
    });

    expect(parse(rootOnly).root.children).toEqual([]);
    expect(parse(rootOnly).totalFolders).toBe(4);
    expect(parse(oneLevel).root.children[0].path).toBe("A");
    expect(parse(oneLevel).root.children[0].children).toEqual([]);
  });

  test("limit caps folder nodes and reports truncation", async () => {
    addFolder("A");
    addFolder("B");
    addFolder("C");

    const capped = await getVaultTreeHandler({
      arguments: { limit: 2 },
      app: mockApp(),
    });
    const exact = await getVaultTreeHandler({
      arguments: { limit: 4 },
      app: mockApp(),
    });

    expect(
      parse(capped).root.children.map((c: { path: string }) => c.path),
    ).toEqual(["A"]);
    expect(parse(capped).truncated).toBe(true);
    expect(parse(capped).totalFolders).toBe(4);
    expect(parse(exact).truncated).toBeUndefined();
  });

  test("defaults to 200 folder nodes including the root", async () => {
    for (let i = 0; i < 250; i++) addFolder(`F-${i}`);

    const result = await getVaultTreeHandler({
      arguments: {},
      app: mockApp(),
    });
    const data = parse(result);

    expect(data.root.children).toHaveLength(199);
    expect(data.truncated).toBe(true);
    expect(data.totalFolders).toBe(251);
  });

  test("nodes carry the full path and no separate name", async () => {
    addFolder("Projects/2026");

    const result = await getVaultTreeHandler({
      arguments: {},
      app: mockApp(),
    });
    const data = parse(result);

    expect(Object.keys(data.root.children[0].children[0]).sort()).toEqual([
      "children",
      "empty",
      "path",
    ]);
    expect(data.root.children[0].children[0].path).toBe("Projects/2026");
  });

  test("an excluded file is hidden and does not fill its folder", async () => {
    addFolder("Notes");
    addFile("Notes/a.md");
    setMockIgnored("Notes/a.md");

    const result = await getVaultTreeHandler({
      arguments: { includeFiles: true },
      app: mockApp(),
    });
    const data = parse(result);

    expect(data.root.children[0]).toMatchObject({
      path: "Notes",
      empty: true,
      files: [],
    });
  });

  test("an excluded folder hides its descendants", async () => {
    addFolder("Secret/Public");
    addFile("Secret/Public/a.md");
    setMockIgnored("Secret");

    const result = await getVaultTreeHandler({
      arguments: {},
      app: mockApp(),
    });

    expect(parse(result)).toEqual({
      root: {
        path: "",
        empty: true,
        children: [],
      },
      totalFolders: 1,
    });
  });

  test("reports a missing path", async () => {
    const result = await getVaultTreeHandler({
      arguments: { path: "Missing" },
      app: mockApp(),
    });

    expect(result.isError).toBe(true);
    expect(parse(result).errorCode).toBe("folder_not_found");
  });

  test("reports a file path as not a directory", async () => {
    addFile("note.md");

    const result = await getVaultTreeHandler({
      arguments: { path: "note.md" },
      app: mockApp(),
    });

    expect(result.isError).toBe(true);
    expect(parse(result).errorCode).toBe("not_a_directory");
  });

  test("treats a trailing slash as the same path", async () => {
    addFolder("Projects/2026");

    const withoutSlash = await getVaultTreeHandler({
      arguments: { path: "Projects" },
      app: mockApp(),
    });
    const withSlash = await getVaultTreeHandler({
      arguments: { path: "Projects/" },
      app: mockApp(),
    });

    expect(parse(withSlash)).toEqual(parse(withoutSlash));
  });
});
