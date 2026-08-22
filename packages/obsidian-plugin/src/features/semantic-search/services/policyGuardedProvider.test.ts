import { describe, expect, test } from "bun:test";
import {
  guardChooserWithPolicy,
  guardProviderWithPolicy,
} from "./policyGuardedProvider";
import { compilePolicy, EMPTY_POLICY } from "$/shared/pathPolicy";
import type {
  SearchResult,
  SemanticSearchProvider,
} from "$/features/semantic-search";
import type { SemanticSearchSettings } from "$/features/semantic-search/types";

function hit(filePath: string, score = 0.9): SearchResult {
  return { filePath, heading: null, excerpt: "x", line: null, score };
}

/** A provider returning a fixed result set and recording its calls. */
function fakeProvider(results: SearchResult[]): SemanticSearchProvider & {
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    isReady: () => true,
    async search() {
      calls++;
      return results;
    },
  };
}

describe("guardProviderWithPolicy", () => {
  test("drops hits under an excluded folder", async () => {
    const guarded = guardProviderWithPolicy(
      fakeProvider([hit("Journal/a.md"), hit("Notes/b.md")]),
      () => compilePolicy(["Journal"]),
    );

    expect(await guarded.search("q", {})).toEqual([hit("Notes/b.md")]);
  });

  test("the folder's own path and nested files are both excluded", async () => {
    const guarded = guardProviderWithPolicy(
      fakeProvider([
        hit("Journal"),
        hit("Journal/deep/c.md"),
        hit("Journalism/d.md"),
      ]),
      () => compilePolicy(["Journal"]),
    );

    // `Journalism` is NOT under `Journal` — the prefix boundary is the
    // bug this assertion exists to catch.
    expect(await guarded.search("q", {})).toEqual([hit("Journalism/d.md")]);
  });

  test("returns the provider's own array when nothing is excluded", async () => {
    const results = [hit("Journal/a.md")];
    const guarded = guardProviderWithPolicy(
      fakeProvider(results),
      () => EMPTY_POLICY,
    );

    expect(await guarded.search("q", {})).toEqual(results);
  });

  test("reads the policy per call, never captures it", async () => {
    let policy = EMPTY_POLICY;
    const guarded = guardProviderWithPolicy(
      fakeProvider([hit("Journal/a.md")]),
      () => policy,
    );

    expect(await guarded.search("q", {})).toHaveLength(1);
    policy = compilePolicy(["Journal"]);
    expect(await guarded.search("q", {})).toHaveLength(0);
  });

  test("hides the fact that anything was hidden", async () => {
    const guarded = guardProviderWithPolicy(
      fakeProvider([hit("Journal/a.md"), hit("Journal/b.md")]),
      () => compilePolicy(["Journal"]),
    );

    // No count, no placeholder, no marker: an empty result set is
    // exactly what a vault with no matching notes returns (ADR-0020 D3).
    expect(await guarded.search("q", {})).toEqual([]);
  });

  test("passes query and options through unchanged", async () => {
    const seen: unknown[] = [];
    const guarded = guardProviderWithPolicy(
      {
        isReady: () => true,
        async search(query, opts) {
          seen.push([query, opts]);
          return [];
        },
      },
      () => compilePolicy(["Journal"]),
    );

    await guarded.search("hello", { limit: 3, excludeFolders: ["Drafts"] });
    expect(seen).toEqual([["hello", { limit: 3, excludeFolders: ["Drafts"] }]]);
  });

  test("forwards isReady", () => {
    const guarded = guardProviderWithPolicy(
      { isReady: () => false, search: async () => [] },
      () => EMPTY_POLICY,
    );

    expect(guarded.isReady()).toBe(false);
  });
});

describe("guardChooserWithPolicy", () => {
  test("guards every provider the chooser ever returns", async () => {
    // The regression this guards: wrapping `state.provider` alone leaves
    // the next provider swap unguarded.
    const chooser = () => fakeProvider([hit("Journal/a.md")]);
    const guarded = guardChooserWithPolicy(chooser, () =>
      compilePolicy(["Journal"]),
    );
    const settings = {} as SemanticSearchSettings;

    expect(await guarded(settings).search("q", {})).toEqual([]);
    expect(await guarded(settings).search("q", {})).toEqual([]);
  });
});
