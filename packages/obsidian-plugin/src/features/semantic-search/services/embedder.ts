/**
 * Embedder wrapper around Transformers.js feature-extraction pipelines.
 *
 * Three concerns layered around the underlying pipeline:
 * 1. **Lazy load** — the model (~25MB MiniLM-L6-v2) is downloaded and
 *    constructed only on the first `embed`/`embedBatch` call, never at
 *    module evaluation time. Two concurrent calls during the cold load
 *    share the same `Promise<Pipeline>` so the model is constructed
 *    exactly once.
 * 2. **LRU query cache** — identical query strings reuse the same
 *    `Float32Array` reference. Default size 32. Exact-match cache;
 *    semantic dedupe is out of scope.
 * 3. **Unload-when-idle** — if `unloadWhenIdle` is true, the pipeline
 *    is dropped 60s after the last call (RAM saver for memory-
 *    constrained users). The next call cold-reloads.
 *
 * Production code injects `realPipelineFactory` (static import of
 * `@huggingface/transformers`) so Transformers.js is not pulled into the
 * bundle eager-side. Tests inject a deterministic mock factory: no
 * model download, no WASM, no sharp transitive resolution.
 */

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_CACHE_SIZE = 32;
const DEFAULT_IDLE_MS = 60_000;
// Max texts per pipeline call in embedBatch. The tokenizer pads to the
// longest text in the batch, so bigger is not monotonically better.
const EMBED_BATCH_SIZE = 8;

/** Minimal subset of Transformers.js's pipeline output that we use. */
export type EmbedTensor = { data: Float32Array; dims?: number[] };

/**
 * The shape Transformers.js returns from
 * `await pipeline("feature-extraction", model)`. We type only the
 * call signature we use.
 */
export type PipelineFn = (
  input: string | string[],
  opts?: {
    pooling?: "mean" | "cls" | "none";
    normalize?: boolean;
    truncation?: boolean;
    max_length?: number;
  },
) => Promise<EmbedTensor>;

export type PipelineFactory = (model: string) => Promise<PipelineFn>;

/**
 * Progress event shape emitted by Transformers.js during model
 * download. Only the fields the UI surfaces are typed; the library
 * emits more (name, total, loaded, etc.) but they don't drive the
 * progress bar.
 */
export type ProgressEvent = {
  status: "initiate" | "download" | "progress" | "done" | "ready";
  progress?: number; // 0-100
  file?: string;
};

export type ProgressCallback = (info: ProgressEvent) => void;

/**
 * Variant of PipelineFactory that forwards Transformers.js progress
 * events. The model downloader (T13) wraps an instance of this and
 * exposes the resulting state machine to the settings UI.
 */
export type PipelineFactoryWithProgress = (
  model: string,
  onProgress?: ProgressCallback,
  opts?: { dtype?: string },
) => Promise<PipelineFn>;

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  unload(): Promise<void>;
  isLoaded(): boolean;
}

export type EmbedderOpts = {
  pipelineFactory: PipelineFactory;
  model?: string;
  maxInputTokens?: number;
  cacheSize?: number;
  idleMs?: number;
  unloadWhenIdle?: boolean;
};

class EmbedderImpl implements Embedder {
  private pipeline: PipelineFn | null = null;
  private loadPromise: Promise<PipelineFn> | null = null;
  // Cache stores Promise<Float32Array> rather than Float32Array so
  // concurrent embed(sameText) calls share the in-flight work and
  // resolve to the same array reference. Query-only: embedBatch reads
  // it but never writes (document chunks must not evict query entries);
  // within-batch duplicate identity comes from embedBatch's dedupe map.
  private cache = new Map<string, Promise<Float32Array>>();
  private idleTimer: number | null = null;

  constructor(private opts: EmbedderOpts) {}

  isLoaded(): boolean {
    return this.pipeline !== null;
  }

