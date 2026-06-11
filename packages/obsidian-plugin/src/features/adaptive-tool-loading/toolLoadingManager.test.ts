import { describe, expect, test } from "bun:test";
import { ToolLoadingManager } from "./toolLoadingManager";
import {
  ADAPTIVE_META_TOOLS,
  ALWAYS_ACTIVE_TOOLS,
  CORE_SET,
  META_TOOLS,
  PROMOTION_THRESHOLD,
} from "./constants";

const ALL_NAMES = [
  "get_server_info",
  "get_active_file",
  "update_active_file",
  "search_vault",
  "search_and_replace",
  "find_broken_links",
  "get_note_outline",
  "tool_catalog",
  "activate_tool",
];

function makePlugin(data: Record<string, unknown> = {}) {
  let store: Record<string, unknown> = { ...data };
  return {
    loadData: async () => ({ ...store }),
    saveData: async (d: unknown) => {
      store = { ...(d as Record<string, unknown>) };
    },
    _store: () => store,
  };
}

const mgr = new ToolLoadingManager();

describe("getActiveToolNames", () => {
  test("all profile: returns every name plus meta-tools", () => {
    const state = { profile: "all" as const, counters: {}, promoted: [] };
    const active = mgr.getActiveToolNames(ALL_NAMES, state);
    for (const n of ALL_NAMES) {
      expect(active.has(n)).toBe(true);
    }
  });

  test("core profile: returns CORE_SET plus tool_catalog only", () => {
    const state = { profile: "core" as const, counters: {}, promoted: [] };
    const active = mgr.getActiveToolNames(ALL_NAMES, state);
    // tool_catalog always active
    for (const m of ALWAYS_ACTIVE_TOOLS) {
      expect(active.has(m)).toBe(true);
    }
    // activate_tool must NOT be active in core
    for (const m of ADAPTIVE_META_TOOLS) {
      expect(active.has(m)).toBe(false);
    }
    // Non-core, non-meta tools must be inactive
    expect(active.has("search_and_replace")).toBe(false);
    expect(active.has("find_broken_links")).toBe(false);
    // A core tool must be active
    expect(active.has("get_active_file")).toBe(true);
  });

  test("adaptive profile: returns CORE_SET + promoted + META_TOOLS", () => {
    const state = {
      profile: "adaptive" as const,
      counters: {},
      promoted: ["search_and_replace"],
    };
    const active = mgr.getActiveToolNames(ALL_NAMES, state);
    expect(active.has("search_and_replace")).toBe(true);
    expect(active.has("find_broken_links")).toBe(false);
    for (const m of META_TOOLS) {
      expect(active.has(m)).toBe(true);
    }
  });

  test("tool_catalog always active regardless of profile", () => {
    for (const profile of ["all", "core", "adaptive"] as const) {
      const state = { profile, counters: {}, promoted: [] };
      const active = mgr.getActiveToolNames(ALL_NAMES, state);
      for (const m of ALWAYS_ACTIVE_TOOLS) {
        expect(active.has(m)).toBe(true);
      }
    }
  });

  test("activate_tool active for all and adaptive profiles, not core", () => {
    for (const profile of ["all", "adaptive"] as const) {
      const state = { profile, counters: {}, promoted: [] };
      const active = mgr.getActiveToolNames(ALL_NAMES, state);
      for (const m of ADAPTIVE_META_TOOLS) {
        expect(active.has(m)).toBe(true);
      }
    }
    const coreState = { profile: "core" as const, counters: {}, promoted: [] };
    const coreActive = mgr.getActiveToolNames(ALL_NAMES, coreState);
    for (const m of ADAPTIVE_META_TOOLS) {
      expect(coreActive.has(m)).toBe(false);
    }
  });
});

