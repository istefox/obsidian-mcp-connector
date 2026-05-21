import { describe, expect, test, beforeEach } from "bun:test";
import {
  ensureFolderExists,
  ensureParentFolderExists,
} from "./ensureFolderExists";
import {
  getMockFolders,
  mockApp,
  resetMockVault,
  setMockFolder,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("ensureFolderExists", () => {
  test("no-op for empty path", async () => {
    const app = mockApp();
    await ensureFolderExists(app, "");
    expect(getMockFolders()).toEqual([]);
  });

  test("creates a single segment", async () => {
    const app = mockApp();
    await ensureFolderExists(app, "A");
    expect(getMockFolders()).toEqual(["A"]);
  });

  test("walks ancestors root-first and creates only missing ones", async () => {
    setMockFolder("A");
    const app = mockApp();
    await ensureFolderExists(app, "A/B/C");
    expect(getMockFolders()).toEqual(["A", "A/B", "A/B/C"]);
  });

  test("idempotent when folder already exists end-to-end", async () => {
    setMockFolder("X");
    setMockFolder("X/Y");
    const app = mockApp();
    await ensureFolderExists(app, "X/Y");
    expect(getMockFolders()).toEqual(["X", "X/Y"]);
  });

  test("trims spurious internal empty segments from double slashes", async () => {
    const app = mockApp();
    await ensureFolderExists(app, "A//B");
    expect(getMockFolders()).toEqual(["A", "A/B"]);
  });

  test("re-throws non-'already-exists' errors", async () => {
    const app = mockApp();
    // Override createFolder to throw a permissions error.
    (
      app.vault as unknown as { createFolder: (p: string) => Promise<void> }
    ).createFolder = async () => {
      throw new Error("EACCES: permission denied");
    };
    await expect(ensureFolderExists(app, "Locked")).rejects.toThrow(/EACCES/);
  });

  test("swallows 'Folder already exists' race", async () => {
    const app = mockApp();
    let calls = 0;
    (
      app.vault as unknown as { createFolder: (p: string) => Promise<void> }
    ).createFolder = async () => {
      calls++;
      throw new Error("Folder already exists: Race");
    };
    // getAbstractFileByPath returns null in the bare mock above, so the
    // helper will reach the createFolder call and must swallow the
    // already-exists error.
    await ensureFolderExists(app, "Race");
    expect(calls).toBe(1);
  });
});

describe("ensureParentFolderExists", () => {
  test("no-op for root-level file", async () => {
    const app = mockApp();
    await ensureParentFolderExists(app, "note.md");
    expect(getMockFolders()).toEqual([]);
  });

  test("creates parent directory chain for nested file path", async () => {
    const app = mockApp();
    await ensureParentFolderExists(app, "A/B/C/note.md");
    expect(getMockFolders()).toEqual(["A", "A/B", "A/B/C"]);
  });
});
