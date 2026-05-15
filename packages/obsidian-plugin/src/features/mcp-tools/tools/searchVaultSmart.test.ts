import { describe, expect, test, beforeEach } from "bun:test";
import {
  searchVaultSmartHandler,
  searchVaultSmartSchema,
} from "./searchVaultSmart";
import { mockApp, mockPlugin, resetMockVault } from "$/test-setup";
import type {
  SearchOpts,
  SearchResult,
  SemanticSearchProvider,
} from "$/features/semantic-search";

beforeEach(() => resetMockVault());

type ProviderSpy = {
  provider: SemanticSearchProvider;
  calls: () => Array<{ query: string; opts: SearchOpts }>;
};

function fakeProvider(opts: {
  ready?: boolean;
  results?: SearchResult[];
  throws?: Error;
}): ProviderSpy {
  const calls: Array<{ query: string; opts: SearchOpts }> = [];
  const provider: SemanticSearchProvider = {
    isReady: () => opts.ready ?? true,
    search: async (query: string, sopts: SearchOpts) => {
      calls.push({ query, opts: sopts });
      if (opts.throws) throw opts.throws;
      return opts.results ?? [];
    },
  };
  return { provider, calls: () => [...calls] };
}

describe("search_vault_smart tool — dispatch contract (T11)", () => {
  test("schema declares the tool name", () => {
    expect(searchVaultSmartSchema.get("name")?.toString()).toContain(
      "search_vault_smart",
    );
  });

  test("returns informative error when the plugin has no semanticSearchState", async () => {
    const plugin = mockPlugin({ semanticSearchState: undefined } as never);
    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not initialized/i);
  });

  test("returns informative error when provider.isReady() is false", async () => {
    const spy = fakeProvider({ ready: false });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);
    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not ready|reconfigure|provider/i);
    // Provider was never called.
    expect(spy.calls()).toHaveLength(0);
  });

  test("forwards query and mapped filter args to the provider", async () => {
    const spy = fakeProvider({ ready: true, results: [] });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    await searchVaultSmartHandler({
      arguments: {
        query: "machine learning",
        filter: {
          includeFolders: ["Notes"],
          excludeFolders: ["Archive"],
        },
        limit: 5,
      },
      app: mockApp(),
      plugin,
    });

    expect(spy.calls()).toHaveLength(1);
    expect(spy.calls()[0]?.query).toBe("machine learning");
    expect(spy.calls()[0]?.opts).toEqual({
      folders: ["Notes"],
      excludeFolders: ["Archive"],
      limit: 5,
    });
  });

  test("filter and limit are optional — provider receives undefined fields", async () => {
    const spy = fakeProvider({ ready: true, results: [] });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    await searchVaultSmartHandler({
      arguments: { query: "q" },
      app: mockApp(),
      plugin,
    });

    expect(spy.calls()[0]?.opts).toEqual({
      folders: undefined,
      excludeFolders: undefined,
      limit: undefined,
    });
  });

  test("serializes provider results into { results: [...] } JSON", async () => {
    const sampleResults: SearchResult[] = [
      {
        filePath: "Notes/ml.md",
        heading: "ML Notes",
        excerpt: "ML Notes: introduction to gradient descent.",
        score: 0.91,
      },
      {
        filePath: "Notes/dl.md",
        heading: null,
        excerpt: "Deep learning summary.",
        score: 0.84,
      },
    ];
    const spy = fakeProvider({ ready: true, results: sampleResults });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    const result = await searchVaultSmartHandler({
      arguments: { query: "ml" },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.results).toEqual(sampleResults);
  });

  test("provider.search throwing is surfaced as a tool-level error (no crash)", async () => {
    const spy = fakeProvider({
      ready: true,
      throws: new Error("transient backend hiccup"),
    });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    const result = await searchVaultSmartHandler({
      arguments: { query: "boom" },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Semantic search failed/);
    expect(result.content[0]?.text).toMatch(/transient backend hiccup/);
  });
});

describe("search_vault_smart — native indexer gating by provider (#99)", () => {
  function stateWith(opts: {
    providerSetting: "native" | "smart-connections" | "auto";
    ready?: boolean;
    smartSearchPresent?: boolean;
  }): {
    plugin: ReturnType<typeof mockPlugin>;
    indexerKicks: () => number;
  } {
    let kicks = 0;
    const spy = fakeProvider({ ready: opts.ready ?? true, results: [] });
    const plugin = mockPlugin({
      // `isSmartConnectionsAvailable` reads plugin.smartSearch?.search
      smartSearch: opts.smartSearchPresent
        ? { search: async () => [] }
        : undefined,
      semanticSearchState: {
        provider: spy.provider,
        settings: { provider: opts.providerSetting, indexingMode: "live" },
        startIndexerIfNeeded: () => {
          kicks += 1;
        },
      },
    } as never);
    return { plugin, indexerKicks: () => kicks };
  }

  test("does NOT kick the native indexer when provider = smart-connections", async () => {
    const { plugin, indexerKicks } = stateWith({
      providerSetting: "smart-connections",
    });
    await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    expect(indexerKicks()).toBe(0);
  });

  test("kicks the native indexer when provider = native", async () => {
    const { plugin, indexerKicks } = stateWith({ providerSetting: "native" });
    await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    expect(indexerKicks()).toBe(1);
  });

  test("provider = auto: kicks native indexer only when Smart Connections is unavailable", async () => {
    const withSC = stateWith({
      providerSetting: "auto",
      smartSearchPresent: true,
    });
    await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin: withSC.plugin,
    });
    expect(withSC.indexerKicks()).toBe(0);

    const withoutSC = stateWith({
      providerSetting: "auto",
      smartSearchPresent: false,
    });
    await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin: withoutSC.plugin,
    });
    expect(withoutSC.indexerKicks()).toBe(1);
  });
});

describe("search_vault_smart — provider-aware not-ready message (#99)", () => {
  function notReadyPlugin(providerSetting: "native" | "smart-connections") {
    const spy = fakeProvider({ ready: false });
    return mockPlugin({
      semanticSearchState: {
        provider: spy.provider,
        settings: { provider: providerSetting, indexingMode: "live" },
      },
    } as never);
  }

  test("smart-connections: message names Smart Connections, not the embedding model", async () => {
    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin: notReadyPlugin("smart-connections"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/smart connections/i);
    expect(result.content[0]?.text).not.toMatch(/embedding model/i);
  });

  test("native: message refers to the embedding model loading", async () => {
    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin: notReadyPlugin("native"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/embedding model|still be loading/i);
  });
});
