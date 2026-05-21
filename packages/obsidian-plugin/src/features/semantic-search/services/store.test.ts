import { describe, expect, test, beforeEach } from "bun:test";
import {
  createEmbeddingStore,
  FORMAT_VERSION,
  type EmbeddingRecord,
  type VaultAdapter,
} from "./store";

/**
 * In-memory vault adapter shared across the test cases. Stores text
 * and binary blobs in two Maps keyed by path. Mirrors the behavior
 * of Obsidian's `vault.adapter` for the surface the store actually
 * uses — exists/read/write/readBinary/writeBinary/remove.
 */
function makeMemAdapter(): {
  adapter: VaultAdapter;
  files: Map<string, string>;
  bins: Map<string, ArrayBuffer>;
} {
  const files = new Map<string, string>();
  const bins = new Map<string, ArrayBuffer>();
  const adapter: VaultAdapter = {
    async exists(path) {
      return files.has(path) || bins.has(path);
    },
    async read(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v;
    },
    async write(path, data) {
      files.set(path, data);
    },
    async readBinary(path) {
      const v = bins.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      // Return a copy so writers don't mutate readers.
      return v.slice(0);
    },
    async writeBinary(path, data) {
      bins.set(path, data.slice(0));
    },
    async remove(path) {
      files.delete(path);
      bins.delete(path);
    },
  };
  return { adapter, files, bins };
}

const DIM = 4; // small fixed dimension to keep test math readable

function makeVector(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = seed * 0.1 + i * 0.01;
  return v;
}

function makeRecord(
  opts: Partial<EmbeddingRecord> & { chunkId: string },
): EmbeddingRecord {
  return {
    chunkId: opts.chunkId,
    filePath: opts.filePath ?? "Notes/a.md",
    offset: opts.offset ?? 0,
    heading: opts.heading ?? null,
    contentHash: opts.contentHash ?? "deadbeefdeadbeef",
    vector: opts.vector ?? makeVector(opts.chunkId.length),
  };
}

