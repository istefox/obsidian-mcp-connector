import { describe, expect, test, beforeEach } from "bun:test";
import {
  appendToVaultFileHandler,
  appendToVaultFileSchema,
} from "./appendToVaultFile";
import {
  getMockFolders,
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("append_to_vault_file tool", () => {
  test("schema declares the tool name", () => {
    expect(appendToVaultFileSchema.get("name")?.toString()).toContain(
      "append_to_vault_file",
    );
  });

  test("appends to existing file with newline normalization", async () => {
    setMockFile("Notes/log.md", "Line1");
    const app = mockApp();
    const result = await appendToVaultFileHandler({
      arguments: { path: "Notes/log.md", content: "Line2" },
      app,
    });
    expect(result.isError).toBeUndefined();
    const file = app.vault.getAbstractFileByPath("Notes/log.md");
    if (!file) throw new Error("expected file");
    expect(await app.vault.read(file as never)).toBe("Line1Line2\n\n");
  });

  test("creates file at root if missing", async () => {
    const app = mockApp();
    const result = await appendToVaultFileHandler({
      arguments: { path: "empty.md", content: "First" },
      app,
    });
    expect(result.isError).toBeUndefined();
    const file = app.vault.getAbstractFileByPath("empty.md");
    expect(file).not.toBeNull();
    expect(await app.vault.read(file as never)).toBe("First\n\n");
  });

  test("auto-creates missing parent directories on the create branch (#86)", async () => {
    const app = mockApp();
    const result = await appendToVaultFileHandler({
      arguments: { path: "Logs/2026/05/today.md", content: "First" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual(["Logs", "Logs/2026", "Logs/2026/05"]);
    const file = app.vault.getAbstractFileByPath("Logs/2026/05/today.md");
    expect(file).not.toBeNull();
    expect(await app.vault.read(file as never)).toBe("First\n\n");
  });

  test("FIX 5: returns isError (does not throw) when path is a folder", async () => {
    setMockFolder("Logs");
    const app = mockApp();
    const result = await appendToVaultFileHandler({
      arguments: { path: "Logs", content: "x" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/folder, not a file/i);
  });

  test("does NOT call createFolder on the modify branch — folder set unchanged", async () => {
    setMockFolder("Notes");
    setMockFile("Notes/log.md", "Line1");
    const app = mockApp();
    await appendToVaultFileHandler({
      arguments: { path: "Notes/log.md", content: "Line2" },
      app,
    });
    expect(getMockFolders()).toEqual(["Notes"]);
  });

  // Regression guard for the lost-update race: the pre-fix handler did an
  // unserialized vault.read → vault.modify, so two concurrent appends to
  // the same file both read the same "before" and the last writer
  // discarded the other's line. vault.process + the vault write lock make
  // both survive.
  test("concurrent appends to the same file keep both updates", async () => {
    setMockFile("Notes/log.md", "start\n");
    const app = mockApp();
    const results = await Promise.all([
      appendToVaultFileHandler({
        arguments: { path: "Notes/log.md", content: "from-agent-A" },
        app,
      }),
      appendToVaultFileHandler({
        arguments: { path: "Notes/log.md", content: "from-agent-B" },
        app,
      }),
    ]);
    expect(results.every((r) => r.isError === undefined)).toBe(true);
    const file = app.vault.getAbstractFileByPath("Notes/log.md");
    const text = await app.vault.read(file as never);
    expect(text).toContain("from-agent-A");
    expect(text).toContain("from-agent-B");
  });

  test("concurrent appends to a MISSING file create once and keep both", async () => {
    const app = mockApp();
    const results = await Promise.all([
      appendToVaultFileHandler({
        arguments: { path: "fresh.md", content: "first" },
        app,
      }),
      appendToVaultFileHandler({
        arguments: { path: "fresh.md", content: "second" },
        app,
      }),
    ]);
    expect(results.every((r) => r.isError === undefined)).toBe(true);
    const file = app.vault.getAbstractFileByPath("fresh.md");
    const text = await app.vault.read(file as never);
    // Without the write lock both calls take the create branch and the
    // second create clobbers the first append.
    expect(text).toContain("first");
    expect(text).toContain("second");
  });
});
