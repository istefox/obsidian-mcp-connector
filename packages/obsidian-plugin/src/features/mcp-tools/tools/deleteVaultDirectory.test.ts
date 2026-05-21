import { describe, expect, test, beforeEach } from "bun:test";
import {
  deleteVaultDirectoryHandler,
  deleteVaultDirectorySchema,
} from "./deleteVaultDirectory";
import {
  getMockFolders,
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("delete_vault_directory tool", () => {
  test("schema declares the tool name", () => {
    expect(deleteVaultDirectorySchema.get("name")?.toString()).toContain(
      "delete_vault_directory",
    );
  });

  test("deletes an empty directory (default recursive=false)", async () => {
    setMockFolder("Empty");
    const app = mockApp();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "Empty" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual([]);
  });

  test("fails on non-empty directory when recursive=false", async () => {
    setMockFolder("Notes");
    setMockFile("Notes/a.md", "x");
    const app = mockApp();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "Notes" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not empty/i);
    // Folder + file must still be there.
    expect(getMockFolders()).toEqual(["Notes"]);
    expect(app.vault.getAbstractFileByPath("Notes/a.md")).not.toBeNull();
  });

  test("recursive=true removes folder, child folders, and child files", async () => {
    setMockFolder("Archive");
    setMockFolder("Archive/2025");
    setMockFolder("Archive/2025/Q1");
    setMockFile("Archive/2025/old.md", "");
    setMockFile("Archive/2025/Q1/note.md", "");
    const app = mockApp();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "Archive", recursive: "true" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual([]);
    expect(app.vault.getAbstractFileByPath("Archive/2025/old.md")).toBeNull();
    expect(
      app.vault.getAbstractFileByPath("Archive/2025/Q1/note.md"),
    ).toBeNull();
  });

  test("returns error if directory does not exist", async () => {
    const app = mockApp();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "ghost" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/failed to delete/i);
  });

  test("rejects when path is a file (use delete_vault_file instead)", async () => {
    setMockFile("note.md", "");
    const app = mockApp();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "note.md" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/delete_vault_file/);
  });

  test("rejects empty / root path", async () => {
    const app = mockApp();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "/" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/empty/i);
  });

  test("trims leading and trailing slashes", async () => {
    setMockFolder("Trash");
    const app = mockApp();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "/Trash/" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual([]);
  });

  // Test-as-spec: locks in the current behavior on path-traversal input.
  // Today the handler does NOT sanitise '..' segments — it forwards the
  // trimmed path to vault.adapter.rmdir. The mock raises ENOENT because no
  // folder named '../escape' exists; on a real adapter the call would either
  // resolve outside the vault root or fail with a permission error. Either
  // way, no implicit accept-and-delete occurs, but a future explicit
  // traversal-rejection branch should surface here rather than silently.
  test("documents current behavior on path traversal '../escape'", async () => {
    const app = mockApp();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "../escape" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/failed to delete/i);
  });

  // Regression guard for #88 — the ENOTEMPTY branch must produce a
  // vault-relative, caller-actionable message and never bubble the
  // absolute filesystem path that Node's `fs.rmdir` embeds in its
  // error message (which would expose $HOME / cloud-sync identifiers
  // / vault folder name to the MCP client).
  test("ENOTEMPTY error is errno-keyed and suppresses the absolute host path", async () => {
    setMockFolder("Notes");
    setMockFile("Notes/a.md", "x");
    const app = mockApp();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "Notes" },
      app,
    });
    expect(result.isError).toBe(true);
    // Errno-keyed actionable shape: the caller learns that recursive=true
    // is the way out.
    expect(result.content[0].text).toContain('use recursive: "true"');
    // No absolute-path trailer ("rmdir '<abs>'" segment from Node).
    expect(result.content[0].text).not.toContain("rmdir '");
    // Belt-and-suspenders: no obvious absolute-path indicators of any
    // platform shape (macOS, Linux, Windows).
    expect(result.content[0].text).not.toMatch(/\/Users\/|\/home\/|C:\\/);
  });

  // Sister regression guard: the ENOENT branch was already vault-relative
  // in spirit (mock used the `<vault>/${path}` placeholder) but with a
  // realistic absolute-path mock the handler must still suppress the
  // trailer.
  test("ENOENT error is errno-keyed and suppresses the absolute host path", async () => {
    const app = mockApp();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "ghost" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not exist");
    expect(result.content[0].text).not.toContain("rmdir '");
    expect(result.content[0].text).not.toMatch(/\/Users\/|\/home\/|C:\\/);
  });

  // Covers the `String(e)` branch of `e instanceof Error ? e.message : String(e)`.
  // Existing tests only trigger the Error-class branch (rmdir throws an Error
  // with ENOENT/ENOTEMPTY). A real adapter could reject with a non-Error value
  // (e.g. a raw string from a native binding); without this test that branch
  // is dead code from the test runner's perspective.
  test("surfaces non-Error thrown values from rmdir", async () => {
    setMockFolder("locked");
    const app = mockApp();
    // Override the mock adapter's rmdir to throw a non-Error value.
    (
      app.vault.adapter as unknown as {
        rmdir: (path: string, recursive: boolean) => Promise<void>;
      }
    ).rmdir = async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "raw string rejection from native binding";
    };
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: "locked" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "raw string rejection from native binding",
    );
  });
});
