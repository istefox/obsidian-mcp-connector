import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTransformersProvider } from "./transformersProvider";
import { createEmbeddingGemmaProvider } from "./embeddingGemmaProvider";
import { createMultilingualE5Provider } from "./multilingualE5Provider";
import { createNativeEmbeddingProvider } from "./nativeEmbeddingProvider";
import {
  __resetBackendForTesting,
  resolveBackend,
  type Embedder,
} from "./embedder";

type MockPipelineFn = (
  input: string | string[],
  opts?: object,
) => Promise<{ data: Float32Array; dims: number[] }>;

function makeMockFactory(dim: number): {
  factory: (model: string) => Promise<MockPipelineFn>;
  calls: string[];
} {
  const calls: string[] = [];
  const factory = async (_model: string): Promise<MockPipelineFn> => {
    return async (input) => {
      const texts = Array.isArray(input) ? input : [input];
      calls.push(...texts);
      return { data: new Float32Array(dim), dims: [1, dim] };
    };
  };
  return { factory, calls };
}

function makeMockFactoryWithOpts(dim: number): {
  factory: (model: string) => Promise<MockPipelineFn>;
  optsLog: Array<object | undefined>;
} {
  const optsLog: Array<object | undefined> = [];
  const factory = async (_model: string): Promise<MockPipelineFn> => {
    return async (_input, opts) => {
      optsLog.push(opts);
      return { data: new Float32Array(dim), dims: [1, dim] };
    };
  };
  return { factory, optsLog };
}

function makeMockEmbedder(loaded = true): Embedder {
  return {
    embed: async (_text) => new Float32Array(384),
    embedBatch: async (texts) => texts.map(() => new Float32Array(384)),
    unload: async () => {},
    isLoaded: () => loaded,
  };
}

// Reset the cached backend resolution between tests so the wasm/webgpu
// dispatch tests below don't bleed cached state into each other.
beforeEach(() => {
  __resetBackendForTesting();
});
afterEach(() => {
  __resetBackendForTesting();
});

describe("TransformersProviderImpl", () => {
  test("applies task prompt before calling pipeline", async () => {
    const { factory, calls } = makeMockFactory(768);
    const provider = createTransformersProvider({
      modelId: "test-model",
      providerKey: "test",
      dimensions: 768,
      maxInputTokensByBackend: { wasm: 512, webgpu: 512 },
      modelSizeBytes: 1_000_000,
      taskPrompt: (text, role) => `${role}: ${text}`,
      pipelineFactory: factory,
    });

    await provider.embed(["hello", "world"], "document");
    expect(calls).toEqual(["document: hello", "document: world"]);

    await provider.embed(["find me"], "query");
    expect(calls).toContain("query: find me");
  });

  test("isAvailable always returns true (pipeline lazy-loads on embed)", async () => {
    const { factory } = makeMockFactory(768);
    const provider = createTransformersProvider({
      modelId: "test-model",
      providerKey: "test",
      dimensions: 768,
      maxInputTokensByBackend: { wasm: 512, webgpu: 512 },
      modelSizeBytes: 1_000_000,
      taskPrompt: (t) => t,
      pipelineFactory: factory,
    });

    expect(await provider.isAvailable()).toBe(true);
    await provider.embed(["hello"], "document");
    expect(await provider.isAvailable()).toBe(true);
  });

  test("returns Float32Array vectors of declared dimensions", async () => {
    const { factory } = makeMockFactory(768);
    const provider = createTransformersProvider({
      modelId: "test-model",
      providerKey: "test",
      dimensions: 768,
      maxInputTokensByBackend: { wasm: 512, webgpu: 512 },
      modelSizeBytes: 1_000_000,
      taskPrompt: (t) => t,
      pipelineFactory: factory,
    });

    const vectors = await provider.embed(["text"], "document");
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]!.length).toBe(768);
  });

  test("getModelSizeBytes returns the declared constant", () => {
    const { factory } = makeMockFactory(768);
    const provider = createTransformersProvider({
      modelId: "test-model",
      providerKey: "test",
      dimensions: 768,
      maxInputTokensByBackend: { wasm: 512, webgpu: 512 },
      modelSizeBytes: 42_000_000,
      taskPrompt: (t) => t,
      pipelineFactory: factory,
    });
    expect(provider.getModelSizeBytes()).toBe(42_000_000);
  });

  test("pipeline is constructed exactly once under concurrent embed calls", async () => {
    let loadCount = 0;
    const factory = async (
      _model: string,
    ): Promise<(input: string) => Promise<{ data: Float32Array }>> => {
      loadCount++;
      return async () => ({ data: new Float32Array(768) });
    };
    const provider = createTransformersProvider({
      modelId: "test-model",
      providerKey: "test",
      dimensions: 768,
      maxInputTokensByBackend: { wasm: 512, webgpu: 512 },
      modelSizeBytes: 1_000_000,
      taskPrompt: (t) => t,
      pipelineFactory: factory,
    });

    await Promise.all([
      provider.embed(["a"], "document"),
      provider.embed(["b"], "document"),
    ]);
    expect(loadCount).toBe(1);
  });
});

