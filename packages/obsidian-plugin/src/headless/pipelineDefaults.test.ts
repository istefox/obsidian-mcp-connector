import { describe, expect, test } from "bun:test";
import {
  embedOneAtATime,
  HEADLESS_DTYPE,
  withHeadlessDefaults,
} from "./pipelineDefaults";

type Output = { data: Float32Array; dims?: number[] };

/** A pipe whose vector for a text is [length, first char code], width 2. */
function fakePipe() {
  const calls: Array<string | string[]> = [];
  const pipe = async (input: string | string[]): Promise<Output> => {
    calls.push(input);
    const texts = Array.isArray(input) ? input : [input];
    const data = new Float32Array(texts.length * 2);
    texts.forEach((t, i) => {
      data[i * 2] = t.length;
      data[i * 2 + 1] = t.charCodeAt(0);
    });
    return { data, dims: [texts.length, 2] };
  };
  return { pipe, calls };
}

describe("embedOneAtATime", () => {
  test("splits a batch into single calls and joins the rows in order", async () => {
    const { pipe, calls } = fakePipe();
    const out = await embedOneAtATime(pipe)(["aa", "b", "ccc"], { x: 1 });
    expect(calls).toEqual(["aa", "b", "ccc"]);
    expect([...out.data]).toEqual([2, 97, 1, 98, 3, 99]);
    expect(out.dims).toEqual([3, 2]);
  });

  test("gives the same vectors as the one call it replaces", async () => {
    const { pipe } = fakePipe();
    const texts = ["aa", "b", "ccc", "dddd"];
    const whole = await pipe(texts);
    const split = await embedOneAtATime(pipe)(texts);
    expect([...split.data]).toEqual([...whole.data]);
    expect(split.dims).toEqual(whole.dims);
  });

  test("runs the calls one after another", async () => {
    const log: string[] = [];
    let open = 0;
    const pipe = async (input: string | string[]): Promise<Output> => {
      open += 1;
      log.push(`start ${String(input)} open=${open}`);
      await Promise.resolve();
      open -= 1;
      return { data: new Float32Array([1]), dims: [1, 1] };
    };
    await embedOneAtATime(pipe)(["a", "b", "c"]);
    expect(log).toEqual(["start a open=1", "start b open=1", "start c open=1"]);
  });

  test("a single text and a one-element batch pass through untouched", async () => {
    const { pipe, calls } = fakePipe();
    const wrapped = embedOneAtATime(pipe);
    await wrapped("one");
    await wrapped(["two"]);
    expect(calls).toEqual(["one", ["two"]]);
  });

  test("passes the options to every call", async () => {
    const seen: unknown[] = [];
    const pipe = async (_input: string | string[], options?: unknown) => {
      seen.push(options);
      return { data: new Float32Array([1]), dims: [1, 1] };
    };
    await embedOneAtATime(pipe)(["a", "b"], { pooling: "mean" });
    expect(seen).toEqual([{ pooling: "mean" }, { pooling: "mean" }]);
  });

  test("a failing call fails the batch", async () => {
    let n = 0;
    const pipe = async (): Promise<Output> => {
      if (++n === 2) throw new Error("out of memory");
      return { data: new Float32Array([1]), dims: [1, 1] };
    };
    await expect(embedOneAtATime(pipe)(["a", "b", "c"])).rejects.toThrow(
      "out of memory",
    );
    expect(n).toBe(2);
  });

  test("rows of different widths are refused", async () => {
    let n = 0;
    const pipe = async (): Promise<Output> => ({
      data: new Float32Array(++n),
      dims: [1, n],
    });
    await expect(embedOneAtATime(pipe)(["a", "b"])).rejects.toThrow("differ");
  });

  test("keeps the properties of the pipe", () => {
    const { pipe } = fakePipe();
    const tokenizer = {};
    const wrapped = embedOneAtATime(Object.assign(pipe, { tokenizer }));
    expect((wrapped as unknown as { tokenizer: unknown }).tokenizer).toBe(
      tokenizer,
    );
  });
});

describe("withHeadlessDefaults", () => {
  test("loads at q8 when no precision is asked for", async () => {
    const seen: unknown[] = [];
    const factory = async (_t: string, _m: string, options?: unknown) => {
      seen.push(options);
      return fakePipe().pipe;
    };
    const wrapped = withHeadlessDefaults(factory);
    await wrapped("feature-extraction", "m", { device: "cpu" });
    await wrapped("feature-extraction", "m");
    await wrapped("feature-extraction", "m", { dtype: undefined });
    expect(seen).toEqual([
      { device: "cpu", dtype: HEADLESS_DTYPE },
      { dtype: HEADLESS_DTYPE },
      { dtype: HEADLESS_DTYPE },
    ]);
    expect(HEADLESS_DTYPE).toBe("q8");
  });

  test("a precision the caller names is kept", async () => {
    const seen: unknown[] = [];
    const factory = async (_t: string, _m: string, options?: unknown) => {
      seen.push(options);
      return fakePipe().pipe;
    };
    await withHeadlessDefaults(factory)("t", "m", { dtype: "fp16" });
    expect(seen).toEqual([{ dtype: "fp16" }]);
  });

  test("the pipeline it returns embeds a batch one text at a time", async () => {
    const { pipe, calls } = fakePipe();
    const made = (await withHeadlessDefaults(
      async (..._args: unknown[]) => pipe,
    )("t", "m")) as typeof pipe;
    const out = await made(["aa", "b"]);
    expect(calls).toEqual(["aa", "b"]);
    expect(out.dims).toEqual([2, 2]);
  });

  test("something that is not a function is returned as it is", async () => {
    const odd = { notCallable: true };
    expect(
      await withHeadlessDefaults(async (..._args: unknown[]) => odd)("t", "m"),
    ).toBe(odd);
  });
});
