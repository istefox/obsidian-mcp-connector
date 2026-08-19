import { describe, expect, test } from "bun:test";
import {
  isIndexableFile,
  probeAndWipeStaleStores,
  purgeExcludedFromStores,
} from "./productionWiring";
import { createEmbeddingStoreRegistry } from "./storeRegistry";
import {
  FORMAT_VERSION,
  type EmbeddingRecord,
  type VaultAdapter,
} from "./store";
import { compilePolicy, EMPTY_POLICY } from "$/shared/pathPolicy";
import { TFile } from "obsidian";

/** In-memory adapter tracking text + binary files and remove() calls. */
function memAdapter() {
  const files = new Map<string, string>();
  const bins = new Map<string, ArrayBuffer>();
  const removed: string[] = [];
  const adapter: VaultAdapter = {
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
      removed.push(p);
      if (!files.delete(p) && !bins.delete(p)) {
        throw new Error(`ENOENT ${p}`);
      }
    },
    async mkdir() {},
  };
  return { adapter, files, bins, removed: () => removed };
}

const BASE = "/p/embeddings";

/** Write a store's index + meta sidecar at a given format version. */
function seedStore(
  mem: ReturnType<typeof memAdapter>,
  key: string,
  version: number,
  recordCount: number,
) {
  const dir = `${BASE}/${key}`;
  mem.files.set(
    `${dir}/embeddings.index.json`,
    JSON.stringify({ version, records: new Array(recordCount).fill({}) }),
  );
  mem.files.set(
    `${dir}/embeddings.meta.json`,
    JSON.stringify({ version, recordCount }),
  );
  mem.bins.set(`${dir}/embeddings.bin`, new ArrayBuffer(8));
  mem.files.set(`${dir}/mtimes.json`, "{}");
}

describe("probeAndWipeStaleStores", () => {
  test("empty base dir: no stale keys, no counts, no removals", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual([]);
    expect(probedCounts).toEqual({});
    expect(mem.removed()).toEqual([]);
  });

  test("current non-empty store is marked ready with its count, not wiped", async () => {
    const mem = memAdapter();
    seedStore(mem, "native-minilm-l6-v2", FORMAT_VERSION, 42);
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual([]);
    expect(probedCounts["native-minilm-l6-v2"]).toBe(42);
    expect(registry.isReady("native-minilm-l6-v2")).toBe(true);
    expect(mem.removed()).toEqual([]);
    // Files survive.
    expect(
      await mem.adapter.exists(`${BASE}/native-minilm-l6-v2/embeddings.bin`),
    ).toBe(true);
  });

  test("stale store: reported stale AND all its files wiped (legacy pair + segments)", async () => {
    const mem = memAdapter();
    const key = "native-minilm-l6-v2";
    seedStore(mem, key, FORMAT_VERSION - 1, 10);
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual([key]);
    expect(probedCounts).toEqual({});
    expect(registry.isReady(key)).toBe(false);
    // Every candidate file is attempted best-effort: the legacy pair,
    // the sidecars, and each segment pair (a stale store may be in
    // either layout, or mid-migration in both).
    const dir = `${BASE}/${key}`;
    const expectedTargets = [
      `${dir}/embeddings.bin`,
      `${dir}/embeddings.index.json`,
      `${dir}/embeddings.index.json.writing`,
      `${dir}/mtimes.json`,
      `${dir}/embeddings.meta.json`,
    ];
    for (let seg = 0; seg < 16; seg++) {
      expectedTargets.push(
        `${dir}/embeddings.seg${seg}.bin`,
        `${dir}/embeddings.seg${seg}.index.json`,
      );
    }
    expect(mem.removed()).toEqual(expectedTargets);
    expect(await mem.adapter.exists(`${dir}/embeddings.bin`)).toBe(false);
    expect(await mem.adapter.exists(`${dir}/embeddings.index.json`)).toBe(
      false,
    );
  });

  test("a current store and a stale store: only the stale one is wiped", async () => {
    const mem = memAdapter();
    seedStore(mem, "native-minilm-l6-v2", FORMAT_VERSION, 5);
    seedStore(mem, "embedding-gemma-300m", FORMAT_VERSION - 1, 9);
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual(["embedding-gemma-300m"]);
    expect(probedCounts).toEqual({ "native-minilm-l6-v2": 5 });
    expect(
      await mem.adapter.exists(`${BASE}/native-minilm-l6-v2/embeddings.bin`),
    ).toBe(true);
    expect(
      await mem.adapter.exists(`${BASE}/embedding-gemma-300m/embeddings.bin`),
    ).toBe(false);
  });
});

