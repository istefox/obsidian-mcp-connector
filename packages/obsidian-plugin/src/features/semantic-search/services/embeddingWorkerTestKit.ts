/**
 * Test support: an embedding worker without a thread. The real runtime
 * (`startEmbeddingWorker`) runs in this process, and every message crosses
 * through `structuredClone`, as it would between threads.
 */
import type { EmbedTensor, PipelineCallOpts, PipelineFn } from "./embedder";
import type { WorkerLike } from "./embeddingWorkerHost";
import type { HostMessage, WorkerMessage } from "./embeddingWorkerProtocol";
import {
  startEmbeddingWorker,
  type WorkerLib,
  type WorkerScope,
} from "./embeddingWorkerRuntime";

export type FakeWorker = WorkerLike & {
  terminated: boolean;
  /** Every message the host sent, in order. */
  received: HostMessage[];
  /** Fires the worker's `error` event on the host. */
  crash(message: string): void;
};

export type FakeLibCall = {
  input: string | string[];
  opts: PipelineCallOpts | undefined;
};

export type FakeLib = WorkerLib & {
  env: { backends: { onnx: { wasm: Record<string, unknown> } } } & Record<
    string,
    unknown
  >;
  calls: FakeLibCall[];
  loads: { model: string; device: string; dtype?: string }[];
  disposed: number;
};

/** A library whose pipeline answers with `embed(input)`. */
export function fakeLib(
  embed: (input: string | string[]) => EmbedTensor | Promise<EmbedTensor>,
  opts: { loadError?: string } = {},
): FakeLib {
  const lib: FakeLib = {
    env: { backends: { onnx: { wasm: {} } } },
    calls: [],
    loads: [],
    disposed: 0,
    pipeline: async (_task, model, options) => {
      lib.loads.push({
        model,
        device: options.device,
        ...(options.dtype !== undefined ? { dtype: options.dtype } : {}),
      });
      options.progress_callback({
        status: "progress",
        progress: 50,
        file: "model.onnx",
      });
      if (opts.loadError) throw new Error(opts.loadError);
      const pipe: PipelineFn = async (input, callOpts) => {
        lib.calls.push({ input, opts: callOpts });
        return embed(input);
      };
      pipe.dispose = async () => {
        lib.disposed += 1;
      };
      return pipe;
    },
  };
  return lib;
}

/** A worker that runs the real runtime on `lib`, delivering asynchronously. */
export function fakeWorker(lib: WorkerLib): FakeWorker {
  const scope: WorkerScope = {
    onmessage: null,
    postMessage: (message: WorkerMessage) => {
      const copy = structuredClone(message);
      queueMicrotask(() => {
        if (!worker.terminated) worker.onmessage?.({ data: copy });
      });
    },
  };
  const worker: FakeWorker = {
    terminated: false,
    received: [],
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      const copy = structuredClone(message);
      worker.received.push(copy);
      queueMicrotask(() => {
        if (!worker.terminated) scope.onmessage?.({ data: copy });
      });
    },
    terminate: () => {
      worker.terminated = true;
    },
    crash: (message) => worker.onerror?.({ message }),
  };
  // The script runs after the constructor returned, as in a real worker.
  queueMicrotask(() => startEmbeddingWorker(lib, scope));
  return worker;
}
