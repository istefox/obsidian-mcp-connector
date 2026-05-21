import { describe, expect, test, beforeEach } from "bun:test";
import {
  cosineSimilarity,
  createNativeProvider,
  type ExcerptResolver,
} from "./nativeProvider";
import type { Embedder } from "./embedder";
import {
  createEmbeddingStore,
  type EmbeddingRecord,
  type VaultAdapter,
} from "./store";

const DIM = 4;

function vec(values: number[]): Float32Array {
  const a = new Float32Array(DIM);
  for (let i = 0; i < DIM && i < values.length; i++) a[i] = values[i] ?? 0;
  return a;
}

function makeFakeEmbedder(textToVec: Map<string, Float32Array>): Embedder {
  return {
    embed: async (text: string) => textToVec.get(text) ?? new Float32Array(DIM),
    embedBatch: async (texts: string[]) =>
      texts.map((t) => textToVec.get(t) ?? new Float32Array(DIM)),
    unload: async () => undefined,
    isLoaded: () => true,
  };
}

function makeMemAdapter(): VaultAdapter {
  const files = new Map<string, string>();
  const bins = new Map<string, ArrayBuffer>();
  return {
    async exists(p) {
      return files.has(p) || bins.has(p);
    },
    async read(p) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async write(p, d) {
      files.set(p, d);
    },
    async readBinary(p) {
      const v = bins.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v.slice(0);
    },
    async writeBinary(p, d) {
      bins.set(p, d.slice(0));
    },
    async remove(p) {
      files.delete(p);
      bins.delete(p);
    },
  };
}

function rec(
  opts: Partial<EmbeddingRecord> & { chunkId: string; vector: Float32Array },
): EmbeddingRecord {
  return {
    chunkId: opts.chunkId,
    filePath: opts.filePath ?? "Notes/a.md",
    offset: opts.offset ?? 0,
    heading: opts.heading ?? null,
    contentHash: opts.contentHash ?? "h",
    vector: opts.vector,
  };
}

async function makeStore(records: EmbeddingRecord[]) {
  const adapter = makeMemAdapter();
  const store = createEmbeddingStore({
    adapter,
    binPath: "/p/embeddings.bin",
    indexPath: "/p/embeddings.index.json",
    vectorDim: DIM,
  });
  await store.init();
  if (records.length > 0) await store.upsert(records);
  return store;
}

