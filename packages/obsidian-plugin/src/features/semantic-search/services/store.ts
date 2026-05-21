/**
 * Persistent embedding store for the semantic-search feature.
 *
 * Format:
 * - `<dir>/embeddings.bin` — sequential Float32 vectors. One vector
 *   per chunk, dimensions implicit from the model (default 384 for
 *   MiniLM-L6-v2). Vectors are written contiguously; the JSON index
 *   carries the byteOffset/byteLength to slice them back out.
 * - `<dir>/embeddings.index.json` — `{ version: 1, records: [...] }`.
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
}

export interface EmbeddingStore {
  init(): Promise<void>;
  size(): number;
  upsert(records: EmbeddingRecord[]): Promise<void>;
  delete(filePath: string): Promise<void>;
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

export const FORMAT_VERSION = 1;
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
  private dirty = false;
  private initialized = false;
  private readonly vectorDim: number;
  // Dirty-sentinel: written before the bin/index pair, removed only
  // after both succeed. Its presence at init means a prior flush was
  // interrupted, so the on-disk pair may be a new bin with a stale
  // index (valid JSON, matching version, garbage offsets). Derived
  // from indexPath so no extra opt is needed.
  private readonly sentinelPath: string;

  constructor(private opts: EmbeddingStoreOpts) {
    this.vectorDim = opts.vectorDim ?? DEFAULT_VECTOR_DIM;
    this.sentinelPath = `${opts.indexPath}.writing`;
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
    }

    this.initialized = true;
    // If any record was skipped, the in-memory set no longer matches
    // the on-disk pair — mark dirty so the next flush rewrites a
    // consistent one.
    this.dirty = skippedAny;
  }

  size(): number {
    return this.records.size;
  }

  async upsert(records: EmbeddingRecord[]): Promise<void> {
    if (!this.initialized) await this.init();
    for (const r of records) {
      if (r.vector.length !== this.vectorDim) {
        throw new Error(
          `embedding dim mismatch: chunkId=${r.chunkId} expected ${this.vectorDim} got ${r.vector.length}`,
        );
      }
      this.records.set(r.chunkId, r);
    }
    this.dirty = true;
  }

  async delete(filePath: string): Promise<void> {
    if (!this.initialized) await this.init();
    let removed = 0;
    for (const [chunkId, rec] of this.records) {
      if (rec.filePath === filePath) {
        this.records.delete(chunkId);
        removed += 1;
      }
    }
    if (removed > 0) this.dirty = true;
  }

  async *scan(): AsyncIterable<EmbeddingRecord> {
    if (!this.initialized) await this.init();
    for (const rec of this.records.values()) {
      yield rec;
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;

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

    // Both writes succeeded — the pair is consistent, clear the sentinel.
    await this.removeSentinel();
    this.dirty = false;
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
    this.initialized = false;
  }
}

export function createEmbeddingStore(opts: EmbeddingStoreOpts): EmbeddingStore {
  return new EmbeddingStoreImpl(opts);
}