  async embed(text: string): Promise<Float32Array> {
    this.touchIdle();

    const cached = this.cache.get(text);
    if (cached) {
      // LRU touch: delete + reinsert so this entry is the most-recent.
      this.cache.delete(text);
      this.cache.set(text, cached);
      return cached;
    }

    const promise = (async (): Promise<Float32Array> => {
      const pipe = await this.ensurePipeline();
      const result = await pipe(text, {
        pooling: "mean",
        normalize: true,
        truncation: true,
        max_length: this.opts.maxInputTokens,
      });
      // Copy into a fresh Float32Array so the cache holds an owned
      // reference even if the pipeline reuses internal buffers.
      return new Float32Array(result.data);
    })();
    this.cacheSet(text, promise);
    // A rejected embed must not be served to later calls for the same
    // text; evict it (only if this entry still owns the slot).
    promise.catch(() => {
      if (this.cache.get(text) === promise) this.cache.delete(text);
    });
    return promise;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.touchIdle();
    // Before ensurePipeline(): an all-cached or empty batch must not
    // cold-load the model.
    if (texts.length === 0) return [];

    // Cache policy: batch traffic is document chunks (indexing); it
    // READS the query LRU (a chunk equal to a recent query reuses the
    // vector) but never WRITES it — 32 slots of query cache would be
    // churned to nothing by a single file's chunks. Duplicate texts
    // within the batch still resolve to the SAME Float32Array
    // reference (invariant the indexer's chunk-delta reuse relies on)
    // via the dedupe map below.
    const results = new Array<Promise<Float32Array>>(texts.length);
    const missing = new Map<string, number[]>();
    texts.forEach((text, i) => {
      const cached = this.cache.get(text);
      if (cached) {
        results[i] = cached;
      } else {
        const positions = missing.get(text);
        if (positions) positions.push(i);
        else missing.set(text, [i]);
      }
    });

    const entries = Array.from(missing.entries());
    for (let start = 0; start < entries.length; start += EMBED_BATCH_SIZE) {
      const slice = entries.slice(start, start + EMBED_BATCH_SIZE);
      const batchTexts = slice.map(([text]) => text);
      const batchPromise = (async (): Promise<Float32Array[]> => {
        const pipe = await this.ensurePipeline();
        const result = await pipe(batchTexts, {
          pooling: "mean",
          normalize: true,
          truncation: true,
          max_length: this.opts.maxInputTokens,
        });
        // [batch, dim] row-major; without dims, derive the stride from
        // the flat length (must divide evenly).
        const stride =
          result.dims?.length === 2 && typeof result.dims[1] === "number"
            ? result.dims[1]
            : result.data.length / batchTexts.length;
        if (!Number.isInteger(stride)) {
          throw new Error(
            `embedBatch: cannot infer row stride (data ${result.data.length}, batch ${batchTexts.length})`,
          );
        }
        return batchTexts.map(
          (_, row) =>
            new Float32Array(
              result.data.subarray(row * stride, (row + 1) * stride),
            ),
        );
      })();
      slice.forEach(([, positions], row) => {
        const rowPromise = batchPromise.then((rows) => {
          const v = rows[row];
          if (!v) throw new Error("embedBatch: missing row in batch result");
          return v;
        });
        for (const pos of positions) results[pos] = rowPromise;
      });
    }

    return Promise.all(results);
  }

  async unload(): Promise<void> {
    this.pipeline = null;
    this.loadPromise = null;
    // A cached vector belongs to the model instance that produced it;
    // it must not survive an unload/reload and be served against a
    // freshly constructed pipeline.
    this.cache.clear();
    if (this.idleTimer) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async ensurePipeline(): Promise<PipelineFn> {
    if (this.pipeline) return this.pipeline;
    if (!this.loadPromise) {
      const model = this.opts.model ?? DEFAULT_MODEL;
      this.loadPromise = this.opts
        .pipelineFactory(model)
        .then((p) => {
          this.pipeline = p;
          return p;
        })
        .catch((e: unknown) => {
          // A failed load must not pin a rejected promise for the rest
          // of the session; clear it so the next call retries the factory.
          this.loadPromise = null;
          throw e;
        });
    }
    return this.loadPromise;
  }

  private cacheSet(text: string, promise: Promise<Float32Array>): void {
    const max = this.opts.cacheSize ?? DEFAULT_CACHE_SIZE;
    if (this.cache.size >= max) {
      const oldest: string | undefined = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(text, promise);
  }

  private touchIdle(): void {
    // Opt-in: an omitted flag keeps the pipeline warm. The previous
    // `=== false` check made `undefined` behave like `true`, which
    // silently disconnected the unloadModelWhenIdle setting and made
    // every search after 60s idle pay a cold pipeline rebuild.
    if (this.opts.unloadWhenIdle !== true) return;
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.pipeline = null;
      this.loadPromise = null;
      this.idleTimer = null;
    }, this.opts.idleMs ?? DEFAULT_IDLE_MS);
  }
}

export function createEmbedder(opts: EmbedderOpts): Embedder {
  return new EmbedderImpl(opts);
}

/**
 * Production pipeline factory. Dynamically imports Transformers.js so
 * the heavy ONNX runtime + tokenizer code is not pulled into the
 * plugin bundle until the first embed call. Tests must NOT call this;
 * they inject a deterministic mock factory instead.
 *
 * Wrapped in a function (not a top-level `import`) so the bundler
 * can split the chunk and so the sharp transitive dependency (which
 * Transformers.js's image pipelines pull in) is never touched in the
 * text-only path we actually use.
 */
