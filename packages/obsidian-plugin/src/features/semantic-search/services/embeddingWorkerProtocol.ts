/**
 * Messages between the plugin and an embedding worker (ADR-0036).
 *
 * One worker holds one model. It boots, loads the model when told to, then
 * answers one `run` at a time: the host keeps the queue, which is what
 * lets a search query go ahead of pending rebuild batches.
 *
 * Types only: this file is bundled into the worker runtime too.
 */
import type { ProgressEvent } from "./embedder";

/** The ONNX environment the worker applies before loading the model. */
export type WorkerEnv = {
  wasmPaths: string;
  useBrowserCache: boolean;
  /** Left out on a WebGPU machine, as `configureEnvForWebGpu` leaves it out. */
  numThreads?: number;
};

/** The pipeline call options that cross to the worker. */
export type WorkerRunOpts = {
  pooling?: "mean" | "cls" | "none";
  normalize?: boolean;
  truncation?: boolean;
  max_length?: number;
};

export type HostMessage =
  | {
      type: "load";
      model: string;
      options: { device: string; dtype?: string };
      env: WorkerEnv;
    }
  | {
      type: "run";
      id: number;
      input: string | string[];
      opts?: WorkerRunOpts;
      /** Read the model's `sentence_embedding` output (EmbeddingGemma). */
      sentence: boolean;
    }
  | { type: "dispose" };

export type WorkerMessage =
  /** The library evaluated: the worker can take a `load`. */
  | { type: "booted" }
  | { type: "progress"; info: ProgressEvent }
  | { type: "loaded" }
  | { type: "load-error"; message: string }
  | { type: "result"; id: number; data: Float32Array; dims?: number[] }
  | { type: "run-error"; id: number; message: string }
  | { type: "disposed" };
