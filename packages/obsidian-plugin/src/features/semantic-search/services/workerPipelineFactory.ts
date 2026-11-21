/**
 * Chooses where a model runs (ADR-0036): WASM inference goes to an embedding
 * worker, everything else stays on the main thread with `inner`
 * (`realPipelineFactory` in production).
 *
 * - WebGPU models (MiniLM and E5 on a machine with an adapter) are not
 *   moved: the GPU does the work there, and the path is left as it was.
 * - No way to spawn a worker (a source checkout, the headless build) means
 *   the main thread, as before.
 * - A worker that cannot boot means the main thread too, for the rest of
 *   the session, with a warning in the log.
 * - A model that fails to load in a worker that did boot is tried once on
 *   the main thread; the next load goes to a worker again.
 */
import { logger } from "$/shared/logger";
import type { BackendKind } from "../types";
import {
  buildPipelineOptions,
  probeBackend,
  type PipelineFactoryWithProgress,
} from "./embedder";
import {
  createWorkerPipeline,
  WorkerBootError,
  type WorkerLike,
} from "./embeddingWorkerHost";
import type { WorkerEnv } from "./embeddingWorkerProtocol";
import { ORT_WASM_PATHS } from "./ortWasmPaths";

export type WorkerPipelineFactoryOpts = {
  inner: PipelineFactoryWithProgress;
  /** `null` when this build cannot start a worker. */
  spawn: (() => WorkerLike) | null;
  /** Injectable for tests. Default: the real probe. */
  probe?: () => Promise<BackendKind>;
  bootTimeoutMs?: number;
  /** Most workers one model may use. Default 1. See `workerPoolSize`. */
  poolSize?: number;
};

const MAX_POOL_SIZE = 4;
const BYTES_PER_WORKER = 4 * 1024 ** 3;

/**
 * How many embedding workers a machine gets: half its cores, one per 4 GB
 * of memory, four at most, one at least. Each worker holds its own copy of
 * the model and its own WASM heap, so memory bounds the pool as much as
 * cores do. An unknown figure counts as the smallest machine.
 */
export function workerPoolSize(machine: {
  cores: number | undefined;
  totalMemoryBytes: number | undefined;
}): number {
  const byCores = Math.floor((machine.cores ?? 0) / 2);
  const byMemory = Math.floor(
    (machine.totalMemoryBytes ?? 0) / BYTES_PER_WORKER,
  );
  const size = Math.min(MAX_POOL_SIZE, byCores, byMemory);
  return Number.isFinite(size) && size > 1 ? size : 1;
}

/**
 * The environment `onnxEnv.ts` would have set on the main thread for this
 * machine: one thread on a WASM-only machine, the library's default where
 * WebGPU was resolved.
 */
export function workerEnvFor(machineBackend: BackendKind): WorkerEnv {
  return {
    wasmPaths: ORT_WASM_PATHS,
    useBrowserCache: typeof navigator !== "undefined",
    ...(machineBackend === "wasm" ? { numThreads: 1 } : {}),
  };
}

export function createWorkerPipelineFactory(
  opts: WorkerPipelineFactoryOpts,
): PipelineFactoryWithProgress {
  const probe = opts.probe ?? (() => probeBackend());
  let workerUnavailable = false;

  return async (model, onProgress, loadOpts) => {
    const spawn = opts.spawn;
    if (!spawn || workerUnavailable) {
      return opts.inner(model, onProgress, loadOpts);
    }
    const machineBackend = await probe();
    const backend = loadOpts?.backend ?? machineBackend;
    if (backend !== "wasm") return opts.inner(model, onProgress, loadOpts);

    const { device, dtype } = buildPipelineOptions(backend, loadOpts?.dtype);
    try {
      return await createWorkerPipeline({
        spawn,
        model,
        options: { device, ...(dtype !== undefined ? { dtype } : {}) },
        env: workerEnvFor(machineBackend),
        onProgress,
        bootTimeoutMs: opts.bootTimeoutMs,
        poolSize: opts.poolSize,
        // Workers that die later and do not come back: same answer as a
        // load that fails, without the caller seeing an error.
        fallback: () => opts.inner(model, undefined, loadOpts),
        onWorkerUnavailable: () => {
          workerUnavailable = true;
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof WorkerBootError) {
        workerUnavailable = true;
        logger.warn(
          "semantic-search: embedding worker unavailable, running on the main thread",
          { message },
        );
      } else {
        // The worker is fine, this model did not load in it. One try on
        // the main thread: a slow rebuild beats no semantic search. The
        // next load goes to a worker again.
        logger.warn(
          "semantic-search: model did not load in the embedding worker, trying the main thread",
          { model, message },
        );
      }
      return opts.inner(model, onProgress, loadOpts);
    }
  };
}
