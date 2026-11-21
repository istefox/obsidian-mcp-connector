/**
 * A search query reaches a queueing pipeline with `priority: "query"`, a
 * document never does, and a pipeline that does not queue (Transformers.js
 * itself, on the main thread) never sees the option at all (ADR-0036).
 */
import { describe, expect, test } from "bun:test";
import {
  createEmbedder,
  type PipelineCallOpts,
  type PipelineFn,
} from "./embedder";
import { createNativeEmbeddingProvider } from "./nativeEmbeddingProvider";
import { createTransformersProvider } from "./transformersProvider";

function recordingFactory(queues: boolean) {
  const seen: (PipelineCallOpts | undefined)[] = [];
  const pipe: PipelineFn = async (input, opts) => {
    seen.push(opts);
    const n = Array.isArray(input) ? input.length : 1;
    return { data: new Float32Array(4 * n), dims: [n, 4] };
  };
  if (queues) pipe.acceptsPriority = true;
  return { seen, factory: async () => pipe };
}

const priorities = (seen: (PipelineCallOpts | undefined)[]) =>
  seen.map((o) => o?.priority);
const mentionsPriority = (seen: (PipelineCallOpts | undefined)[]) =>
  seen.some((o) => o !== undefined && "priority" in o);

function transformersProvider(factory: () => Promise<PipelineFn>) {
  return createTransformersProvider({
    modelId: "m",
    providerKey: "p",
    dimensions: 4,
    maxInputTokensByBackend: { wasm: 16, webgpu: 16 },
    backend: "wasm",
    modelSizeBytes: 1,
    taskPrompt: (t) => t,
    pipelineFactory: factory,
  });
}

describe("query priority", () => {
  test("transformers provider: query yes, document no", async () => {
    const { seen, factory } = recordingFactory(true);
    const provider = transformersProvider(factory);
    await provider.embed(["q"], "query");
    await provider.embed(["d"], "document");
    expect(priorities(seen)).toEqual(["query", undefined]);
  });

  test("native provider: query yes, document no", async () => {
    const { seen, factory } = recordingFactory(true);
    const provider = createNativeEmbeddingProvider(
      createEmbedder({ pipelineFactory: factory }),
    );
    await provider.embed(["q"], "query");
    await provider.embed(["d"], "document");
    expect(priorities(seen)).toEqual(["query", undefined]);
  });

  test("embedder: a single embed is a query, a batch is not", async () => {
    const { seen, factory } = recordingFactory(true);
    const embedder = createEmbedder({ pipelineFactory: factory });
    await embedder.embed("q");
    await embedder.embedBatch(["d"]);
    expect(priorities(seen)).toEqual(["query", undefined]);
  });

  test("a pipeline that does not queue never receives the option", async () => {
    const { seen, factory } = recordingFactory(false);
    const embedder = createEmbedder({ pipelineFactory: factory });
    const native = createNativeEmbeddingProvider(embedder);
    const provider = transformersProvider(factory);
    await embedder.embed("q");
    await native.embed(["q2"], "query");
    await provider.embed(["q3"], "query");
    expect(seen).toHaveLength(3);
    expect(mentionsPriority(seen)).toBe(false);
  });
});