describe("TransformersProviderImpl — backend-resolved maxInputTokens", () => {
  test("synchronous maxInputTokens always returns the wasm value", () => {
    const { factory } = makeMockFactory(768);
    const provider = createTransformersProvider({
      modelId: "test-model",
      providerKey: "test",
      dimensions: 768,
      maxInputTokensByBackend: { wasm: 512, webgpu: 2048 },
      modelSizeBytes: 1_000_000,
      taskPrompt: (t) => t,
      pipelineFactory: factory,
    });
    expect(provider.maxInputTokens).toBe(512);
  });

  test("getMaxInputTokens returns wasm value when navigator.gpu absent", async () => {
    const { factory } = makeMockFactory(768);
    const provider = createTransformersProvider({
      modelId: "test-model",
      providerKey: "test",
      dimensions: 768,
      maxInputTokensByBackend: { wasm: 512, webgpu: 2048 },
      modelSizeBytes: 1_000_000,
      taskPrompt: (t) => t,
      pipelineFactory: factory,
    });
    // Pre-resolve the backend with an explicit "no gpu" navigator.
    expect(await resolveBackend(undefined)).toBe("wasm");
    expect(await provider.getMaxInputTokens()).toBe(512);
  });

  test("getMaxInputTokens returns webgpu value when adapter available", async () => {
    const { factory } = makeMockFactory(768);
    const provider = createTransformersProvider({
      modelId: "test-model",
      providerKey: "test",
      dimensions: 768,
      maxInputTokensByBackend: { wasm: 512, webgpu: 2048 },
      modelSizeBytes: 1_000_000,
      taskPrompt: (t) => t,
      pipelineFactory: factory,
    });
    expect(
      await resolveBackend({
        gpu: { requestAdapter: async () => ({}) },
      }),
    ).toBe("webgpu");
    expect(await provider.getMaxInputTokens()).toBe(2048);
  });

  test("embed forwards backend-resolved max_length to pipeline", async () => {
    const { factory, optsLog } = makeMockFactoryWithOpts(768);
    const provider = createTransformersProvider({
      modelId: "test-model",
      providerKey: "test",
      dimensions: 768,
      maxInputTokensByBackend: { wasm: 512, webgpu: 2048 },
      modelSizeBytes: 1_000_000,
      taskPrompt: (t) => t,
      pipelineFactory: factory,
    });
    // Force webgpu resolution.
    await resolveBackend({
      gpu: { requestAdapter: async () => ({}) },
    });
    await provider.embed(["hello"], "document");
    expect(optsLog[0]).toMatchObject({ truncation: true, max_length: 2048 });
  });
});

describe("TransformersProviderImpl — truncation opts", () => {
  test("passes truncation: true and max_length to pipeline (wasm path)", async () => {
    const { factory, optsLog } = makeMockFactoryWithOpts(768);
    const provider = createTransformersProvider({
      modelId: "test-model",
      providerKey: "test",
      dimensions: 768,
      maxInputTokensByBackend: { wasm: 512, webgpu: 512 },
      modelSizeBytes: 1_000_000,
      taskPrompt: (t) => t,
      pipelineFactory: factory,
    });

    await provider.embed(["hello"], "document");
    expect(optsLog[0]).toMatchObject({ truncation: true, max_length: 512 });
  });
});

