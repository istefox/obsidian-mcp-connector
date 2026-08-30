import { describe, expect, test } from "bun:test";
import {
  applyRolePrompt,
  createRemoteEmbeddingProvider,
  listRemoteModels,
  normalizeInPlace,
  packBatches,
  parseEmbeddingsResponse,
  probeRemoteDimensions,
  resolveEndpoint,
  type HttpGet,
  type HttpPost,
} from "./remoteEmbeddingProvider";
import {
  mergeRemoteSettings,
  remoteProviderKey,
  resolveRemoteConfig,
  type RemoteEmbeddingConfig,
} from "../types";

const cfg = (
  over: Partial<RemoteEmbeddingConfig> = {},
): RemoteEmbeddingConfig =>
  ({
    ...mergeRemoteSettings({ model: "test-model", dimensions: 3 }),
    ...over,
  }) as RemoteEmbeddingConfig;

/** Records every request and replies from a queue of canned bodies. */
function recordingPost(replies: Array<{ status?: number; body: unknown }>): {
  post: HttpPost;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const post: HttpPost = async ({ url, body }) => {
    calls.push({ url, ...(JSON.parse(body) as Record<string, unknown>) });
    const reply = replies[Math.min(i++, replies.length - 1)];
    return {
      status: reply.status ?? 200,
      text:
        typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body),
    };
  };
  return { post, calls };
}

const vectorsBody = (vectors: number[][]) => ({
  data: vectors.map((embedding, index) => ({ embedding, index })),
});

describe("resolveEndpoint", () => {
  test("accepts a bare server root", () => {
    expect(resolveEndpoint("http://localhost:1234", "embeddings")).toBe(
      "http://localhost:1234/v1/embeddings",
    );
  });

  test("accepts a versioned root and a trailing slash", () => {
    expect(resolveEndpoint("http://localhost:1234/v1/", "embeddings")).toBe(
      "http://localhost:1234/v1/embeddings",
    );
  });

  test("accepts the full endpoint unchanged", () => {
    expect(
      resolveEndpoint("http://localhost:1234/v1/embeddings", "embeddings"),
    ).toBe("http://localhost:1234/v1/embeddings");
  });

  test("swaps a full endpoint for the sibling path", () => {
    expect(
      resolveEndpoint("http://localhost:1234/v1/embeddings", "models"),
    ).toBe("http://localhost:1234/v1/models");
  });
});

describe("parseEmbeddingsResponse", () => {
  test("normalizes vectors to unit length", () => {
    const [vec] = parseEmbeddingsResponse(
      JSON.stringify(vectorsBody([[3, 4, 0]])),
      1,
    );
    expect(vec[0]).toBeCloseTo(0.6, 5);
    expect(vec[1]).toBeCloseTo(0.8, 5);
  });

  test("places vectors by `index`, not arrival order", () => {
    const body = {
      data: [
        { embedding: [0, 1], index: 1 },
        { embedding: [1, 0], index: 0 },
      ],
    };
    const vecs = parseEmbeddingsResponse(JSON.stringify(body), 2);
    expect(Array.from(vecs[0])).toEqual([1, 0]);
    expect(Array.from(vecs[1])).toEqual([0, 1]);
  });

  test("rejects a short response rather than misaligning the batch", () => {
    expect(() =>
      parseEmbeddingsResponse(JSON.stringify(vectorsBody([[1, 0]])), 2),
    ).toThrow(/1 vectors for 2 inputs/);
  });

  test("rejects a repeated index", () => {
    const body = {
      data: [
        { embedding: [1, 0], index: 0 },
        { embedding: [0, 1], index: 0 },
      ],
    };
    expect(() => parseEmbeddingsResponse(JSON.stringify(body), 2)).toThrow(
      /repeated index/,
    );
  });

  test("leaves a zero vector alone instead of dividing by zero", () => {
    const [vec] = parseEmbeddingsResponse(
      JSON.stringify(vectorsBody([[0, 0, 0]])),
      1,
    );
    expect(Array.from(vec)).toEqual([0, 0, 0]);
  });

  test("surfaces a non-JSON body", () => {
    expect(() => parseEmbeddingsResponse("<html>502</html>", 1)).toThrow(
      /not JSON/,
    );
  });
});

describe("normalizeInPlace", () => {
  test("is a no-op on an already-unit vector", () => {
    const v = new Float32Array([1, 0, 0]);
    expect(Array.from(normalizeInPlace(v))).toEqual([1, 0, 0]);
  });
});

describe("applyRolePrompt", () => {
  test("prefixes queries only", () => {
    expect(applyRolePrompt("hello", "query", "Find notes")).toBe(
      "Instruct: Find notes\nQuery: hello",
    );
    expect(applyRolePrompt("hello", "document", "Find notes")).toBe("hello");
  });

  test("an empty instruction means symmetric embedding", () => {
    expect(applyRolePrompt("hello", "query", "   ")).toBe("hello");
  });
});