describe("isIndexableFile", () => {
  // Builds an object that passes `instanceof TFile` (the obsidian mock
  // wires up the prototype) with an explicit `extension`, without
  // depending on MockTFile.
  function fakeTFile(path: string, extension: string): TFile {
    const f = Object.create(TFile.prototype) as TFile;
    Object.assign(f, { path, extension });
    return f;
  }

  test("accepts a .md TFile", () => {
    expect(isIndexableFile(fakeTFile("Notes/a.md", "md"))).toBe(true);
  });

  test("rejects a .pdf TFile", () => {
    expect(isIndexableFile(fakeTFile("Attachments/doc.pdf", "pdf"))).toBe(
      false,
    );
  });

  test("rejects a .canvas TFile", () => {
    expect(isIndexableFile(fakeTFile("map.canvas", "canvas"))).toBe(false);
  });

  test("rejects something that is not a TFile", () => {
    expect(isIndexableFile({ path: "x.md", extension: "md" })).toBe(false);
    expect(isIndexableFile(null)).toBe(false);
  });
});

describe("purgeExcludedFromStores", () => {
  const DIMS = {
    "native-minilm-l6-v2": 384,
    "embedding-gemma-300m": 768,
    "multilingual-e5-base": 768,
  } as const;

  function rec(filePath: string, dim: number): EmbeddingRecord {
    return {
      chunkId: `${filePath}#0`,
      filePath,
      offset: 0,
      heading: "Session notes",
      contentHash: "deadbeefdeadbeef",
      vector: new Float32Array(dim),
    };
  }

  /** Seed a real store for `key` with one record per path, flushed. */
  async function seed(
    registry: ReturnType<typeof createEmbeddingStoreRegistry>,
    key: keyof typeof DIMS,
    paths: string[],
  ) {
    const store = registry.storeFor(key, DIMS[key]);
    await store.init();
    await store.upsert(paths.map((p) => rec(p, DIMS[key])));
    await store.flush();
    return store;
  }

  test("purges every provider store, not only the active one", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const native = await seed(registry, "native-minilm-l6-v2", [
      "Journal/a.md",
      "Notes/b.md",
    ]);
    const gemma = await seed(registry, "embedding-gemma-300m", [
      "Journal/c.md",
    ]);

    // A store the user switched away from still holds paths and
    // headings. "Hidden unless you switch back to last month's
    // provider" is not a policy (ADR-0020 D15).
    const removed = await purgeExcludedFromStores(
      registry,
      compilePolicy(["Journal"]),
    );

    expect(removed).toBe(2);
    expect(native.hasRecords("Journal/a.md")).toBe(false);
    expect(native.hasRecords("Notes/b.md")).toBe(true);
    expect(gemma.hasRecords("Journal/c.md")).toBe(false);
  });

  test("an empty policy purges nothing", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const native = await seed(registry, "native-minilm-l6-v2", [
      "Journal/a.md",
    ]);

    expect(await purgeExcludedFromStores(registry, EMPTY_POLICY)).toBe(0);
    expect(native.hasRecords("Journal/a.md")).toBe(true);
  });

  test("never initializes a store this vault has never used", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);

    expect(
      await purgeExcludedFromStores(registry, compilePolicy(["Journal"])),
    ).toBe(0);
    // A store that inits writes a dirty sentinel and a segment pair on
    // its first flush. Nothing on disk means nothing was loaded — the
    // point of probing before touching a provider's bin.
    expect(mem.files.size).toBe(0);
    expect(mem.bins.size).toBe(0);
  });
});
