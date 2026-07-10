import { describe, expect, test, beforeEach } from "bun:test";
import {
  createEmbeddingStore,
  FORMAT_VERSION,
  segmentOfPath,
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
    async mkdir() {},
  };
  return { adapter, files, bins };
}

const DIM = 4; // small fixed dimension to keep test math readable

const SEG_INDEX_RE = /embeddings\.seg\d+\.index\.json$/;
const SEG_BIN_RE = /embeddings\.seg\d+\.bin$/;

/** All records across the persisted segment index files. */
function persistedRecords(
  mem: ReturnType<typeof makeMemAdapter>,
): Array<{ chunkId: string }> {
  return [...mem.files.entries()]
    .filter(([path]) => SEG_INDEX_RE.test(path))
    .flatMap(
      ([, text]) =>
        (JSON.parse(text) as { records: Array<{ chunkId: string }> }).records,
    );
}

/** Versions carried by the persisted segment index files. */
function persistedVersions(mem: ReturnType<typeof makeMemAdapter>): number[] {
  return [...mem.files.entries()]
    .filter(([path]) => SEG_INDEX_RE.test(path))
    .map(([, text]) => (JSON.parse(text) as { version: number }).version);
}

/** Total byte length across the persisted segment bins. */
function persistedBinBytes(mem: ReturnType<typeof makeMemAdapter>): number {
  return [...mem.bins.entries()]
    .filter(([path]) => SEG_BIN_RE.test(path))
    .reduce((n, [, buf]) => n + buf.byteLength, 0);
}

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
    // Flush on empty store should produce zero-record segment artifacts,
    // and the stale legacy index must be gone.
    await store.flush();
    expect(mem.files.has("/p/embeddings.index.json")).toBe(false);
    expect(persistedRecords(mem)).toHaveLength(0);
    expect(persistedBinBytes(mem)).toBe(0);
    // Subsequent upsert + flush should persist with the current version.
    await store.upsert([makeRecord({ chunkId: "a:0" })]);
    await store.flush();
    expect(persistedRecords(mem)).toHaveLength(1);
    for (const v of persistedVersions(mem)) expect(v).toBe(FORMAT_VERSION);
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
    // The record must be on disk (in its segment index) after close.
    expect(persistedRecords(mem).map((r) => r.chunkId)).toContain("a:0");
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

    // Second store: simulate a crash mid-flush. The segment bin write
    // succeeds (a NEW, larger bin lands) but the segment index write
    // throws before the index is updated, so disk holds a NEW bin +
    // OLD index — the silent-corruption scenario.
    const failingAdapter: VaultAdapter = {
      ...mem.adapter,
      async write(path, data) {
        if (SEG_INDEX_RE.test(path)) {
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

    // The discard is observable: a flush now rewrites clean (empty)
    // segments even though no upsert happened after init.
    await c.flush();
    expect(persistedRecords(mem)).toHaveLength(0);
    for (const v of persistedVersions(mem)) expect(v).toBe(FORMAT_VERSION);
  });

  test("FORMAT_VERSION round-trip: flushed index carries current FORMAT_VERSION", async () => {
    const opts = {
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    };
    const store = createEmbeddingStore(opts);
    await store.init();
    await store.upsert([makeRecord({ chunkId: "a:0" })]);
    await store.flush();
    const versions = persistedVersions(mem);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(v).toBe(FORMAT_VERSION);
    expect(FORMAT_VERSION).toBe(4);
  });

  test("v1 index treated as stale (version mismatch); re-init from scratch", async () => {
    const opts = {
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    };
    // v1 indexes are no longer grandfathered: migrateV1FlatStore handles
    // the path-rename migration (v1→v2); any remaining v1 on-disk index
    // is treated as stale and wiped on next init().
    const v1Vec = makeVector(3);
    const bin = new Float32Array(DIM);
    bin.set(v1Vec, 0);
    await mem.adapter.writeBinary("/p/embeddings.bin", bin.buffer.slice(0));
    await mem.adapter.write(
      "/p/embeddings.index.json",
      JSON.stringify({
        version: 1,
        records: [
          {
            chunkId: "legacy:0",
            filePath: "Legacy.md",
            offset: 0,
            heading: null,
            contentHash: "abc123",
            byteOffset: 0,
            byteLength: DIM * 4,
          },
        ],
      }),
    );

    const store = createEmbeddingStore(opts);
    await store.init();
    // Version mismatch → re-init from scratch, no records loaded, and
    // the stale legacy pair removed.
    expect(store.size()).toBe(0);
    expect(mem.files.has("/p/embeddings.index.json")).toBe(false);
    // Flush should write FORMAT_VERSION segments with no records.
    await store.flush();
    expect(persistedRecords(mem)).toHaveLength(0);
    for (const v of persistedVersions(mem)) expect(v).toBe(FORMAT_VERSION);
  });

  test("legacy single-pair layout migrates to segments without losing vectors", async () => {
    // Hand-write a current-version LEGACY pair (pre-segmentation layout).
    const v0 = makeVector(7);
    const bin = new Float32Array(DIM);
    bin.set(v0, 0);
    await mem.adapter.writeBinary("/p/embeddings.bin", bin.buffer.slice(0));
    await mem.adapter.write(
      "/p/embeddings.index.json",
      JSON.stringify({
        version: FORMAT_VERSION,
        records: [
          {
            chunkId: "old:0",
            filePath: "Old.md",
            offset: 0,
            heading: null,
            contentHash: "h0",
            byteOffset: 0,
            byteLength: DIM * 4,
          },
        ],
      }),
    );

    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await store.init();

    // Vector preserved in memory (no re-embed needed)...
    expect(store.size()).toBe(1);
    const rec0 = [...store.recordsFor("Old.md")][0];
    for (let i = 0; i < DIM; i++) {
      expect(rec0?.vector[i]).toBeCloseTo(v0[i] ?? 0, 6);
    }
    // ...persisted in the segmented layout, legacy pair removed.
    expect(persistedRecords(mem).map((r) => r.chunkId)).toEqual(["old:0"]);
    expect(mem.files.has("/p/embeddings.index.json")).toBe(false);
    expect(mem.bins.has("/p/embeddings.bin")).toBe(false);

    // Round trip: a fresh store over the segmented layout loads it.
    const reopened = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await reopened.init();
    expect(reopened.size()).toBe(1);
    const rec1 = [...reopened.recordsFor("Old.md")][0];
    for (let i = 0; i < DIM; i++) {
      expect(rec1?.vector[i]).toBeCloseTo(v0[i] ?? 0, 6);
    }
  });

  test("editing one file rewrites only that file's segment", async () => {
    // Two paths guaranteed to live in different segments.
    const pathA = "Notes/a.md";
    let pathB = "Notes/b.md";
    for (let i = 0; segmentOfPath(pathB) === segmentOfPath(pathA); i++) {
      pathB = `Notes/b${i}.md`;
    }

    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([
      makeRecord({ chunkId: "a:0", filePath: pathA }),
      makeRecord({ chunkId: "b:0", filePath: pathB }),
    ]);
    await store.flush();

    // Tripwire: delete pathB's persisted segment pair. Touching only
    // pathA must NOT re-create them.
    const segB = segmentOfPath(pathB);
    mem.bins.delete(`/p/embeddings.seg${segB}.bin`);
    mem.files.delete(`/p/embeddings.seg${segB}.index.json`);

    await store.upsert([
      makeRecord({ chunkId: "a:0", filePath: pathA, contentHash: "changed" }),
    ]);
    await store.flush();

    expect(mem.bins.has(`/p/embeddings.seg${segB}.bin`)).toBe(false);
    expect(mem.files.has(`/p/embeddings.seg${segB}.index.json`)).toBe(false);
    // pathA's segment carries the update.
    const segA = segmentOfPath(pathA);
    const idxA = JSON.parse(
      mem.files.get(`/p/embeddings.seg${segA}.index.json`) ?? "{}",
    ) as { records: Array<{ chunkId: string; contentHash: string }> };
    expect(idxA.records.find((r) => r.chunkId === "a:0")?.contentHash).toBe(
      "changed",
    );
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

describe("EmbeddingStore — recordsFor", () => {
  function makeOpts() {
    const { adapter } = makeMemAdapter();
    return {
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    };
  }

  test("returns empty iterable for unknown filePath", async () => {
    const store = createEmbeddingStore(makeOpts());
    await store.init();
    const result = Array.from(store.recordsFor("Notes/missing.md"));
    expect(result).toHaveLength(0);
  });

  test("returns only records for the requested filePath", async () => {
    const store = createEmbeddingStore(makeOpts());
    await store.init();
    await store.upsert([
      makeRecord({ chunkId: "a:0", filePath: "Notes/a.md" }),
      makeRecord({ chunkId: "a:1", filePath: "Notes/a.md" }),
      makeRecord({ chunkId: "b:0", filePath: "Notes/b.md" }),
    ]);
    const forA = Array.from(store.recordsFor("Notes/a.md"));
    expect(forA).toHaveLength(2);
    expect(forA.every((r) => r.filePath === "Notes/a.md")).toBe(true);
    const forB = Array.from(store.recordsFor("Notes/b.md"));
    expect(forB).toHaveLength(1);
    expect(forB[0]?.chunkId).toBe("b:0");
  });

  test("returns empty iterable after delete for that filePath", async () => {
    const store = createEmbeddingStore(makeOpts());
    await store.init();
    await store.upsert([
      makeRecord({ chunkId: "a:0", filePath: "Notes/a.md" }),
      makeRecord({ chunkId: "a:1", filePath: "Notes/a.md" }),
    ]);
    await store.delete("Notes/a.md");
    const result = Array.from(store.recordsFor("Notes/a.md"));
    expect(result).toHaveLength(0);
    expect(store.size()).toBe(0);
  });

  test("recordsFor reflects records loaded from disk after flush+init", async () => {
    const opts = makeOpts();
    const store1 = createEmbeddingStore(opts);
    await store1.init();
    await store1.upsert([
      makeRecord({ chunkId: "a:0", filePath: "Notes/a.md" }),
      makeRecord({ chunkId: "b:0", filePath: "Notes/b.md" }),
    ]);
    await store1.flush();
    await store1.close();

    const store2 = createEmbeddingStore(opts);
    await store2.init();
    const forA = Array.from(store2.recordsFor("Notes/a.md"));
    expect(forA).toHaveLength(1);
    expect(forA[0]?.chunkId).toBe("a:0");
    const forB = Array.from(store2.recordsFor("Notes/b.md"));
    expect(forB).toHaveLength(1);
    expect(forB[0]?.chunkId).toBe("b:0");
  });
});

describe("embedding store — mtimes sidecar", () => {
  const A = "/p/embeddings.bin";
  const I = "/p/embeddings.index.json";
  const M = "/p/mtimes.json";

  function rec(chunkId: string, filePath: string): EmbeddingRecord {
    const vector = new Float32Array(DIM);
    vector[0] = 1;
    return {
      chunkId,
      filePath,
      offset: 0,
      heading: null,
      contentHash: `h:${chunkId}`,
      vector,
    };
  }

  test("setMtime persists through flush and reloads in a new instance", async () => {
    const mem = makeMemAdapter();
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: A,
      indexPath: I,
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([rec("a.md#0", "a.md")]);
    store.setMtime("a.md", 111);
    await store.flush();
    expect(mem.files.has(M)).toBe(true);

    const reloaded = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: A,
      indexPath: I,
      vectorDim: DIM,
    });
    await reloaded.init();
    expect(reloaded.mtimeFor("a.md")).toBe(111);
    expect(reloaded.hasRecords("a.md")).toBe(true);
  });

  test("mtime-only change flushes the sidecar without rewriting the bin", async () => {
    const mem = makeMemAdapter();
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: A,
      indexPath: I,
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([rec("a.md#0", "a.md")]);
    store.setMtime("a.md", 1);
    await store.flush();
    const segBinsAfterFirst = [...mem.bins.keys()].filter((p) =>
      SEG_BIN_RE.test(p),
    );
    expect(segBinsAfterFirst.length).toBeGreaterThan(0);

    // Advance only the mtime: the record pairs must not be rewritten.
    for (const p of segBinsAfterFirst) mem.bins.delete(p); // tripwire
    store.setMtime("a.md", 2);
    await store.flush();
    expect([...mem.bins.keys()].some((p) => SEG_BIN_RE.test(p))).toBe(false);
    expect(
      (JSON.parse(mem.files.get(M) ?? "{}") as Record<string, number>)["a.md"],
    ).toBe(2);
  });

  test("setMtime with an unchanged value does not dirty the sidecar", async () => {
    const mem = makeMemAdapter();
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: A,
      indexPath: I,
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([rec("a.md#0", "a.md")]);
    store.setMtime("a.md", 5);
    await store.flush();
    mem.files.delete(M); // tripwire
    store.setMtime("a.md", 5);
    await store.flush();
    expect(mem.files.has(M)).toBe(false);
  });

  test("delete(path) clears the path's mtime", async () => {
    const mem = makeMemAdapter();
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: A,
      indexPath: I,
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([rec("a.md#0", "a.md")]);
    store.setMtime("a.md", 7);
    await store.delete("a.md");
    expect(store.mtimeFor("a.md")).toBeUndefined();
    await store.flush();
    expect(JSON.parse(mem.files.get(M) ?? "{}")).toEqual({});
  });

  test("corrupt mtimes sidecar is ignored, init succeeds", async () => {
    const mem = makeMemAdapter();
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: A,
      indexPath: I,
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([rec("a.md#0", "a.md")]);
    store.setMtime("a.md", 9);
    await store.flush();
    mem.files.set(M, "not json{");

    const reloaded = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: A,
      indexPath: I,
      vectorDim: DIM,
    });
    await reloaded.init();
    expect(reloaded.mtimeFor("a.md")).toBeUndefined();
    expect(reloaded.size()).toBe(1);
  });

  test("sentinel recovery discards mtimes along with the records", async () => {
    const mem = makeMemAdapter();
    const store = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: A,
      indexPath: I,
      vectorDim: DIM,
    });
    await store.init();
    await store.upsert([rec("a.md#0", "a.md")]);
    store.setMtime("a.md", 13);
    await store.flush();
    // Simulate a crash mid-flush: sentinel left behind.
    mem.files.set(`${I}.writing`, "1");

    const reloaded = createEmbeddingStore({
      adapter: mem.adapter,
      binPath: A,
      indexPath: I,
      vectorDim: DIM,
    });
    await reloaded.init();
    expect(reloaded.size()).toBe(0);
    // A sidecar claiming "current" over discarded records would make a
    // session-start rebuild skip everything.
    expect(reloaded.mtimeFor("a.md")).toBeUndefined();
  });
});

