import { describe, expect, test, beforeEach } from "bun:test";
import {
  searchVaultSmartHandler,
  searchVaultSmartSchema,
} from "./searchVaultSmart";
import {
  mockApp,
  mockPlugin,
  resetMockVault,
  setMockFile,
  setMockIgnored,
} from "$/test-setup";
import { _resetIsUserIgnoredWarning } from "$/shared/isUserIgnored";
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
        line: 3,
        score: 0.91,
      },
      {
        filePath: "Notes/dl.md",
        heading: null,
        excerpt: "Deep learning summary.",
        line: null,
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

// RFC #238, D3 — query-time exclusion. Even after the indexer stops
// admitting excluded files, chunks indexed before a folder was excluded
// can linger until the next manual Rebuild; the handler filters them out
// of results so they never surface.
describe("search_vault_smart — query-time exclusion filter (#238)", () => {
  const sampleResults: SearchResult[] = [
    {
      filePath: "Notes/keep.md",
      heading: null,
      excerpt: "kept",
      line: null,
      score: 0.91,
    },
    {
      filePath: "Archive/old.md",
      heading: null,
      excerpt: "stale",
      line: null,
      score: 0.84,
    },
  ];

  test("drops results whose path is user-ignored", async () => {
    setMockIgnored("Archive/old.md");
    const spy = fakeProvider({ ready: true, results: sampleResults });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.results.map((r: SearchResult) => r.filePath)).toEqual([
      "Notes/keep.md",
    ]);
  });

  test("gracefully degrades when isUserIgnored is unavailable (no filtering, no throw)", async () => {
    _resetIsUserIgnoredWarning();
    const spy = fakeProvider({ ready: true, results: sampleResults });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    const app = mockApp();
    delete (app.metadataCache as unknown as { isUserIgnored?: unknown })
      .isUserIgnored;

    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app,
      plugin,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    // Accessor absent → exclusion disabled → all results flow through.
    expect(parsed.results).toEqual(sampleResults);
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
    expect(result.content[0]?.text).toMatch(
      /embedding model|still be loading/i,
    );
  });
});

