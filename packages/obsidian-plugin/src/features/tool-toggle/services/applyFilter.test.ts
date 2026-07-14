import { describe, expect, test } from "bun:test";
import { applyDisabledToolsFilter } from "./applyFilter";

/**
 * Tests for the tool-toggle filter applied to a freshly-registered
 * ToolRegistry. We stub the registry with a recording
 * `setUserDisabled` so we don't depend on any specific tool actually
 * being registered.
 */

function fakeRegistry(known: string[]) {
  const knownSet = new Set(known);
  const disabled = new Set<string>();
  return {
    setUserDisabled: (name: string, isDisabled: boolean) => {
      if (knownSet.has(name)) {
        if (isDisabled) disabled.add(name);
        return true;
      }
      return false;
    },
    getDisabled: () => [...disabled],
  };
}

function fakePlugin(data: unknown) {
  return { loadData: async () => data };
}

const TOOLS = [
  "get_server_info",
  "delete_vault_file",
  "delete_active_file",
  "fetch",
];

describe("applyDisabledToolsFilter", () => {
  test("no data.json → empty result, no calls", async () => {
    const reg = fakeRegistry(TOOLS);
    const r = await applyDisabledToolsFilter(reg, fakePlugin(null));
    expect(r).toEqual({ disabled: [], unknown: [] });
    expect(reg.getDisabled()).toEqual([]);
  });

  test("missing toolToggle slice → no-op", async () => {
    const reg = fakeRegistry(TOOLS);
    const r = await applyDisabledToolsFilter(
      reg,
      fakePlugin({ otherFeature: { foo: "bar" } }),
    );
    expect(r).toEqual({ disabled: [], unknown: [] });
  });

  test("empty disabled array → no-op", async () => {
    const reg = fakeRegistry(TOOLS);
    const r = await applyDisabledToolsFilter(
      reg,
      fakePlugin({ toolToggle: { disabled: [] } }),
    );
    expect(r).toEqual({ disabled: [], unknown: [] });
  });

  test("disables every known name in the list", async () => {
    const reg = fakeRegistry(TOOLS);
    const r = await applyDisabledToolsFilter(
      reg,
      fakePlugin({
        toolToggle: { disabled: ["delete_vault_file", "delete_active_file"] },
      }),
    );
    expect(r.disabled.sort()).toEqual([
      "delete_active_file",
      "delete_vault_file",
    ]);
    expect(r.unknown).toEqual([]);
    expect(reg.getDisabled().sort()).toEqual([
      "delete_active_file",
      "delete_vault_file",
    ]);
  });

  test("unknown names are reported but do not abort filtering", async () => {
    const reg = fakeRegistry(TOOLS);
    const r = await applyDisabledToolsFilter(
      reg,
      fakePlugin({
        toolToggle: { disabled: ["delete_vault_file", "typo_tool", "fetch"] },
      }),
    );
    expect(r.disabled.sort()).toEqual(["delete_vault_file", "fetch"]);
    expect(r.unknown).toEqual(["typo_tool"]);
  });

  test("non-string entries skipped (defensive)", async () => {
    const reg = fakeRegistry(TOOLS);
    const r = await applyDisabledToolsFilter(
      reg,
      fakePlugin({
        toolToggle: { disabled: ["fetch", 42, null, "delete_vault_file"] },
      }),
    );
    expect(r.disabled.sort()).toEqual(["delete_vault_file", "fetch"]);
  });

  test("whitespace-only entries dropped, valid names trimmed", async () => {
    const reg = fakeRegistry(TOOLS);
    const r = await applyDisabledToolsFilter(
      reg,
      fakePlugin({
        toolToggle: { disabled: ["", "   ", "  fetch  "] },
      }),
    );
    expect(r.disabled).toEqual(["fetch"]);
  });

  test("non-array `disabled` field → no-op (corrupt data tolerated)", async () => {
    const reg = fakeRegistry(TOOLS);
    const r = await applyDisabledToolsFilter(
      reg,
      fakePlugin({ toolToggle: { disabled: "fetch,delete_vault_file" } }),
    );
    expect(r).toEqual({ disabled: [], unknown: [] });
  });

  test("loadData throwing is handled gracefully", async () => {
    const reg = fakeRegistry(TOOLS);
    const throwingPlugin = {
      loadData: async () => {
        throw new Error("disk full");
      },
    };
    const r = await applyDisabledToolsFilter(reg, throwingPlugin);
    expect(r).toEqual({ disabled: [], unknown: [] });
  });
});
