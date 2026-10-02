import { describe, expect, test } from "bun:test";
import { mockPlugin } from "$/test-setup";
import {
  DEFAULT_SEARCH_RESULTS_VIEW,
  effectiveSearchResultsView,
  readGlobalSearchResultsView,
  resolveSearchResultsView,
  SEARCH_RESULTS_UI_META_KEYS,
} from "./searchResultsViewSetting";

/**
 * The MCP Apps off switch (discussion #543, ADR-0018 addendum): a
 * vault-wide default in `mcpTools.searchResultsView` and a per-token
 * override in the policy, the override winning whenever it is a boolean.
 */
describe("searchResultsViewSetting", () => {
  test("the default is on, and the stripped keys are the two forms wireSearchResultsApp writes", () => {
    expect(DEFAULT_SEARCH_RESULTS_VIEW).toBe(true);
    expect([...SEARCH_RESULTS_UI_META_KEYS].sort()).toEqual([
      "ui",
      "ui/resourceUri",
    ]);
  });

  test("effectiveSearchResultsView: an override wins either way, absence inherits", () => {
    expect(effectiveSearchResultsView(true, {})).toBe(true);
    expect(effectiveSearchResultsView(false, {})).toBe(false);
    expect(effectiveSearchResultsView(true, { searchResultsView: false })).toBe(
      false,
    );
    expect(effectiveSearchResultsView(false, { searchResultsView: true })).toBe(
      true,
    );
  });

  test("readGlobalSearchResultsView: no plugin, no slice, or a malformed value all read as the default", async () => {
    expect(await readGlobalSearchResultsView(undefined)).toBe(true);
    expect(await readGlobalSearchResultsView(mockPlugin())).toBe(true);
    expect(
      await readGlobalSearchResultsView(
        mockPlugin({
          // A hand-edited data.json: the typed slice says boolean, the
          // disk may say otherwise.
          loadData: async () =>
            ({ mcpTools: { searchResultsView: "no" } }) as never,
        }),
      ),
    ).toBe(true);
  });

  test("readGlobalSearchResultsView: a stored false is honoured", async () => {
    const plugin = mockPlugin({
      loadData: async () => ({ mcpTools: { searchResultsView: false } }),
    });
    expect(await readGlobalSearchResultsView(plugin)).toBe(false);
  });

  test("resolveSearchResultsView: inherits the stored global, and a token override beats it", async () => {
    const off = mockPlugin({
      loadData: async () => ({ mcpTools: { searchResultsView: false } }),
    });
    expect(await resolveSearchResultsView(off, {})).toBe(false);
    expect(
      await resolveSearchResultsView(off, { searchResultsView: true }),
    ).toBe(true);
    expect(
      await resolveSearchResultsView(mockPlugin(), {
        searchResultsView: false,
      }),
    ).toBe(false);
  });

  test("resolveSearchResultsView: an override decides without touching the settings at all", async () => {
    let reads = 0;
    const plugin = mockPlugin({
      loadData: async () => {
        reads += 1;
        return {};
      },
    });
    await resolveSearchResultsView(plugin, { searchResultsView: false });
    expect(reads).toBe(0);
    await resolveSearchResultsView(plugin, {});
    expect(reads).toBe(1);
  });
});
