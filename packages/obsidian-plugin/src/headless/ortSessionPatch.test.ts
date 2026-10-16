import { afterEach, describe, expect, test } from "bun:test";
import { patchInferenceSession, sessionHooks } from "./ortSessionPatch";

afterEach(() => {
  delete sessionHooks.beforeCreate;
  delete sessionHooks.afterRun;
});

function fakeOrt() {
  const calls: Array<{ source: unknown; options: unknown }> = [];
  const ort = {
    InferenceSession: {
      create: async (source: unknown, options?: unknown) => {
        calls.push({ source, options });
        return "session";
      },
    },
  };
  return { ort, calls };
}
const files: Record<string, Uint8Array> = {
  "/m/model.onnx": new Uint8Array([1, 2, 3]),
  "/m/w.bin": new Uint8Array([9]),
};
const readFile = async (p: string) => files[p];

describe("patchInferenceSession", () => {
  test("reads a path into bytes before creating the session", async () => {
    const { ort, calls } = fakeOrt();
    const patched = patchInferenceSession(ort, readFile);
    expect(
      await patched.InferenceSession.create("/m/model.onnx", { a: 1 }),
    ).toBe("session");
    expect(calls).toEqual([
      { source: files["/m/model.onnx"], options: { a: 1 } },
    ]);
  });

  test("bytes pass through untouched", async () => {
    const { ort, calls } = fakeOrt();
    const bytes = new Uint8Array([7]);
    await patchInferenceSession(ort, readFile).InferenceSession.create(bytes);
    expect(calls[0].source).toBe(bytes);
  });

  test("external data given as paths is read, other entries are kept", async () => {
    const { ort, calls } = fakeOrt();
    const inline = new Uint8Array([5]);
    await patchInferenceSession(ort, readFile).InferenceSession.create(
      "/m/model.onnx",
      {
        graphOptimizationLevel: "all",
        externalData: [
          { path: "w.bin", data: "/m/w.bin" },
          { path: "x.bin", data: inline },
        ],
      },
    );
    expect(calls[0].options).toEqual({
      graphOptimizationLevel: "all",
      externalData: [
        { path: "w.bin", data: files["/m/w.bin"] },
        { path: "x.bin", data: inline },
      ],
    });
  });
});

describe("the hooks", () => {
  /** A deferred promise to hold a call open. */
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  test("beforeCreate finishes before the session is created", async () => {
    const order: string[] = [];
    const gate = deferred();
    sessionHooks.beforeCreate = async () => {
      order.push("hook start");
      await gate.promise;
      order.push("hook end");
    };
    const ort = {
      InferenceSession: {
        create: async (_source: unknown) => {
          order.push("create");
          return {};
        },
      },
    };
    const creating = patchInferenceSession(
      ort,
      readFile,
    ).InferenceSession.create(new Uint8Array());
    await Promise.resolve();
    expect(order).toEqual(["hook start"]);
    gate.resolve();
    await creating;
    expect(order).toEqual(["hook start", "hook end", "create"]);
  });

  test("a failing beforeCreate fails the creation and nothing is created", async () => {
    sessionHooks.beforeCreate = async () => {
      throw new Error("download failed");
    };
    const { ort, calls } = fakeOrt();
    await expect(
      patchInferenceSession(ort, readFile).InferenceSession.create(
        new Uint8Array(),
      ),
    ).rejects.toThrow("download failed");
    expect(calls).toEqual([]);
  });

  test("runs of one session go one at a time, with afterRun between them", async () => {
    const log: string[] = [];
    const held = [deferred(), deferred(), deferred()];
    let started = 0;
    const session = {
      run: async (input: string) => {
        const n = started++;
        log.push(`start ${input}`);
        await held[n].promise;
        log.push(`end ${input}`);
        return `out ${input}`;
      },
    };
    sessionHooks.afterRun = async () => {
      log.push("yield");
    };
    const ort = {
      InferenceSession: { create: async (_source: unknown) => session },
    };
    const made = (await patchInferenceSession(
      ort,
      readFile,
    ).InferenceSession.create(new Uint8Array())) as typeof session;

    const results = ["a", "b", "c"].map((i) => made.run(i));
    // Only the first run has started: the rest wait their turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["start a"]);
    held[0].resolve();
    await results[0];
    held[1].resolve();
    held[2].resolve();
    expect(await Promise.all(results)).toEqual(["out a", "out b", "out c"]);
    // The last yield is queued behind the last run's result.
    await new Promise<void>((r) => setImmediate(r));
    expect(log).toEqual([
      "start a",
      "end a",
      "yield",
      "start b",
      "end b",
      "yield",
      "start c",
      "end c",
      "yield",
    ]);
  });

  test("a failed run rejects its own caller and not the ones behind it", async () => {
    let calls = 0;
    const session = {
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("bad input");
        return "fine";
      },
    };
    const ort = {
      InferenceSession: { create: async (_source: unknown) => session },
    };
    const made = (await patchInferenceSession(
      ort,
      readFile,
    ).InferenceSession.create(new Uint8Array())) as typeof session;
    const first = made.run();
    const second = made.run();
    await expect(first).rejects.toThrow("bad input");
    expect(await second).toBe("fine");
  });

  test("a created object without run is returned as it is", async () => {
    const plain = { other: 1 };
    const ort = {
      InferenceSession: { create: async (_source: unknown) => plain },
    };
    expect(
      await patchInferenceSession(ort, readFile).InferenceSession.create(
        new Uint8Array(),
      ),
    ).toBe(plain);
  });
});
