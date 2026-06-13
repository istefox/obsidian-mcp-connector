/**
 * A minimal async mutex for serializing critical sections, plus the
 * process-wide settings mutex singleton (`globalSettingsMutex`).
 *
 * ## Why a single process-wide settings mutex
 *
 * `plugin.loadData()` / `plugin.saveData()` are two independent async
 * calls — Obsidian's default persistence is NOT atomic. Every feature
 * that does `load → modify-its-own-slice → save` against `data.json`
 * is therefore racing every OTHER feature that does the same: two
 * concurrent cycles both read the same "before", each writes back
 * "before + my slice", and the last writer silently clobbers the
 * other slice (cross-feature lost update). Per-feature mutexes do not
 * fix this — they only serialize a feature against itself; the file
 * is shared, so the lock must be too. `globalSettingsMutex` is the
 * one queue every `data.json` write site goes through.
 *
 * The lock wraps ONLY the settings I/O, never a modal wait or other
 * user interaction, so the fast path stays fast and concurrent modals
 * coexist (see `main.ts` checkCommandPermission Phase A/B).
 *
 * ## Non-re-entrant — do NOT nest
 *
 * `run()` does not track an owner. Calling `mutex.run()` from inside
 * another `mutex.run()` on the SAME mutex deadlocks: the inner call
 * waits on a tail that only advances when the outer call finishes,
 * which can't happen until the inner call returns. Any helper that
 * itself acquires `globalSettingsMutex` must be called OUTSIDE an
 * enclosing `.run()`.
 *
 * ## Implementation
 *
 * Each acquirer awaits a Promise representing the "tail" of the
 * queue. When its critical section completes (or throws), the next
 * acquirer is released. The tail is advanced synchronously inside
 * the `run` function so that two calls arriving in the same
 * microtask slot correctly chain — the second call sees a tail
 * that already includes the first call's completion promise.
 *
 * In-process only: it serializes within a single plugin instance;
 * it does NOT coordinate across windows, vaults, or processes. That
 * is sufficient — Obsidian loads one plugin instance per vault and
 * each vault has its own `data.json`.
 *
 * ## Usage
 *
 *     await globalSettingsMutex.run(async () => {
 *       const settings = await plugin.loadData();
 *       settings.foo = "bar";
 *       await plugin.saveData(settings);
 *     });
 *
 * The callback returns a promise; the mutex resolves when the
 * callback's promise resolves (or rejects). Errors are propagated
 * via `run`'s return value but DO NOT break the chain — the next
 * acquirer runs as usual.
 */
export interface Mutex {
  /**
   * Run a critical section serialized against all other `run()`
   * calls on the same mutex. Returns whatever `fn` returns.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createMutex(): Mutex {
  // The "tail" of the queue: a promise that resolves when the
  // currently-running (or last-enqueued) critical section is done.
  // Each new acquirer awaits this promise, then replaces it with
  // its own completion promise so the NEXT acquirer waits on them.
  //
  // This variable is mutated ONLY synchronously at the top of `run`,
  // which is why a non-lock-free assignment is safe: JavaScript is
  // single-threaded, and the sync prefix of an async function runs
  // atomically inside a microtask slot before yielding on the first
  // `await`.
  let tail: Promise<void> = Promise.resolve();

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      // Capture the current tail synchronously and replace it with
      // our own completion promise. These two lines must run atomically
      // with no `await` between them — they do, because they're the
      // sync prefix of the async function body.
      const prev = tail;
      let release!: () => void;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      tail = mine;

      try {
        // Wait for the previous critical section to finish. Because
        // `mine` was built from a resolver that never rejects, the
        // chain of tails can never enter a rejected state — so
        // `await prev` always succeeds.
        await prev;
        return await fn();
      } finally {
        // Release the next waiter unconditionally, even if `fn`
        // threw. Without this the chain would deadlock on the first
        // error, which is very much not what we want.
        release();
      }
    },
  };
}

/**
 * Process-wide settings mutex. Every `data.json` load→modify→save
 * site in the plugin serializes through this single instance so
 * concurrent writes from different features cannot clobber each
 * other's slice. Non-re-entrant (see the file header).
 */
export const globalSettingsMutex: Mutex = createMutex();
