/**
 * Persistent embedding store for the semantic-search feature.
 *
 * Format:
 * - `<dir>/embeddings.bin` — sequential Float32 vectors. One vector
 *   per chunk, dimensions implicit from the model (default 384 for
 *   MiniLM-L6-v2). Vectors are written contiguously; the JSON index
 *   carries the byteOffset/byteLength to slice them back out.
 * - `<dir>/embeddings.index.json` — `{ version: 3, records: [...] }`.
 *   Each record maps a chunkId to its `(filePath, offset, heading,
 *   contentHash, byteOffset, byteLength)`. Bumping `version` triggers
 *   a clean re-index on next `init()` (logged warning, no error).
 *
 * Why flat-file instead of SQLite or HNSW:
 * - Vault sizes targeted at 0.4.0 are well under 100k chunks. Cosine
 *   flat scan over 100k × 384-dim Float32 (~150MB) takes ~20ms on
 *   modern CPU with vectorized typed-array math. HNSW indexing is
 *   deferred to 0.6.x if vault-size evidence demands it.
 * - SQLite adds a runtime dependency (better-sqlite3 / sql.js
 *   variants are heavy + platform-sensitive in Electron). Plain
 *   Float32 + JSON is simpler and bun-test-friendly.
 *
 * I/O is injected via `VaultAdapter` so tests can run with an
 * in-memory adapter without touching the real filesystem or
 * Obsidian's vault.adapter API.
 */

import { logger } from "$/shared/logger";

export type EmbeddingRecord = {
  chunkId: string;
  filePath: string;
  offset: number;
  heading: string | null;
  contentHash: string;
  vector: Float32Array;
};

export interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface EmbeddingStore {
  init(): Promise<void>;
  size(): number;
  upsert(records: EmbeddingRecord[]): Promise<void>;
  delete(filePath: string): Promise<void>;
  /** O(chunks-in-file) lookup via secondary index. Use instead of scan()+filter for per-path access. */
  recordsFor(filePath: string): Iterable<EmbeddingRecord>;
  /** O(1): true when the path has at least one record. */
  hasRecords(filePath: string): boolean;
  /**
   * Last successfully indexed mtime for the path, persisted in the
   * `mtimes.json` sidecar. Lets a session-start rebuild skip unchanged
   * files without reading them. Accepted risk: a sync tool that
   * preserves mtime while changing content defeats the skip — same
   * exposure as the low-power indexer's in-memory map; the manual
   * "Rebuild index" button forces a full pass.
   */
  mtimeFor(filePath: string): number | undefined;
  /** Record the mtime for a successfully indexed path (sidecar-dirty only). */
  setMtime(filePath: string, mtime: number): void;
  /**
   * Cheap readiness probe: reads only the `embeddings.meta.json`
   * sidecar (fallback: one parse of the index JSON, for stores written
   * before the sidecar existed), never the bin, and never initializes
   * the store. Returns null when nothing is persisted or the dirty
   * sentinel is present — a pending init() would discard those records,
   * so reporting them as ready would be a lie.
   */
  probe(): Promise<{ version: number; recordCount: number } | null>;
  scan(): AsyncIterable<EmbeddingRecord>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type EmbeddingStoreOpts = {
  adapter: VaultAdapter;
  binPath: string;
  indexPath: string;
  /** Expected vector dimensionality. Records that don't match are
   *  rejected with an error to keep the store self-consistent. */
  vectorDim?: number;
};

// v4: chunk size now derived from provider.getMaxInputTokens() (WebGPU lets
// EmbeddingGemma use its full 2K context). Stored hashes from v3 differ from
// v4 for the same source files, so the index is wiped on upgrade.
export const FORMAT_VERSION = 4;
const DEFAULT_VECTOR_DIM = 384;

type IndexRecord = {
  chunkId: string;
  filePath: string;
  offset: number;
  heading: string | null;
  contentHash: string;
  byteOffset: number;
  byteLength: number;
};

type IndexFile = {
  version: number;
  records: IndexRecord[];
};

class EmbeddingStoreImpl implements EmbeddingStore {
  private records = new Map<string, EmbeddingRecord>();
  private fileIndex = new Map<string, Set<string>>();
  private dirty = false;
  // Per-file mtimes live in their own sidecar with their own dirty
  // flag: an autosave that only advances mtime must cost one small
  // JSON write, never the full bin+index rewrite.
  private fileMtimes = new Map<string, number>();
  private mtimeDirty = false;
  private initialized = false;
  private readonly vectorDim: number;
  // Dirty-sentinel: written before the bin/index pair, removed only
  // after both succeed. Its presence at init means a prior flush was
  // interrupted, so the on-disk pair may be a new bin with a stale
  // index (valid JSON, matching version, garbage offsets). Derived
  // from indexPath so no extra opt is needed.
  private readonly sentinelPath: string;

  /** Sidecar next to the index file, e.g. `<dir>/mtimes.json`. */
  private readonly mtimesPath: string;
  /** Tiny readiness sidecar, e.g. `<dir>/embeddings.meta.json`. */
  private readonly metaPath: string;

  constructor(private opts: EmbeddingStoreOpts) {
    this.vectorDim = opts.vectorDim ?? DEFAULT_VECTOR_DIM;
    this.sentinelPath = `${opts.indexPath}.writing`;
    const dir = opts.indexPath.split("/").slice(0, -1).join("/");
    this.mtimesPath = dir ? `${dir}/mtimes.json` : "mtimes.json";
    this.metaPath = dir
      ? `${dir}/embeddings.meta.json`
      : "embeddings.meta.json";
  }

  async probe(): Promise<{ version: number; recordCount: number } | null> {
    if (await this.opts.adapter.exists(this.sentinelPath)) return null;
    try {
      if (await this.opts.adapter.exists(this.metaPath)) {
        const parsed = JSON.parse(
          await this.opts.adapter.read(this.metaPath),
        ) as { version?: unknown; recordCount?: unknown };
        if (
          typeof parsed.version === "number" &&
          typeof parsed.recordCount === "number"
        ) {
          return {
            version: parsed.version,
            recordCount: parsed.recordCount,
          };
        }
      }
    } catch {
      // Corrupt meta: fall through to the index parse below.
    }
    try {
      if (!(await this.opts.adapter.exists(this.opts.indexPath))) return null;
      const parsed = JSON.parse(
        await this.opts.adapter.read(this.opts.indexPath),
      ) as IndexFile;
      if (typeof parsed.version !== "number") return null;
      return {
        version: parsed.version,
        recordCount: parsed.records?.length ?? 0,
      };
    } catch {
      return null;
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    if (await this.opts.adapter.exists(this.sentinelPath)) {
      // A previous flush was interrupted between the bin and index
      // writes. The pair on disk is known-inconsistent; loading it
      // would silently slice vectors at wrong offsets. The lost index
      // is re-derivable (the indexer re-embeds from the vault), so
      // discard and rebuild instead of trusting garbage.
      logger.warn("embedding store was mid-write, discarding and rebuilding");
      await this.removeSentinel();
      this.initialized = true;
      this.dirty = true; // next flush rewrites a clean bin/index pair
      // Discard mtimes too: a sidecar claiming "current" while the
      // records are gone would make the rebuild skip everything.
      this.fileMtimes.clear();
      this.mtimeDirty = true;
      return;
    }

    const indexExists = await this.opts.adapter.exists(this.opts.indexPath);
    if (!indexExists) {
      this.initialized = true;
      this.dirty = false;
      return;
    }

    let parsed: IndexFile;
    try {
      const text = await this.opts.adapter.read(this.opts.indexPath);
      parsed = JSON.parse(text) as IndexFile;
    } catch (error) {
      logger.warn("embedding index unreadable, starting fresh", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.initialized = true;
      this.dirty = true; // signal a flush is needed to overwrite the bad file
      return;
    }

    // v1 is intentionally not grandfathered: all v1 stores were migrated
    // to v2 by migrateV1FlatStore; any remaining v1 index is stale and
    // is treated as a version mismatch (triggers re-index).
    if (parsed.version !== FORMAT_VERSION) {
      logger.warn("embedding index format version mismatch, re-indexing", {
        expected: FORMAT_VERSION,
        found: parsed.version,
      });
      this.initialized = true;
      this.dirty = true;
      return;
    }

    const binExists = await this.opts.adapter.exists(this.opts.binPath);
    if (!binExists || parsed.records.length === 0) {
      this.initialized = true;
      this.dirty = false;
      return;
    }

    const buf = await this.opts.adapter.readBinary(this.opts.binPath);
    const all = new Float32Array(buf);

    let skippedAny = false;
    for (const idx of parsed.records) {
      // Defense-in-depth behind the sentinel: a corrupt/truncated bin
      // or a stale index that slipped past the sentinel must never
      // yield a wrong-dimension Float32Array. On any inconsistency,
      // skip the record and mark dirty so the next flush self-heals.
      if (
        idx.byteOffset < 0 ||
        idx.byteLength < 0 ||
        idx.byteOffset % 4 !== 0 ||
        idx.byteLength % 4 !== 0 ||
        idx.byteOffset + idx.byteLength > buf.byteLength
      ) {
        logger.warn("embedding record out of bounds, skipping", {
          chunkId: idx.chunkId,
          byteOffset: idx.byteOffset,
          byteLength: idx.byteLength,
          bufByteLength: buf.byteLength,
        });
        skippedAny = true;
        continue;
      }
      const startFloat = idx.byteOffset / 4;
      const lenFloat = idx.byteLength / 4;
      // Copy into a fresh Float32Array so each record owns its buffer
      // independently of the read-side ArrayBuffer lifetime.
      const vector = new Float32Array(
        all.subarray(startFloat, startFloat + lenFloat),
      );
      this.records.set(idx.chunkId, {
        chunkId: idx.chunkId,
        filePath: idx.filePath,
        offset: idx.offset,
        heading: idx.heading,
        contentHash: idx.contentHash,
        vector,
      });
      let fileSet = this.fileIndex.get(idx.filePath);
      if (!fileSet) {
        fileSet = new Set();
        this.fileIndex.set(idx.filePath, fileSet);
      }
      fileSet.add(idx.chunkId);
    }

    this.initialized = true;
    this.dirty = skippedAny;
    await this.loadMtimes();
  }

  /** Best-effort load of the mtimes sidecar; absent/corrupt → empty map. */
  private async loadMtimes(): Promise<void> {
    try {
      if (!(await this.opts.adapter.exists(this.mtimesPath))) return;
      const parsed = JSON.parse(
        await this.opts.adapter.read(this.mtimesPath),
      ) as Record<string, unknown>;
      for (const [path, mtime] of Object.entries(parsed)) {
        if (typeof mtime === "number") this.fileMtimes.set(path, mtime);
      }
    } catch (error) {
      logger.warn("mtimes sidecar unreadable, ignoring", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  size(): number {
    return this.records.size;
  }

  hasRecords(filePath: string): boolean {
    const set = this.fileIndex.get(filePath);
    return set !== undefined && set.size > 0;
  }

  mtimeFor(filePath: string): number | undefined {
    return this.fileMtimes.get(filePath);
  }

  setMtime(filePath: string, mtime: number): void {
    if (this.fileMtimes.get(filePath) === mtime) return;
    this.fileMtimes.set(filePath, mtime);
    this.mtimeDirty = true;
  }

  async upsert(records: EmbeddingRecord[]): Promise<void> {
    if (!this.initialized) await this.init();
    for (const r of records) {
      if (r.vector.length !== this.vectorDim) {
        throw new Error(
          `embedding dim mismatch: chunkId=${r.chunkId} expected ${this.vectorDim} got ${r.vector.length}`,
        );
      }
      // If the chunkId already exists under a different filePath, remove it
      // from the old fileIndex entry before overwriting.
      const existing = this.records.get(r.chunkId);
      if (existing && existing.filePath !== r.filePath) {
        const oldSet = this.fileIndex.get(existing.filePath);
        if (oldSet) {
          oldSet.delete(r.chunkId);
          if (oldSet.size === 0) this.fileIndex.delete(existing.filePath);
        }
      }
      this.records.set(r.chunkId, r);
      let fileSet = this.fileIndex.get(r.filePath);
      if (!fileSet) {
        fileSet = new Set();
        this.fileIndex.set(r.filePath, fileSet);
      }
      fileSet.add(r.chunkId);
    }
    this.dirty = true;
  }

  async delete(filePath: string): Promise<void> {
    if (!this.initialized) await this.init();
    if (this.fileMtimes.delete(filePath)) this.mtimeDirty = true;
    const chunkIds = this.fileIndex.get(filePath);
    if (!chunkIds || chunkIds.size === 0) return;
    for (const chunkId of chunkIds) {
      this.records.delete(chunkId);
    }
    this.fileIndex.delete(filePath);
    this.dirty = true;
  }

  recordsFor(filePath: string): Iterable<EmbeddingRecord> {
    const chunkIds = this.fileIndex.get(filePath);
    if (!chunkIds) return [];
    const out: EmbeddingRecord[] = [];
    for (const chunkId of chunkIds) {
      const r = this.records.get(chunkId);
      if (r) out.push(r);
    }
    return out;
  }

  async *scan(): AsyncIterable<EmbeddingRecord> {
    if (!this.initialized) await this.init();
    for (const rec of this.records.values()) {
      yield rec;
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      // mtime-only change (the common autosave case): one small JSON
      // write, no sentinel needed — the sidecar is advisory and the
      // record pair is untouched.
      if (this.mtimeDirty) await this.flushMtimes();
      return;
    }

    // Ensure the parent directory exists before writing — on a fresh
    // install the per-providerKey subdirectory may not exist yet.
    const dir = this.opts.binPath.split("/").slice(0, -1).join("/");
    if (dir) await this.opts.adapter.mkdir(dir);

    const recordList = Array.from(this.records.values());
    let totalFloats = 0;
    for (const r of recordList) totalFloats += r.vector.length;

    const bin = new Float32Array(totalFloats);
    const indexRecs: IndexRecord[] = [];
    let floatOffset = 0;
    for (const r of recordList) {
      const byteOffset = floatOffset * 4;
      const byteLength = r.vector.length * 4;
      bin.set(r.vector, floatOffset);
      floatOffset += r.vector.length;
      indexRecs.push({
        chunkId: r.chunkId,
        filePath: r.filePath,
        offset: r.offset,
        heading: r.heading,
        contentHash: r.contentHash,
        byteOffset,
        byteLength,
      });
    }

    // Slice to exact byte length — bin.buffer can be larger than the
    // logical content if Float32Array was allocated with padding by
    // some runtimes.
    const exactBuffer = bin.buffer.slice(
      bin.byteOffset,
      bin.byteOffset + bin.byteLength,
    );

    // Raise the sentinel before touching either file: if the process
    // dies between the bin and index writes the sentinel stays,
    // signalling the next init() that the pair is inconsistent.
    await this.opts.adapter.write(this.sentinelPath, "1");
    await this.opts.adapter.writeBinary(this.opts.binPath, exactBuffer);

    const indexFile: IndexFile = {
      version: FORMAT_VERSION,
      records: indexRecs,
    };
    await this.opts.adapter.write(
      this.opts.indexPath,
      JSON.stringify(indexFile),
    );

    // After the pair, inside the sentinel window: a crash here leaves
    // the sentinel up, so init() discards records AND mtimes together.
    if (this.mtimeDirty) await this.flushMtimes();

    // Meta sidecar last, still inside the window: it doubles as the
    // commit marker probe() trusts, so it must never describe a pair
    // that didn't finish writing.
    await this.opts.adapter.write(
      this.metaPath,
      JSON.stringify({
        version: FORMAT_VERSION,
        recordCount: this.records.size,
      }),
    );

    // Both writes succeeded — the pair is consistent, clear the sentinel.
    await this.removeSentinel();
    this.dirty = false;
  }

  private async flushMtimes(): Promise<void> {
    const dir = this.mtimesPath.split("/").slice(0, -1).join("/");
    if (dir) await this.opts.adapter.mkdir(dir);
    await this.opts.adapter.write(
      this.mtimesPath,
      JSON.stringify(Object.fromEntries(this.fileMtimes)),
    );
    this.mtimeDirty = false;
  }

  /** Remove the sentinel, tolerating it already being gone. */
  private async removeSentinel(): Promise<void> {
    try {
      if (await this.opts.adapter.exists(this.sentinelPath)) {
        await this.opts.adapter.remove(this.sentinelPath);
      }
    } catch (error) {
      // A failed sentinel removal is non-fatal: a leftover sentinel
      // only triggers a (safe) discard-and-rebuild on next init().
      logger.warn("could not remove embedding store sentinel", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.records.clear();
    this.fileIndex.clear();
    this.fileMtimes.clear();
    this.dirty = false;
    this.mtimeDirty = false;
    this.initialized = false;
  }
}

export function createEmbeddingStore(opts: EmbeddingStoreOpts): EmbeddingStore {
  return new EmbeddingStoreImpl(opts);
}
