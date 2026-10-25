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
 * A dropped pipeline is disposed, not only dereferenced: its ONNX
 * sessions hold the model weights outside the JavaScript heap, and
 * the garbage collector does not reclaim them (#597, ADR-0032). The
 * disposal waits for calls still in flight on that pipeline.
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
export type PipelineFn = ((
  input: string | string[],
  opts?: {
    pooling?: "mean" | "cls" | "none";
    normalize?: boolean;
    truncation?: boolean;
    max_length?: number;
  },
) => Promise<EmbedTensor>) & {
  /**
   * Releases the pipeline's ONNX sessions (`Pipeline.dispose` in
   * Transformers.js). Optional so a test's plain function qualifies.
   */
  dispose?: () => Promise<void>;
};

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
  opts?: PipelineLoadOpts,
) => Promise<PipelineFn>;

export type PipelineLoadOpts = {
  dtype?: DtypeSpec;
  /**
   * Run this model on WASM even when WebGPU was resolved for the others.
   * EmbeddingGemma needs it: on the WebGPU execution provider it returns
   * vectors that rank notes at random, with q4 and q8 alike, while the
   * same weights on WASM rank them correctly (ADR-0034).
   */
  backend?: "wasm";
};

/**
 * Model weight precision. A plain string applies to every backend; a
 * record picks one per backend, because a precision that is right for
 * WASM can be the wrong download on WebGPU (see `buildPipelineOptions`).
 */
export type DtypeSpec = string | Partial<Record<BackendKind, string>>;

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
  // Calls in flight on the current pipeline. A pipeline dropped while
  // they run is disposed once the last of them settles.
  private active = 0;
  private retired = new Set<PipelineFn>();

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

    const promise = this.withPipeline(async (pipe) => {
      const result = await pipe(text, {
        pooling: "mean",
        normalize: true,
        truncation: true,
        max_length: this.opts.maxInputTokens,
      });
      // Copy into a fresh Float32Array so the cache holds an owned
      // reference even if the pipeline reuses internal buffers.
      return new Float32Array(result.data);
    });
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
      const batchPromise = this.withPipeline(async (pipe) => {
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
      });
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
    if (this.idleTimer) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // A cached vector belongs to the model instance that produced it;
    // it must not survive an unload/reload and be served against a
    // freshly constructed pipeline.
    this.cache.clear();
    await this.dropPipeline();
  }

  /**
   * Forgets the current pipeline and disposes it once no call is using
   * it. A load still pending is forgotten too: ensurePipeline disposes
   * its pipeline on arrival, because the load is no longer the current
   * one.
   */
  private dropPipeline(): Promise<void> {
    const pipe = this.pipeline;
    this.pipeline = null;
    this.loadPromise = null;
    if (pipe) this.retired.add(pipe);
    return this.disposeRetired();
  }

  private async disposeRetired(): Promise<void> {
    if (this.active > 0 || this.retired.size === 0) return;
    const batch = [...this.retired];
    this.retired.clear();
    await Promise.all(batch.map((p) => disposePipeline(p)));
  }

  /** Runs `fn` on the loaded pipeline, counted as in flight. */
  private async withPipeline<T>(
    fn: (pipe: PipelineFn) => Promise<T>,
  ): Promise<T> {
    this.active += 1;
    try {
      const pipe = await this.ensurePipeline();
      return await fn(pipe);
    } finally {
      this.active -= 1;
      void this.disposeRetired();
    }
  }

  private async ensurePipeline(): Promise<PipelineFn> {
    if (this.pipeline) return this.pipeline;
    if (!this.loadPromise) {
      const model = this.opts.model ?? DEFAULT_MODEL;
      const load: Promise<PipelineFn> = this.opts
        .pipelineFactory(model)
        .then((p) => {
          if (this.loadPromise === load) {
            this.pipeline = p;
          } else {
            // Unloaded, or idled out, while loading: the callers that
            // awaited this load still get the pipeline, and it is
            // disposed once they are done with it.
            this.retired.add(p);
            void this.disposeRetired();
          }
          return p;
        })
        .catch((e: unknown) => {
          // A failed load must not pin a rejected promise for the rest
          // of the session; clear it so the next call retries the factory.
          if (this.loadPromise === load) this.loadPromise = null;
          throw e;
        });
      this.loadPromise = load;
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
      this.idleTimer = null;
      // A batch still running: it touched the timer when it started,
      // so wait one more idle period rather than pull its pipeline.
      if (this.active > 0) {
        this.touchIdle();
        return;
      }
      void this.dropPipeline();
    }, this.opts.idleMs ?? DEFAULT_IDLE_MS);
  }
}