describe("search_vault_smart — structured index_building error (#344)", () => {
  test("pendingProvider with no store: filesIndexed and percent are 0", async () => {
    setMockFile("a.md", "# A");
    setMockFile("b.md", "# B");
    const spy = fakeProvider({ ready: false });
    const plugin = mockPlugin({
      semanticSearchState: {
        provider: spy.provider,
        pendingProvider: "embedding-gemma",
        store: undefined,
      },
    } as never);

    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.errorCode).toBe("index_building");
    expect(parsed.filesTotal).toBe(2);
    expect(parsed.filesIndexed).toBe(0);
    expect(parsed.percent).toBe(0);
  });

  test("pendingProvider with a store: reports real indexed/total/percent", async () => {
    setMockFile("a.md", "# A");
    setMockFile("b.md", "# B");
    const spy = fakeProvider({ ready: false });
    const fakeStore = { hasRecords: (path: string) => path === "a.md" };
    const plugin = mockPlugin({
      semanticSearchState: {
        provider: spy.provider,
        pendingProvider: "embedding-gemma",
        store: fakeStore,
      },
    } as never);

    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.errorCode).toBe("index_building");
    expect(parsed.filesTotal).toBe(2);
    expect(parsed.filesIndexed).toBe(1);
    expect(parsed.percent).toBe(50);
  });

  test("pendingProvider with no pendingProviderStartedAt: retryAfterSeconds is null", async () => {
    setMockFile("a.md", "# A");
    const spy = fakeProvider({ ready: false });
    const plugin = mockPlugin({
      semanticSearchState: {
        provider: spy.provider,
        pendingProvider: "embedding-gemma",
      },
    } as never);

    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.retryAfterSeconds).toBeNull();
  });

  test("pendingProvider with pendingProviderStartedAt: retryAfterSeconds is a bounded estimate", async () => {
    setMockFile("a.md", "# A");
    setMockFile("b.md", "# B");
    setMockFile("c.md", "# C");
    setMockFile("d.md", "# D");
    const spy = fakeProvider({ ready: false });
    // 1 of 4 files indexed (25%) after 10s elapsed → est. ~30s remaining.
    const fakeStore = { hasRecords: (path: string) => path === "a.md" };
    const plugin = mockPlugin({
      semanticSearchState: {
        provider: spy.provider,
        pendingProvider: "embedding-gemma",
        pendingProviderStartedAt: Date.now() - 10_000,
        store: fakeStore,
      },
    } as never);

    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.percent).toBe(25);
    expect(typeof parsed.retryAfterSeconds).toBe("number");
    expect(parsed.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(parsed.retryAfterSeconds).toBeLessThanOrEqual(600);
  });

  test("native build in progress: reports index_building without ever calling provider.search", async () => {
    setMockFile("a.md", "# A");
    setMockFile("b.md", "# B");
    const spy = fakeProvider({ ready: true }); // native isReady() is always true
    const fakeStore = { hasRecords: (path: string) => path === "a.md" };
    const plugin = mockPlugin({
      semanticSearchState: {
        provider: spy.provider,
        settings: { provider: "native", indexingMode: "live" },
        startIndexerIfNeeded: () => {},
        nativeIndexBuildInProgress: true,
        nativeIndexBuildStartedAt: Date.now() - 5_000,
        store: fakeStore,
      },
    } as never);

    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.errorCode).toBe("index_building");
    expect(parsed.filesTotal).toBe(2);
    expect(parsed.filesIndexed).toBe(1);
    expect(parsed.percent).toBe(50);
    expect(spy.calls()).toHaveLength(0);
  });

  test("native, not building: proceeds to a normal search (regression guard)", async () => {
    const spy = fakeProvider({ ready: true, results: [] });
    const plugin = mockPlugin({
      semanticSearchState: {
        provider: spy.provider,
        settings: { provider: "native", indexingMode: "live" },
        startIndexerIfNeeded: () => {},
        nativeIndexBuildInProgress: false,
      },
    } as never);

    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    });
    expect(result.isError).toBeUndefined();
    expect(spy.calls()).toHaveLength(1);
  });
});

describe("search_vault_smart — notifications/progress push (#344)", () => {
  function buildingPlugin() {
    setMockFile("a.md", "# A");
    setMockFile("b.md", "# B");
    const spy = fakeProvider({ ready: true });
    const plugin = mockPlugin({
      semanticSearchState: {
        provider: spy.provider,
        settings: { provider: "native", indexingMode: "live" },
        startIndexerIfNeeded: () => {},
        nativeIndexBuildInProgress: true,
        nativeIndexBuildStartedAt: Date.now() - 1_000,
      },
    } as never);
    return { plugin, calls: () => spy.calls() };
  }

  test("sends notifications/progress when both progressToken and sendNotification are present", async () => {
    const { plugin } = buildingPlugin();
    const sent: Array<{ method: string; params?: Record<string, unknown> }> =
      [];
    await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
      progressToken: "tok-1",
      sendNotification: async (n) => {
        sent.push(n);
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("notifications/progress");
    expect(sent[0]?.params?.progressToken).toBe("tok-1");
    expect(sent[0]?.params?.progress).toBe(0);
  });

  test("does NOT send a notification when progressToken is absent", async () => {
    const { plugin } = buildingPlugin();
    let called = false;
    await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
      sendNotification: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  test("does NOT send a notification when sendNotification is absent", async () => {
    const { plugin } = buildingPlugin();
    // Absence of sendNotification must not throw even with a progressToken.
    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
      progressToken: "tok-1",
    });
    expect(result.isError).toBe(true);
  });

  test("a throwing sendNotification does not fail the tool call", async () => {
    const { plugin } = buildingPlugin();
    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
      progressToken: "tok-1",
      sendNotification: async () => {
        throw new Error("transport gone");
      },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.errorCode).toBe("index_building");
  });
});

