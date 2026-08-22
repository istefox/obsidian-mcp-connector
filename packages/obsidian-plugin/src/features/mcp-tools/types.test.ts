import { describe, expect, test } from "bun:test";
import {
  EXCLUDED_FOLDERS_CONSENT_VERSION,
  UNFILTERABLE_TOOL_NAMES,
  normalizeExcludedFolders,
  shouldDisableUnfilterableTools,
} from "./types";
import { registerTools } from "./index";
import { ToolRegistryClass } from "$/features/mcp-transport/services/toolRegistry";
import { mockApp } from "$/test-setup";
import type McpToolsPlugin from "$/main";
import {
  DENY_ALL_POLICY,
  EMPTY_POLICY,
  MAX_POLICY_FOLDERS,
  compilePolicy,
} from "$/shared/pathPolicy";

describe("normalizeExcludedFolders", () => {
  // The whole point of the field: absent and empty mean the same thing,
  // so the writer can omit the key and leave data.json byte-identical
  // for a vault that never touched the feature.
  test("collapses every flavour of nothing to undefined", () => {
    for (const nothing of [
      undefined,
      null,
      [],
      ["", "   "],
      ["../secrets"],
      ["/"],
      "Therapy", // a bare string, not an array
      42,
      {},
    ]) {
      expect(normalizeExcludedFolders(nothing)).toBeUndefined();
    }
  });

  test("returns the canonical list when there is something to return", () => {
    expect(normalizeExcludedFolders(["/Journal/Therapy/", "Finances"])).toEqual(
      ["Journal/Therapy", "Finances"],
    );
  });

  test("shares the matcher's rules, so storage and matching cannot diverge", () => {
    const stored = normalizeExcludedFolders(["Journal\\Therapy//"]);
    expect(stored).toEqual(["Journal/Therapy"]);
    expect(compilePolicy(stored).isExcluded("Journal/Therapy/a.md")).toBe(true);
  });

  test("keeps a nested entry rather than pruning it", () => {
    expect(normalizeExcludedFolders(["Journal", "Journal/Therapy"])).toEqual([
      "Journal",
      "Journal/Therapy",
    ]);
  });

  test("caps an oversized list instead of rejecting it", () => {
    const huge = Array.from({ length: MAX_POLICY_FOLDERS + 10 }, (_, i) =>
      String(i),
    );
    expect(normalizeExcludedFolders(huge)).toHaveLength(MAX_POLICY_FOLDERS);
  });

  test("never throws, whatever it is handed", () => {
    for (const junk of [Symbol("x"), () => {}, [Symbol("y"), () => {}]]) {
      expect(() => normalizeExcludedFolders(junk)).not.toThrow();
    }
  });
});

describe("shouldDisableUnfilterableTools", () => {
  test("no policy in force leaves all three enabled", () => {
    expect(shouldDisableUnfilterableTools(EMPTY_POLICY)).toBe(false);
  });

  test("a configured folder disables them", () => {
    expect(shouldDisableUnfilterableTools(compilePolicy(["Therapy"]))).toBe(
      true,
    );
  });

  // The reason this takes a policy and not the folder list. Under
  // deny-all the list is empty while everything is refused, so a
  // list-based check would leave all three enabled at exactly the moment
  // nothing is known.
  test("the pre-first-read posture disables them too", () => {
    expect(shouldDisableUnfilterableTools(DENY_ALL_POLICY)).toBe(true);
    expect(DENY_ALL_POLICY.folders).toEqual([]);
  });
});

describe("the unfilterable set", () => {
  test("names exactly the three tools ADR-0020 D9 lists", () => {
    expect([...UNFILTERABLE_TOOL_NAMES].sort()).toEqual([
      "execute_dataview_query",
      "execute_obsidian_command",
      "execute_template",
    ]);
  });

  // Without this, a typo in the set above passes every other assertion
  // in this file and silently disables nothing — which would mean the
  // three tools stay live while the user believes a folder is hidden.
  test("every name in it is a tool the registry actually registers", async () => {
    const registry = new ToolRegistryClass();
    await registerTools(registry, {
      app: mockApp(),
      // Only captured lazily inside handler closures, so a bare stub is
      // enough to enumerate the list (see index.test.ts).
      plugin: {} as McpToolsPlugin,
      pluginVersion: "0.0.0-test",
    });
    const registered = new Set(registry.list().tools.map((t) => t.name));
    expect(registered.size).toBeGreaterThan(40);
    const missing = UNFILTERABLE_TOOL_NAMES.filter((n) => !registered.has(n));
    expect(missing).toEqual([]);
  });

  // Measured, not assumed: list_bookmarks returns typed items carrying
  // `path` strings, so it filters like anything else and stays enabled.
  test("list_bookmarks is not in it", () => {
    expect(UNFILTERABLE_TOOL_NAMES).not.toContain("list_bookmarks");
  });
});

describe("the consent version", () => {
  test("is a positive integer, so an absent record compares below it", () => {
    expect(Number.isInteger(EXCLUDED_FOLDERS_CONSENT_VERSION)).toBe(true);
    expect(EXCLUDED_FOLDERS_CONSENT_VERSION).toBeGreaterThan(0);
    // How the gate reads a vault that has never accepted anything.
    const stored: { version?: number } = {};
    expect((stored.version ?? 0) >= EXCLUDED_FOLDERS_CONSENT_VERSION).toBe(
      false,
    );
  });
});
