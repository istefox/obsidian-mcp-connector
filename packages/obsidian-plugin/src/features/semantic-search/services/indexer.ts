/**
 * Live semantic indexer.
 *
 * Algorithm:
 *   - On `start`, run a full build over every markdown file currently
 *     in the vault (reused at first run + after a manual rebuild).
 *   - Subscribe to `vault.on('modify'|'create'|'delete')` and
 *     debounce per-path: rapid edits within `debounceMs` (default
 *     2000ms) collapse to a single re-process when the user stops
 *     typing on that file.
 *   - Per-file processing: read content, chunk, compare each new
 *     chunk's contentHash against the existing records for that
 *     filePath. Chunks whose hash matches reuse the existing
 *     vector (chunk-delta — no re-embed). New or changed chunks go
 *     through the embedder. Delete events (file gone) drop all
 *     records for that path.
 *
 * Vault access is injected via the `VaultLike` interface so the
 * production wiring (T11) supplies a thin wrapper around
 * `app.vault.on/getMarkdownFiles/read`, while tests use an in-memory
 * vault with synchronous event dispatch.
 */

import { logger } from "$/shared/logger";
import type { ChunkerFn } from "./chunker";
import { wrapChunkerWithOverlap } from "./chunker";
import type { EmbeddingRecord, EmbeddingStore } from "./store";
import type { EmbeddingProvider } from "../types";

export type { ChunkerFn };

export type VaultEvent = "modify" | "create" | "delete";

export interface VaultLike {
  /**
   * `mtime` is optional so the live-mode tests (and the live wiring
   * itself, which doesn't need it) don't have to fabricate it. The
   * low-power indexer requires it; entries missing `mtime` are
   * processed on every scan (degraded fallback rather than skipped,
   * so a misconfigured wrapper still indexes — just less
   * efficiently).
   */
  getMarkdownFiles(): Array<{ path: string; mtime?: number }>;
  read(path: string): Promise<string>;
  /** Returns an unsubscribe function. */
  on(event: VaultEvent, handler: (path: string) => void): () => void;
}

export type LiveIndexerOpts = {
  vault: VaultLike;
  chunker: ChunkerFn;
  embedder: EmbeddingProvider;
  store: EmbeddingStore;
  /** Per-file inactivity window before re-processing. Default 2000ms. */
  debounceMs?: number;
};

export interface SemanticIndexer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Force a full re-build over all markdown files. */
  rebuildAll(): Promise<void>;
  /**
   * Drain any pending debounce timers and await every in-flight
   * file processing. Test helper — production code does not need
   * this since the timers fire on their own.
   */
  flush(): Promise<void>;
  /** Number of file paths with a pending debounce timer. */
  pending(): number;
}

const DEFAULT_DEBOUNCE_MS = 2000;

