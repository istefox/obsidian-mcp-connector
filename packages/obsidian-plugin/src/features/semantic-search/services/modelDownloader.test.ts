import { describe, expect, test } from "bun:test";
import { createModelDownloader, type ModelState } from "./modelDownloader";
import type {
  PipelineFactoryWithProgress,
  PipelineFn,
  ProgressCallback,
  ProgressEvent,
} from "./embedder";

/**
 * Manual-control mock factory: returns a promise that the test
 * resolves/rejects on demand, and exposes the progress callback so
 * the test can simulate Transformers.js-style events.
 */
function makeControlledFactory(): {
  factory: PipelineFactoryWithProgress;
  emit: (info: ProgressEvent) => void;
  resolve: () => void;
  reject: (err: Error) => void;
  callCount: () => number;
} {
  let onProgress: ProgressCallback | undefined;
  let resolveOuter: (pipe: PipelineFn) => void = () => undefined;
  let rejectOuter: (err: Error) => void = () => undefined;
  let calls = 0;

  const fakePipe: PipelineFn = async () => ({
    data: new Float32Array(4),
    dims: [1, 4],
  });

  const factory: PipelineFactoryWithProgress = async (_model, cb) => {
    calls += 1;
    onProgress = cb;
    return new Promise<PipelineFn>((res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    });
  };

  return {
    factory,
    emit: (info) => onProgress?.(info),
    resolve: () => resolveOuter(fakePipe),
    reject: (err) => rejectOuter(err),
    callCount: () => calls,
  };
}

describe("model downloader — state machine (T13)", () => {
  test("starts in idle and emits the current state to new subscribers", () => {
    const { factory } = makeControlledFactory();
    const dl = createModelDownloader({ innerFactory: factory });
    expect(dl.getState()).toEqual({ kind: "idle" });

    const emissions: ModelState[] = [];
    const unsub = dl.subscribe((s) => emissions.push(s));
    expect(emissions).toEqual([{ kind: "idle" }]);
    unsub();
  });

  test("idle → downloading → ready on the happy path", async () => {
    const ctrl = makeControlledFactory();
    const dl = createModelDownloader({ innerFactory: ctrl.factory });

    const emissions: ModelState[] = [];
    dl.subscribe((s) => emissions.push(s));

    const pending = dl.factory("Xenova/all-MiniLM-L6-v2");
    expect(dl.getState()).toEqual({ kind: "downloading", progress: 0 });

    ctrl.emit({ status: "progress", progress: 42, file: "model.onnx" });
    expect(dl.getState()).toEqual({
      kind: "downloading",
      progress: 42,
      file: "model.onnx",
    });

    ctrl.emit({ status: "progress", progress: 99 });
    expect(dl.getState()).toMatchObject({ kind: "downloading", progress: 99 });

    ctrl.resolve();
    await pending;

    expect(dl.getState()).toEqual({ kind: "ready" });
    // Sequence: idle (initial subscribe) → downloading 0 → 42 → 99 → ready
    expect(emissions.map((s) => s.kind)).toEqual([
      "idle",
      "downloading",
      "downloading",
      "downloading",
      "ready",
    ]);
  });

  test("error state on failure carries the message and is reported to subscribers", async () => {
    const ctrl = makeControlledFactory();
    const dl = createModelDownloader({ innerFactory: ctrl.factory });

    const states: ModelState[] = [];
    dl.subscribe((s) => states.push(s));

    const pending = dl.factory("model");
    expect(dl.getState().kind).toBe("downloading");

    ctrl.reject(new Error("network is down"));
    await expect(pending).rejects.toThrow("network is down");

    expect(dl.getState()).toEqual({
      kind: "error",
      message: "network is down",
    });
    // Emissions include the final error state.
    expect(states[states.length - 1]).toEqual({
      kind: "error",
      message: "network is down",
    });
  });

  test("retry from error returns to idle and the next factory call re-runs the inner factory", async () => {
    const ctrl = makeControlledFactory();
    const dl = createModelDownloader({ innerFactory: ctrl.factory });

    const first = dl.factory("model");
    ctrl.reject(new Error("fail"));
    await expect(first).rejects.toThrow();
    expect(dl.getState().kind).toBe("error");

    dl.retry();
    expect(dl.getState()).toEqual({ kind: "idle" });

    const second = dl.factory("model");
    expect(dl.getState().kind).toBe("downloading");
    ctrl.resolve();
    await second;
    expect(dl.getState().kind).toBe("ready");

    expect(ctrl.callCount()).toBe(2); // inner factory invoked twice
  });

  test("concurrent first-call dedupes through the in-flight promise", async () => {
    const ctrl = makeControlledFactory();
    const dl = createModelDownloader({ innerFactory: ctrl.factory });

    const a = dl.factory("model");
    const b = dl.factory("model");
    expect(a).toBe(b); // same promise reference

    ctrl.resolve();
    await Promise.all([a, b]);
    expect(ctrl.callCount()).toBe(1);
    expect(dl.getState().kind).toBe("ready");
  });

  test("retry during a download is a no-op (state stays downloading)", async () => {
    const ctrl = makeControlledFactory();
    const dl = createModelDownloader({ innerFactory: ctrl.factory });

    const pending = dl.factory("model");
    expect(dl.getState().kind).toBe("downloading");

    dl.retry(); // ignored
    expect(dl.getState().kind).toBe("downloading");

    ctrl.resolve();
    await pending;
    expect(dl.getState().kind).toBe("ready");
  });

  test("subscribe returns an unsubscribe that stops further emissions", async () => {
    const ctrl = makeControlledFactory();
    const dl = createModelDownloader({ innerFactory: ctrl.factory });

    const seen: ModelState[] = [];
    const unsub = dl.subscribe((s) => seen.push(s));
    unsub();

    const pending = dl.factory("model");
    ctrl.resolve();
    await pending;

    // Only the initial idle from subscribe should be in `seen`.
    expect(seen).toEqual([{ kind: "idle" }]);
  });
});