describe("embedding store — probe() and meta sidecar", () => {
  const A = "/p/embeddings.bin";
  const I = "/p/embeddings.index.json";
  const META = "/p/embeddings.meta.json";

  function rec2(chunkId: string, filePath: string): EmbeddingRecord {
    const vector = new Float32Array(DIM);
    vector[0] = 1;
    return {
      chunkId,
      filePath,
      offset: 0,
      heading: null,
      contentHash: `h:${chunkId}`,
      vector,
    };
  }

  function makeOn(adapter: VaultAdapter) {
    return createEmbeddingStore({
      adapter,
      binPath: A,
      indexPath: I,
      vectorDim: DIM,
    });
  }

  /** Adapter wrapper logging every write path in order + readBinary calls. */
  function spying(adapter: VaultAdapter): {
    adapter: VaultAdapter;
    writes: string[];
    binReads: () => number;
  } {
    const writes: string[] = [];
    let binReads = 0;
    return {
      writes,
      binReads: () => binReads,
      adapter: {
        ...adapter,
        write: async (p, d) => {
          writes.push(p);
          return adapter.write(p, d);
        },
        writeBinary: async (p, d) => {
          writes.push(p);
          return adapter.writeBinary(p, d);
        },
        readBinary: async (p) => {
          binReads++;
          return adapter.readBinary(p);
        },
      },
    };
  }

  test("flush writes the meta sidecar last, with version and recordCount", async () => {
    const mem = makeMemAdapter();
    const spy = spying(mem.adapter);
    const store = makeOn(spy.adapter);
    await store.init();
    await store.upsert([rec2("a.md#0", "a.md"), rec2("a.md#1", "a.md")]);
    store.setMtime("a.md", 1);
    await store.flush();

    expect(JSON.parse(mem.files.get(META) ?? "{}")).toEqual({
      version: FORMAT_VERSION,
      recordCount: 2,
    });
    // Meta is the commit marker: nothing may be written after it
    // except nothing (sentinel removal is a remove, not a write).
    expect(spy.writes[spy.writes.length - 1]).toBe(META);
  });

  test("probe() on a fresh store returns null without touching the bin", async () => {
    const mem = makeMemAdapter();
    const spy = spying(mem.adapter);
    const store = makeOn(spy.adapter);
    expect(await store.probe()).toBeNull();
    expect(spy.binReads()).toBe(0);
  });

  test("probe() reads the meta sidecar and never the bin", async () => {
    const mem = makeMemAdapter();
    const store = makeOn(mem.adapter);
    await store.init();
    await store.upsert([rec2("a.md#0", "a.md")]);
    await store.flush();

    const spy = spying(mem.adapter);
    const probing = makeOn(spy.adapter);
    expect(await probing.probe()).toEqual({
      version: FORMAT_VERSION,
      recordCount: 1,
    });
    expect(spy.binReads()).toBe(0);
  });

  test("probe() falls back to the index JSON when the meta sidecar is absent or corrupt", async () => {
    const mem = makeMemAdapter();
    const store = makeOn(mem.adapter);
    await store.init();
    await store.upsert([rec2("a.md#0", "a.md")]);
    await store.flush();

    // Pre-sidecar store: meta missing.
    mem.files.delete(META);
    const spy1 = spying(mem.adapter);
    expect(await makeOn(spy1.adapter).probe()).toEqual({
      version: FORMAT_VERSION,
      recordCount: 1,
    });
    expect(spy1.binReads()).toBe(0);

    // Corrupt meta: same fallback.
    mem.files.set(META, "{broken");
    expect(await makeOn(mem.adapter).probe()).toEqual({
      version: FORMAT_VERSION,
      recordCount: 1,
    });
  });

  test("probe() returns null while the dirty sentinel is present", async () => {
    const mem = makeMemAdapter();
    const store = makeOn(mem.adapter);
    await store.init();
    await store.upsert([rec2("a.md#0", "a.md")]);
    await store.flush();

    // Crash window: sentinel up. A probe trusting the healthy-looking
    // meta would mark ready a store that init() is about to discard.
    mem.files.set(`${I}.writing`, "1");
    expect(await makeOn(mem.adapter).probe()).toBeNull();
  });

  test("close() on a never-initialized store performs zero writes", async () => {
    const mem = makeMemAdapter();
    const spy = spying(mem.adapter);
    const store = makeOn(spy.adapter);
    await store.close();
    expect(spy.writes).toEqual([]);
  });
});
