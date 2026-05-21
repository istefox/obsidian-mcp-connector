import { describe, expect, test } from "bun:test";
import {
  createSmartConnectionsProvider,
  mapFolderFilter,
  SmartConnectionsUnavailableError,
} from "./smartConnectionsProvider";
import type McpToolsPlugin from "$/main";

type FakeSmartSearch = {
  search: (
    query: string,
    filter: Record<string, unknown>,
  ) => Promise<
    Array<{
      item: { path: string; breadcrumbs?: string; read: () => Promise<string> };
      score: number;
    }>
  >;
};

function makeFakePlugin(smartSearch?: FakeSmartSearch): McpToolsPlugin {
  return { smartSearch } as unknown as McpToolsPlugin;
}

describe("mapFolderFilter helper", () => {
  test("emits no keys for an empty SearchOpts", () => {
    expect(mapFolderFilter({})).toEqual({});
  });

  test("maps includeFolders → key_starts_with_any", () => {
    expect(mapFolderFilter({ folders: ["Notes", "Inbox"] })).toEqual({
      key_starts_with_any: ["Notes", "Inbox"],
    });
  });

  test("maps excludeFolders → exclude_key_starts_with_any", () => {
    expect(mapFolderFilter({ excludeFolders: ["Archive"] })).toEqual({
      exclude_key_starts_with_any: ["Archive"],
    });
  });

  test("forwards limit when set", () => {
    expect(mapFolderFilter({ limit: 5 })).toEqual({ limit: 5 });
  });

  test("limit=0 is forwarded (caller intent: zero results)", () => {
    expect(mapFolderFilter({ limit: 0 })).toEqual({ limit: 0 });
  });

  test("empty array filters do NOT emit the key (SC distinguishes [] from absent)", () => {
    expect(mapFolderFilter({ folders: [], excludeFolders: [] })).toEqual({});
  });

  test("combines all keys", () => {
    expect(
      mapFolderFilter({
        folders: ["Notes"],
        excludeFolders: ["Archive"],
        limit: 10,
      }),
    ).toEqual({
      key_starts_with_any: ["Notes"],
      exclude_key_starts_with_any: ["Archive"],
      limit: 10,
    });
  });
});

describe("SmartConnectionsProvider", () => {
  test("isReady false when plugin.smartSearch is absent", () => {
    const provider = createSmartConnectionsProvider(makeFakePlugin(undefined));
    expect(provider.isReady()).toBe(false);
  });

  test("isReady true when plugin.smartSearch.search is a function", () => {
    const fakeSC: FakeSmartSearch = { search: async () => [] };
    const provider = createSmartConnectionsProvider(makeFakePlugin(fakeSC));
    expect(provider.isReady()).toBe(true);
  });

  test("search throws SmartConnectionsUnavailableError when SC not loaded", async () => {
    const provider = createSmartConnectionsProvider(makeFakePlugin(undefined));
    await expect(provider.search("anything", {})).rejects.toBeInstanceOf(
      SmartConnectionsUnavailableError,
    );
  });

  test("delegates query verbatim to SC API", async () => {
    let receivedQuery = "";
    const fakeSC: FakeSmartSearch = {
      search: async (q) => {
        receivedQuery = q;
        return [];
      },
    };
    const provider = createSmartConnectionsProvider(makeFakePlugin(fakeSC));
    await provider.search("machine learning", {});
    expect(receivedQuery).toBe("machine learning");
  });

  test("forwards mapped folder filters and limit to SC API", async () => {
    let received: Record<string, unknown> = {};
    const fakeSC: FakeSmartSearch = {
      search: async (_q, filter) => {
        received = filter;
        return [];
      },
    };
    const provider = createSmartConnectionsProvider(makeFakePlugin(fakeSC));
    await provider.search("x", {
      folders: ["Notes"],
      excludeFolders: ["Archive"],
      limit: 7,
    });
    expect(received).toEqual({
      key_starts_with_any: ["Notes"],
      exclude_key_starts_with_any: ["Archive"],
      limit: 7,
    });
  });

  test("transforms SC raw results into SearchResult shape", async () => {
    const fakeSC: FakeSmartSearch = {
      search: async () => [
        {
          item: {
            path: "Zettelkasten/idea.md",
            breadcrumbs: "Zettelkasten > idea",
            read: async () => "Body content of the idea note.",
          },
          score: 0.95,
        },
        {
          item: {
            path: "Inbox/quick.md",
            // no breadcrumbs
            read: async () => "Quick note body.",
          },
          score: 0.42,
        },
      ],
    };
    const provider = createSmartConnectionsProvider(makeFakePlugin(fakeSC));
    const results = await provider.search("idea", {});

    expect(results).toHaveLength(2);

    expect(results[0]).toEqual({
      filePath: "Zettelkasten/idea.md",
      heading: "Zettelkasten > idea",
      excerpt: "Zettelkasten > idea: Body content of the idea note.",
      score: 0.95,
    });

    expect(results[1]?.filePath).toBe("Inbox/quick.md");
    expect(results[1]?.heading).toBeNull();
    expect(results[1]?.excerpt).toBe("Quick note body.");
    expect(results[1]?.score).toBe(0.42);
  });

  test("excerpt is bounded to 200 chars (with heading prefix counted)", async () => {
    const longBody = "x".repeat(500);
    const fakeSC: FakeSmartSearch = {
      search: async () => [
        {
          item: {
            path: "L/long.md",
            breadcrumbs: "Long",
            read: async () => longBody,
          },
          score: 0.5,
        },
        {
          item: {
            path: "N/no.md",
            // no breadcrumbs
            read: async () => longBody,
          },
          score: 0.4,
        },
      ],
    };
    const provider = createSmartConnectionsProvider(makeFakePlugin(fakeSC));
    const results = await provider.search("q", {});

    for (const r of results) {
      expect(r.excerpt.length).toBeLessThanOrEqual(200);
    }
    expect(results[0]?.excerpt.startsWith("Long: ")).toBe(true);
  });

  test("empty body without heading falls back to (no preview)", async () => {
    const fakeSC: FakeSmartSearch = {
      search: async () => [
        {
          item: { path: "E/empty.md", read: async () => "" },
          score: 0.1,
        },
      ],
    };
    const provider = createSmartConnectionsProvider(makeFakePlugin(fakeSC));
    const results = await provider.search("q", {});
    expect(results[0]?.excerpt).toBe("(no preview)");
  });
});
