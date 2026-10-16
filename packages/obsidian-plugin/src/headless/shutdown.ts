/**
 * Bounded shutdown. Cleanup waits on the semantic indexer, which can sit in
 * a stalled model download for good, so SIGTERM or the end of stdin must not
 * depend on it finishing: past the bound the process exits anyway.
 */

/** How long cleanup may take before the process exits without it. */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

export type ShutdownDeps = {
  exit: (code: number) => void;
  say: (line: string) => void;
  /** Calls `fire` once after `ms`. The timer must not keep the process alive. */
  startTimer: (fire: () => void, ms: number) => void;
  timeoutMs?: number;
};

/** The returned function runs `cleanup` at most once, then exits with 0. */
export function createShutdown(
  cleanup: () => Promise<void>,
  deps: ShutdownDeps,
): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    const timeoutMs = deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      deps.exit(0);
    };
    deps.startTimer(() => {
      if (!finished) {
        deps.say(
          `Shutdown cleanup did not finish in ${timeoutMs / 1000} s, exiting anyway`,
        );
      }
      finish();
    }, timeoutMs);
    // A cleanup that throws synchronously must still reach the exit.
    Promise.resolve()
      .then(cleanup)
      .catch((err: unknown) => deps.say(`Shutdown error: ${String(err)}`))
      .finally(finish);
  };
}

export function unrefTimer(fire: () => void, ms: number): void {
  setTimeout(fire, ms).unref();
}
