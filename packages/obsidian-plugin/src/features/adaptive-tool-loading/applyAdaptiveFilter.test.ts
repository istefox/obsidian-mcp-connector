import { describe, expect, test } from "bun:test";
import { applyAdaptiveFilter } from "./applyAdaptiveFilter";
import {
  ADAPTIVE_META_TOOLS,
  ALWAYS_ACTIVE_TOOLS,
  META_TOOLS,
} from "./constants";

type FakeEntry = { name: string; description: string; enabled: boolean };

function makeRegistry(names: string[]) {
  const entries: FakeEntry[] = names.map((n) => ({
    name: n,
    description: `${n} description`,
    enabled: true,
  }));
  const disabled: string[] = [];

  return {
    listAll: () =>
      entries.map((e) => ({ ...e, enabled: !disabled.includes(e.name) })),
    disableByName: (name: string) => {
      const found = entries.find((e) => e.name === name);
      if (!found) return false;
      disabled.push(name);
      return true;
    },
    _disabled: () => disabled,
  };
}

function makePlugin(toolLoadingData?: Record<string, unknown>) {
  const store: Record<string, unknown> = toolLoadingData
    ? { toolLoading: toolLoadingData }
    : {};
  return {
    loadData: async () => ({ ...store }),
    saveData: async () => {},
  };
}

const DOMAIN_TOOLS = [
  "get_server_info",
  "get_active_file",
  "update_active_file",
  "search_vault",
  "search_and_replace",
  "find_broken_links",
];
const ALL_TOOLS = [...DOMAIN_TOOLS, ...META_TOOLS];

describe("applyAdaptiveFilter", () => {
  test("all profile: no tools are disabled", async () => {
    const registry = makeRegistry(ALL_TOOLS);
    const plugin = makePlugin({ profile: "all", counters: {}, promoted: [] });
    await applyAdaptiveFilter(registry, plugin);
    expect(registry._disabled()).toHaveLength(0);
  });

  test("core profile: tool_catalog stays enabled, activate_tool is disabled", async () => {
    const registry = makeRegistry(ALL_TOOLS);
    const plugin = makePlugin({ profile: "core", counters: {}, promoted: [] });
    await applyAdaptiveFilter(registry, plugin);

    // tool_catalog always active
    for (const m of ALWAYS_ACTIVE_TOOLS) {
      expect(registry._disabled()).not.toContain(m);
    }
    // activate_tool must be disabled in core
    for (const m of ADAPTIVE_META_TOOLS) {
      expect(registry._disabled()).toContain(m);
    }
    // Non-core domain tools must be disabled
    expect(registry._disabled()).toContain("search_and_replace");
    expect(registry._disabled()).toContain("find_broken_links");
  });

  test("core profile: core tools are not disabled", async () => {
    const registry = makeRegistry(ALL_TOOLS);
    const plugin = makePlugin({ profile: "core", counters: {}, promoted: [] });
    await applyAdaptiveFilter(registry, plugin);
    expect(registry._disabled()).not.toContain("get_active_file");
    expect(registry._disabled()).not.toContain("search_vault");
  });

  test("adaptive profile: promoted tools are enabled beyond core", async () => {
    const registry = makeRegistry(ALL_TOOLS);
    const plugin = makePlugin({
      profile: "adaptive",
      counters: {},
      promoted: ["search_and_replace"],
    });
    await applyAdaptiveFilter(registry, plugin);
    // Promoted tool must NOT be disabled
    expect(registry._disabled()).not.toContain("search_and_replace");
    // Non-promoted non-core tool must be disabled
    expect(registry._disabled()).toContain("find_broken_links");
  });

  test("missing toolLoading key defaults to 'all' (zero regression)", async () => {
    const registry = makeRegistry(ALL_TOOLS);
    const plugin = makePlugin(); // no toolLoading key
    await applyAdaptiveFilter(registry, plugin);
    expect(registry._disabled()).toHaveLength(0);
  });
});
