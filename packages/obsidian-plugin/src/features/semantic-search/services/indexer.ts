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
  /**
   * O(1) mtime lookup for a single path, used by the live event path
   * to capture the mtime BEFORE reading the file (recording it after
   * the read could stamp newer mtime on older content). Optional:
   * without it, live-edited files simply don't get a persisted mtime.
   */
  getFileMtime?(path: string): number | undefined;
  /** Returns an unsubscribe function. */
  on(event: VaultEvent, handler: (path: string) => void): () => void;
}

export type LiveIndexerOpts = {
  vault: VaultLike;
  chunker: ChunkerFn;
  embedder: EmbeddingProvider;
  store: EmbeddingStore;
  /**
   * Excluded-path predicate. Returns `true` for paths Obsidian's
   * `Files & Links → Excluded files` setting hides (built from
   * `MetadataCache.isUserIgnored` in production wiring). Excluded paths
   * are skipped by both the full rebuild and the live event listener, so
   * a file in an excluded folder never enters the index and a later edit
   * to it does not re-enter it. Omitted in tests / early lifecycle →
   * nothing is excluded.
   */
  isExcluded?: (path: string) => boolean;
  /** Per-file inactivity window before re-processing. Default 2000ms. */
  debounceMs?: number;
  /**
   * Idle window after the last `processOnePath` completes before the
   * in-memory store is flushed to disk. Coalesces a burst of edits into
   * a single `writeBinary` call. Default 5000ms. `stop()` and the public
   * `flush()` method both drain any pending flush before returning.
   */
  flushDebounceMs?: number;
};

export type StartOpts = {
  /**
   * Whether to run a full `rebuildAll()` immediately as part of `start()`.
   * Default `true` (existing behavior). Set to `false` when an existing
   * on-disk store is already current and you only need to subscribe to
   * future vault events — e.g. a DLC indexer auto-started at plugin load
   * for a provider whose store survived from a prior session.
   */
  initialRebuild?: boolean;
};

export type RebuildOpts = {
  /**
   * `true` (default) re-processes every file — the contract of the
   * manual "Rebuild index" button and of `startRebuildFor`. `false`
   * (used by `start()`) skips files whose persisted mtime matches and
   * whose records are present, so a session start does not re-read the
   * whole vault.
   */
  force?: boolean;
};

export interface SemanticIndexer {
  start(opts?: StartOpts): Promise<void>;
  stop(): Promise<void>;
  /** Full re-build over all markdown files. See {@link RebuildOpts}. */
  rebuildAll(opts?: RebuildOpts): Promise<void>;
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
const DEFAULT_FLUSH_DEBOUNCE_MS = 5000;

class LiveIndexerImpl implements SemanticIndexer {
  private timers = new Map<string, number>();
  private inFlight = new Map<string, Promise<void>>();
  private unsubs: Array<() => void> = [];
  private running = false;
  private flushTimer: number | null = null;
  private flushInFlight: Promise<void> | null = null;
  private readonly debounceMs: number;
  private readonly flushDebounceMs: number;
  private readonly opts: LiveIndexerOpts;

  constructor(opts: LiveIndexerOpts) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.flushDebounceMs = opts.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
    this.opts = { ...opts, chunker: wrapChunkerWithOverlap(opts.chunker) };
  }