export function createEmbedder(opts: EmbedderOpts): Embedder {
  return new EmbedderImpl(opts);
}

/**
 * Releases a pipeline's ONNX sessions. Best-effort: a pipeline without
 * `dispose` (a test double) is a no-op, and a failing release is logged,
 * because the caller is unloading and has nothing left to do about it.
 */
export async function disposePipeline(pipe: PipelineFn): Promise<void> {
  if (typeof pipe.dispose !== "function") return;
  try {
    await pipe.dispose();
  } catch (error) {
    logger.warn("semantic-search: pipeline dispose failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
// Loaded through transformersModule.ts: a bundled require() on first use.
// Obsidian's eval-based plugin loader cannot resolve node_modules at
// runtime, so this must stay a require() the bundler resolves, never a
// dynamic `import(...)`, which would 404.
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
import { loadTransformers } from "./transformersModule";
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
/**
 * Read the global navigator as NavigatorLike. The `unknown` hop is
 * deliberate: this repo's DOM lib predates WebGPU (Navigator has no
 * `gpu`, so a direct assignment fails the weak-type check), while a
 * WebGPU-aware lib makes any direct cast redundant. Widening to
 * `unknown` first is the one spelling both type environments accept.
 */
function detectNavigator(): NavigatorLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  const nav: unknown = navigator;
  return nav as NavigatorLike;
}

export function resolveBackend(
  navigatorRef: NavigatorLike | undefined = detectNavigator(),
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
    await configureEnv();
    return "wasm";
  }
  try {
    const adapter = await navigatorRef.gpu.requestAdapter();
    if (adapter !== null) {
      // JSEP WASM path: omit numThreads so onnxruntime-web selects
      // ort-wasm-simd.jsep.wasm, which registers the WebGPU EP.
      await configureEnvForWebGpu();
      return "webgpu";
    }
  } catch {
    // adapter probe failed — fall through to wasm
  }
  await configureEnv();
  return "wasm";
}

/** Test-only: reset the cached backend resolution. */
export function __resetBackendForTesting(): void {
  _backendConfig = null;
}

/**
 * Options for `pipeline("feature-extraction", …)` on the resolved backend.
 *
 * The dtype must reach the library on both backends: transformers.js falls
 * back to fp32 for every device except WASM, so a dropped dtype on WebGPU
 * downloads the full-precision weights (1.23 GB for EmbeddingGemma against
 * the ~200 MB the settings promise). When no dtype is given, or the record
 * has no entry for this backend, the key is left out and the library
 * default applies.
 */
export function buildPipelineOptions(
  backend: BackendKind,
  dtype: DtypeSpec | undefined,
  onProgress?: ProgressCallback,
): { device: string; progress_callback?: ProgressCallback; dtype?: string } {
  const resolved = typeof dtype === "string" ? dtype : dtype?.[backend];
  return {
    device: backend === "webgpu" ? "webgpu" : "cpu",
    progress_callback: onProgress,
    ...(resolved !== undefined ? { dtype: resolved } : {}),
  };
}

export async function realPipelineFactory(
  model: string,
  onProgress?: ProgressCallback,
  opts?: PipelineLoadOpts,
): Promise<PipelineFn> {
  // Always resolved first: it configures the ONNX environment once for
  // the whole plugin. A WASM override then runs on the CPU execution
  // provider of whichever WASM build that environment loaded.
  const resolved = await resolveBackend();
  const backend = opts?.backend ?? resolved;
  const options = buildPipelineOptions(
    backend,
    opts?.dtype,
    onProgress,
  ) as Parameters<Awaited<ReturnType<typeof loadTransformers>>["pipeline"]>[2];

  // On WebGPU there is no CPU fallback: a failed WebGPU attempt corrupts
  // onnxruntime-web's internal session state — subsequent cpu calls also get
  // "webgpu backend not found". Let the error propagate so the caller can
  // surface it cleanly.
  return (await loadTransformers()).pipeline(
    "feature-extraction",
    model,
    options,
  );
}