describe("EmbeddingGemmaProvider", () => {
  test("providerKey, dimensions, sync maxInputTokens (wasm cap)", () => {
    const { factory } = makeMockFactory(768);
    const provider = createEmbeddingGemmaProvider(factory);
    expect(provider.providerKey).toBe("embedding-gemma-300m");
    expect(provider.dimensions).toBe(768);
    expect(provider.maxInputTokens).toBe(512);
  });

  test("getMaxInputTokens unlocks 2048 on webgpu", async () => {
    const { factory } = makeMockFactory(768);
    const provider = createEmbeddingGemmaProvider(factory);
    await resolveBackend({
      gpu: { requestAdapter: async () => ({}) },
    });
    expect(await provider.getMaxInputTokens()).toBe(2048);
  });

  test("getModelSizeBytes returns 190 MB", () => {
    const { factory } = makeMockFactory(768);
    expect(createEmbeddingGemmaProvider(factory).getModelSizeBytes()).toBe(
      190_000_000,
    );
  });

  test("document role → title/text prompt format", async () => {
    const { factory, calls } = makeMockFactory(768);
    await createEmbeddingGemmaProvider(factory).embed(
      ["my document"],
      "document",
    );
    expect(calls[0]).toBe("title: none | text: my document");
  });

  test("query role → task/query prompt format", async () => {
    const { factory, calls } = makeMockFactory(768);
    await createEmbeddingGemmaProvider(factory).embed(["my query"], "query");
    expect(calls[0]).toBe("task: search result | query: my query");
  });
});

describe("MultilingualE5Provider", () => {
  test("providerKey, dimensions, sync maxInputTokens", () => {
    const { factory } = makeMockFactory(768);
    const provider = createMultilingualE5Provider(factory);
    expect(provider.providerKey).toBe("multilingual-e5-base");
    expect(provider.dimensions).toBe(768);
    expect(provider.maxInputTokens).toBe(512);
  });

  test("getMaxInputTokens returns 512 on both backends (model intrinsic cap)", async () => {
    const { factory } = makeMockFactory(768);
    const provider = createMultilingualE5Provider(factory);
    await resolveBackend({
      gpu: { requestAdapter: async () => ({}) },
    });
    expect(await provider.getMaxInputTokens()).toBe(512);
  });


  test("getModelSizeBytes returns 60 MB", () => {
    const { factory } = makeMockFactory(768);
    expect(createMultilingualE5Provider(factory).getModelSizeBytes()).toBe(
      60_000_000,
    );
  });

  test("document role → passage prefix", async () => {
    const { factory, calls } = makeMockFactory(768);
    await createMultilingualE5Provider(factory).embed(
      ["my document"],
      "document",
    );
    expect(calls[0]).toBe("passage: my document");
  });

  test("query role → query prefix", async () => {
    const { factory, calls } = makeMockFactory(768);
    await createMultilingualE5Provider(factory).embed(["my query"], "query");
    expect(calls[0]).toBe("query: my query");
  });
});

describe("NativeEmbeddingProvider", () => {
  test("providerKey, dimensions, maxInputTokens", () => {
    const provider = createNativeEmbeddingProvider(makeMockEmbedder());
    expect(provider.providerKey).toBe("native-minilm-l6-v2");
    expect(provider.dimensions).toBe(384);
    expect(provider.maxInputTokens).toBe(256);
  });

  test("getMaxInputTokens returns 256 regardless of backend", async () => {
    const provider = createNativeEmbeddingProvider(makeMockEmbedder());
    await resolveBackend({
      gpu: { requestAdapter: async () => ({}) },
    });
    expect(await provider.getMaxInputTokens()).toBe(256);
  });

  test("getModelSizeBytes returns 25 MB", () => {
    expect(
      createNativeEmbeddingProvider(makeMockEmbedder()).getModelSizeBytes(),
    ).toBe(25_000_000);
  });

  test("isAvailable always returns true (lazy-loads on demand)", async () => {
    expect(
      await createNativeEmbeddingProvider(makeMockEmbedder(true)).isAvailable(),
    ).toBe(true);
    expect(
      await createNativeEmbeddingProvider(
        makeMockEmbedder(false),
      ).isAvailable(),
    ).toBe(true);
  });

  test("embed delegates to embedder.embedBatch ignoring role", async () => {
    const captured: string[] = [];
    const embedder: Embedder = {
      embed: async (_text) => new Float32Array(384),
      embedBatch: async (texts) => {
        captured.push(...texts);
        return texts.map(() => new Float32Array(384));
      },
      unload: async () => {},
      isLoaded: () => true,
    };
    const provider = createNativeEmbeddingProvider(embedder);
    const result = await provider.embed(["hello", "world"], "query");
    expect(captured).toEqual(["hello", "world"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(Float32Array);
  });
});
