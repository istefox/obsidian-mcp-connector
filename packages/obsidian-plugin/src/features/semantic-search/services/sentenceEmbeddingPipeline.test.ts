import { describe, expect, test } from "bun:test";
import type { PipelineFn } from "./embedder";
import { withSentenceEmbedding } from "./sentenceEmbeddingPipeline";

type Tokenized = { texts: string[]; opts: Record<string, unknown> };

/** A Transformers.js-shaped pipeline whose model returns `outputs`. */
function fakePipeline(
  outputs: (texts: string[]) => Record<string, unknown>,
  extra: { dispose?: () => Promise<void> } = {},
) {
  const tokenized: Tokenized[] = [];
  const pipe = Object.assign(
    async () => {
      throw new Error("pipeline pooling must not run");
    },
    {
      tokenizer: (texts: string[], opts: Record<string, unknown>) => {
        tokenized.push({ texts, opts });
        return { texts };
      },
      model: async ({ texts }: { texts: string[] }) => outputs(texts),
      ...extra,
    },
  ) as unknown as PipelineFn;
  return { factory: async () => pipe, tokenized };
}

describe("withSentenceEmbedding", () => {
  test("returns sentence_embedding rows, L2-normalized when asked", async () => {
    const { factory } = fakePipeline((texts) => ({
      last_hidden_state: { data: new Float32Array(99), dims: [1, 99] },
      sentence_embedding: {
        data: new Float32Array([3, 4, 0, 0, 0, 2]),
        dims: [texts.length, 3],
      },
    }));
    const pipe = await withSentenceEmbedding(factory)("m");
    const out = await pipe(["a", "b"], { pooling: "mean", normalize: true });
    expect(out.dims).toEqual([2, 3]);
    [0.6, 0.8, 0, 0, 0, 1].forEach((v, i) =>
      expect(out.data[i]).toBeCloseTo(v, 6),
    );
  });

  test("leaves the vectors as they are without normalize", async () => {
    const { factory } = fakePipeline(() => ({
      sentence_embedding: { data: new Float32Array([3, 4]), dims: [1, 2] },
    }));
    const out = await (await withSentenceEmbedding(factory)("m"))("a");
    expect(Array.from(out.data)).toEqual([3, 4]);
  });

  test("passes truncation and max_length to the tokenizer", async () => {
    const { factory, tokenized } = fakePipeline(() => ({
      sentence_embedding: { data: new Float32Array(2), dims: [1, 2] },
    }));
    const pipe = await withSentenceEmbedding(factory)("m");
    await pipe("hello", { truncation: true, max_length: 512 });
    expect(tokenized[0]).toEqual({
      texts: ["hello"],
      opts: { padding: true, truncation: true, max_length: 512 },
    });
  });

  test("fails instead of falling back when the output is missing", async () => {
    const { factory } = fakePipeline(() => ({
      last_hidden_state: { data: new Float32Array(4), dims: [1, 2, 2] },
    }));
    const pipe = await withSentenceEmbedding(factory)("m");
    await expect(pipe("a")).rejects.toThrow("sentence_embedding");
  });

  test("fails on a pipeline without tokenizer or model", async () => {
    const bare = (async () => ({
      data: new Float32Array(2),
    })) as unknown as PipelineFn;
    await expect(withSentenceEmbedding(async () => bare)("m")).rejects.toThrow(
      "tokenizer or model",
    );
  });

  test("dispose reaches the underlying pipeline", async () => {
    let disposed = 0;
    const { factory } = fakePipeline(() => ({}), {
      dispose: async () => {
        disposed++;
      },
    });
    const pipe = await withSentenceEmbedding(factory)("m");
    await pipe.dispose?.();
    expect(disposed).toBe(1);
  });
});
