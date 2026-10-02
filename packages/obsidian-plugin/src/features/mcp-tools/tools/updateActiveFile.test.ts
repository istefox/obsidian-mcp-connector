import { describe, expect, test, beforeEach } from "bun:test";
import {
  updateActiveFileHandler,
  updateActiveFileSchema,
} from "./updateActiveFile";
import {
  mockApp,
  mockPlugin,
  resetMockVault,
  setMockActiveFile,
  setMockFile,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("update_active_file tool", () => {
  test("schema declares the tool name", () => {
    const name = updateActiveFileSchema.get("name");
    expect(name?.toString()).toContain("update_active_file");
  });

  test("replaces content of the active file", async () => {
    setMockFile("Inbox/note.md", "# Old");
    setMockActiveFile("Inbox/note.md");

    const app = mockApp();
    const result = await updateActiveFileHandler({
      arguments: { content: "# New content" },
      app,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/ok|updated/i);

    // Verify content changed
    const file = app.workspace.getActiveFile();
    if (!file) throw new Error("expected active file");
    expect(await app.vault.read(file)).toBe("# New content");
  });

  test("returns informative error when no active file", async () => {
    setMockActiveFile(null);
    const result = await updateActiveFileHandler({
      arguments: { content: "anything" },
      app: mockApp(),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no active file/i);
  });

  test("expectedContent mismatch: refuses with stale_precondition and keeps the content", async () => {
    setMockFile("Inbox/note.md", "# Edited by the user");
    setMockActiveFile("Inbox/note.md");
    const app = mockApp();
    const result = await updateActiveFileHandler({
      arguments: { content: "# New", expectedContent: "# Old" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("stale_precondition");
    expect(result.content[0].text).toContain("get_active_file");
    const file = app.workspace.getActiveFile();
    if (!file) throw new Error("expected active file");
    expect(await app.vault.read(file)).toBe("# Edited by the user");
  });

  test("expectedContent matching: replaces the content", async () => {
    setMockFile("Inbox/note.md", "# Old\n");
    setMockActiveFile("Inbox/note.md");
    const app = mockApp();
    const result = await updateActiveFileHandler({
      arguments: { content: "# New", expectedContent: "# Old\n" },
      app,
    });
    expect(result.isError).toBeUndefined();
    const file = app.workspace.getActiveFile();
    if (!file) throw new Error("expected active file");
    expect(await app.vault.read(file)).toBe("# New");
  });

  test("requireWritePreconditions on: refuses without expectedContent", async () => {
    setMockFile("Inbox/note.md", "# Old");
    setMockActiveFile("Inbox/note.md");
    const plugin = mockPlugin({
      loadData: async () => ({ mcpTools: { requireWritePreconditions: true } }),
    });
    const result = await updateActiveFileHandler({
      arguments: { content: "# New" },
      app: plugin.app,
      plugin,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("stale_precondition");
    const file = plugin.app.workspace.getActiveFile();
    if (!file) throw new Error("expected active file");
    expect(await plugin.app.vault.read(file)).toBe("# Old");
  });

  test("schema requires content argument", () => {
    // Test that omitting content fails ArkType validation
    const schema = updateActiveFileSchema;
    const result = schema({ name: "update_active_file", arguments: {} });
    // ArkType returns errors as a property when validation fails
    expect(
      result instanceof Error ||
        (typeof result === "object" && "summary" in result),
    ).toBe(true);
  });
});
