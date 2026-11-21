import { describe, expect, test } from "bun:test";
import type {
  PipelineFactoryWithProgress,
  PipelineFn,
  PipelineLoadOpts,
} from "./embedder";
import { withSentenceEmbedding } from "./sentenceEmbeddingPipeline";
import { fakeLib, fakeWorker, type FakeWorker } from "./embeddingWorkerTestKit";
import { ORT_WASM_PATHS } from "./ortWasmPaths";
import {
  createWorkerPipelineFactory,
  workerPoolSize,
} from "./workerPipelineFactory";

function mainThread() {
  const calls: { model: string; opts: PipelineLoadOpts | undefined }[] = [];
  const pipe: PipelineFn = async () => ({ data: new Float32Array([7]) });
  const inner: PipelineFactoryWithProgress = async (model, _p, opts) => {
    calls.push({ model, opts });
    return pipe;
  };
  return { calls, pipe, inner };
}

function workers(lib = fakeLib(() => ({ data: new Float32Array([1, 2]) }))) {
  const spawned: FakeWorker[] = [];
  const spawn = () => {
    const w = fakeWorker(lib);
    spawned.push(w);
    return w;
  };
  return { lib, spawned, spawn };
}

describe("createWorkerPipelineFactory", () => {
  test("a WASM model runs in a worker, and the main thread is not asked", async () => {
    const main = mainThread();
    const { lib, spawned, spawn } = workers();
    const factory = createWorkerPipelineFactory({
      inner: main.inner,
      spawn,
      probe: async () => "wasm",
    });

    const pipe = await factory("Xenova/all-MiniLM-L6-v2", undefined, {
      dtype: { wasm: "q8", webgpu: "q4" },
    });

    expect(main.calls).toEqual([]);
    expect(spawned).toHaveLength(1);
    expect(lib.loads).toEqual([
      { model: "Xenova/all-MiniLM-L6-v2", device: "cpu", dtype: "q8" },
    ]);
    // What onnxEnv.configureEnv sets on a WASM-only machine.
    expect(spawned[0]!.received[0]).toMatchObject({
      type: "load",
      env: { wasmPaths: ORT_WASM_PATHS, numThreads: 1 },
    });
    expect(Array.from((await pipe("x")).data)).toEqual([1, 2]);
  });

  test("a WebGPU model stays on the main thread, untouched", async () => {
    const main = mainThread();
    const { spawned, spawn } = workers();
    const factory = createWorkerPipelineFactory({
      inner: main.inner,
      spawn,
      probe: async () => "webgpu",
    });
    const opts = { dtype: { wasm: "q8", webgpu: "q8" } };

    const pipe = await factory("Xenova/multilingual-e5-base", undefined, opts);

    expect(pipe).toBe(main.pipe);
    expect(main.calls).toEqual([
      { model: "Xenova/multilingual-e5-base", opts },
    ]);
    expect(spawned).toEqual([]);
  });

  test("a model pinned to WASM on a WebGPU machine runs in a worker, numThreads left to the library", async () => {
    const main = mainThread();
    const { lib, spawned, spawn } = workers();
    const factory = createWorkerPipelineFactory({
      inner: main.inner,
      spawn,
      probe: async () => "webgpu",
    });

    await factory("onnx-community/embeddinggemma-300m-ONNX", undefined, {
      dtype: { wasm: "q8", webgpu: "q4" },
      backend: "wasm",
    });

    expect(main.calls).toEqual([]);
    expect(lib.loads[0]).toMatchObject({ device: "cpu", dtype: "q8" });
    const load = spawned[0]!.received[0];
    expect(load?.type === "load" && "numThreads" in load.env).toBe(false);
  });

  test("with no way to spawn a worker, every model takes the main thread", async () => {
    const main = mainThread();
    let probed = false;
    const factory = createWorkerPipelineFactory({
      inner: main.inner,
      spawn: null,
      probe: async () => {
        probed = true;
        return "wasm";
      },
    });

    expect(await factory("m")).toBe(main.pipe);
    expect(probed).toBe(false);
  });

  test("falls back to the main thread when the worker cannot start, and stops trying", async () => {
    const main = mainThread();
    let attempts = 0;
    const factory = createWorkerPipelineFactory({
      inner: main.inner,
      spawn: () => {
        attempts += 1;
        throw new Error("Worker blocked by policy");
      },
      probe: async () => "wasm",
    });
    const opts = { backend: "wasm" as const };

    expect(await factory("m", undefined, opts)).toBe(main.pipe);
    expect(await factory("m2", undefined, opts)).toBe(main.pipe);

    expect(main.calls).toEqual([
      { model: "m", opts },
      { model: "m2", opts },
    ]);
    expect(attempts).toBe(1);
  });

  test("a worker that dies and cannot be started again moves the model to the main thread, with the same load options, and stops trying", async () => {
    const main = mainThread();
    const lib = fakeLib(() => ({ data: new Float32Array([1, 2]) }));
    const spawned: FakeWorker[] = [];
    let attempts = 0;
    const factory = createWorkerPipelineFactory({
      inner: main.inner,
      spawn: () => {
        attempts += 1;
        if (spawned.length >= 1) throw new Error("workers are blocked");
        const w = fakeWorker(lib);
        spawned.push(w);
        return w;
      },
      probe: async () => "wasm",
    });
    const loadOpts = { dtype: { wasm: "q8", webgpu: "q4" } } as const;

    const pipe = await factory("some/model", undefined, loadOpts);
    spawned[0]!.crash("gone");
    expect(Array.from((await pipe("x")).data)).toEqual([7]);
    expect(main.calls).toEqual([{ model: "some/model", opts: loadOpts }]);

    await factory("other/model", undefined, loadOpts);
    expect(attempts).toBe(2);
    expect(main.calls).toHaveLength(2);
  });

  test("a model that fails to load in the worker is tried once on the main thread", async () => {
    const main = mainThread();
    const { spawned, spawn } = workers(
      fakeLib(() => ({ data: new Float32Array(0) }), {
        loadError: "Failed to fetch",
      }),
    );
    const factory = createWorkerPipelineFactory({
      inner: main.inner,
      spawn,
      probe: async () => "wasm",
    });

    expect(await factory("m")).toBe(main.pipe);
    expect(main.calls).toHaveLength(1);
    expect(spawned[0]!.terminated).toBe(true);

    // Not a boot failure: the next load asks a worker again.
    expect(await factory("m")).toBe(main.pipe);
    expect(spawned).toHaveLength(2);
  });

  test("a model that loads nowhere reports the main thread's error", async () => {
    const { spawn } = workers(
      fakeLib(() => ({ data: new Float32Array(0) }), {
        loadError: "Failed to fetch",
      }),
    );
    const factory = createWorkerPipelineFactory({
      inner: async () => {
        throw new Error("offline");
      },
      spawn,
      probe: async () => "wasm",
    });
    await expect(factory("m")).rejects.toThrow("offline");
  });

  test("withSentenceEmbedding hands a worker pipeline's calls to the worker", async () => {
    const main = mainThread();
    const { spawned, spawn } = workers();
    const factory = createWorkerPipelineFactory({
      inner: main.inner,
      spawn,
      probe: async () => "wasm",
    });
    const pipe = await withSentenceEmbedding((model) => factory(model))("m");

    expect(pipe.acceptsPriority).toBe(true);
    // The fake pipeline has no tokenizer: the worker answers with the
    // wrapper's own error, which proves the call took the sentence path.
    await expect(pipe(["a"], { priority: "query" })).rejects.toThrow();
    expect(spawned[0]!.received.at(-1)).toMatchObject({
      type: "run",
      sentence: true,
      input: ["a"],
    });
    await pipe.dispose!();
    expect(spawned[0]!.terminated).toBe(true);
  });
});

