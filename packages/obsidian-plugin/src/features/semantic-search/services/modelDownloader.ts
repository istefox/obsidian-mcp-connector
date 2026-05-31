/**
 * Model downloader — state machine that surfaces the Transformers.js
 * model download progress to the settings UI (T13).
 *
 * Architecture:
 *   - Wraps a `PipelineFactoryWithProgress` (the inner factory; the
 *     production wiring uses `realPipelineFactory`, tests inject a
 *     deterministic mock that the test code drives manually).
 *   - Exposes a normal `PipelineFactory` (`.factory`) that the
 *     embedder consumes — to the embedder this looks identical to
 *     calling `realPipelineFactory` directly. Behind the scenes the
 *     downloader subscribes to the inner progress events and feeds
 *     a single observable state into the UI.
 *   - State transitions: idle → downloading → ready (happy path) or
 *     idle → downloading → error (failure). `retry()` resets to
 *     idle so the next factory call re-runs the inner factory.
 *
 * Subscribers receive every state change; the most recent state is
 * also accessible via `getState()` for components mounting late.
 */

import type {
  PipelineFactory,
  PipelineFactoryWithProgress,
  PipelineFn,
  ProgressEvent,
} from "./embedder";

export type ModelState =
  | { kind: "idle" }
  | { kind: "downloading"; progress: number; file?: string }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export interface ModelDownloader {
  /** Wrapped factory — pass this to `createEmbedder`. */
  factory: PipelineFactory;
  getState(): ModelState;
  subscribe(handler: (state: ModelState) => void): () => void;
  /**
   * Reset state from `error` or `ready` back to `idle` so the next
   * `factory(...)` call retries the inner factory. UI calls this
   * from a "Retry" button.
   */
  retry(): void;
}

export type ModelDownloaderOpts = {
  innerFactory: PipelineFactoryWithProgress;
  /** Passed to the WASM fallback path. Unused when WebGPU succeeds. */
  dtype?: string;
};

const IDLE: ModelState = { kind: "idle" };

class ModelDownloaderImpl implements ModelDownloader {
  private state: ModelState = IDLE;
  private subscribers = new Set<(state: ModelState) => void>();
  private inFlight: Promise<PipelineFn> | null = null;

  constructor(private opts: ModelDownloaderOpts) {}

  getState(): ModelState {
    return this.state;
  }

  subscribe(handler: (state: ModelState) => void): () => void {
    this.subscribers.add(handler);
    handler(this.state); // emit current state immediately
    return () => {
      this.subscribers.delete(handler);
    };
  }

  retry(): void {
    if (this.state.kind === "downloading") return;
    this.setState(IDLE);
  }

  factory: PipelineFactory = (model: string) => {
    // De-duplicate concurrent first-call: any caller during the
    // download awaits the same inner promise, which keeps the state
    // transitions consistent with what the subscriber sees.
    if (this.inFlight) return this.inFlight;

    this.setState({ kind: "downloading", progress: 0 });
    const promise = (async () => {
      try {
        const pipe = await this.opts.innerFactory(
          model,
          (info) => this.onProgress(info),
          this.opts.dtype !== undefined
            ? { dtype: this.opts.dtype }
            : undefined,
        );
        this.setState({ kind: "ready" });
        return pipe;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.setState({ kind: "error", message });
        throw err;
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = promise;
    return promise;
  };

  private onProgress(info: ProgressEvent): void {
    // Only `progress`-style events update the bar. `done`/`ready`
    // are handled by the surrounding factory promise resolving.
    if (info.status === "progress" && typeof info.progress === "number") {
      this.setState({
        kind: "downloading",
        progress: clamp(info.progress, 0, 100),
        file: info.file,
      });
    }
  }

  private setState(next: ModelState): void {
    this.state = next;
    for (const h of this.subscribers) h(next);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function createModelDownloader(
  opts: ModelDownloaderOpts,
): ModelDownloader {
  return new ModelDownloaderImpl(opts);
}
