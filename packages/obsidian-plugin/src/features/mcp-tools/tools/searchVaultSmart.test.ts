import { describe, expect, test, beforeEach } from "bun:test";
import {
  groupBestPerFile,
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
import { startSmartSearchBinding } from "$/shared";
import type McpToolsPlugin from "$/main";
import {
  refreshAutoProvider,
  type SemanticSearchState,
} from "$/features/semantic-search";
import { createProviderFactory } from "$/features/semantic-search/services/providerFactory";
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
    expect(parsed.results).toEqual([
      {
        ...sampleResults[0],
        uri: "obsidian://open?vault=Test%20Vault&file=Notes%2Fml.md",
      },
      {
        ...sampleResults[1],
        uri: "obsidian://open?vault=Test%20Vault&file=Notes%2Fdl.md",
      },
    ]);
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
    expect(parsed.results).toEqual(
      sampleResults.map((r) => ({
        ...r,
        uri: `obsidian://open?vault=Test%20Vault&file=${encodeURIComponent(r.filePath)}`,
      })),
    );
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
    // Repaired for ADR-0026 (issue #533): every row now carries a
    // file-level `uri` (see the describe block below), a deliberate shape
    // change to this literal, not drift.
    expect(JSON.stringify(result.content)).toBe(
      '[{"type":"text","text":"{\\"results\\":[{\\"filePath\\":\\"Notes/ml.md\\",\\"heading\\":\\"ML Notes\\",\\"excerpt\\":\\"ML Notes: introduction to gradient descent.\\",\\"line\\":3,\\"score\\":0.91,\\"uri\\":\\"obsidian://open?vault=Test%20Vault&file=Notes%2Fml.md\\"}]}"}]',
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

    // ADR-0026 D10: `uri` is a wire-only addition, mapped in immediately
    // before JSON.stringify. It must never reach the `_meta` payload rows.
    for (const row of payload?.rows ?? []) {
      expect((row as Record<string, unknown>).uri).toBeUndefined();
    }
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

describe("search_vault_smart — _meta payload gated on declared UI capability (R-09, ADR-0023 D9)", () => {
  const PAYLOAD_KEY = "io.github.istefox.mcp-connector/searchResults";
  const sampleResults: SearchResult[] = [
    {
      filePath: "Notes/ml.md",
      heading: "ML Notes",
      excerpt: "ML Notes: introduction to gradient descent.",
      line: 3,
      score: 0.91,
    },
  ];

  // FAILING today: searchVaultSmartHandler calls withSearchResultsPayload
  // unconditionally and never reads hasUiCapability at all.
  test("hasUiCapability: false — the modern era's declared non-support — omits the _meta payload", async () => {
    const spy = fakeProvider({ ready: true, results: sampleResults });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    const result = (await searchVaultSmartHandler({
      arguments: { query: "ml" },
      app: mockApp(),
      plugin,
      hasUiCapability: false,
    })) as { _meta?: Record<string, unknown> };

    expect(result._meta?.[PAYLOAD_KEY]).toBeUndefined();
  });

  test("hasUiCapability: true — the modern era's declared support — carries the _meta payload", async () => {
    const spy = fakeProvider({ ready: true, results: sampleResults });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    const result = (await searchVaultSmartHandler({
      arguments: { query: "ml" },
      app: mockApp(),
      plugin,
      hasUiCapability: true,
    })) as { _meta?: Record<string, unknown> };

    expect(result._meta?.[PAYLOAD_KEY]).toBeDefined();
  });

  // Regression guard, not a task-8 failing case: hasUiCapability absent is
  // the legacy-era shape (no per-request signal exists there) AND every
  // caller that predates this field. Must stay green through task 8.
  test("hasUiCapability omitted (legacy era / callers that predate the signal) — payload stays unconditional", async () => {
    const spy = fakeProvider({ ready: true, results: sampleResults });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    const result = (await searchVaultSmartHandler({
      arguments: { query: "ml" },
      app: mockApp(),
      plugin,
    })) as { _meta?: Record<string, unknown> };

    expect(result._meta?.[PAYLOAD_KEY]).toBeDefined();
  });

  // isError already has its own dedicated regression coverage above
  // ("index_building..." / "provider not ready...", R-05); this adds the
  // one case those do not: isError must stay _meta-free even when the
  // caller ALSO declares hasUiCapability: true — the branch order must be
  // isError-first, capability-gate-second, never the reverse.
  test("isError with hasUiCapability: true still carries no _meta key", async () => {
    const spy = fakeProvider({ ready: false });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);

    const result = (await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin,
      hasUiCapability: true,
    })) as { isError?: true; _meta?: Record<string, unknown> };

    expect(result.isError).toBe(true);
    expect("_meta" in result).toBe(false);
  });
});

