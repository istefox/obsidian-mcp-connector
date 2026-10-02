/**
 * Opt-in read cache over `plugin.loadData()`, keyed by plugin instance.
 *
 * Every MCP request reads `data.json` three to four times before any tool
 * runs: the token list for auth, the caller's policy for the tool scope,
 * the folder-exclusion policy for the guarded App. Each read is a disk
 * round trip plus a JSON parse of the same unchanged file. This cache
 * collapses them into one read per short window.
 *
 * Design constraints, in order of importance:
 *
 * - **Writes never read from it.** `SettingsStore.updateSlice` and
 *   `loadSlice` always load from disk under the mutex, exactly as before,
 *   so a stale cache can never feed a read-modify-write and lose an
 *   update. After a write they prime the cache with what was written.
 * - **Short TTL, not write-only invalidation.** `data.json` has writers
 *   this process does not see (a hand edit, Obsidian Sync). A write-only
 *   invalidation would hold their change back until the next in-process
 *   write; a {@link DEFAULT_READ_CACHE_TTL_MS} window bounds that to a
 *   fraction of a second while still coalescing every read within one
 *   request.
 * - **Opt-in per plugin instance.** `main.ts` enables it; tests and the
 *   bench harness get today's read-through behaviour unless they ask.
 *   An in-memory test double whose backing object is mutated directly
 *   between reads would otherwise see stale data for the TTL.
 * - **Snapshots are read-only.** `readSlice` hands out the cached object,
 *   not a copy; every reader in this codebase normalizes into fresh
 *   structures. A reader that mutated it would corrupt the next read.
 */

import type { PluginReadLike } from "./types";

/**
 * Long enough to cover one request's reads (auth, policy, exclusion
 * policy run within a few milliseconds of each other), short enough that
 * an external edit of `data.json` is picked up before a human notices.
 */
export const DEFAULT_READ_CACHE_TTL_MS = 250;

type Snapshot = Record<string, unknown>;

type ReadCache = {
  ttlMs: number;
  snapshot: Snapshot | null;
  /** `performance.now()` at which `snapshot` was taken; -Infinity when none. */
  at: number;
  /** A load in flight, shared by every reader that arrives before it lands. */
  inflight: Promise<Snapshot> | null;
};

const caches = new WeakMap<PluginReadLike, ReadCache>();

/** Turn the cache on for `plugin`. Idempotent; a second call updates the TTL. */
export function enableSettingsReadCache(
  plugin: PluginReadLike,
  ttlMs: number = DEFAULT_READ_CACHE_TTL_MS,
): void {
  const existing = caches.get(plugin);
  if (existing) {
    existing.ttlMs = ttlMs;
    return;
  }
  caches.set(plugin, { ttlMs, snapshot: null, at: -Infinity, inflight: null });
}

/** Turn the cache off and drop what it holds. Reads go back to disk. */
export function disableSettingsReadCache(plugin: PluginReadLike): void {
  caches.delete(plugin);
}

/** Drop the cached snapshot; the next read goes to disk. No-op when off. */
export function invalidateSettingsReadCache(plugin: PluginReadLike): void {
  const cache = caches.get(plugin);
  if (!cache) return;
  cache.snapshot = null;
  cache.at = -Infinity;
}

/**
 * Record `snapshot` as the current on-disk state, for a writer that just
 * persisted it. The written object is what `loadData` would return, so
 * priming saves the re-read AND makes the write visible to the very next
 * read, with no TTL window in between. No-op when off.
 */
export function primeSettingsReadCache(
  plugin: PluginReadLike,
  snapshot: Snapshot,
): void {
  const cache = caches.get(plugin);
  if (!cache) return;
  cache.snapshot = snapshot;
  cache.at = performance.now();
  cache.inflight = null;
}

/**
 * `plugin.loadData()`, through the cache when one is enabled for this
 * plugin and its snapshot is fresh. Concurrent callers during a miss
 * share one load. A failed load is not cached.
 */
export async function loadSettingsSnapshot(
  plugin: PluginReadLike,
): Promise<Snapshot> {
  const cache = caches.get(plugin);
  if (!cache) return readFromDisk(plugin);

  if (cache.snapshot && performance.now() - cache.at < cache.ttlMs) {
    return cache.snapshot;
  }
  if (cache.inflight) return cache.inflight;

  const load = readFromDisk(plugin).then(
    (snapshot) => {
      // Only this load may fill the cache: a write that landed meanwhile
      // has already primed it and cleared `inflight`, and its snapshot is
      // the newer one.
      if (cache.inflight === load) {
        cache.snapshot = snapshot;
        cache.at = performance.now();
        cache.inflight = null;
      }
      return snapshot;
    },
    (error: unknown) => {
      if (cache.inflight === load) cache.inflight = null;
      throw error;
    },
  );
  cache.inflight = load;
  return load;
}

async function readFromDisk(plugin: PluginReadLike): Promise<Snapshot> {
  return ((await plugin.loadData()) as Snapshot | null) ?? {};
}
