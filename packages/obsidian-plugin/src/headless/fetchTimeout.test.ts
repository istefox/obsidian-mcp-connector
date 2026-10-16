import { describe, expect, test } from "bun:test";
import { withHeadersTimeout, type Timers } from "./fetchTimeout";

/** Timers a test fires by hand, so nothing waits on a clock. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers: Timers = {
    set: (callback) => {
      pending.set(next, callback);
      return next++;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => pending.size,
    fireAll: () => [...pending.values()].forEach((cb) => cb()),
  };
}

/** A fetch that never answers until its signal aborts, as the real one does. */
const hangingFetch = (_input: string | URL, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

describe("withHeadersTimeout", () => {
  test("aborts a request that gets no response headers in time", async () => {
    const clock = manualTimers();
    const wrapped = withHeadersTimeout(hangingFetch, 30_000, clock.timers);
    const call = wrapped("https://huggingface.co/model.onnx");
    clock.fireAll();
    await expect(call).rejects.toThrow(
      "No response from https://huggingface.co/model.onnx after 30s",
    );
  });

  test("a response before the deadline clears the timer and passes through", async () => {
    const clock = manualTimers();
    const response = new Response("body");
    const wrapped = withHeadersTimeout(
      async () => response,
      30_000,
      clock.timers,
    );
    expect(await wrapped("https://x/y")).toBe(response);
    expect(clock.pending()).toBe(0);
  });

  test("a failing request clears the timer too", async () => {
    const clock = manualTimers();
    const wrapped = withHeadersTimeout(
      async () => {
        throw new Error("refused");
      },
      30_000,
      clock.timers,
    );
    await expect(wrapped("https://x/y")).rejects.toThrow("refused");
    expect(clock.pending()).toBe(0);
  });

  test("the body is not on the clock: the signal is only the headers deadline", async () => {
    const clock = manualTimers();
    let seen: AbortSignal | undefined;
    const wrapped = withHeadersTimeout(
      async (_input, init) => {
        seen = init?.signal ?? undefined;
        return new Response("body");
      },
      30_000,
      clock.timers,
    );
    await wrapped("https://x/y");
    clock.fireAll();
    expect(seen?.aborted).toBe(false);
  });

  test("the caller's own signal still aborts", async () => {
    const clock = manualTimers();
    const wrapped = withHeadersTimeout(hangingFetch, 30_000, clock.timers);
    const own = new AbortController();
    const call = wrapped("https://x/y", { signal: own.signal });
    own.abort(new Error("cancelled by caller"));
    await expect(call).rejects.toThrow("cancelled by caller");
  });

  test("an already-aborted caller signal aborts at once", async () => {
    const clock = manualTimers();
    const wrapped = withHeadersTimeout(hangingFetch, 30_000, clock.timers);
    const own = new AbortController();
    own.abort(new Error("already gone"));
    await expect(
      wrapped("https://x/y", { signal: own.signal }),
    ).rejects.toThrow("already gone");
  });
});
