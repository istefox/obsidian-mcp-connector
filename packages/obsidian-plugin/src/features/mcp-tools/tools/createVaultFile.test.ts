import { describe, expect, test, beforeEach } from "bun:test";
import {
  createVaultFileHandler,
  createVaultFileSchema,
} from "./createVaultFile";
import {
  getMockFolders,
  mockApp,
  mockPlugin,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("create_vault_file tool", () => {
  test("schema declares the tool name", () => {
    expect(createVaultFileSchema.get("name")?.toString()).toContain(
      "create_vault_file",
    );
  });

  test("creates new file at root path", async () => {
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: { path: "note.md", content: "# Hi" },
      app,
    });
    expect(result.isError).toBeUndefined();
    const file = app.vault.getAbstractFileByPath("note.md");
    expect(file).not.toBeNull();
    expect(await app.vault.read(file as never)).toBe("# Hi");
  });

  test("auto-creates single-level missing parent directory (#86)", async () => {
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: { path: "New/note.md", content: "# Hi" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toContain("New");
    const file = app.vault.getAbstractFileByPath("New/note.md");
    expect(file).not.toBeNull();
    expect(await app.vault.read(file as never)).toBe("# Hi");
  });

  test("auto-creates multi-level missing parent chain (#86)", async () => {
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: { path: "A/B/C/deep.md", content: "deep" },
      app,
    });
    expect(result.isError).toBeUndefined();
    // Every ancestor was created in order, root-first.
    expect(getMockFolders()).toEqual(["A", "A/B", "A/B/C"]);
    const file = app.vault.getAbstractFileByPath("A/B/C/deep.md");
    expect(file).not.toBeNull();
  });

  test("partial existing chain — only creates the missing tail (#86)", async () => {
    setMockFolder("A");
    setMockFolder("A/B");
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: { path: "A/B/C/note.md", content: "hi" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual(["A", "A/B", "A/B/C"]);
  });

  test("idempotent when parent already exists (no createFolder call needed)", async () => {
    setMockFolder("Existing");
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: { path: "Existing/note.md", content: "x" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual(["Existing"]);
  });

  test("FIX 5: returns isError (does not throw) when path is a folder", async () => {
    setMockFolder("Notes");
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: { path: "Notes", content: "x" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/folder, not a file/i);
  });

  test("overwrites existing file when target exists", async () => {
    setMockFile("a.md", "OLD");
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: { path: "a.md", content: "NEW" },
      app,
    });
    expect(result.isError).toBeUndefined();
    const file = app.vault.getAbstractFileByPath("a.md");
    expect(await app.vault.read(file as never)).toBe("NEW");
  });
});

describe("create_vault_file — expectedContent write precondition (ADR-0022)", () => {
  const FILE = "Notes/precond.md";
  const ORIGINAL = "what the human just wrote";

  /** Reads the file back through the vault, so assertions are about disk. */
  async function readBack(app: ReturnType<typeof mockApp>): Promise<string> {
    const file = app.vault.getAbstractFileByPath(FILE);
    return await app.vault.read(file as never);
  }

  function expectStalePrecondition(result: {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }): void {
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as {
      error: string;
      errorCode: string;
      path: string;
    };
    expect(parsed.errorCode).toBe("stale_precondition");
    expect(parsed.path).toBe(FILE);
  }

  test("path does not exist, expectedContent absent: creates (unchanged)", async () => {
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: { path: FILE, content: "brand new" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(await readBack(app)).toBe("brand new");
  });

  test('path does not exist, expectedContent "": creates', async () => {
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: { path: FILE, content: "brand new", expectedContent: "" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(await readBack(app)).toBe("brand new");
  });

  test("path does not exist, expectedContent non-empty: refused, nothing written", async () => {
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: {
        path: FILE,
        content: "brand new",
        expectedContent: "I thought this was already here",
      },
      app,
    });
    expectStalePrecondition(result);
    expect(app.vault.getAbstractFileByPath(FILE)).toBeNull();
  });

  test("path exists, expectedContent absent, toggle off: overwrites (unchanged)", async () => {
    setMockFile(FILE, ORIGINAL);
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: { path: FILE, content: "new content" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(await readBack(app)).toBe("new content");
  });

  test("path exists, expectedContent absent, toggle on: refused, file byte-identical after", async () => {
    setMockFile(FILE, ORIGINAL);
    const app = mockApp();
    const plugin = mockPlugin({
      app,
      loadData: async () => ({ mcpTools: { requireWritePreconditions: true } }),
    } as never);
    const result = await createVaultFileHandler({
      arguments: { path: FILE, content: "new content" },
      app,
      plugin,
    });
    expectStalePrecondition(result);
    expect(result.content[0].text).toContain("requires a write precondition");
    expect(await readBack(app)).toBe(ORIGINAL);
  });

  test("path exists, expectedContent matches: overwrites", async () => {
    setMockFile(FILE, ORIGINAL);
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: {
        path: FILE,
        content: "new content",
        expectedContent: ORIGINAL,
      },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(await readBack(app)).toBe("new content");
  });

  test("a matching expectation survives CRLF and trailing-space drift", async () => {
    setMockFile(FILE, ORIGINAL);
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: {
        path: FILE,
        content: "new content",
        expectedContent: `${ORIGINAL}  \r\n`,
      },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(await readBack(app)).toBe("new content");
  });

  test("path exists, expectedContent mismatches: refused, file byte-identical after", async () => {
    setMockFile(FILE, ORIGINAL);
    const app = mockApp();
    const result = await createVaultFileHandler({
      arguments: {
        path: FILE,
        content: "the agent's stale rewrite",
        expectedContent: "what the agent read ten minutes ago",
      },
      app,
    });
    expectStalePrecondition(result);
    expect(await readBack(app)).toBe(ORIGINAL);
  });

  test("with the setting on, a correct expectation still writes", async () => {
    setMockFile(FILE, ORIGINAL);
    const app = mockApp();
    const plugin = mockPlugin({
      app,
      loadData: async () => ({ mcpTools: { requireWritePreconditions: true } }),
    } as never);
    const result = await createVaultFileHandler({
      arguments: {
        path: FILE,
        content: "new content",
        expectedContent: ORIGINAL,
      },
      app,
      plugin,
    });
    expect(result.isError).toBeUndefined();
    expect(await readBack(app)).toBe("new content");
  });
});
