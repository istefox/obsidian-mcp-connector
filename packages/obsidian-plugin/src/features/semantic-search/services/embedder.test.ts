import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetBackendForTesting,
  createEmbedder,
  resolveBackend,
  type PipelineFactory,
  type PipelineFn,
} from "./embedder";

/**
 * Deterministic mock factory: returns a pipeline that hashes the
 * input string into a stable Float32Array. No model download, no
 * WASM, no Transformers.js touched. Each test gets a fresh factory
 * so call counts are isolated.
 */
function makeMockFactory(): {
  factory: PipelineFactory;
  callCount: () => number;
  embedCount: () => number;
} {
  let factoryCalls = 0;
  let embedCalls = 0;
  const factory: PipelineFactory = async (_model: string) => {
    factoryCalls += 1;
    const pipe: PipelineFn = async (input, _opts) => {
      embedCalls += 1;
      const text = Array.isArray(input) ? input.join("|") : input;
      const dim = 8;
      const data = new Float32Array(dim);
      // Stable per-input vector via a tiny hash.
      let h = 2166136261;
      for (let i = 0; i < text.length; i++) {
        h = (h ^ text.charCodeAt(i)) >>> 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
      for (let i = 0; i < dim; i++) {
        data[i] = ((h >>> (i * 4)) & 0xff) / 255;
      }
      return { data, dims: [1, dim] };
    };
    return pipe;
  };
  return {
    factory,
    callCount: () => factoryCalls,
    embedCount: () => embedCalls,
  };
}

describe("embedder", () => {
  test("lazy load: factory not called until first embed", async () => {
    const { factory, callCount } = makeMockFactory();
    const embedder = createEmbedder({ pipelineFactory: factory });
    expect(embedder.isLoaded()).toBe(false);
    expect(callCount()).toBe(0);
    await embedder.embed("hello world");
    expect(embedder.isLoaded()).toBe(true);
    expect(callCount()).toBe(1);
  });

  test("LRU cache: same text → same Float32Array reference", async () => {
    const { factory, embedCount } = makeMockFactory();
    const embedder = createEmbedder({ pipelineFactory: factory });
    const a = await embedder.embed("hello");
    const b = await embedder.embed("hello");
    expect(a).toBe(b);
    expect(embedCount()).toBe(1); // pipeline called only once
  });

  test("LRU cache: 33rd unique query evicts the oldest", async () => {
    const { factory, embedCount } = makeMockFactory();
    const embedder = createEmbedder({
      pipelineFactory: factory,
      cacheSize: 32,
    });
    // Fill cache with 32 distinct queries.
    for (let i = 0; i < 32; i++) {
      await embedder.embed(`q${i}`);
    }
    expect(embedCount()).toBe(32);
    // Re-querying #0 should still hit the cache (most-recent so far).
    const before = embedCount();
    await embedder.embed("q0");
    expect(embedCount()).toBe(before); // hit, no new pipeline call
    // Now insert a 33rd: this evicts the LEAST-recent, which is q1
    // (q0 was just touched). q1 → next embed re-runs the pipeline.
    await embedder.embed("q33");
    expect(embedCount()).toBe(before + 1);
    const beforeQ1 = embedCount();
    await embedder.embed("q1");
    expect(embedCount()).toBe(beforeQ1 + 1); // miss, re-embedded
    // q0 is still cached.
    const beforeQ0 = embedCount();
    await embedder.embed("q0");
    expect(embedCount()).toBe(beforeQ0); // hit
  });

  test("embedBatch: returns one vector per input, dedupes duplicates via cache", async () => {
    const { factory, embedCount } = makeMockFactory();
    const embedder = createEmbedder({ pipelineFactory: factory });
    const out = await embedder.embedBatch(["a", "b", "c", "a"]);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(out[3]); // same Float32Array reference
    // a, b, c are 3 distinct strings → 3 pipeline calls. The duplicate
    // "a" hits the cache after the first one resolves.
    expect(embedCount()).toBeLessThanOrEqual(4);
    expect(embedCount()).toBeGreaterThanOrEqual(3);
  });

  test("unload: clears pipeline; next call re-loads", async () => {
    const { factory, callCount } = makeMockFactory();
    const embedder = createEmbedder({
      pipelineFactory: factory,
      unloadWhenIdle: false,
    });
    await embedder.embed("hello");
    expect(embedder.isLoaded()).toBe(true);
    expect(callCount()).toBe(1);

    await embedder.unload();
    expect(embedder.isLoaded()).toBe(false);

    await embedder.embed("hello again");
    expect(embedder.isLoaded()).toBe(true);
    expect(callCount()).toBe(2);
  });

  test("unload clears the query cache: same text re-embeds after reload", async () => {
    const { factory, callCount, embedCount } = makeMockFactory();
    const embedder = createEmbedder({
      pipelineFactory: factory,
      unloadWhenIdle: false,
    });
    const first = await embedder.embed("hello");
    expect(callCount()).toBe(1);
    expect(embedCount()).toBe(1);

    await embedder.unload();

    // Same text again. If the cache survived the unload it would
    // return the stale array from the previous model instance without
    // reloading; clearing it forces a fresh factory + pipeline call.
    const second = await embedder.embed("hello");
    expect(callCount()).toBe(2); // factory re-invoked (cache cleared)
    expect(embedCount()).toBe(2); // pipeline re-invoked, not a cache hit
    expect(second).not.toBe(first); // distinct array from the reload
  });

  test("idle timer: pipeline unloaded after idleMs since last call", async () => {
    const { factory, callCount } = makeMockFactory();
    const embedder = createEmbedder({
      pipelineFactory: factory,
      idleMs: 30,
      unloadWhenIdle: true,
    });
    await embedder.embed("hello");
    expect(embedder.isLoaded()).toBe(true);
    // Wait past the idle threshold.
    await new Promise((r) => setTimeout(r, 60));
    expect(embedder.isLoaded()).toBe(false);
    // Next call cold-loads again.
    await embedder.embed("world");
    expect(callCount()).toBe(2);
  });

  test("concurrent first calls share one pipeline construction", async () => {
    const { factory, callCount } = makeMockFactory();
    const embedder = createEmbedder({ pipelineFactory: factory });
    const [a, b, c] = await Promise.all([
      embedder.embed("a"),
      embedder.embed("b"),
      embedder.embed("c"),
    ]);
    expect(a).toBeInstanceOf(Float32Array);
    expect(b).toBeInstanceOf(Float32Array);
    expect(c).toBeInstanceOf(Float32Array);
    // Pipeline factory called exactly once even under three parallel
    // cold-load calls.
    expect(callCount()).toBe(1);
  });

  test("returns 8-dim Float32Array from the mock pipeline", async () => {
    const { factory } = makeMockFactory();
    const embedder = createEmbedder({ pipelineFactory: factory });
    const v = await embedder.embed("hello");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(8);
  });

  test("maxInputTokens: passes truncation: true and max_length to pipeline", async () => {
    const pipeOpts: Array<object | undefined> = [];
    const factory: PipelineFactory = async (_model) => {
      return async (_input, opts) => {
        pipeOpts.push(opts);
        return { data: new Float32Array(8), dims: [1, 8] };
      };
    };
    const embedder = createEmbedder({
      pipelineFactory: factory,
      maxInputTokens: 128,
    });
    await embedder.embed("hello");
    expect(pipeOpts[0]).toMatchObject({ truncation: true, max_length: 128 });
  });
});

describe("resolveBackend", () => {
  afterEach(() => {
    __resetBackendForTesting();
  });

  test("returns 'wasm' when navigator is undefined (test environment)", async () => {
    expect(await resolveBackend(undefined)).toBe("wasm");
  });

  test("returns 'wasm' when navigator.gpu is missing", async () => {
    expect(await resolveBackend({})).toBe("wasm");
  });

  test("returns 'wasm' when requestAdapter resolves null", async () => {
    expect(
      await resolveBackend({
        gpu: { requestAdapter: async () => null },
      }),
    ).toBe("wasm");
  });

  test("returns 'wasm' when requestAdapter throws", async () => {
    expect(
      await resolveBackend({
        gpu: {
          requestAdapter: async () => {
            throw new Error("adapter denied");
          },
        },
      }),
    ).toBe("wasm");
  });

  test("returns 'webgpu' when requestAdapter resolves a non-null adapter", async () => {
    expect(
      await resolveBackend({
        gpu: { requestAdapter: async () => ({}) },
      }),
    ).toBe("webgpu");
  });

  test("cached after first call — second call ignores changed navigator", async () => {
    expect(
      await resolveBackend({
        gpu: { requestAdapter: async () => ({}) },
      }),
    ).toBe("webgpu");
    // No reset between calls; the cached result wins.
    expect(await resolveBackend(undefined)).toBe("webgpu");
  });
});
