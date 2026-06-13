import { beforeEach, describe, expect, test } from "bun:test";
import { resolveTFile } from "./resolveTFile";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("resolveTFile", () => {
  test("resolves an existing file to ok + the TFile", () => {
    setMockFile("Notes/a.md", "hello");
    const result = resolveTFile(mockApp().vault, "Notes/a.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.path).toBe("Notes/a.md");
    }
  });

  test("reports not_found for a missing path", () => {
    const result = resolveTFile(mockApp().vault, "Notes/missing.md");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  test("reports not_a_file when the path is a folder", () => {
    setMockFolder("Notes");
    const result = resolveTFile(mockApp().vault, "Notes");
    expect(result).toEqual({ ok: false, reason: "not_a_file" });
  });
});