describe("remoteProviderKey", () => {
  test("encodes model and width, and is filesystem-safe", () => {
    expect(remoteProviderKey("text-embedding-f2llm-v2-1.7b", 2048)).toBe(
      "remote-text-embedding-f2llm-v2-1.7b-2048",
    );
    expect(remoteProviderKey("vendor/Model Name:q8", 1024)).toBe(
      "remote-vendor-model-name-q8-1024",
    );
  });

  test("differs when the width differs, so stores never mix", () => {
    expect(remoteProviderKey("m", 768)).not.toBe(remoteProviderKey("m", 1024));
  });
});

describe("resolveRemoteConfig", () => {
  test("refuses an undetected width", () => {
    expect(
      resolveRemoteConfig({ baseUrl: "http://x", model: "m", dimensions: 0 }),
    ).toBeNull();
  });

  test("refuses a missing model", () => {
    expect(
      resolveRemoteConfig({ baseUrl: "http://x", model: "", dimensions: 8 }),
    ).toBeNull();
  });

  test("clamps out-of-range numeric fields", () => {
    const resolved = resolveRemoteConfig({
      baseUrl: "http://x",
      model: "m",
      dimensions: 8,
      batchSize: 9999,
      maxInputTokens: 1,
    });
    expect(resolved?.batchSize).toBe(128);
    expect(resolved?.maxInputTokens).toBe(64);
  });
});

