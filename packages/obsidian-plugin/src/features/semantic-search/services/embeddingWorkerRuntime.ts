/**
 * The code that runs inside an embedding worker (ADR-0036).
 *
 * Bundled on its own by `bun.config.ts` and started from its source text,
 * next to the Transformers.js factory. So it must stay small and import
 * nothing that reaches `transformersModule.ts`, the logger or Obsidian:
 * the library arrives as the `lib` argument.
 *
 * It does what `realPipelineFactory` and `onnxEnv.ts` do on the main
 * thread, with the same library, the same options and the same
 * environment, which is why the vectors are the same.
 */
import type { PipelineFn, ProgressEvent } from "./embedder";
import type {
  HostMessage,
  WorkerEnv,
  WorkerMessage,
} from "./embeddingWorkerProtocol";
import { wrapSentenceEmbedding } from "./sentenceEmbeddingPipeline";

/** Transformers.js, as far as the worker uses it. */
export type WorkerLib = {
  env: unknown;
  pipeline: (
    task: "feature-extraction",
    model: string,
    options: {
      device: string;
      dtype?: string;
      progress_callback: (info: ProgressEvent) => void;
    },
  ) => Promise<unknown>;
};

/** The worker global scope, as far as the runtime uses it. */
export type WorkerScope = {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((event: { data: HostMessage }) => void) | null;
};

type HfEnv = {
  backends?: {
    onnx?: { wasm?: { numThreads?: number; wasmPaths?: string } };
  };
  useBrowserCache?: boolean;
};

function applyEnv(target: unknown, env: WorkerEnv): void {
  const e = target as HfEnv;
  const wasm = e.backends?.onnx?.wasm;
  if (!wasm) {
    // On the main thread this is a logged warning and the load goes on to
    // fail on a 404. Here the host reports the message as a load error.
    throw new Error(
      "embedding worker: expected WASM backend shape not found, CDN paths not configured",
    );
  }
  wasm.wasmPaths = env.wasmPaths;
  if (env.numThreads !== undefined) wasm.numThreads = env.numThreads;
  if (env.useBrowserCache) e.useBrowserCache = true;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function startEmbeddingWorker(lib: WorkerLib, scope: WorkerScope): void {
  let pipe: PipelineFn | null = null;
  let sentencePipe: PipelineFn | null = null;
  // One message at a time: a `run` never overtakes the `load` before it.
  let chain: Promise<void> = Promise.resolve();

  const handle = async (message: HostMessage): Promise<void> => {
    if (message.type === "load") {
      try {
        applyEnv(lib.env, message.env);
        pipe = (await lib.pipeline("feature-extraction", message.model, {
          ...message.options,
          progress_callback: (info) => {
            // Only the fields the UI reads: the library's event also
            // carries values that do not survive a structured clone.
            scope.postMessage({
              type: "progress",
              info: {
                status: info.status,
                progress: info.progress,
                file: info.file,
              },
            });
          },
        })) as PipelineFn;
        scope.postMessage({ type: "loaded" });
      } catch (err) {
        scope.postMessage({ type: "load-error", message: messageOf(err) });
      }
      return;
    }

    if (message.type === "run") {
      try {
        if (!pipe) throw new Error("embedding worker: no model loaded");
        let run = pipe;
        if (message.sentence) {
          sentencePipe ??= wrapSentenceEmbedding(pipe);
          run = sentencePipe;
        }
        const out = await run(message.input, message.opts);
        // An owned copy: the buffer is transferred, and the library's own
        // tensor must not be the one that goes away.
        const data = Float32Array.from(out.data);
        scope.postMessage(
          {
            type: "result",
            id: message.id,
            data,
            ...(out.dims ? { dims: Array.from(out.dims) } : {}),
          },
          [data.buffer],
        );
      } catch (err) {
        scope.postMessage({
          type: "run-error",
          id: message.id,
          message: messageOf(err),
        });
      }
      return;
    }

    const loaded = pipe;
    pipe = null;
    sentencePipe = null;
    try {
      await loaded?.dispose?.();
    } catch {
      // The host terminates the worker next, which frees the sessions anyway.
    }
    scope.postMessage({ type: "disposed" });
  };

  scope.onmessage = (event) => {
    chain = chain.then(() => handle(event.data));
  };
  scope.postMessage({ type: "booted" });
}