describe("search_vault_smart — file-level uri (ADR-0026, R-01, R-08, D10)", () => {
  test("every result row carries a uri built from filePath, never a heading fragment even when heading is non-null", async () => {
    const sampleResults: SearchResult[] = [
      {
        filePath: "Notes/ml.md",
        heading: "ML Notes",
        excerpt: "excerpt",
        line: 3,
        score: 0.91,
      },
      {
        filePath: "Notes/dl.md",
        heading: null,
        excerpt: "excerpt 2",
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
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    for (const row of parsed.results) {
      expect(row.uri).toBe(
        `obsidian://open?vault=Test%20Vault&file=${encodeURIComponent(row.filePath)}`,
      );
      expect(row.uri).not.toContain("%23");
    }
  });
});

describe("search_vault_smart — excerptLength and compact (#567)", () => {
  const sample: SearchResult[] = [
    {
      filePath: "Notes/ml.md",
      heading: "ML Notes",
      excerpt: "ML Notes: introduction to gradient descent.",
      line: 3,
      score: 0.91,
    },
    {
      filePath: "Notes/short.md",
      heading: "Short",
      excerpt: "tiny",
      line: 1,
      score: 0.5,
    },
  ];

  async function run(args: Record<string, unknown>) {
    const spy = fakeProvider({ ready: true, results: sample });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);
    const result = await searchVaultSmartHandler({
      arguments: { query: "ml", ...args },
      app: mockApp(),
      plugin,
    });
    const text = (result.content[0] as { text: string }).text;
    return {
      result,
      rows: JSON.parse(text).results as Record<string, unknown>[],
    };
  }

  test("excerptLength truncates long excerpts with an ellipsis and leaves short ones", async () => {
    const { rows } = await run({ excerptLength: 8 });
    expect(rows[0]!.excerpt).toBe("ML Notes…");
    expect(rows[1]!.excerpt).toBe("tiny");
    expect(rows[0]!.uri).toBeDefined();
  });

  test("excerptLength 0 drops the excerpt but keeps the other fields", async () => {
    const { rows } = await run({ excerptLength: 0 });
    expect("excerpt" in rows[0]!).toBe(false);
    expect(rows[0]!.filePath).toBe("Notes/ml.md");
    expect(rows[0]!.score).toBe(0.91);
  });

  test("compact returns only filePath and score, and wins over excerptLength", async () => {
    const { rows } = await run({ compact: true, excerptLength: 100 });
    expect(rows).toEqual([
      { filePath: "Notes/ml.md", score: 0.91 },
      { filePath: "Notes/short.md", score: 0.5 },
    ]);
  });

  test("the MCP Apps payload keeps the full rows under compact", async () => {
    const { result } = await run({ compact: true });
    const meta = (
      result as { _meta?: Record<string, { rows: Array<{ excerpt: string }> }> }
    )._meta!;
    const payload = Object.values(meta)[0]!;
    expect(payload.rows[0]!.excerpt).toBe(
      "ML Notes: introduction to gradient descent.",
    );
  });

  test("omitting both options leaves the wire shape unchanged", async () => {
    const { rows } = await run({});
    expect(rows[0]!.excerpt).toBe(
      "ML Notes: introduction to gradient descent.",
    );
    expect(rows[0]!.heading).toBe("ML Notes");
  });
});

describe("search_vault_smart — groupByFile", () => {
  const chunk = (
    filePath: string,
    score: number,
    heading = "H",
  ): SearchResult => ({
    filePath,
    heading,
    excerpt: `${filePath} ${heading}`,
    line: 1,
    score,
  });
  const sample: SearchResult[] = [
    chunk("A.md", 0.9, "a1"),
    chunk("A.md", 0.8, "a2"),
    chunk("B.md", 0.85, "b1"),
    chunk("A.md", 0.7, "a3"),
    chunk("C.md", 0.6, "c1"),
  ];

  async function run(args: Record<string, unknown>, results = sample) {
    const spy = fakeProvider({ ready: true, results });
    const plugin = mockPlugin({
      semanticSearchState: { provider: spy.provider },
    } as never);
    const result = await searchVaultSmartHandler({
      arguments: { query: "q", ...args },
      app: mockApp(),
      plugin,
    });
    const text = (result.content[0] as { text: string }).text;
    return {
      result,
      spy,
      rows: JSON.parse(text).results as Record<string, unknown>[],
    };
  }

  test("keeps the best chunk per file, ranked by score", async () => {
    const { rows } = await run({ groupByFile: true });
    expect(rows.map((r) => [r.filePath, r.heading])).toEqual([
      ["A.md", "a1"],
      ["B.md", "b1"],
      ["C.md", "c1"],
    ]);
  });

  test("limit counts notes and the provider is asked for a larger pool", async () => {
    const { rows, spy } = await run({ groupByFile: true, limit: 2 });
    expect(rows.map((r) => r.filePath)).toEqual(["A.md", "B.md"]);
    expect(spy.calls()[0]!.opts.limit).toBe(8);
  });

  test("the pool never drops below the requested limit", async () => {
    const { spy } = await run({ groupByFile: true, limit: 200 });
    expect(spy.calls()[0]!.opts.limit).toBe(200);
  });

  test("the pool is capped at 100 chunks", async () => {
    const { spy } = await run({ groupByFile: true, limit: 50 });
    expect(spy.calls()[0]!.opts.limit).toBe(100);
  });

  test("compact + groupByFile returns one filePath/score pair per note", async () => {
    const { rows } = await run({ groupByFile: true, compact: true });
    expect(rows).toEqual([
      { filePath: "A.md", score: 0.9 },
      { filePath: "B.md", score: 0.85 },
      { filePath: "C.md", score: 0.6 },
    ]);
  });

  test("an excluded file does not take a slot", async () => {
    setMockIgnored("A.md");
    const { rows } = await run({ groupByFile: true, limit: 2 });
    expect(rows.map((r) => r.filePath)).toEqual(["B.md", "C.md"]);
  });

  test("the MCP Apps payload is grouped too", async () => {
    const { result } = await run({ groupByFile: true });
    const meta = (
      result as {
        _meta?: Record<string, { rows: Array<{ filePath: string }> }>;
      }
    )._meta!;
    const payload = Object.values(meta)[0]!;
    expect(payload.rows.map((r) => r.filePath)).toEqual([
      "A.md",
      "B.md",
      "C.md",
    ]);
  });

  test("without the flag, chunks of the same file stay separate and limit is forwarded untouched", async () => {
    const { rows, spy } = await run({ limit: 5 });
    expect(rows).toHaveLength(5);
    expect(spy.calls()[0]!.opts.limit).toBe(5);
  });

  test("groupBestPerFile returns fewer than limit when the pool has fewer files", () => {
    expect(groupBestPerFile(sample, 10).map((r) => r.filePath)).toEqual([
      "A.md",
      "B.md",
      "C.md",
    ]);
  });
});

describe("search_vault_smart — Smart Connections that loads after the startup poll (#676)", () => {
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * The production shape: a real binding (poll + refresh), a real provider
   * factory and the real `refreshAutoProvider`, wired the way main.ts's
   * `bindSmartSearch` / `refreshSmartSearchBinding` wire them. Only the
   * Smart Connections plugin itself is fake, and it is absent until the
   * test installs it, after the poll has already given up.
   */
  async function lateSmartConnections(provider: "auto" | "smart-connections") {
    setMockFile("Notes/late.md", "late body");
    const registry: Record<string, unknown> = {};
    const lookups: string[][] = [];
    const plugin = mockPlugin() as McpToolsPlugin & {
      refreshSmartSearchBinding: () => boolean;
    };
    (plugin.app as unknown as { plugins: unknown }).plugins = {
      plugins: registry,
    };
    let kicks = 0;
    const choose = createProviderFactory({
      plugin,
      embedder: {} as never,
      store: {} as never,
    });
    const settings = { provider, indexingMode: "live" } as const;
    const state = {
      provider: choose(settings as never),
      settings,
      chooser: choose,
      startIndexerIfNeeded: () => {
        kicks += 1;
      },
    } as unknown as SemanticSearchState;
    plugin.semanticSearchState = state;
    let completed = 0;
    const binding = startSmartSearchBinding(plugin, {
      bind: (dep) => {
        plugin.smartSearch = dep.api;
        refreshAutoProvider(state);
      },
      onComplete: () => completed++,
      intervalMs: 5,
      timeoutMs: 30,
    });
    plugin.refreshSmartSearchBinding = () => binding.refresh();
    await settle(60);
    expect(completed).toBe(1);
    expect(plugin.smartSearch).toBeUndefined();

    const install = () => {
      registry["smart-connections"] = {
        env: {
          smart_sources: {
            lookup: async (params: { hypotheticals: string[] }) => {
              lookups.push(params.hypotheticals);
              return [
                {
                  item: {
                    path: "Notes/late.md",
                    breadcrumbs: "Late",
                    read: async () => "late body",
                  },
                  score: 0.9,
                },
              ];
            },
          },
        },
      };
    };
    const call = () =>
      searchVaultSmartHandler({
        arguments: { query: "late" },
        app: mockApp(),
        plugin,
      });
    return {
      state,
      binding,
      install,
      call,
      lookups,
      kicks: () => kicks,
    };
  }

  test("auto: the next call binds Smart Connections, re-runs the chooser and is served by it", async () => {
    const t = await lateSmartConnections("auto");
    const nativeProvider = t.state.provider;
    t.install();
    const result = await t.call();
    expect(result.isError).toBeFalsy();
    expect(t.state.provider).not.toBe(nativeProvider);
    expect(t.lookups).toEqual([["late"]]);
    expect(result.content[0]?.text).toContain("Notes/late.md");
    expect(t.kicks()).toBe(0);
    t.binding.cancel();
  });

  test("smart-connections: not ready before it loads, served on the next call after", async () => {
    const t = await lateSmartConnections("smart-connections");
    const before = await t.call();
    expect(before.isError).toBe(true);
    const text = before.content[0]?.text ?? "";
    expect(text).toMatch(/smart connections/i);
    expect(text).toMatch(/checks again/i);
    expect(text).not.toMatch(/\bwait\b/i);

    t.install();
    const after = await t.call();
    expect(after.isError).toBeFalsy();
    expect(t.lookups).toEqual([["late"]]);
    expect(after.content[0]?.text).toContain("Notes/late.md");
    t.binding.cancel();
  });
});

describe("search_vault_smart — v2 window.SmartSearch that gains search after the poll (#676)", () => {
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("auto: the bound object turning callable in place swaps the provider and Smart Connections serves", async () => {
    setMockFile("Notes/v2.md", "v2 body");
    const queries: string[] = [];
    const legacy: {
      search?: (q: string) => Promise<unknown[]>;
    } = {};
    const w = window as unknown as { SmartSearch?: unknown };
    w.SmartSearch = legacy;
    try {
      const plugin = mockPlugin() as McpToolsPlugin & {
        refreshSmartSearchBinding: () => boolean;
      };
      (plugin.app as unknown as { plugins: unknown }).plugins = {
        plugins: {},
      };
      const choose = createProviderFactory({
        plugin,
        embedder: {} as never,
        store: {} as never,
      });
      const settings = { provider: "auto", indexingMode: "live" } as const;
      const state = {
        provider: choose(settings as never),
        settings,
        chooser: choose,
        startIndexerIfNeeded: () => {},
      } as unknown as SemanticSearchState;
      plugin.semanticSearchState = state;
      const binding = startSmartSearchBinding(plugin, {
        bind: (dep) => {
          plugin.smartSearch = dep.api;
          refreshAutoProvider(state);
        },
        onComplete: () => {},
        intervalMs: 5,
        timeoutMs: 30,
      });
      plugin.refreshSmartSearchBinding = () => binding.refresh();
      await settle(60);
      // The poll bound the incomplete object and gave up; auto is native.
      expect(plugin.smartSearch).toBe(legacy as never);
      const nativeProvider = state.provider;

      legacy.search = async (q: string) => {
        queries.push(q);
        return [
          {
            item: {
              path: "Notes/v2.md",
              breadcrumbs: "V2",
              read: async () => "v2 body",
            },
            score: 0.8,
          },
        ];
      };
      const result = await searchVaultSmartHandler({
        arguments: { query: "v2" },
        app: mockApp(),
        plugin,
      });
      expect(result.isError).toBeFalsy();
      expect(state.provider).not.toBe(nativeProvider);
      expect(queries).toEqual(["v2"]);
      expect(result.content[0]?.text).toContain("Notes/v2.md");
      binding.cancel();
    } finally {
      delete w.SmartSearch;
    }
  });
});

describe("search_vault_smart — DLC index not ready (reported on #678)", () => {
  const GEMMA = "embedding-gemma-300m";
  const hit: SearchResult = {
    filePath: "a.md",
    heading: null,
    excerpt: "alpha",
    line: 1,
    score: 0.9,
  };

  /**
   * State as production wires it under the Gemma setting. The provider
   * is a ready one, like the real native provider, whose isReady() is
   * always true: a `ready: false` fake would hide the empty-index path.
   */
  function gemmaState(opts: {
    results?: SearchResult[];
    ready?: boolean;
    building?: boolean;
    buildError?: string;
    switching?: boolean;
    /** The live provider's own readiness (Smart Connections can be false). */
    providerReady?: boolean;
    /**
     * `pendingProvider` set while the live provider already reads the
     * Gemma store: Gemma selected at startup with no index, then any
     * settings save goes through `applySettings`.
     */
    pendingWithoutSwitch?: boolean;
  }) {
    const spy = fakeProvider({
      ready: opts.providerReady ?? true,
      results: opts.results ?? [],
    });
    const storeKeys: string[] = [];
    const rebuildsStarted: string[] = [];
    const gemmaStore = { hasRecords: (path: string) => path === "a.md" };
    const state = {
      provider: spy.provider,
      settings: { provider: "embedding-gemma", indexingMode: "live" },
      pendingProvider:
        opts.switching || opts.pendingWithoutSwitch ? GEMMA : null,
      pendingProviderStartedAt:
        opts.switching || opts.pendingWithoutSwitch ? Date.now() - 5_000 : null,
      // A switch keeps the provider built from the previous setting.
      providerSetting: opts.switching ? "native" : "embedding-gemma",
      // MiniLM's store: progress must never be read from it.
      store: { hasRecords: () => false },
      registry: {
        isReady: (key: string) => key === GEMMA && opts.ready === true,
        storeFor: (key: string) => {
          storeKeys.push(key);
          return gemmaStore;
        },
      },
      isRebuildingFor: (key: string) => key === GEMMA && opts.building === true,
      dlcRebuildErrors: new Map(
        opts.buildError ? [[GEMMA, opts.buildError]] : [],
      ),
      startRebuildFor: (key: string) => {
        rebuildsStarted.push(key);
      },
    };
    return { spy, state, storeKeys, rebuildsStarted };
  }

  async function run(state: unknown) {
    const result = await searchVaultSmartHandler({
      arguments: { query: "x" },
      app: mockApp(),
      plugin: mockPlugin({ semanticSearchState: state } as never),
    });
    return {
      result,
      parsed: JSON.parse(result.content[0]?.text ?? "{}"),
    };
  }

  beforeEach(() => {
    setMockFile("a.md", "# A");
    setMockFile("b.md", "# B");
  });

  test("first-ever build: index_building with Gemma's progress, the unfinished index is not queried", async () => {
    const { spy, state, storeKeys } = gemmaState({ building: true });
    const { result, parsed } = await run(state);
    expect(result.isError).toBe(true);
    expect(parsed.errorCode).toBe("index_building");
    expect(parsed.filesIndexed).toBe(1);
    expect(parsed.filesTotal).toBe(2);
    expect(parsed.percent).toBe(50);
    expect(storeKeys).toEqual([GEMMA]);
    expect(spy.calls()).toHaveLength(0);
  });

  test("first-ever build with some notes indexed: still a status, never partial results", async () => {
    const { spy, state } = gemmaState({ building: true, results: [hit] });
    const { parsed } = await run(state);
    expect(parsed.errorCode).toBe("index_building");
    expect(spy.calls()).toHaveLength(0);
  });

  test("switch into Gemma, previous index empty: index_building instead of a silent []", async () => {
    const { spy, state } = gemmaState({ building: true, switching: true });
    const { result, parsed } = await run(state);
    expect(result.isError).toBe(true);
    expect(parsed.errorCode).toBe("index_building");
    expect(parsed.percent).toBe(50);
    expect(typeof parsed.retryAfterSeconds).toBe("number");
    expect(spy.calls()).toHaveLength(1);
  });

  test("switch into Gemma, previous index populated: its results are served", async () => {
    const { state } = gemmaState({
      building: true,
      switching: true,
      results: [hit],
    });
    const { result, parsed } = await run(state);
    expect(result.isError).toBeFalsy();
    expect(parsed.results.map((r: SearchResult) => r.filePath)).toEqual([
      "a.md",
    ]);
  });

  test("Gemma unready since startup, then a settings save: still a status, the partial index is not served", async () => {
    const { spy, state } = gemmaState({
      building: true,
      pendingWithoutSwitch: true,
      results: [hit],
    });
    const { parsed } = await run(state);
    expect(parsed.errorCode).toBe("index_building");
    expect(spy.calls()).toHaveLength(0);
  });

  test("switch with an unknown provider origin: fails closed to a status", async () => {
    const { spy, state } = gemmaState({
      building: true,
      switching: true,
      results: [hit],
    });
    const { parsed } = await run({ ...state, providerSetting: null });
    expect(parsed.errorCode).toBe("index_building");
    expect(spy.calls()).toHaveLength(0);
  });

  test("switch to e5 away from an unfinished Gemma index: no complete previous index, so a status", async () => {
    const E5 = "multilingual-e5-base";
    const spy = fakeProvider({ ready: true, results: [hit] });
    const { parsed } = await run({
      provider: spy.provider,
      settings: { provider: "multilingual-e5-base", indexingMode: "live" },
      pendingProvider: E5,
      pendingProviderStartedAt: Date.now() - 5_000,
      providerSetting: "embedding-gemma",
      registry: {
        isReady: () => false,
        storeFor: () => ({ hasRecords: () => false }),
      },
      isRebuildingFor: (key: string) => key === E5,
      dlcRebuildErrors: new Map(),
    });
    expect(parsed.errorCode).toBe("index_building");
    expect(spy.calls()).toHaveLength(0);
  });

  test("rebuild over a ready Gemma index: the previous index keeps answering", async () => {
    const { spy, state } = gemmaState({
      ready: true,
      building: true,
      results: [hit],
    });
    const { result, parsed } = await run(state);
    expect(result.isError).toBeFalsy();
    expect(parsed.results).toHaveLength(1);
    expect(spy.calls()).toHaveLength(1);
  });

  test("rebuild finished: results come from the Gemma index", async () => {
    const { state } = gemmaState({ ready: true, results: [hit] });
    const { result, parsed } = await run(state);
    expect(result.isError).toBeFalsy();
    expect(parsed.results).toHaveLength(1);
  });

  test("rebuild finished on an index with no match: [] is a real answer", async () => {
    const { result, parsed } = await run(gemmaState({ ready: true }).state);
    expect(result.isError).toBeFalsy();
    expect(parsed.results).toEqual([]);
  });

  test("failed build: index_build_failed with the reason, not a permanent index_building", async () => {
    const { spy, state } = gemmaState({ buildError: "network down" });
    const { result, parsed } = await run(state);
    expect(result.isError).toBe(true);
    expect(parsed.errorCode).toBe("index_build_failed");
    expect(parsed.error).toContain("network down");
    expect(spy.calls()).toHaveLength(0);
  });

  test("failed build during a switch, previous index empty: index_build_failed", async () => {
    const { parsed } = await run(
      gemmaState({ buildError: "network down", switching: true }).state,
    );
    expect(parsed.errorCode).toBe("index_build_failed");
  });

  test("failed build during a switch from a provider that is not ready: index_build_failed, not index_building", async () => {
    const { spy, state } = gemmaState({
      buildError: "network down",
      switching: true,
      providerReady: false,
    });
    const { parsed } = await run(state);
    expect(parsed.errorCode).toBe("index_build_failed");
    expect(spy.calls()).toHaveLength(0);
  });

  test("index never built and no build running: index_not_built, no build is started", async () => {
    const { spy, state, rebuildsStarted } = gemmaState({});
    const { result, parsed } = await run(state);
    expect(result.isError).toBe(true);
    expect(parsed.errorCode).toBe("index_not_built");
    expect(parsed.error).toMatch(/Rebuild index from scratch/);
    expect(spy.calls()).toHaveLength(0);
    expect(rebuildsStarted).toEqual([]);
  });
});