  async start(opts: StartOpts = {}): Promise<void> {
    if (this.running) return;
    this.running = true;

    // With lazy store loading the store may not be initialized yet.
    // processOnePath reads recordsFor() (sync, no defensive init): on
    // an un-inited store it would see zero records and silently
    // re-embed the whole vault. Idempotent, cheap when already inited.
    await this.opts.store.init();

    this.unsubs.push(
      this.opts.vault.on("modify", (p) => this.schedule(p)),
      this.opts.vault.on("create", (p) => this.schedule(p)),
      this.opts.vault.on("delete", (p) => this.schedule(p)),
    );

    if (opts.initialRebuild !== false) {
      // Session start is not a user-requested rebuild: unchanged files
      // (persisted mtime matches, records present) are skipped.
      await this.rebuildAll({ force: false });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    // Wait for any in-flight processing to finish so the store is
    // not mid-mutation when the caller drops it.
    await Promise.all(this.inFlight.values());
    // Drain any pending debounced flush + await an in-flight one so the
    // on-disk store reflects every event processed before stop().
    await this.drainFlush();
  }

  private isExcluded(path: string): boolean {
    return this.opts.isExcluded?.(path) ?? false;
  }

  async rebuildAll(opts: RebuildOpts = {}): Promise<void> {
    const force = opts.force ?? true;
    if (!(await this.opts.embedder.isAvailable())) {
      logger.warn(
        "live indexer: embedding provider not available, skipping rebuild",
      );
      return;
    }
    // See start(): guard against recordsFor() on an un-inited store.
    await this.opts.store.init();
    const files = this.opts.vault
      .getMarkdownFiles()
      .filter((f) => !this.isExcluded(f.path));
    logger.info("live indexer: rebuildAll starting", {
      providerKey: this.opts.embedder.providerKey,
      fileCount: files.length,
      force,
    });
    let skipped = 0;
    for (const f of files) {
      // Session-start pass: a file whose persisted mtime matches and
      // whose records are present is current — skip the read entirely.
      // The hasRecords guard self-heals a stale sidecar (e.g. records
      // discarded by sentinel recovery while mtimes survived a crash
      // window elsewhere).
      if (
        !force &&
        f.mtime !== undefined &&
        f.mtime === this.opts.store.mtimeFor(f.path) &&
        this.opts.store.hasRecords(f.path)
      ) {
        skipped++;
        continue;
      }
      await this.processFile(f.path, f.mtime);
    }
    logger.info("live indexer: rebuildAll finished", {
      providerKey: this.opts.embedder.providerKey,
      fileCount: files.length,
      skippedUnchanged: skipped,
    });
  }

  async flush(): Promise<void> {
    // Fire every pending timer immediately and wait for all the
    // resulting processing to settle.
    const pending = Array.from(this.timers.entries());
    for (const [, t] of pending) window.clearTimeout(t);
    this.timers.clear();
    await Promise.all(
      pending.map(async ([path]) => {
        await this.processFile(path);
      }),
    );
    await Promise.all(this.inFlight.values());
    // Persist whatever the processing produced so callers (tests and
    // production teardown alike) see a synchronous "everything settled,
    // including disk" boundary.
    await this.drainFlush();
  }

  pending(): number {
    return this.timers.size;
  }

  private schedule(path: string): void {
    if (!this.running) return;
    // The live event listener (modify/create/delete) bypasses
    // `getMarkdownFiles()`, so the rebuild-loop filter alone would let an
    // edit to a file in an excluded folder re-enter the index on the next
    // vault event. Guard the event path here too. Stale chunks from a
    // file excluded after indexing are left in place (no destructive
    // delete on a setting change) and hidden at query time; physical
    // cleanup is the manual Rebuild.
    if (this.isExcluded(path)) return;
    const existing = this.timers.get(path);
    if (existing) window.clearTimeout(existing);
    const handle = window.setTimeout(() => {
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

  private async processFile(path: string, knownMtime?: number): Promise<void> {
    // Serialize per-path so a fast modify→delete sequence does not
    // race the in-flight processor for the prior modify event.
    const prior = this.inFlight.get(path);
    const next = (async () => {
      if (prior) await prior.catch(() => {});
      await this.doProcessFile(path, knownMtime);
    })();
    this.inFlight.set(path, next);
    try {
      await next;
      // Schedule a debounced flush so the upsert/delete the file just
      // produced eventually reaches disk. Coalesces bursts.
      this.scheduleFlush();
    } finally {
      // Only clear inFlight if our promise is still the current one
      // (a later schedule may have queued behind).
      if (this.inFlight.get(path) === next) this.inFlight.delete(path);
    }
  }

  private async doProcessFile(
    path: string,
    knownMtime?: number,
  ): Promise<void> {
    await processOnePath(this.opts, path, knownMtime);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flushInFlight = this.runFlush();
    }, this.flushDebounceMs);
  }

  private async runFlush(): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.opts.store.flush();
      logger.info("live indexer: flush completed", {
        providerKey: this.opts.embedder.providerKey,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      // Do not let a transient flush failure crash future processing —
      // the store still has `dirty = true` (or the next upsert will set
      // it), so the next debounced flush self-heals by rewriting both
      // bin and index from current in-memory state.
      logger.error("live indexer: flush failed", {
        providerKey: this.opts.embedder.providerKey,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.flushInFlight = null;
    }
  }

  /**
   * Force any pending debounced flush to run now, then await the
   * in-flight flush (if any) so the caller observes a synchronous
   * "store persisted" boundary. Used by `stop()` and `flush()`.
   */
  private async drainFlush(): Promise<void> {
    if (this.flushTimer) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flushInFlight = this.runFlush();
    }
    if (this.flushInFlight) {
      await this.flushInFlight;
    }
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
  /** See {@link LiveIndexerOpts.isExcluded}. */
  isExcluded?: (path: string) => boolean;
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
  private timer: number | null = null;
  private running = false;
  private cycleInFlight: Promise<void> | null = null;
  private lastSeenMtime = new Map<string, number>();
  private bypassPersistedMtime = false;
  private readonly intervalMs: number;
  private readonly opts: LowPowerIndexerOpts;

  constructor(opts: LowPowerIndexerOpts) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_LOW_POWER_INTERVAL_MS;
    this.opts = { ...opts, chunker: wrapChunkerWithOverlap(opts.chunker) };
  }

  async start(opts: StartOpts = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Run the first scan immediately so the user doesn't wait
    // `intervalMs` for indexing to begin (unless explicitly opted out).
    // Subsequent scans tick on the interval regardless.
    if (opts.initialRebuild !== false) {
      await this.runCycle();
    }
    this.timer = window.setInterval(() => {
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
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cycleInFlight) await this.cycleInFlight;
  }

  private isExcluded(path: string): boolean {
    return this.opts.isExcluded?.(path) ?? false;
  }

  async rebuildAll(opts: RebuildOpts = {}): Promise<void> {
    const force = opts.force ?? true;
    if (!(await this.opts.embedder.isAvailable())) {
      logger.warn(
        "low-power indexer: embedding provider not available, skipping rebuild",
      );
      return;
    }
    if (force) {
      // Force every file to be considered stale: clear the in-memory
      // map AND bypass the persisted mtimes for this cycle, otherwise
      // the sidecar would defeat the manual "Rebuild index" button.
      this.lastSeenMtime.clear();
      this.bypassPersistedMtime = true;
    }
    try {
      await this.runCycle();
    } finally {
      this.bypassPersistedMtime = false;
    }
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
      // Guard against recordsFor()/mtimeFor() on an un-inited store
      // (lazy loading); idempotent.
      await this.opts.store.init();
      const files = this.opts.vault.getMarkdownFiles();
      const seenPaths = new Set<string>();

      for (const f of files) {
        // Add to `seenPaths` before the exclusion check so an
        // already-indexed file that becomes excluded is treated as
        // "seen but skipped", not "vanished" — that keeps the
        // vanished-file cleanup below from destructively purging its
        // stale chunks on a settings change (D3: leave them in place,
        // hide at query time, physical cleanup only via manual Rebuild).
        seenPaths.add(f.path);
        if (this.isExcluded(f.path)) continue;
        // Seed from the persisted sidecar so the first cycle after a
        // restart skips unchanged files too. Guarded by hasRecords so
        // a stale sidecar without records self-heals, and bypassed
        // entirely during a forced rebuild.
        const persisted =
          this.bypassPersistedMtime || !this.opts.store.hasRecords(f.path)
            ? undefined
            : this.opts.store.mtimeFor(f.path);
        const prev = this.lastSeenMtime.get(f.path) ?? persisted;
        const cur = f.mtime ?? Number.POSITIVE_INFINITY; // unknown mtime → process every cycle
        if (prev !== undefined && cur <= prev) continue;
        await processOnePath(this.opts, f.path, f.mtime);
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
async function processOnePath(
  deps: ProcessDeps,
  path: string,
  knownMtime?: number,
): Promise<void> {
  // Capture the mtime BEFORE reading: stamping it after the read could
  // record a newer mtime for older content if the file changes in
  // between, and a too-old mtime only costs one redundant re-process.
  const mtime = knownMtime ?? deps.vault.getFileMtime?.(path);
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
  for (const r of deps.store.recordsFor(path)) {
    existingByHash.set(r.contentHash, r);
  }

  // Two-pass: collect every chunk that needs an embed (deduped by
  // contentHash) and run ONE batched embedder call. Per-chunk calls
  // were batch-of-1 inferences — tokenization and the forward pass
  // batch far better in a single pipeline invocation.
  const vectors = new Array<Float32Array | undefined>(chunks.length);
  const toEmbedTexts: string[] = [];
  const slotsByHash = new Map<string, number[]>();
  chunks.forEach((c, i) => {
    const reused = existingByHash.get(c.contentHash);
    if (reused) {
      vectors[i] = reused.vector;
      return;
    }
    const slots = slotsByHash.get(c.contentHash);
    if (slots) {
      slots.push(i);
    } else {
      slotsByHash.set(c.contentHash, [i]);
      toEmbedTexts.push(c.text);
    }
  });

  if (toEmbedTexts.length > 0) {
    const embedded = await deps.embedder.embed(toEmbedTexts, "document");
    let k = 0;
    for (const slots of slotsByHash.values()) {
      const vector = embedded[k++];
      for (const i of slots) vectors[i] = vector;
    }
  }

  const records: EmbeddingRecord[] = chunks.map((c, i) => {
    const vector = vectors[i];
    if (!vector) {
      throw new Error(
        `indexer: missing embedding for chunk ${path}#${c.id} (batch result misaligned)`,
      );
    }
    return {
      chunkId: `${path}#${c.id}`,
      filePath: path,
      offset: c.offset,
      heading: c.heading,
      contentHash: c.contentHash,
      vector,
    };
  });

  // A save that didn't change the chunking (the common autosave case)
  // would otherwise mark the store dirty and trigger a full-store
  // rewrite at the next flush. The mtime is still recorded (sidecar
  // dirty only) so the next session-start rebuild can skip the file.
  if (sameRecordSet(records, deps.store.recordsFor(path))) {
    if (mtime !== undefined) deps.store.setMtime(path, mtime);
    return;
  }

  await deps.store.delete(path);
  await deps.store.upsert(records);
  if (mtime !== undefined) deps.store.setMtime(path, mtime);
}

/**
 * True when the freshly built records match the stored ones
 * field-for-field. Vectors are excluded: a matching contentHash means
 * the vector was reused from the matching stored record.
 */
function sameRecordSet(
  next: EmbeddingRecord[],
  current: Iterable<EmbeddingRecord>,
): boolean {
  const byId = new Map<string, EmbeddingRecord>();
  for (const r of current) byId.set(r.chunkId, r);
  if (byId.size !== next.length) return false;
  return next.every((r) => {
    const e = byId.get(r.chunkId);
    return (
      e !== undefined &&
      e.contentHash === r.contentHash &&
      e.offset === r.offset &&
      e.heading === r.heading
    );
  });
}