describe("search_vault_smart — content bytes are pinned for a client that never reads _meta (R-06)", () => {
  // The literal below was captured from this handler's actual output for
  // this exact fixture and query, then pasted in — it is not derived or
  // recomputed here. A structural comparison would not catch a change to
  // key order, whitespace or a renamed field. If the payload work ever
  // touches the argument passed to successText(), this test fails
  // loudly; if it only adds a sibling _meta key, this test keeps passing.
  test("JSON.stringify(result.content) matches the captured literal", async () => {
    const sampleResults: SearchResult[] = [
      {
        filePath: "Notes/ml.md",
        heading: "ML Notes",
        excerpt: "ML Notes: introduction to gradient descent.",
        line: 3,
        score: 0.91,
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
    expect(JSON.stringify(result.content)).toBe(
      '[{"type":"text","text":"{\\"results\\":[{\\"filePath\\":\\"Notes/ml.md\\",\\"heading\\":\\"ML Notes\\",\\"excerpt\\":\\"ML Notes: introduction to gradient descent.\\",\\"line\\":3,\\"score\\":0.91}]}"}]',
    );
  });
});

describe("search_vault_smart — result _meta carries the structured payload on success, and is absent on every isError branch (R-05, ADR-0018 D5/D6)", () => {
  test("_meta.io.github.istefox.mcp-connector/searchResults carries vaultName, totalRows, truncated and rows; structuredContent is absent", async () => {
    const sampleResults: SearchResult[] = [
      {
        filePath: "Notes/ml.md",
        heading: "ML Notes",
        excerpt: "ML Notes: introduction to gradient descent.",
        line: 3,
        score: 0.91,
      },
    ];
    const spy = fakeProvider({ ready: true, results: sampleResults });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    const result = (await searchVaultSmartHandler({
      arguments: { query: "ml" },
      app: mockApp(),
      plugin,
    })) as {
      content: Array<{ type: "text"; text: string }>;
      _meta?: Record<string, unknown>;
      structuredContent?: unknown;
    };

    const payload = result._meta?.[
      "io.github.istefox.mcp-connector/searchResults"
    ] as
      | {
          vaultName: string;
          totalRows: number;
          truncated: boolean;
          rows: unknown[];
        }
      | undefined;
    expect(payload).toBeDefined();
    expect(typeof payload?.vaultName).toBe("string");
    expect(typeof payload?.totalRows).toBe("number");
    expect(typeof payload?.truncated).toBe("boolean");
    expect(Array.isArray(payload?.rows)).toBe(true);

    // structuredContent is a first-class, client-visible field; emitting
    // it alongside a payload that only ever lives in _meta would invite a
    // client to expect the pair (ADR-0018 D4). Whether the tool's
    // *tools/list* entry carries no outputSchema is checked where that
    // entry actually exists — mcpServer.test.ts — not on the call result.
    expect("structuredContent" in result).toBe(false);
  });

  test("index_building: a tool that has no results yet must not stamp a results payload it does not have — _meta is absent entirely", async () => {
    setMockFile("a.md", "# A");
    setMockFile("b.md", "# B");
    const spy = fakeProvider({ ready: false });
    const plugin = mockPlugin({
      semanticSearchState: {
        provider: spy.provider,
        pendingProvider: "embedding-gemma",
        store: undefined,
      },
    } as never);

    const result = (await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    })) as { isError?: true; _meta?: Record<string, unknown> };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(
      (result as unknown as { content: Array<{ text: string }> }).content[0]
        .text,
    );
    expect(parsed.errorCode).toBe("index_building");
    expect("_meta" in result).toBe(false);
  });

  test("provider not ready (non-index_building error): _meta is also absent — the rule is isError, not a specific error code", async () => {
    const spy = fakeProvider({ ready: false });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    const result = (await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
    })) as { isError?: true; _meta?: Record<string, unknown> };

    expect(result.isError).toBe(true);
    expect("_meta" in result).toBe(false);
  });
});