describe("native provider", () => {
  test("returns empty when store is empty", async () => {
    const store = await makeStore([]);
    const embedder = makeFakeEmbedder(new Map([["q", vec([1, 0, 0, 0])]]));
    const provider = createNativeProvider({ embedder, store });
    const out = await provider.search("q", {});
    expect(out).toEqual([]);
  });

  test("returns top-K by cosine score, descending", async () => {
    const store = await makeStore([
      rec({ chunkId: "near", vector: vec([1, 0, 0, 0]), heading: "Near" }),
      rec({
        chunkId: "mid",
        vector: vec([0.7, 0.7, 0, 0]),
        heading: "Mid",
        filePath: "Notes/m.md",
      }),
      rec({
        chunkId: "far",
        vector: vec([0, 1, 0, 0]),
        heading: "Far",
        filePath: "Notes/f.md",
      }),
    ]);
    const embedder = makeFakeEmbedder(new Map([["query", vec([1, 0, 0, 0])]]));
    const provider = createNativeProvider({ embedder, store });

    const out = await provider.search("query", { limit: 3 });
    expect(out.map((r) => r.heading)).toEqual(["Near", "Mid", "Far"]);
    // score is descending and within [-1, 1].
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    expect(out[1]!.score).toBeGreaterThan(out[2]!.score);
    expect(out[0]!.score).toBeCloseTo(1, 5);
    expect(out[2]!.score).toBeCloseTo(0, 5);
  });

  test("applies folder include filter", async () => {
    const store = await makeStore([
      rec({ chunkId: "a", vector: vec([1, 0, 0, 0]), filePath: "A/x.md" }),
      rec({ chunkId: "b", vector: vec([1, 0, 0, 0]), filePath: "B/y.md" }),
      rec({ chunkId: "c", vector: vec([1, 0, 0, 0]), filePath: "C/z.md" }),
    ]);
    const embedder = makeFakeEmbedder(new Map([["q", vec([1, 0, 0, 0])]]));
    const provider = createNativeProvider({ embedder, store });

    const out = await provider.search("q", { folders: ["A", "B"] });
    expect(out.map((r) => r.filePath)).toEqual(
      expect.arrayContaining(["A/x.md", "B/y.md"]),
    );
    expect(out).toHaveLength(2);
  });

  test("applies folder exclude filter", async () => {
    const store = await makeStore([
      rec({ chunkId: "a", vector: vec([1, 0, 0, 0]), filePath: "A/x.md" }),
      rec({ chunkId: "b", vector: vec([1, 0, 0, 0]), filePath: "B/y.md" }),
      rec({ chunkId: "c", vector: vec([1, 0, 0, 0]), filePath: "C/z.md" }),
    ]);
    const embedder = makeFakeEmbedder(new Map([["q", vec([1, 0, 0, 0])]]));
    const provider = createNativeProvider({ embedder, store });

    const out = await provider.search("q", { excludeFolders: ["B"] });
    expect(out.map((r) => r.filePath)).not.toContain("B/y.md");
    expect(out).toHaveLength(2);
  });

  test("folder filter does not match a prefix substring (NotesArchive vs Notes)", async () => {
    const store = await makeStore([
      rec({
        chunkId: "n",
        vector: vec([1, 0, 0, 0]),
        filePath: "Notes/x.md",
      }),
      rec({
        chunkId: "na",
        vector: vec([1, 0, 0, 0]),
        filePath: "NotesArchive/y.md",
      }),
    ]);
    const embedder = makeFakeEmbedder(new Map([["q", vec([1, 0, 0, 0])]]));
    const provider = createNativeProvider({ embedder, store });

    const out = await provider.search("q", { folders: ["Notes"] });
    expect(out.map((r) => r.filePath)).toEqual(["Notes/x.md"]);
  });

  test("applies result limit", async () => {
    const store = await makeStore([
      rec({ chunkId: "1", vector: vec([1, 0, 0, 0]), filePath: "1.md" }),
      rec({ chunkId: "2", vector: vec([0.9, 0.1, 0, 0]), filePath: "2.md" }),
      rec({ chunkId: "3", vector: vec([0.8, 0.2, 0, 0]), filePath: "3.md" }),
      rec({ chunkId: "4", vector: vec([0.7, 0.3, 0, 0]), filePath: "4.md" }),
    ]);
    const embedder = makeFakeEmbedder(new Map([["q", vec([1, 0, 0, 0])]]));
    const provider = createNativeProvider({ embedder, store });

    const out = await provider.search("q", { limit: 2 });
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.filePath)).toEqual(["1.md", "2.md"]);
  });

  test("excerpt is bounded to 200 chars", async () => {
    const longBody = "x".repeat(1000);
    const store = await makeStore([
      rec({
        chunkId: "a",
        vector: vec([1, 0, 0, 0]),
        heading: "H",
        filePath: "a.md",
        offset: 5,
      }),
    ]);
    const embedder = makeFakeEmbedder(new Map([["q", vec([1, 0, 0, 0])]]));
    const resolver: ExcerptResolver = async (_p, _o, max) =>
      longBody.slice(0, max);

    const provider = createNativeProvider({
      embedder,
      store,
      excerptResolver: resolver,
    });

    const out = await provider.search("q", {});
    expect(out).toHaveLength(1);
    expect(out[0]!.excerpt.length).toBeLessThanOrEqual(200);
    expect(out[0]!.excerpt.startsWith("H: ")).toBe(true);
  });

  test("excerpt without resolver falls back to heading + sentinel or sentinel only", async () => {
    const store = await makeStore([
      rec({
        chunkId: "with-h",
        vector: vec([1, 0, 0, 0]),
        heading: "Heading",
        filePath: "h.md",
      }),
      rec({
        chunkId: "no-h",
        vector: vec([0.99, 0.01, 0, 0]),
        heading: null,
        filePath: "n.md",
      }),
    ]);
    const embedder = makeFakeEmbedder(new Map([["q", vec([1, 0, 0, 0])]]));
    const provider = createNativeProvider({ embedder, store });

    const out = await provider.search("q", { limit: 2 });
    const byPath = Object.fromEntries(out.map((r) => [r.filePath, r]));
    expect(byPath["h.md"]?.excerpt.startsWith("Heading: ")).toBe(true);
    expect(byPath["n.md"]?.excerpt).toBe("(no preview)");
  });

  test("score is in [-1, 1] including the orthogonal and antipodal cases", () => {
    const a = vec([1, 0, 0, 0]);
    const b = vec([0, 1, 0, 0]);
    const c = vec([-1, 0, 0, 0]);
    const z = vec([0, 0, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
    expect(cosineSimilarity(a, c)).toBeCloseTo(-1, 6);
    expect(cosineSimilarity(a, z)).toBe(0);
  });

  test("excerpt resolver failure degrades gracefully", async () => {
    const store = await makeStore([
      rec({
        chunkId: "a",
        vector: vec([1, 0, 0, 0]),
        heading: "H",
        filePath: "a.md",
      }),
    ]);
    const embedder = makeFakeEmbedder(new Map([["q", vec([1, 0, 0, 0])]]));
    const resolver: ExcerptResolver = async () => {
      throw new Error("vault read failed");
    };

    const provider = createNativeProvider({
      embedder,
      store,
      excerptResolver: resolver,
    });

    const out = await provider.search("q", {});
    expect(out).toHaveLength(1);
    // Falls back to heading-only excerpt (with empty body) — does
    // not throw.
    expect(out[0]!.excerpt.startsWith("H: ")).toBe(true);
  });
});