// Static import required: Obsidian's eval-based plugin loader cannot
// resolve node_modules at runtime; a bundled require() works, a
// dynamic `import(...)` would 404.
//
// `sharp` is stubbed at bundle time (image pipelines are unreachable in
// our text-only path). `onnxruntime-node` is REDIRECTED to
// `onnxruntime-web` at bundle time — see bun.config.ts for the rationale
// (Electron renderer reports `process.release.name === 'node'`, so
// Transformers.js picks the node branch; routing it to the WASM runtime
// is the only way to actually run inference here).
//
// @huggingface/transformers v4.2.0 — upgraded from @xenova/transformers
// v2.17.2. Spike (2026-04-26) found import.meta.url failures; a later
// re-spike confirmed v4 loads cleanly with the bun.config.ts define block
// already in place (import.meta.url + __dirname/__filename neutralized).
//
// device must be explicit — Transformers.js v4 auto-selects WebGPU when
// navigator.gpu is present (Electron exposes it). We probe once via
// requestAdapter(); on success we configure JSEP WASM env (no numThreads
// override) and use "webgpu"; on failure we configure CPU env (numThreads:1)
// and use "cpu". Valid v4.2.0 devices: "coreml" | "webgpu" | "cpu".
import { pipeline as _hfPipeline } from "@huggingface/transformers";
import type { BackendKind } from "../types";
import { configureEnv, configureEnvForWebGpu } from "./onnxEnv";
import { logger } from "$/shared/logger";

export type { BackendKind } from "../types";

/**
 * Optional navigator-shape parameter used by tests to inject a mock
 * `navigator.gpu` without touching the global. Production callers pass
 * nothing and the function reads the real `navigator`.
 */
export type NavigatorLike = {
  gpu?: { requestAdapter(): Promise<unknown> };
};

// Resolved once: "webgpu" if requestAdapter() returns a non-null adapter,
// "wasm" otherwise. Cached so all subsequent factory calls share the same
// backend and env configuration without re-probing.
let _backendConfig: Promise<BackendKind> | null = null;

/**
 * Probe the active inference backend. Calls the matching env configurator
 * (`configureEnvForWebGpu` on success, `configureEnv` otherwise) so the
 * one-shot env state is consistent with the resolved backend.
 *
 * Cached after first call. Tests should call `__resetBackendForTesting()`
 * in `afterEach` to clear the cache.
 */
export function resolveBackend(
  // The DOM lib in this tsconfig predates WebGPU, so Navigator has no
  // `gpu` member; widen with an intersection instead of an
  // unknown-bridge double cast.
  navigatorRef: NavigatorLike | undefined = typeof navigator !== "undefined"
    ? (navigator as Navigator & NavigatorLike)
    : undefined,
): Promise<BackendKind> {
  if (!_backendConfig) {
    _backendConfig = (async (): Promise<BackendKind> => {
      const backend = await resolveBackendInner(navigatorRef);
      logger.info("semantic-search: backend resolved", { backend });
      return backend;
    })();
  }
  return _backendConfig;
}

async function resolveBackendInner(
  navigatorRef: NavigatorLike | undefined,
): Promise<BackendKind> {
  if (!navigatorRef?.gpu) {
    configureEnv();
    return "wasm";
  }
  try {
    const adapter = await navigatorRef.gpu.requestAdapter();
    if (adapter !== null) {
      // JSEP WASM path: omit numThreads so onnxruntime-web selects
      // ort-wasm-simd.jsep.wasm, which registers the WebGPU EP.
      configureEnvForWebGpu();
      return "webgpu";
    }
  } catch {
    // adapter probe failed — fall through to wasm
  }
  configureEnv();
  return "wasm";
}

/** Test-only: reset the cached backend resolution. */
export function __resetBackendForTesting(): void {
  _backendConfig = null;
}

export async function realPipelineFactory(
  model: string,
  onProgress?: ProgressCallback,
  opts?: { dtype?: string },
): Promise<PipelineFn> {
  const backend = await resolveBackend();

  if (backend === "webgpu") {
    // No CPU fallback: a failed WebGPU attempt corrupts onnxruntime-web's
    // internal session state — subsequent cpu calls also get "webgpu backend
    // not found". Let the error propagate so the caller can surface it cleanly.
    const pipe = await _hfPipeline("feature-extraction", model, {
      device: "webgpu",
      progress_callback: onProgress,
    } as Parameters<typeof _hfPipeline>[2]);
    return pipe;
  }

  const pipe = await _hfPipeline("feature-extraction", model, {
    device: "cpu",
    progress_callback: onProgress,
    ...(opts?.dtype !== undefined ? { dtype: opts.dtype } : {}),
  } as Parameters<typeof _hfPipeline>[2]);
  return pipe;
}
