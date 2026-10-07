import { describe, expect, test } from "bun:test";
import {
  getClaudeCodeProjectPath,
  setClaudeCodeProjectPath,
} from "./claudeCodeProject";

/**
 * Persistence of the "Claude Code project path" setting through a fake
 * plugin with in-memory `loadData/saveData`.
 */

type StoredData = Record<string, unknown> | null;

function fakePlugin(initial: StoredData = {}) {
  let data: StoredData = initial;
  return {
    async loadData() {
      return data;
    },
    async saveData(next: unknown) {
      data = next as StoredData;
    },
    get _data() {
      return data;
    },
  };
}

describe("getClaudeCodeProjectPath", () => {
  test("reads empty for a fresh install or a missing key", async () => {
    expect(await getClaudeCodeProjectPath(fakePlugin(null))).toBe("");
    expect(
      await getClaudeCodeProjectPath(fakePlugin({ mcpClientConfig: {} })),
    ).toBe("");
  });

  test("reads a saved path", async () => {
    const p = fakePlugin({
      mcpClientConfig: { claudeCodeProjectPath: "/home/me/app" },
    });
    expect(await getClaudeCodeProjectPath(p)).toBe("/home/me/app");
  });

  test.each([42, "relative/app", "/tmp/it's"])(
    "reads a hand-edited invalid value %p as empty",
    async (stored) => {
      const p = fakePlugin({
        mcpClientConfig: { claudeCodeProjectPath: stored },
      });
      expect(await getClaudeCodeProjectPath(p)).toBe("");
    },
  );
});

describe("setClaudeCodeProjectPath", () => {
  test("saves the trimmed path and keeps the rest of the slice", async () => {
    const p = fakePlugin({
      mcpClientConfig: { autoWriteClaudeDesktopConfig: true },
      other: "kept",
    });
    expect(
      await setClaudeCodeProjectPath(p, "  C:\\My Projects\\app "),
    ).toEqual({ ok: true, path: "C:\\My Projects\\app" });
    expect(p._data).toEqual({
      mcpClientConfig: {
        autoWriteClaudeDesktopConfig: true,
        claudeCodeProjectPath: "C:\\My Projects\\app",
      },
      other: "kept",
    });
    expect(await getClaudeCodeProjectPath(p)).toBe("C:\\My Projects\\app");
  });

  test("clears the path with an empty value", async () => {
    const p = fakePlugin({
      mcpClientConfig: { claudeCodeProjectPath: "/home/me/app" },
    });
    expect(await setClaudeCodeProjectPath(p, " ")).toEqual({
      ok: true,
      path: "",
    });
    expect(await getClaudeCodeProjectPath(p)).toBe("");
  });

  test("rejects an invalid path without writing", async () => {
    const initial = {
      mcpClientConfig: { claudeCodeProjectPath: "/home/me/app" },
    };
    const p = fakePlugin(initial);
    const result = await setClaudeCodeProjectPath(p, "relative/app");
    expect(result.ok).toBe(false);
    expect(p._data).toBe(initial);
  });
});