describe("embedding store", () => {
  let mem: ReturnType<typeof makeMemAdapter>;
  beforeEach(() => {
    mem = makeMemAdapter();
  });

  test("init on empty: size === 0, no files written until flush", async () => {
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await store.init();
    expect(store.size()).toBe(0);
    expect(mem.files.size).toBe(0);
    expect(mem.bins.size).toBe(0);
  });

  test("upsert + size: 3 records → size === 3", async () => {
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([
      makeRecord({ chunkId: "a:0" }),
      makeRecord({ chunkId: "a:1" }),
      makeRecord({ chunkId: "b:0", filePath: "Notes/b.md" }),
    ]);
    expect(store.size()).toBe(3);
  });

  test("upsert with existing chunkId replaces in place", async () => {
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([makeRecord({ chunkId: "x:0", contentHash: "v1" })]);
    await store.upsert([makeRecord({ chunkId: "x:0", contentHash: "v2" })]);
    expect(store.size()).toBe(1);
    const seen: EmbeddingRecord[] = [];
    for await (const r of store.scan()) seen.push(r);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.contentHash).toBe("v2");
  });

  test("delete by filePath removes all chunks for that path", async () => {
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([
      makeRecord({ chunkId: "a:0", filePath: "Notes/a.md" }),
      makeRecord({ chunkId: "a:1", filePath: "Notes/a.md" }),
      makeRecord({ chunkId: "b:0", filePath: "Notes/b.md" }),
    ]);
    await store.delete("Notes/a.md");
    expect(store.size()).toBe(1);
    const seen: EmbeddingRecord[] = [];
    for await (const r of store.scan()) seen.push(r);
    expect(seen[0]?.filePath).toBe("Notes/b.md");
  });

  test("scan yields all records in insertion order", async () => {
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await store.init();
    const ids = ["a:0", "b:0", "c:0"];
    await store.upsert(ids.map((id) => makeRecord({ chunkId: id })));
    const seenIds: string[] = [];
    for await (const r of store.scan()) seenIds.push(r.chunkId);
    expect(seenIds).toEqual(ids);
  });

  test("flush + reopen: state persists across init cycles", async () => {
    const opts = {
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    };
    const a = createEmbeddingStore(opts);
    await a.init();
    const v1 = makeVector(7);
    const v2 = makeVector(13);
    await a.upsert([
      makeRecord({ chunkId: "x:0", vector: v1, contentHash: "h1" }),
      makeRecord({
        chunkId: "y:0",
        vector: v2,
        contentHash: "h2",
        filePath: "Y.md",
      }),
    ]);
    await a.flush();

    const b = createEmbeddingStore(opts);
    await b.init();
    expect(b.size()).toBe(2);
    const records: Record<string, EmbeddingRecord> = {};
    for await (const r of b.scan()) records[r.chunkId] = r;

    expect(records["x:0"]?.contentHash).toBe("h1");
    expect(records["y:0"]?.filePath).toBe("Y.md");
    // Vectors round-tripped exactly (Float32 is lossless to itself).
    for (let i = 0; i < DIM; i++) {
      expect(records["x:0"]?.vector[i]).toBeCloseTo(v1[i] ?? 0, 6);
      expect(records["y:0"]?.vector[i]).toBeCloseTo(v2[i] ?? 0, 6);
    }
  });

  test("format version mismatch → re-init from scratch (logged warning)", async () => {
    // Pre-populate the index file with a wrong version.
    await mem.adapter.write(
      "/p/embeddings.index.json",
      JSON.stringify({ version: FORMAT_VERSION + 1, records: [] }),
    );
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await store.init();
    expect(store.size()).toBe(0);
    // Subsequent upsert + flush should overwrite with the current version.
    await store.upsert([makeRecord({ chunkId: "a:0" })]);
    await store.flush();
    const written = JSON.parse(
      mem.files.get("/p/embeddings.index.json") ?? "{}",
    );
    expect(written.version).toBe(FORMAT_VERSION);
    expect(written.records).toHaveLength(1);
  });

  test("upsert rejects vector with wrong dimensionality", async () => {
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await store.init();
    const wrong = new Float32Array(DIM + 1);
    await expect(
      store.upsert([makeRecord({ chunkId: "bad:0", vector: wrong })]),
    ).rejects.toThrow(/dim mismatch/);
  });

  test("close flushes and clears state", async () => {
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([makeRecord({ chunkId: "a:0" })]);
    await store.close();
    // The index file should be on disk after close.
    expect(mem.files.has("/p/embeddings.index.json")).toBe(true);
    // size() reads internal state which was cleared.
    expect(store.size()).toBe(0);
  });

  test("interrupted flush leaves a sentinel; next init discards rather than loading garbage", async () => {
    const opts = {
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    };
    const sentinelPath = "/p/embeddings.index.json.writing";

    // First store: write a clean pair so a stale (old) index/bin exists.
    const a = createEmbeddingStore(opts);
    await a.init();
    await a.upsert([makeRecord({ chunkId: "old:0", vector: makeVector(1) })]);
    await a.flush();
    expect(await mem.adapter.exists(sentinelPath)).toBe(false);

    // Second store: simulate a crash mid-flush. The bin write succeeds
    // (a NEW, larger bin lands) but the index write throws before the
    // index is updated, so disk holds a NEW bin + OLD index — the
    // silent-corruption scenario.
    const failingAdapter: VaultAdapter = {
      ...mem.adapter,
      async write(path, data) {
        if (path === opts.indexPath) {
          throw new Error("simulated crash during index write");
        }
        return mem.adapter.write(path, data);
      },
    };
    const b = createEmbeddingStore({ ...opts, adapter: failingAdapter });
    await b.init();
    await b.upsert([
      makeRecord({ chunkId: "old:0", vector: makeVector(1) }),
      makeRecord({ chunkId: "new:0", vector: makeVector(2), filePath: "N.md" }),
    ]);
    await expect(b.flush()).rejects.toThrow(/simulated crash/);

    // The sentinel must survive the interrupted flush.
    expect(await mem.adapter.exists(sentinelPath)).toBe(true);

    // A fresh store over this inconsistent on-disk state must NOT load
    // the new-bin/old-index pair (which would slice garbage). It
    // discards: records empty, dirty (so the next flush rewrites a
    // clean pair), sentinel cleaned.
    const c = createEmbeddingStore(opts);
    await c.init();
    expect(c.size()).toBe(0);
    expect(await mem.adapter.exists(sentinelPath)).toBe(false);

    // dirty === true is observable: a flush now rewrites the pair even
    // though no upsert happened after init.
    await c.flush();
    const written = JSON.parse(
      mem.files.get("/p/embeddings.index.json") ?? "{}",
    );
    expect(written.version).toBe(FORMAT_VERSION);
    expect(written.records).toHaveLength(0);
  });

  test("bin shorter than a record's byteOffset+byteLength: skip that record, keep valid ones, no throw", async () => {
    const opts = {
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    };
    // One valid record (DIM floats = 16 bytes) followed by an index
    // record whose byteOffset+byteLength runs past the actual bin.
    const v0 = makeVector(9);
    const bin = new Float32Array(DIM);
    bin.set(v0, 0);
    await mem.adapter.writeBinary("/p/embeddings.bin", bin.buffer.slice(0));
    await mem.adapter.write(
      "/p/embeddings.index.json",
      JSON.stringify({
        version: FORMAT_VERSION,
        records: [
          {
            chunkId: "good:0",
            filePath: "G.md",
            offset: 0,
            heading: null,
            contentHash: "g",
            byteOffset: 0,
            byteLength: DIM * 4,
          },
          {
            chunkId: "oob:0",
            filePath: "B.md",
            offset: 0,
            heading: null,
            contentHash: "b",
            byteOffset: DIM * 4,
            byteLength: DIM * 4, // points past the 16-byte bin
          },
        ],
      }),
    );

    const store = createEmbeddingStore(opts);
    await store.init();
    // Out-of-bounds record skipped; valid one survives. No throw.
    expect(store.size()).toBe(1);
    const seen: Record<string, EmbeddingRecord> = {};
    for await (const r of store.scan()) seen[r.chunkId] = r;
    expect(seen["good:0"]?.filePath).toBe("G.md");
    expect(seen["oob:0"]).toBeUndefined();
    for (let i = 0; i < DIM; i++) {
      expect(seen["good:0"]?.vector[i]).toBeCloseTo(v0[i] ?? 0, 6);
    }
  });
});
