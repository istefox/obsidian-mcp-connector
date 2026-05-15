import { describe, expect, test, beforeEach } from "bun:test";
import {
  deleteActiveFileHandler,
  deleteActiveFileSchema,
} from "./deleteActiveFile";
import {
  mockApp,
  resetMockVault,
  setMockActiveFile,
  setMockFile,
  getMockTrashedPaths,
  getMockDeletedPaths,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("delete_active_file tool", () => {
  test("schema declares the tool name", () => {
    expect(deleteActiveFileSchema.get("name")?.toString()).toContain(
      "delete_active_file",
    );
  });

  test("trashes the active file via fileManager.trashFile, honouring the vault 'Deleted files' setting (not a permanent unlink)", async () => {
    setMockFile("Inbox/temp.md", "to be deleted");
    setMockActiveFile("Inbox/temp.md");
    const app = mockApp();

    const result = await deleteActiveFileHandler({ arguments: {}, app });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/ok|deleted/i);
    // After deletion, no active file
    expect(app.workspace.getActiveFile()).toBeNull();
    expect(getMockTrashedPaths()).toContain("Inbox/temp.md");
    expect(getMockDeletedPaths()).not.toContain("Inbox/temp.md");
  });

  test("returns error when no active file", async () => {
    setMockActiveFile(null);
    const result = await deleteActiveFileHandler({
      arguments: {},
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no active file/i);
  });
});
