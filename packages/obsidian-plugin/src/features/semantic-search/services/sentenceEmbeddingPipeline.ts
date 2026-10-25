/**
 * Reads a model's `sentence_embedding` output instead of mean-pooling its
 * token states.
 *
 * EmbeddingGemma's sentence vector is mean pooling followed by two Dense
 * projections and a normalize step. The onnx-community export runs all
 * of that inside the graph and returns it as `sentence_embedding`. The
 * feature-extraction pipeline never reads that output: it takes
 * `last_hidden_state` and pools it itself, which skips the Dense layers
 * and leaves vectors that barely separate relevant from irrelevant text.
 *
 * The wrapper keeps the pipeline object for its tokenizer, model and
 * `dispose()`, so loading, progress and the ONNX session lifecycle
 * (ADR-0032) stay where they are. `pooling` is ignored, the graph has
 * already pooled. Unlike the pipeline, it passes `max_length` to the
 * tokenizer, so the per-backend input cap actually applies.
 */

import type { EmbedTensor, PipelineFactory, PipelineFn } from "./embedder";

type TokenizerFn = (
  texts: string[],
  opts: { padding: boolean; truncation: boolean; max_length?: number },
) => unknown;

type ModelOutputTensor = {
  data: ArrayLike<number>;
  dims?: number[];
};

type ModelFn = (inputs: unknown) => Promise<Record<string, unknown>>;

/** The pipeline instance Transformers.js returns, as far as we use it. */
type LoadedPipeline = PipelineFn & {
  tokenizer?: TokenizerFn;
  model?: ModelFn;
};

export const SENTENCE_EMBEDDING_OUTPUT = "sentence_embedding";

export function withSentenceEmbedding(
  factory: PipelineFactory,
): PipelineFactory {
  return async (model) => wrap((await factory(model)) as LoadedPipeline);
}

function wrap(pipe: LoadedPipeline): PipelineFn {
  const { tokenizer, model } = pipe;
  if (typeof tokenizer !== "function" || typeof model !== "function") {
    throw new Error(
      "semantic-search: pipeline exposes no tokenizer or model to read sentence_embedding from",
    );
  }

  const run = async (
    input: string | string[],
    opts?: Parameters<PipelineFn>[1],
  ): Promise<EmbedTensor> => {
    const texts = typeof input === "string" ? [input] : input;
    const inputs = tokenizer(texts, {
      padding: true,
      truncation: opts?.truncation ?? true,
      ...(opts?.max_length !== undefined
        ? { max_length: opts.max_length }
        : {}),
    });
    const outputs = await model(inputs);
    const tensor = outputs[SENTENCE_EMBEDDING_OUTPUT] as
      | ModelOutputTensor
      | undefined;
    if (!tensor || !tensor.data) {
      // Mean pooling instead would fill the index with the vectors this
      // wrapper exists to avoid, so fail loudly.
      throw new Error(
        `semantic-search: model returned no ${SENTENCE_EMBEDDING_OUTPUT} output`,
      );
    }

    const data = Float32Array.from(tensor.data);
    const dim =
      tensor.dims?.length === 2 && typeof tensor.dims[1] === "number"
        ? tensor.dims[1]
        : data.length / texts.length;
    if (!Number.isInteger(dim) || dim * texts.length !== data.length) {
      throw new Error(
        `semantic-search: ${SENTENCE_EMBEDDING_OUTPUT} has an unexpected shape`,
      );
    }
    if (opts?.normalize) normalizeRows(data, dim);
    return { data, dims: [texts.length, dim] };
  };

  const wrapped: PipelineFn = run;
  if (typeof pipe.dispose === "function") {
    wrapped.dispose = () => pipe.dispose!();
  }
  return wrapped;
}

/** L2-normalizes each row in place. A zero row stays zero. */
function normalizeRows(data: Float32Array, dim: number): void {
  for (let start = 0; start < data.length; start += dim) {
    let sum = 0;
    for (let i = start; i < start + dim; i++) sum += data[i] * data[i];
    if (sum === 0) continue;
    const inv = 1 / Math.sqrt(sum);
    for (let i = start; i < start + dim; i++) data[i] *= inv;
  }
}