describe("workerPoolSize", () => {
  const GB = 1024 ** 3;
  test("half the cores, one worker per 4 GB, four at most", () => {
    expect(workerPoolSize({ cores: 8, totalMemoryBytes: 16 * GB })).toBe(4);
    expect(workerPoolSize({ cores: 16, totalMemoryBytes: 64 * GB })).toBe(4);
    expect(workerPoolSize({ cores: 4, totalMemoryBytes: 32 * GB })).toBe(2);
    expect(workerPoolSize({ cores: 12, totalMemoryBytes: 8 * GB })).toBe(2);
  });

  test("a small or unknown machine gets one worker", () => {
    expect(workerPoolSize({ cores: 2, totalMemoryBytes: 16 * GB })).toBe(1);
    expect(workerPoolSize({ cores: 8, totalMemoryBytes: 4 * GB })).toBe(1);
    expect(
      workerPoolSize({ cores: undefined, totalMemoryBytes: 16 * GB }),
    ).toBe(1);
    expect(workerPoolSize({ cores: 8, totalMemoryBytes: undefined })).toBe(1);
    expect(
      workerPoolSize({ cores: Number.NaN, totalMemoryBytes: 16 * GB }),
    ).toBe(1);
  });

  test("the pool size reaches the worker pipeline", async () => {
    const { spawn } = workers();
    const { inner } = mainThread();
    const factory = createWorkerPipelineFactory({
      inner,
      spawn,
      probe: async () => "wasm",
      poolSize: 3,
    });
    const pipe = await factory("m", undefined, { backend: "wasm" });
    expect(pipe.concurrency?.()).toBe(3);
    await pipe.dispose?.();
  });
});
