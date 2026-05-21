import { describe, expect, test, beforeEach } from "bun:test";
import {
  createVaultDirectoryHandler,
  createVaultDirectorySchema,
} from "./createVaultDirectory";
import {
  getMockFolders,
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("create_vault_directory tool", () => {
  test("schema declares the tool name", () => {
    expect(createVaultDirectorySchema.get("name")?.toString()).toContain(
      "create_vault_directory",
    );
  });

  test("creates a single new directory", async () => {
    const app = mockApp();
    const result = await createVaultDirectoryHandler({
      arguments: { path: "Inbox" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual(["Inbox"]);
  });

  test("creates a nested chain (mkdirp)", async () => {
    const app = mockApp();
    const result = await createVaultDirectoryHandler({
      arguments: { path: "Projects/2026/Q2" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual([
      "Projects",
      "Projects/2026",
      "Projects/2026/Q2",
    ]);
  });

  test("idempotent — succeeds when directory already exists", async () => {
    setMockFolder("Inbox");
    const app = mockApp();
    const result = await createVaultDirectoryHandler({
      arguments: { path: "Inbox" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual(["Inbox"]);
  });

  test("normalises leading and trailing slashes", async () => {
    const app = mockApp();
    const result = await createVaultDirectoryHandler({
      arguments: { path: "/Projects/A/" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual(["Projects", "Projects/A"]);
  });

  test("rejects empty path after trimming", async () => {
    const app = mockApp();
    const result = await createVaultDirectoryHandler({
      arguments: { path: "/" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/empty/i);
  });

  test("rejects when a file already exists at that path", async () => {
    setMockFile("note.md", "");
    const app = mockApp();
    const result = await createVaultDirectoryHandler({
      arguments: { path: "note.md" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/file already exists/i);
  });

  // Test-as-spec: locks in the current behavior on path-traversal input.
  // Today the handler does NOT sanitise '..' segments — it forwards them to
  // ensureFolderExists, which in turn delegates to the Obsidian Vault API.
  // The mock vault accepts the literal string and creates a folder named '..'
  // (a sibling of the vault root in the in-memory map). On a real Obsidian
  // vault the same input would either no-op or surface an adapter-level
  // error. If a future change adds explicit traversal rejection upstream of
  // ensureFolderExists, this test will fail and the behavior change becomes
  // a deliberate signal rather than a silent regression.
  test("documents current behavior on path traversal '../escape'", async () => {
    const app = mockApp();
    const result = await createVaultDirectoryHandler({
      arguments: { path: "../escape" },
      app,
    });
    // No isError surfaced today — the handler treats '..' as a regular segment.
    expect(result.isError).toBeUndefined();
    // The mock records the literal segments as folders.
    expect(getMockFolders()).toContain("../escape");
  });

  // Test-as-spec: the top-level regex `/^\/+|\/+$/g` only collapses leading
  // and trailing slashes, but ensureFolderExists downstream splits on '/' and
  // discards empty segments — so 'A//B' resolves to the same folder list as
  // 'A/B'. Locked in so a future normaliser change (or a regression that
  // surfaces literal '' segments) shows up here.
  test("collapses internal double slashes 'A//B' to 'A/B'", async () => {
    const app = mockApp();
    const result = await createVaultDirectoryHandler({
      arguments: { path: "A//B" },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual(["A", "A/B"]);
  });
});