describe("RemoteEmbeddingProvider.embed", () => {
  test("splits into batches and preserves input order across them", async () => {
    const { post, calls } = recordingPost([
      {
        body: vectorsBody([
          [1, 0, 0],
          [0, 1, 0],
        ]),
      },
      { body: vectorsBody([[0, 0, 1]]) },
    ]);
    const provider = createRemoteEmbeddingProvider(
      "remote-test-model-3",
      cfg({ batchSize: 2 }),
      { post },
    );

    const out = await provider.embed(["a", "b", "c"], "document");

    expect(calls).toHaveLength(2);
    expect(calls[0].input).toEqual(["a", "b"]);
    expect(calls[1].input).toEqual(["c"]);
    expect(out.map((v) => Array.from(v))).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });

  test("applies the query instruction to the wire payload", async () => {
    const { post, calls } = recordingPost([{ body: vectorsBody([[1, 0, 0]]) }]);
    const provider = createRemoteEmbeddingProvider(
      "k",
      cfg({ queryInstruction: "Find notes" }),
      { post },
    );

    await provider.embed(["shabbos"], "query");
    expect(calls[0].input).toEqual(["Instruct: Find notes\nQuery: shabbos"]);
  });

  test("rejects a width that does not match the index it was built for", async () => {
    const { post } = recordingPost([{ body: vectorsBody([[1, 0]]) }]);
    const provider = createRemoteEmbeddingProvider(
      "k",
      cfg({ dimensions: 3 }),
      {
        post,
      },
    );

    await expect(provider.embed(["a"], "document")).rejects.toThrow(
      /returned 2-d vectors, but this index was built at 3-d/,
    );
  });

  test("retries a 503 and succeeds", async () => {
    const { post, calls } = recordingPost([
      { status: 503, body: { error: "loading model" } },
      { body: vectorsBody([[1, 0, 0]]) },
    ]);
    const provider = createRemoteEmbeddingProvider("k", cfg(), { post });

    const out = await provider.embed(["a"], "document");
    expect(calls).toHaveLength(2);
    expect(Array.from(out[0])).toEqual([1, 0, 0]);
  });

  test("does not retry a 404, and surfaces the server's reason", async () => {
    const { post, calls } = recordingPost([
      { status: 404, body: { error: { message: "model not found" } } },
    ]);
    const provider = createRemoteEmbeddingProvider("k", cfg(), { post });

    await expect(provider.embed(["a"], "document")).rejects.toThrow(
      /model not found/,
    );
    expect(calls).toHaveLength(1);
  });

  test("embeds nothing without calling the server", async () => {
    const { post, calls } = recordingPost([{ body: vectorsBody([]) }]);
    const provider = createRemoteEmbeddingProvider("k", cfg(), { post });
    expect(await provider.embed([], "document")).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("RemoteEmbeddingProvider.isAvailable", () => {
  const okGet: HttpGet = async () => ({
    status: 200,
    text: JSON.stringify({ data: [] }),
  });

  test("is true when the server answers", async () => {
    const provider = createRemoteEmbeddingProvider("k", cfg(), { get: okGet });
    expect(await provider.isAvailable()).toBe(true);
  });

  test("is false when the server is unreachable", async () => {
    const provider = createRemoteEmbeddingProvider("k", cfg(), {
      get: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await provider.isAvailable()).toBe(false);
  });

  test("caches the verdict instead of probing per file", async () => {
    let probes = 0;
    const provider = createRemoteEmbeddingProvider("k", cfg(), {
      get: async () => {
        probes++;
        return { status: 200, text: "{}" };
      },
    });
    await provider.isAvailable();
    await provider.isAvailable();
    expect(probes).toBe(1);
  });

  test("reports no downloadable model — nothing lands in the vault", () => {
    const provider = createRemoteEmbeddingProvider("k", cfg());
    expect(provider.getModelSizeBytes()).toBe(0);
  });
});

describe("probeRemoteDimensions", () => {
  test("returns the width the server actually produced", async () => {
    const { post, calls } = recordingPost([
      { body: vectorsBody([[1, 2, 3, 4]]) },
    ]);
    const dims = await probeRemoteDimensions(
      { baseUrl: "http://localhost:1234", model: "m", apiKey: "" },
      { post },
    );
    expect(dims).toBe(4);
    expect(calls[0].url).toBe("http://localhost:1234/v1/embeddings");
  });

  test("reports an unreachable or misconfigured server", async () => {
    const { post } = recordingPost([
      { status: 400, body: { error: "no embedding model loaded" } },
    ]);
    await expect(
      probeRemoteDimensions(
        { baseUrl: "http://localhost:1234", model: "m", apiKey: "" },
        { post },
      ),
    ).rejects.toThrow(/no embedding model loaded/);
  });
});

describe("listRemoteModels", () => {
  test("returns sorted model ids", async () => {
    const get: HttpGet = async () => ({
      status: 200,
      text: JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha" }] }),
    });
    expect(
      await listRemoteModels({ baseUrl: "http://x", apiKey: "" }, { get }),
    ).toEqual(["alpha", "zeta"]);
  });

  test("tolerates a server without /v1/models", async () => {
    const get: HttpGet = async () => ({ status: 200, text: "not json" });
    expect(
      await listRemoteModels({ baseUrl: "http://x", apiKey: "" }, { get }),
    ).toEqual([]);
  });
});

describe("oversized-input guards", () => {
  test("packBatches bounds a request by count and by total size", () => {
    // Count is the binding limit when items are small.
    expect(packBatches(["a", "b", "c"], 2, 1000)).toEqual([["a", "b"], ["c"]]);
    // Size is the binding limit when they are not.
    expect(packBatches(["aaaa", "bbbb", "cc"], 8, 8)).toEqual([
      ["aaaa", "bbbb"],
      ["cc"],
    ]);
  });

  test("packBatches sends an over-budget item alone rather than dropping it", () => {
    expect(packBatches(["x", "y".repeat(50), "z"], 8, 10)).toEqual([
      ["x"],
      ["y".repeat(50)],
      ["z"],
    ]);
  });

  test("a whole-file code fence is truncated instead of taking the server down", async () => {
    // The real shape: מפתחות/עניני דיומא.md is one 387-line dataviewjs
    // fence, ~19.8k chars, which the chunker keeps atomic.
    const dashboard = "```dataviewjs\n" + "dv.list(x);\n".repeat(1800) + "```";
    expect(dashboard.length).toBeGreaterThan(19000);

    const { post, calls } = recordingPost([{ body: vectorsBody([[1, 0, 0]]) }]);
    const provider = createRemoteEmbeddingProvider(
      "k",
      cfg({ maxInputChars: 6000 }),
      { post },
    );

    await provider.embed([dashboard], "document");

    const sent = (calls[0].input as string[])[0];
    expect(sent.length).toBe(6000);
    expect(sent).toBe(dashboard.slice(0, 6000));
  });

  test("ordinary chunks are never touched by the ceiling", async () => {
    const prose = "מעשה הגברא ומצב החפץ. ".repeat(60); // ~1.3k chars
    const { post, calls } = recordingPost([{ body: vectorsBody([[1, 0, 0]]) }]);
    const provider = createRemoteEmbeddingProvider("k", cfg(), { post });

    await provider.embed([prose], "document");
    expect((calls[0].input as string[])[0]).toBe(prose);
  });

  test("truncation happens before prompting, so the instruction survives", async () => {
    const long = "z".repeat(9000);
    const { post, calls } = recordingPost([{ body: vectorsBody([[1, 0, 0]]) }]);
    const provider = createRemoteEmbeddingProvider(
      "k",
      cfg({ maxInputChars: 100, queryInstruction: "Find notes" }),
      { post },
    );

    await provider.embed([long], "query");
    const sent = (calls[0].input as string[])[0];
    expect(sent.startsWith("Instruct: Find notes\nQuery: ")).toBe(true);
    expect(sent.endsWith("z".repeat(100))).toBe(true);
  });

  test("a batch of legal-but-large chunks is split across requests", async () => {
    const chunk = "w".repeat(3000);
    const { post, calls } = recordingPost([
      {
        body: vectorsBody([
          [1, 0, 0],
          [1, 0, 0],
        ]),
      },
      {
        body: vectorsBody([
          [1, 0, 0],
          [1, 0, 0],
        ]),
      },
    ]);
    const provider = createRemoteEmbeddingProvider(
      "k",
      cfg({ batchSize: 8, maxRequestChars: 6000 }),
      { post },
    );

    await provider.embed([chunk, chunk, chunk, chunk], "document");
    expect(calls).toHaveLength(2);
    expect((calls[0].input as string[]).length).toBe(2);
  });
});
