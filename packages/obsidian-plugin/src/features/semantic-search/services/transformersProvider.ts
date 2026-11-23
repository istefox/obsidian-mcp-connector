/**
 * Generic `EmbeddingProvider` implementation backed by a Transformers.js
 * feature-extraction pipeline.
 *
 * Providers that use asymmetric task prompts (EmbeddingGemma, multilingual-e5)
 * inject a `TaskPromptFn`; providers that do not (plain cosine models) can
 * pass the identity function `(t) => t`.
 *
 * The underlying pipeline is loaded lazily on the first `embed()` call;
 * concurrent calls during cold load share the same `Promise<PipelineFn>` so
 * the model is constructed exactly once. `unload()` disposes it: the ONNX
 * sessions hold the weights outside the JavaScript heap, where dropping
 * the reference frees nothing (ADR-0032).
 */

import type { BackendKind, EmbeddingProvider } from "../types";
import { disposePipeline, probeBackend } from "./embedder";
import type { PipelineFactory, PipelineFn } from "./embedder";

export type TaskPromptFn = (text: string, role: "document" | "query") => string;

export type TransformersProviderOpts = {
  modelId: string;
  providerKey: string;
  dimensions: number;
  /**
   * Per-backend input-token cap. The conservative `wasm` value is also
   * the synchronous `maxInputTokens` fallback for callers that run
   * before the backend has been resolved.
   *
   * Note: vectors produced under different backends are not bit-identical
   * (FP16 reductions on WebGPU vs FP32 on WASM). The `FORMAT_VERSION`
   * bump on upgrades makes this a non-issue for new installs; mid-session
   * hardware swap is rare enough that we accept the small re-rank drift
   * over doubling on-disk footprint with a per-backend `providerKey`.
   */
  maxInputTokensByBackend: Record<BackendKind, number>;
  modelSizeBytes: number;
  taskPrompt: TaskPromptFn;
  pipelineFactory: PipelineFactory;
  /**
   * Max texts per pipeline call. The tokenizer pads every text in a
   * batch to the longest one, so attention memory scales with
   * batch × seq² — large-context models on WebGPU need a smaller
   * batch (EmbeddingGemma uses 4). Default 8.
   */
  batchSize?: number;
  /**
   * The model always runs on WASM, whatever backend the others use. Must
   * match the `backend` its model downloader passes to the factory, so
   * the input cap is the WASM one.
   */
  backend?: "wasm";
};

const DEFAULT_BATCH_SIZE = 8;

class TransformersProviderImpl implements EmbeddingProvider {
  readonly providerKey: string;
  readonly dimensions: number;
  readonly maxInputTokens: number;

  private pipeline: PipelineFn | null = null;
  private loadPromise: Promise<PipelineFn> | null = null;
  private resolvedMaxTokens: Promise<number> | null = null;

  constructor(private opts: TransformersProviderOpts) {
    this.providerKey = opts.providerKey;
    this.dimensions = opts.dimensions;
    this.maxInputTokens = opts.maxInputTokensByBackend.wasm;
  }

  getMaxInputTokens(): Promise<number> {
    if (!this.resolvedMaxTokens) {
      // The probe alone: resolving would evaluate Transformers.js on the
      // main thread even when the model runs in a worker (ADR-0036).
      this.resolvedMaxTokens = probeBackend().then(
        (b) => this.opts.maxInputTokensByBackend[this.opts.backend ?? b],
      );
    }
    return this.resolvedMaxTokens;
  }

  getModelSizeBytes(): number {
    return this.opts.modelSizeBytes;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  documentConcurrency(): number {
    return this.pipeline?.concurrency?.() ?? 1;
  }

  async embed(
    texts: string[],
    role: "document" | "query",
  ): Promise<Float32Array[]> {
    // Before ensurePipeline(): an all-reused reindex must not cold-load
    // the model.
    if (texts.length === 0) return [];
    const pipe = await this.ensurePipeline();
    const maxLen = await this.getMaxInputTokens();
    const batchSize = this.opts.batchSize ?? DEFAULT_BATCH_SIZE;

    // One pipeline call per sub-batch: tokenization and the forward
    // pass are batched by Transformers.js, which beats per-text calls
    // by a wide margin (kernel-launch and tensor-upload overhead
    // dominates at batch size 1, especially on WebGPU).
    //
    // A pipeline that runs each call on its own ORT session (the
    // embedding worker pool, ADR-0036) gets up to `concurrency()`
    // sub-batches of this text list at once, so one long note keeps
    // every worker busy instead of one (#14: a rebuild checkpoint waits
    // for the longest file in flight, and with its sub-batches in series
    // the other workers sat idle until the idle release dropped them).
    // Anything else stays at one: concurrent calls on a single session
    // queue anyway and only multiply peak memory.
    const starts: number[] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      starts.push(start);
    }
    const width = Math.max(
      1,
      Math.min(starts.length, Math.floor(pipe.concurrency?.() ?? 1)),
    );
    const rows: Float32Array[][] = new Array(starts.length);
    let next = 0;
    const runBatch = async (at: number): Promise<void> => {
      const start = starts[at] as number;
      const batch = texts
        .slice(start, start + batchSize)
        .map((text) => this.opts.taskPrompt(text, role));
      const result = await pipe(batch, {
        pooling: "mean",
        normalize: true,
        truncation: true,
        max_length: maxLen,
        ...(role === "query" && pipe.acceptsPriority
          ? { priority: "query" as const }
          : {}),
      });
      // [batch, dim] tensor, row-major. Fall back to the declared
      // dimensions if dims is missing.
      const stride =
        result.dims?.length === 2 && typeof result.dims[1] === "number"
          ? result.dims[1]
          : this.opts.dimensions;
      const own: Float32Array[] = [];
      for (let row = 0; row < batch.length; row++) {
        // Copy each row into an owned Float32Array, independent of the
        // pipeline's internal buffer.
        own.push(
          new Float32Array(
            result.data.subarray(row * stride, (row + 1) * stride),
          ),
        );
      }
      rows[at] = own;
    };
    // A failed sub-batch stops this lane from taking more; the others
    // finish the call they are in, and the first error is thrown.
    let failure: { err: unknown } | null = null;
    const lane = async (): Promise<void> => {
      while (!failure && next < starts.length) {
        const at = next++;
        try {
          await runBatch(at);
        } catch (err) {
          failure ??= { err };
        }
      }
    };
    await Promise.all(Array.from({ length: width }, lane));
    if (failure) throw (failure as { err: unknown }).err;
    return rows.flat();
  }

  /**
   * Forgets the current pipeline and disposes it. A load still pending is
   * forgotten too, and its pipeline is disposed when it arrives. Teardown
   * stops the indexers first, so no embed is in flight here.
   */
  async unload(): Promise<void> {
    const pipe = this.pipeline;
    this.pipeline = null;
    this.loadPromise = null;
    if (pipe) await disposePipeline(pipe);
  }

  private async ensurePipeline(): Promise<PipelineFn> {
    if (this.pipeline) return this.pipeline;
    if (!this.loadPromise) {
      const load: Promise<PipelineFn> = this.opts
        .pipelineFactory(this.opts.modelId)
        .then((p) => {
          if (this.loadPromise === load) this.pipeline = p;
          else void disposePipeline(p);
          return p;
        })
        .catch((e: unknown) => {
          if (this.loadPromise === load) this.loadPromise = null;
          throw e;
        });
      this.loadPromise = load;
    }
    return this.loadPromise;
  }
}

export function createTransformersProvider(
  opts: TransformersProviderOpts,
): EmbeddingProvider {
  return new TransformersProviderImpl(opts);
}
