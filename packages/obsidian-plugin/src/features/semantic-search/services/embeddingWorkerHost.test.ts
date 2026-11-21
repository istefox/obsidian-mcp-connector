import { describe, expect, test } from "bun:test";
import type { EmbedTensor, PipelineFn } from "./embedder";
import {
  createWorkerPipeline,
  WorkerBootError,
  type WorkerLike,
} from "./embeddingWorkerHost";
import { fakeLib, fakeWorker, type FakeWorker } from "./embeddingWorkerTestKit";

const ENV = { wasmPaths: "https://cdn.test/ort/", useBrowserCache: true };
const OPTIONS = { device: "cpu", dtype: "q8" };

function start(lib = fakeLib(() => ({ data: new Float32Array([1]) }))) {
  const workers: FakeWorker[] = [];
  const spawn = () => {
    const w = fakeWorker(lib);
    workers.push(w);
    return w;
  };
  return { lib, workers, spawn };
}

/** A gate each pipeline call waits on, so a test controls the order. */
function gated() {
  const order: string[] = [];
  const release: (() => void)[] = [];
  const lib = fakeLib((input) => {
    order.push(String(input));
    return new Promise<EmbedTensor>((resolve) => {
      release.push(() => resolve({ data: new Float32Array([order.length]) }));
    });
  });
  return { lib, order, release };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createWorkerPipeline", () => {
  test("loads the model in the worker with the given options and env", async () => {
    const { lib, spawn } = start();
    const progress: unknown[] = [];
    await createWorkerPipeline({
      spawn,
      model: "some/model",
      options: OPTIONS,
      env: { ...ENV, numThreads: 1 },
      onProgress: (info) => progress.push(info),
    });

    expect(lib.loads).toEqual([
      { model: "some/model", device: "cpu", dtype: "q8" },
    ]);
    expect(lib.env.backends.onnx.wasm).toEqual({
      wasmPaths: "https://cdn.test/ort/",
      numThreads: 1,
    });
    expect(lib.env.useBrowserCache).toBe(true);
    expect(progress).toEqual([
      { status: "progress", progress: 50, file: "model.onnx" },
    ]);
  });

  test("leaves numThreads alone when the env does not set it", async () => {
    const { lib, spawn } = start();
    await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });
    expect("numThreads" in lib.env.backends.onnx.wasm).toBe(false);
  });

  test("returns the worker's vectors bit for bit", async () => {
    // Values a lossy transport would change: a denormal, negative zero,
    // the float32 extremes, a NaN with a payload.
    const bits = new Uint32Array([
      0x00000001, 0x80000000, 0x7f7fffff, 0xff7fffff, 0x7fc00123, 0x3eaaaaab,
    ]);
    const source = new Float32Array(bits.buffer.slice(0));
    const { spawn } = start(
      fakeLib(() => ({ data: new Float32Array(source), dims: [2, 3] })),
    );
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });

    const out = await pipe(["a", "b"], { normalize: true });

    expect(out.dims).toEqual([2, 3]);
    expect(out.data).toBeInstanceOf(Float32Array);
    expect(
      Array.from(new Uint32Array(out.data.buffer, out.data.byteOffset, 6)),
    ).toEqual(Array.from(bits));
  });

  test("passes the call options on, without the priority hint", async () => {
    const { lib, spawn } = start();
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });
    expect(pipe.acceptsPriority).toBe(true);

    await pipe("q", {
      pooling: "mean",
      normalize: true,
      truncation: true,
      max_length: 512,
      priority: "query",
    });

    expect(lib.calls).toEqual([
      {
        input: "q",
        opts: {
          pooling: "mean",
          normalize: true,
          truncation: true,
          max_length: 512,
        },
      },
    ]);
  });

  test("runs one call at a time and puts a query ahead of waiting documents", async () => {
    const { lib, order, release } = gated();
    const { spawn } = start(lib);
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });

    const d1 = pipe("doc-1");
    const d2 = pipe("doc-2");
    const d3 = pipe("doc-3");
    const q = pipe("query", { priority: "query" });
    await tick();
    // Only the first call reached the model; the rest wait on the host.
    expect(order).toEqual(["doc-1"]);

    for (let i = 0; i < 4; i++) {
      release[i]?.();
      await tick();
    }
    await Promise.all([d1, d2, d3, q]);
    expect(order).toEqual(["doc-1", "query", "doc-2", "doc-3"]);
  });

  test("reads sentence_embedding in the worker for sentenceEmbedding calls", async () => {
    const lib = fakeLib(() => ({ data: new Float32Array([9]) }));
    const inner = lib.pipeline;
    const tokenized: unknown[] = [];
    lib.pipeline = async (task, model, options) => {
      const pipe = (await inner(task, model, options)) as Record<
        string,
        unknown
      >;
      pipe.tokenizer = (texts: string[], opts: unknown) => {
        tokenized.push({ texts, opts });
        return { input_ids: texts };
      };
      pipe.model = async () => ({
        sentence_embedding: { data: [3, 4, 0, 5], dims: [2, 2] },
      });
      return pipe;
    };
    const { spawn } = start(lib);
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });

    const out = await pipe.sentenceEmbedding!(["a", "b"], {
      normalize: true,
      max_length: 512,
    });

    expect(tokenized).toEqual([
      {
        texts: ["a", "b"],
        opts: { padding: true, truncation: true, max_length: 512 },
      },
    ]);
    expect(out.dims).toEqual([2, 2]);
    expect(Array.from(out.data)).toEqual([
      Math.fround(0.6),
      Math.fround(0.8),
      0,
      1,
    ]);
    // The pipeline's own pooling never ran.
    expect(lib.calls).toEqual([]);
  });

  test("a pipeline error rejects that call and the next one still runs", async () => {
    let fail = true;
    const { spawn } = start(
      fakeLib(() => {
        if (fail) throw new Error("ort: out of memory");
        return { data: new Float32Array([2]) };
      }),
    );
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });

    await expect(pipe("a")).rejects.toThrow("ort: out of memory");
    fail = false;
    expect(Array.from((await pipe("b")).data)).toEqual([2]);
  });

  describe("a worker that cannot start", () => {
    test("constructor throws: WorkerBootError", async () => {
      const attempt = createWorkerPipeline({
        spawn: () => {
          throw new Error("Worker is not defined");
        },
        model: "m",
        options: OPTIONS,
        env: ENV,
      });
      await expect(attempt).rejects.toBeInstanceOf(WorkerBootError);
      await expect(attempt).rejects.toThrow("Worker is not defined");
    });

    test("script fails before it boots: WorkerBootError, worker terminated", async () => {
      let worker: (WorkerLike & { terminated: boolean }) | undefined;
      const attempt = createWorkerPipeline({
        spawn: () => {
          const w = {
            terminated: false,
            onmessage: null,
            onerror: null,
            postMessage: () => {},
            terminate: () => {
              w.terminated = true;
            },
          } as WorkerLike & { terminated: boolean };
          worker = w;
          queueMicrotask(() =>
            w.onerror?.({ message: "require is not defined" }),
          );
          return w;
        },
        model: "m",
        options: OPTIONS,
        env: ENV,
      });
      await expect(attempt).rejects.toBeInstanceOf(WorkerBootError);
      expect(worker?.terminated).toBe(true);
    });

    test("stays silent: WorkerBootError after the boot timeout", async () => {
      const attempt = createWorkerPipeline({
        spawn: () => ({
          onmessage: null,
          onerror: null,
          postMessage: () => {},
          terminate: () => {},
        }),
        model: "m",
        options: OPTIONS,
        env: ENV,
        bootTimeoutMs: 5,
      });
      await expect(attempt).rejects.toBeInstanceOf(WorkerBootError);
    });
  });

  test("a model that fails to load is an ordinary error, not a boot failure", async () => {
    const { workers, spawn } = start(
      fakeLib(() => ({ data: new Float32Array(0) }), {
        loadError: "Could not locate file: model_quantized.onnx",
      }),
    );
    const attempt = createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });
    await expect(attempt).rejects.toThrow("Could not locate file");
    await attempt.catch((err: unknown) => {
      expect(err).not.toBeInstanceOf(WorkerBootError);
    });
    expect(workers[0]?.terminated).toBe(true);
  });

  test("a crash puts the running call on a new worker, ahead of what waited", async () => {
    const { lib, order, release } = gated();
    const { workers, spawn } = start(lib);
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });

    const running = pipe("doc-1");
    const waiting = pipe("doc-2");
    await tick();
    workers[0]!.crash("out of memory");
    expect(workers[0]!.terminated).toBe(true);
    await tick();
    expect(workers).toHaveLength(2);
    expect(lib.loads).toHaveLength(2);
    expect(order).toEqual(["doc-1", "doc-1"]);
    release[1]?.();
    await running;
    await tick();
    release[2]?.();
    await waiting;
    expect(order).toEqual(["doc-1", "doc-1", "doc-2"]);
  });

  test("a call the worker never answers ends as a crash and is tried on a new worker", async () => {
    const { lib, order, release } = gated();
    const { workers, spawn } = start(lib);
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
      callTimeoutMs: 20,
    });

    const call = pipe("doc-1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    release[1]?.();
    await call;
    expect(order).toEqual(["doc-1", "doc-1"]);
    await pipe.dispose!();
  });

  test("a message that cannot be read is a crash", async () => {
    const { lib, release } = gated();
    const { workers, spawn } = start(lib);
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });

    const call = pipe("doc-1");
    await tick();
    workers[0]!.onmessageerror?.();
    expect(workers[0]!.terminated).toBe(true);
    await tick();
    release[1]?.();
    await call;
    await pipe.dispose!();
  });

  test("a call that takes two workers down fails alone", async () => {
    const { lib, order, release } = gated();
    const { workers, spawn } = start(lib);
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });

    const poison = pipe("poison");
    const next = pipe("doc-2");
    await tick();
    workers[0]!.crash("out of memory");
    await tick();
    workers[1]!.crash("out of memory");
    await expect(poison).rejects.toThrow("embedding worker crashed");
    await tick();
    expect(workers).toHaveLength(3);
    release[2]?.();
    await next;
    expect(order).toEqual(["poison", "poison", "doc-2"]);
  });

  describe("main-thread takeover", () => {
    /** A main-thread pipeline that also answers the sentence path. */
    const mainPipe = () => {
      const calls: { kind: string; input: unknown; opts: unknown }[] = [];
      const pipe: PipelineFn = async (input, opts) => {
        calls.push({ kind: "pooled", input, opts });
        return { data: new Float32Array([9]) };
      };
      let disposed = 0;
      pipe.dispose = async () => {
        disposed += 1;
      };
      Object.assign(pipe, {
        tokenizer: (texts: string[]) => texts,
        model: async (inputs: unknown) => {
          calls.push({ kind: "sentence", input: inputs, opts: undefined });
          return {
            sentence_embedding: {
              data: new Float32Array([3, 4]),
              dims: [1, 2],
            },
          };
        },
      });
      return { pipe, calls, disposed: () => disposed };
    };

    const takeover = async (extra: {
      failSpawnAfter?: number;
      fallback?: () => Promise<PipelineFn>;
    }) => {
      const { lib, release } = gated();
      const workers: FakeWorker[] = [];
      const here = mainPipe();
      let unavailable = 0;
      const pipe = await createWorkerPipeline({
        spawn: () => {
          if (workers.length >= (extra.failSpawnAfter ?? Infinity)) {
            throw new Error("workers are blocked");
          }
          const w = fakeWorker(lib);
          workers.push(w);
          return w;
        },
        model: "m",
        options: OPTIONS,
        env: ENV,
        fallback: extra.fallback ?? (async () => here.pipe),
        onWorkerUnavailable: () => {
          unavailable += 1;
        },
      });
      return { pipe, workers, here, release, unavailable: () => unavailable };
    };

    test("no worker comes back: the queue runs on the main thread", async () => {
      const t = await takeover({ failSpawnAfter: 1 });
      const first = t.pipe("doc-1", { pooling: "mean", priority: "query" });
      const second = t.pipe.sentenceEmbedding!("doc-2", { normalize: false });
      await tick();
      t.workers[0]!.crash("gone");

      expect((await first).data).toEqual(new Float32Array([9]));
      // The sentence path reads `sentence_embedding`, as in the worker.
      expect((await second).data).toEqual(new Float32Array([3, 4]));
      expect(t.here.calls.map((c) => c.kind)).toEqual(["pooled", "sentence"]);
      // `priority` is the host's own and does not reach the pipeline.
      expect(t.here.calls[0]!.opts).toEqual({ pooling: "mean" });
      expect(t.unavailable()).toBe(1);
      expect(t.pipe.concurrency!()).toBe(1);

      await t.pipe("doc-3");
      expect(t.workers).toHaveLength(1);
      await t.pipe.dispose!();
      expect(t.here.disposed()).toBe(1);
    });

    test("three crashes in a row with no answer in between", async () => {
      const t = await takeover({});
      const poison = t.pipe("poison");
      const next = t.pipe("doc-2");
      await tick();
      t.workers[0]!.crash("gone");
      await tick();
      t.workers[1]!.crash("gone");
      await expect(poison).rejects.toThrow("embedding worker crashed");
      await tick();
      t.workers[2]!.crash("gone");

      expect((await next).data).toEqual(new Float32Array([9]));
      expect(t.workers).toHaveLength(3);
      expect(t.workers.every((w) => w.terminated)).toBe(true);
      // The worker booted each time: the machine can still run workers.
      expect(t.unavailable()).toBe(0);
      await t.pipe.dispose!();
    });

    test("an answered call resets the count of crashes", async () => {
      const t = await takeover({});
      for (let i = 0; i < 4; i++) {
        const call = t.pipe(`doc-${i}`);
        await tick();
        t.workers[i]!.crash("gone");
        await tick();
        t.release[2 * i + 1]?.();
        await call;
      }
      expect(t.here.calls).toHaveLength(0);
      expect(t.workers).toHaveLength(5);
      await t.pipe.dispose!();
    });

    test("dispose does not wait for a main-thread load that never ends", async () => {
      const t = await takeover({
        failSpawnAfter: 1,
        fallback: () => new Promise(() => {}),
      });
      const call = t.pipe("doc-1").catch((e: unknown) => e);
      await tick();
      t.workers[0]!.crash("gone");
      await tick();
      await t.pipe.dispose!();
      expect(await call).toBeInstanceOf(Error);
    });
  });

  describe("pool", () => {
    const pool = async (
      lib: ReturnType<typeof gated>["lib"],
      poolSize: number,
      extra: { idleReleaseMs?: number; failSpawnAfter?: number } = {},
    ) => {
      const workers: FakeWorker[] = [];
      const pipe = await createWorkerPipeline({
        spawn: () => {
          if (workers.length >= (extra.failSpawnAfter ?? Infinity)) {
            throw new Error("no memory for another worker");
          }
          const w = fakeWorker(lib);
          workers.push(w);
          return w;
        },
        model: "m",
        options: OPTIONS,
        env: ENV,
        poolSize,
        ...(extra.idleReleaseMs !== undefined
          ? { idleReleaseMs: extra.idleReleaseMs }
          : {}),
      });
      return { pipe, workers };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 2));
    const drain = async (release: (() => void)[], n: number) => {
      for (let i = 0; i < n; i++) {
        release[i]?.();
        await tick();
      }
    };

    test("one worker until calls overlap, then up to poolSize, each with the model", async () => {
      const { lib, order, release } = gated();
      const { pipe, workers } = await pool(lib, 3);
      expect(pipe.concurrency?.()).toBe(3);
      expect(workers).toHaveLength(1);

      const calls = ["a", "b", "c", "d"].map((t) => pipe(t));
      await tick();
      await tick();
      expect(workers).toHaveLength(3);
      expect(lib.loads).toHaveLength(3);
      // Three run at once; the fourth waits for a free worker.
      expect([...order].sort()).toEqual(["a", "b", "c"]);

      await drain(release, 4);
      await Promise.all(calls);
      expect(order).toHaveLength(4);
      await pipe.dispose!();
    });

    test("a query takes the first worker that frees, ahead of waiting documents", async () => {
      const { lib, order, release } = gated();
      const { pipe } = await pool(lib, 2);
      const docs = ["d1", "d2", "d3"].map((t) => pipe(t));
      await tick();
      await tick();
      const q = pipe("query", { priority: "query" });
      release[1]?.();
      await tick();
      expect(order[2]).toBe("query");
      await drain(release, 4);
      await Promise.all([...docs, q]);
      await pipe.dispose!();
    });

    test("a spare that cannot start is given up, and its call runs on the others", async () => {
      const { lib, order, release } = gated();
      const { pipe, workers } = await pool(lib, 3, { failSpawnAfter: 1 });

      const calls = ["a", "b"].map((t) => pipe(t));
      await tick();
      await tick();
      expect(workers).toHaveLength(1);
      expect(pipe.concurrency?.()).toBe(1);
      expect(order).toEqual(["a"]);

      await drain(release, 2);
      await Promise.all(calls);
      expect(order).toEqual(["a", "b"]);
      await pipe.dispose!();
    });

    test("a spare that dies lowers the pool, and its call runs on the others", async () => {
      const { lib, order, release } = gated();
      const { pipe, workers } = await pool(lib, 2);
      const a = pipe("a");
      const b = pipe("b");
      const c = pipe("c");
      await settle();
      expect(workers).toHaveLength(2);
      expect(order).toEqual(["a", "b"]);

      workers[1]!.crash("out of memory");
      await settle();
      expect(pipe.concurrency?.()).toBe(1);

      for (let i = 0; i < 6; i++) {
        release.forEach((r) => r());
        await settle();
      }
      await Promise.all([a, b, c]);
      // `b` ran again, ahead of `c`, on the worker that was left.
      expect(order).toEqual(["a", "b", "b", "c"]);
      expect(workers).toHaveLength(2);
      await pipe.dispose!();
    });

    test("a call that loses its worker twice fails", async () => {
      const { lib, release } = gated();
      const { pipe, workers } = await pool(lib, 3);
      const calls = ["a", "b", "c"].map((t) => pipe(t));
      const settled = Promise.allSettled(calls);
      await settle();
      await settle();
      expect(workers).toHaveLength(3);
      workers[2]!.crash("out of memory");
      await settle();
      release[0]?.();
      await settle();
      // `c` is now on the first worker again, with one spare left.
      workers[0]!.crash("out of memory");
      await expect(calls[2]!).rejects.toThrow("embedding worker crashed");
      release.forEach((r) => r());
      await settle();
      await settled;
      await pipe.dispose!();
    });

    test("a call is not tied to a worker that is still starting", async () => {
      const { lib, order, release } = gated();
      const workers: FakeWorker[] = [];
      const held: (() => void)[] = [];
      const pipe = await createWorkerPipeline({
        spawn: () => {
          const w = fakeWorker(lib);
          if (workers.length > 0) {
            // A spare: hold everything it says until released.
            const real = w.postMessage.bind(w);
            let open = false;
            const backlog: unknown[] = [];
            w.postMessage = (message: unknown) => {
              if (open) real(message as never);
              else backlog.push(message);
            };
            held.push(() => {
              open = true;
              for (const m of backlog) real(m as never);
            });
          }
          workers.push(w);
          return w;
        },
        model: "m",
        options: OPTIONS,
        env: ENV,
        poolSize: 2,
      });
      const d1 = pipe("d1");
      const d2 = pipe("d2");
      await settle();
      expect(workers).toHaveLength(2);
      const q = pipe("query", { priority: "query" });
      // The first worker frees while the spare is still loading: the
      // query goes to it, then the document that was waiting.
      release[0]?.();
      await settle();
      expect(order).toEqual(["d1", "query"]);
      release[1]?.();
      await settle();
      expect(order).toEqual(["d1", "query", "d2"]);
      release[2]?.();
      await Promise.all([d1, d2, q]);
      held.forEach((h) => h());
      await pipe.dispose!();
    });

    test("a query alone never starts a second worker", async () => {
      const { lib, release } = gated();
      const { pipe, workers } = await pool(lib, 3);
      const d = pipe("doc");
      await settle();
      const q = pipe("query", { priority: "query" });
      await settle();
      expect(workers).toHaveLength(1);
      await drain(release, 2);
      await Promise.all([d, q]);
      await pipe.dispose!();
    });

    test("idle spares are released, and one worker stays", async () => {
      const { lib, release } = gated();
      const { pipe, workers } = await pool(lib, 3, { idleReleaseMs: 5 });
      const calls = ["a", "b", "c"].map((t) => pipe(t));
      await tick();
      await tick();
      await drain(release, 3);
      await Promise.all(calls);

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(workers.filter((w) => !w.terminated)).toHaveLength(1);
      expect(lib.disposed).toBe(2);

      // The pool grows again on demand.
      const again = ["d", "e"].map((t) => pipe(t));
      await tick();
      await tick();
      expect(workers.filter((w) => !w.terminated)).toHaveLength(2);
      await drain(release, 5);
      await Promise.all(again);
      await pipe.dispose!();
    });

    test("dispose terminates every worker", async () => {
      const { lib, release } = gated();
      const { pipe, workers } = await pool(lib, 2);
      const calls = Promise.allSettled([pipe("a"), pipe("b")]);
      await tick();
      await tick();
      const disposing = pipe.dispose!();
      await tick();
      release[0]?.();
      release[1]?.();
      await disposing;
      await calls;
      expect(workers.map((w) => w.terminated)).toEqual([true, true]);
      expect(lib.disposed).toBe(2);
    });

    test("dispose does not wait for a spare whose load never ends", async () => {
      const { lib, release } = gated();
      const load = lib.pipeline;
      let loads = 0;
      // The first worker loads; the spare's load hangs, as a stalled
      // download of the weights would.
      lib.pipeline = (...args) =>
        ++loads === 1 ? load(...args) : new Promise(() => {});
      const { pipe, workers } = await pool(lib, 2);
      const calls = Promise.allSettled([pipe("a"), pipe("b")]);
      await settle();
      expect(workers).toHaveLength(2);
      expect(workers[1]!.terminated).toBe(false);

      const disposing = pipe.dispose!();
      release[0]?.();
      await disposing;
      await calls;
      expect(workers.map((w) => w.terminated)).toEqual([true, true]);
    });
  });

  test("a load that goes silent ends as a load error, worker terminated", async () => {
    const lib = fakeLib(() => ({ data: new Float32Array([1]) }));
    lib.pipeline = () => new Promise(() => {});
    const workers: FakeWorker[] = [];
    const loading = createWorkerPipeline({
      spawn: () => {
        const w = fakeWorker(lib);
        workers.push(w);
        return w;
      },
      model: "m",
      options: OPTIONS,
      env: ENV,
      loadStallTimeoutMs: 10,
    });
    const err = await loading.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WorkerBootError);
    expect((err as Error).message).toContain("stopped answering");
    expect(workers[0]!.terminated).toBe(true);
  });

  test("dispose releases the model in the worker, then terminates it", async () => {
    const { lib, workers, spawn } = start();
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });

    await pipe.dispose!();

    expect(lib.disposed).toBe(1);
    expect(workers[0]!.terminated).toBe(true);
    await expect(pipe("late")).rejects.toThrow("disposed");
  });

  test("dispose rejects the calls still waiting", async () => {
    const { lib, release } = gated();
    const { spawn } = start(lib);
    const pipe = await createWorkerPipeline({
      spawn,
      model: "m",
      options: OPTIONS,
      env: ENV,
    });
    const running = pipe("doc-1");
    const waiting = pipe("doc-2");
    await tick();
    // No unhandled rejection while dispose waits on the worker.
    const settled = Promise.allSettled([running, waiting]);

    // The worker finishes the pass it is in before it releases the model.
    const disposing = pipe.dispose!();
    await tick();
    release[0]?.();
    await disposing;

    expect(lib.disposed).toBe(1);
    expect((await settled).map((r) => r.status)).toEqual([
      "rejected",
      "rejected",
    ]);
  });
});