class LiveIndexerImpl implements SemanticIndexer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = new Map<string, Promise<void>>();
  private unsubs: Array<() => void> = [];
  private running = false;
  private readonly debounceMs: number;
  private readonly opts: LiveIndexerOpts;

  constructor(opts: LiveIndexerOpts) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.opts = { ...opts, chunker: wrapChunkerWithOverlap(opts.chunker) };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.unsubs.push(
      this.opts.vault.on("modify", (p) => this.schedule(p)),
      this.opts.vault.on("create", (p) => this.schedule(p)),
      this.opts.vault.on("delete", (p) => this.schedule(p)),
    );

    await this.rebuildAll();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    // Wait for any in-flight processing to finish so the store is
    // not mid-mutation when the caller drops it.
    await Promise.all(this.inFlight.values());
  }

  async rebuildAll(): Promise<void> {
    if (!(await this.opts.embedder.isAvailable())) {
      logger.warn(
        "live indexer: embedding provider not available, skipping rebuild",
      );
      return;
    }
    const files = this.opts.vault.getMarkdownFiles();
    for (const f of files) {
      await this.processFile(f.path);
    }
  }

  async flush(): Promise<void> {
    // Fire every pending timer immediately and wait for all the
    // resulting processing to settle.
    const pending = Array.from(this.timers.entries());
    for (const [, t] of pending) clearTimeout(t);
    this.timers.clear();
    await Promise.all(
      pending.map(async ([path]) => {
        await this.processFile(path);
      }),
    );
    await Promise.all(this.inFlight.values());
  }

  pending(): number {
    return this.timers.size;
  }

  private schedule(path: string): void {
    if (!this.running) return;
    const existing = this.timers.get(path);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.timers.delete(path);
      this.processFile(path).catch((err) => {
        logger.error("live indexer: process failed", {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.debounceMs);
    this.timers.set(path, handle);
  }

  private async processFile(path: string): Promise<void> {
    // Serialize per-path so a fast modify→delete sequence does not
    // race the in-flight processor for the prior modify event.
    const prior = this.inFlight.get(path);
    const next = (async () => {
      if (prior) await prior.catch(() => {});
      await this.doProcessFile(path);
    })();
    this.inFlight.set(path, next);
    try {
      await next;
    } finally {
      // Only clear inFlight if our promise is still the current one
      // (a later schedule may have queued behind).
      if (this.inFlight.get(path) === next) this.inFlight.delete(path);
    }
  }

  private async doProcessFile(path: string): Promise<void> {
    await processOnePath(this.opts, path);
  }
}

export function createLiveIndexer(opts: LiveIndexerOpts): SemanticIndexer {
  return new LiveIndexerImpl(opts);
}

// ---------------------------------------------------------------------------
// Low-power indexer (opt-in)
// ---------------------------------------------------------------------------

export type LowPowerIndexerOpts = {
  vault: VaultLike;
  chunker: ChunkerFn;
  embedder: EmbeddingProvider;
  store: EmbeddingStore;
  /** Scan interval. Default 5 minutes (300_000 ms). */
  intervalMs?: number;
};

const DEFAULT_LOW_POWER_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Low-power indexer — interval-driven scan instead of event-driven
 * live updates. Each cycle:
 *   1. Snapshot vault.getMarkdownFiles().
 *   2. Diff against the in-memory `lastSeenMtime` map: only files
 *      whose mtime advanced (or that we've never seen) are
 *      re-processed.
 *   3. Process each affected file via the same path-level helper as
 *      the live indexer (chunk-delta reuse stays intact).
 *   4. Drop any path that disappeared from the vault.
 *   5. Single store.flush() at the end of the cycle, so a 5-minute
 *      run produces one writeBinary instead of one per file.
 *
 * `lastSeenMtime` is in-memory and lost on restart. That's intentional
 * — at first start after a restart everything looks "stale", but the
 * chunker contentHash check inside processOne means we still don't
 * re-embed unchanged content (we only re-read + re-chunk; embeds are
 * skipped because the hash matches an existing record).
 */
class LowPowerIndexerImpl implements SemanticIndexer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cycleInFlight: Promise<void> | null = null;
  private lastSeenMtime = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly opts: LowPowerIndexerOpts;

  constructor(opts: LowPowerIndexerOpts) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_LOW_POWER_INTERVAL_MS;
    this.opts = { ...opts, chunker: wrapChunkerWithOverlap(opts.chunker) };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Run the first scan immediately so the user doesn't wait
    // `intervalMs` for indexing to begin. Subsequent scans tick on
    // the interval.
    await this.runCycle();
    this.timer = setInterval(() => {
      // Skip if a cycle is still in flight to avoid stacking.
      if (this.cycleInFlight) return;
      this.runCycle().catch((err) => {
        logger.error("low-power indexer: cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cycleInFlight) await this.cycleInFlight;
  }

  async rebuildAll(): Promise<void> {
    if (!(await this.opts.embedder.isAvailable())) {
      logger.warn(
        "low-power indexer: embedding provider not available, skipping rebuild",
      );
      return;
    }
    // Force every file to be considered stale, then run a cycle.
    this.lastSeenMtime.clear();
    await this.runCycle();
  }

  async flush(): Promise<void> {
    // Test helper: trigger a cycle now and wait for it to finish.
    await this.runCycle();
  }

  pending(): number {
    return this.cycleInFlight ? 1 : 0;
  }

  private async runCycle(): Promise<void> {
    if (this.cycleInFlight) {
      await this.cycleInFlight;
      return;
    }
    const cycle = (async () => {
      const files = this.opts.vault.getMarkdownFiles();
      const seenPaths = new Set<string>();

      for (const f of files) {
        seenPaths.add(f.path);
        const prev = this.lastSeenMtime.get(f.path);
        const cur = f.mtime ?? Number.POSITIVE_INFINITY; // unknown mtime → process every cycle
        if (prev !== undefined && cur <= prev) continue;
        await processOnePath(this.opts, f.path);
        if (f.mtime !== undefined) this.lastSeenMtime.set(f.path, f.mtime);
      }

      // Files that vanished from the vault since the last cycle:
      // drop their records from the store and forget their mtime.
      for (const knownPath of Array.from(this.lastSeenMtime.keys())) {
        if (!seenPaths.has(knownPath)) {
          await this.opts.store.delete(knownPath);
          this.lastSeenMtime.delete(knownPath);
        }
      }

      await this.opts.store.flush();
    })();
    this.cycleInFlight = cycle;
    try {
      await cycle;
    } finally {
      this.cycleInFlight = null;
    }
  }
}

export function createLowPowerIndexer(
  opts: LowPowerIndexerOpts,
): SemanticIndexer {
  return new LowPowerIndexerImpl(opts);
}

// ---------------------------------------------------------------------------
// Shared per-path processing
// ---------------------------------------------------------------------------

type ProcessDeps = {
  vault: VaultLike;
  chunker: ChunkerFn;
  embedder: EmbeddingProvider;
  store: EmbeddingStore;
};

/**
 * Module-level helper used by both indexers. Reads the file, chunks
 * it, reuses vectors for chunks whose contentHash matches an existing
 * record, embeds the rest, and replaces the path's record set
 * atomically (delete + upsert).
 *
 * A read failure is disambiguated against the vault's file list: if
 * the path is no longer listed it is a genuine deletion (drop the
 * records); if it is still listed the failure is transient (file
 * lock / I/O) — keep the existing vectors and retry on the next
 * cycle. Empty/below-threshold content is still a delete so the
 * index stays consistent with what `chunker` would produce on a
 * fresh re-build.
 */
async function processOnePath(deps: ProcessDeps, path: string): Promise<void> {
  let content: string;
  try {
    content = await deps.vault.read(path);
  } catch (error) {
    const stillListed = deps.vault
      .getMarkdownFiles()
      .some((f) => f.path === path);
    if (stillListed) {
      // Transient error (file lock / I/O): preserve existing vectors;
      // the next live event or low-power cycle retries this path.
      logger.warn("live indexer: read failed but path still in vault", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    // Genuine deletion: the path is gone from the vault.
    await deps.store.delete(path);
    return;
  }

  const chunks = await deps.chunker(content);
  if (chunks.length === 0) {
    await deps.store.delete(path);
    return;
  }

  const existingByHash = new Map<string, EmbeddingRecord>();
  for await (const r of deps.store.scan()) {
    if (r.filePath === path) existingByHash.set(r.contentHash, r);
  }

  const records: EmbeddingRecord[] = [];
  for (const c of chunks) {
    const reused = existingByHash.get(c.contentHash);
    const vector =
      reused?.vector ?? (await deps.embedder.embed([c.text], "document"))[0]!;
    records.push({
      chunkId: `${path}#${c.id}`,
      filePath: path,
      offset: c.offset,
      heading: c.heading,
      contentHash: c.contentHash,
      vector,
    });
  }

  await deps.store.delete(path);
  await deps.store.upsert(records);
}
