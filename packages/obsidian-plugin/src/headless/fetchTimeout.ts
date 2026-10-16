/**
 * A `fetch` that gives up when the server sends no response headers within
 * `ms`. It bounds only the wait for the response to start, not the body, so
 * a slow but steady download of a large model is never cut off. A caller's
 * own `signal` still aborts the request.
 */

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type Timers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: Timers = {
  set: (callback, ms) => globalThis.setTimeout(callback, ms),
  clear: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function withHeadersTimeout(
  base: FetchFn,
  ms: number,
  timers: Timers = realTimers,
): FetchFn {
  return async (input, init) => {
    const controller = new AbortController();
    const outer = init?.signal;
    if (outer?.aborted) {
      controller.abort(outer.reason);
    } else {
      outer?.addEventListener("abort", () => controller.abort(outer.reason), {
        once: true,
      });
    }
    const timer = timers.set(() => {
      controller.abort(
        new Error(`No response from ${String(input)} after ${ms / 1000}s`),
      );
    }, ms);
    try {
      return await base(input, { ...init, signal: controller.signal });
    } finally {
      timers.clear(timer);
    }
  };
}