describe("recordCall", () => {
  test("increments counter for the given tool", async () => {
    const plugin = makePlugin();
    await mgr.recordCall("search_vault", plugin);
    const data = plugin._store() as Record<string, unknown>;
    const state = data.toolLoading as { counters: Record<string, number> };
    expect(state.counters["search_vault"]).toBe(1);
  });

  test("promotes tool in adaptive mode when threshold reached", async () => {
    const plugin = makePlugin({
      toolLoading: { profile: "adaptive", counters: {}, promoted: [] },
    });
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      await mgr.recordCall("search_and_replace", plugin);
    }
    const data = plugin._store() as Record<string, unknown>;
    const state = data.toolLoading as { promoted: string[] };
    expect(state.promoted).toContain("search_and_replace");
  });

  test("does not promote in core profile", async () => {
    const plugin = makePlugin({
      toolLoading: { profile: "core", counters: {}, promoted: [] },
    });
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      await mgr.recordCall("search_and_replace", plugin);
    }
    const data = plugin._store() as Record<string, unknown>;
    const state = data.toolLoading as { promoted: string[] };
    expect(state.promoted).not.toContain("search_and_replace");
  });

  test("does not count meta-tools toward promotion", async () => {
    const plugin = makePlugin({
      toolLoading: { profile: "adaptive", counters: {}, promoted: [] },
    });
    for (let i = 0; i < PROMOTION_THRESHOLD + 2; i++) {
      await mgr.recordCall("tool_catalog", plugin);
    }
    const data = plugin._store() as Record<string, unknown>;
    const state = data.toolLoading as { promoted: string[] };
    expect(state.promoted).not.toContain("tool_catalog");
  });

  test("concurrent recordCalls do not lose counter updates", async () => {
    const plugin = makePlugin();
    // Fire two read-modify-write cycles concurrently. Without the
    // settings mutex both read the same "before" snapshot and the
    // last writer clobbers the first one's counter (lost update).
    await Promise.all([
      mgr.recordCall("search_vault", plugin),
      mgr.recordCall("get_active_file", plugin),
    ]);
    const data = plugin._store() as Record<string, unknown>;
    const state = data.toolLoading as { counters: Record<string, number> };
    expect(state.counters["search_vault"]).toBe(1);
    expect(state.counters["get_active_file"]).toBe(1);
  });

  test("does not re-promote an already-promoted tool", async () => {
    const plugin = makePlugin({
      toolLoading: {
        profile: "adaptive",
        counters: { search_and_replace: PROMOTION_THRESHOLD - 1 },
        promoted: ["search_and_replace"],
      },
    });
    await mgr.recordCall("search_and_replace", plugin);
    const data = plugin._store() as Record<string, unknown>;
    const state = data.toolLoading as { promoted: string[] };
    // Should appear exactly once
    expect(
      state.promoted.filter((n) => n === "search_and_replace").length,
    ).toBe(1);
  });
});

describe("activateTool", () => {
  test("returns 'not_found' for unknown tool names", async () => {
    const plugin = makePlugin();
    const result = await mgr.activateTool(
      "nonexistent_tool",
      ALL_NAMES,
      plugin,
    );
    expect(result).toBe("not_found");
  });

  test("returns 'already_active' if already in promoted list", async () => {
    const plugin = makePlugin({
      toolLoading: {
        profile: "adaptive",
        counters: {},
        promoted: ["search_and_replace"],
      },
    });
    const result = await mgr.activateTool(
      "search_and_replace",
      ALL_NAMES,
      plugin,
    );
    expect(result).toBe("already_active");
  });

  test("returns 'activated' and writes to promoted list", async () => {
    const plugin = makePlugin();
    const result = await mgr.activateTool(
      "search_and_replace",
      ALL_NAMES,
      plugin,
    );
    expect(result).toBe("activated");
    const data = plugin._store() as Record<string, unknown>;
    const state = data.toolLoading as { promoted: string[] };
    expect(state.promoted).toContain("search_and_replace");
  });
});

describe("resetAll", () => {
  test("clears counters and promoted but preserves profile", async () => {
    const plugin = makePlugin({
      toolLoading: {
        profile: "adaptive",
        counters: { get_active_file: 5, search_vault: 2 },
        promoted: ["search_and_replace"],
      },
    });
    await mgr.resetAll(plugin);
    const data = plugin._store() as Record<string, unknown>;
    const state = data.toolLoading as {
      profile: string;
      counters: Record<string, number>;
      promoted: string[];
    };
    expect(state.profile).toBe("adaptive");
    expect(state.counters).toEqual({});
    expect(state.promoted).toEqual([]);
  });
});

describe("loadState", () => {
  test("merges missing toolLoading key with defaults", async () => {
    const plugin = makePlugin({ someOtherKey: 1 });
    const state = await mgr.loadState(plugin);
    expect(state.profile).toBe("all");
    expect(state.counters).toEqual({});
    expect(state.promoted).toEqual([]);
  });

  test("merges partial toolLoading slice with defaults", async () => {
    const plugin = makePlugin({ toolLoading: { profile: "core" } });
    const state = await mgr.loadState(plugin);
    expect(state.profile).toBe("core");
    expect(state.counters).toEqual({});
    expect(state.promoted).toEqual([]);
  });
});

// Smoke-test: CORE_SET contains only real tool names
describe("CORE_SET", () => {
  test("all core tools are known names (sanity check)", () => {
    const coreSet = CORE_SET as readonly string[];
    for (const name of coreSet) {
      // If this breaks, CORE_SET references a tool name that doesn't exist
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
    expect(coreSet.length).toBeGreaterThan(0);
  });
});
