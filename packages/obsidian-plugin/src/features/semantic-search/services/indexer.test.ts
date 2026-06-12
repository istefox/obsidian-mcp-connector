import { describe, expect, test, beforeEach } from "bun:test";
import {
  createLiveIndexer,
  createLowPowerIndexer,
  type VaultEvent,
  type VaultLike,
} from "./indexer";
import type { EmbeddingProvider } from "../types";
import {
  createEmbeddingStore,
  type EmbeddingRecord,
  type VaultAdapter,
} from "./store";
import type { Chunk } from "./chunker";

const DIM = 4;

/** In-memory vault with synchronous event dispatch. */
function makeVault(initial: Record<string, string> = {}): {
  vault: VaultLike;
  files: Map<string, string>;
  emit(event: VaultEvent, path: string): void;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const handlers: Record<VaultEvent, Set<(p: string) => void>> = {
    modify: new Set(),
    create: new Set(),
    delete: new Set(),
  };
  const vault: VaultLike = {
    getMarkdownFiles: () => Array.from(files.keys()).map((path) => ({ path })),
    read: async (path) => {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v;
    },
    on: (event, handler) => {
      handlers[event].add(handler);
      return () => {
        handlers[event].delete(handler);
      };
    },
  };
  function emit(event: VaultEvent, path: string) {
    for (const h of handlers[event]) h(path);
  }
  return { vault, files, emit };
}

function memAdapter(): VaultAdapter {
  const f = new Map<string, string>();
  const b = new Map<string, ArrayBuffer>();
  return {
    async exists(p) {
      return f.has(p) || b.has(p);
    },
    async read(p) {
      const v = f.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async write(p, d) {
      f.set(p, d);
    },
    async readBinary(p) {
      const v = b.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v.slice(0);
    },
    async writeBinary(p, d) {
      b.set(p, d.slice(0));
    },
    async remove(p) {
      f.delete(p);
      b.delete(p);
    },
    async mkdir() {},
  };
}

async function makeStore() {
  const store = createEmbeddingStore({
    adapter: memAdapter(),
    binPath: "/p/embeddings.bin",
    indexPath: "/p/embeddings.index.json",
    vectorDim: DIM,
  });
  await store.init();
  return store;
}

/**
 * Simple chunker: splits content on `---CHUNK---` markers.
 * Each chunk's contentHash is its position-stripped text so that
 * tests can reason about chunk-delta reuse without depending on
 * the real SHA-256 helper.
 */
async function fakeChunker(content: string): Promise<Chunk[]> {
  if (content.length === 0) return [];
  const parts = content
    .split("---CHUNK---")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((text, i) => ({
    id: String(i),
    text,
    heading: null,
    offset: i * 10,
    contentHash: `h:${text}`,
  }));
}

function fakeEmbeddingProvider(): {
  embedder: EmbeddingProvider;
  embeds: () => string[];
  /** One entry per embed() invocation, preserving the batch shape. */
  embedCalls: () => string[][];
} {
  const calls: string[] = [];
  const shapes: string[][] = [];
  const embedder: EmbeddingProvider = {
    providerKey: "test-provider",
    dimensions: DIM,
    maxInputTokens: 512,
    getMaxInputTokens: async () => 512,
    embed: async (texts, _role) => {
      shapes.push([...texts]);
      for (const text of texts) calls.push(text);
      return texts.map((text) => {
        const v = new Float32Array(DIM);
        v[0] = text.length;
        return v;
      });
    },
    isAvailable: async () => true,
    getModelSizeBytes: () => 0,
  };
  return {
    embedder,
    embeds: () => [...calls],
    embedCalls: () => shapes.map((s) => [...s]),
  };
}

async function collect(
  store: Awaited<ReturnType<typeof makeStore>>,
): Promise<EmbeddingRecord[]> {
  const out: EmbeddingRecord[] = [];
  for await (const r of store.scan()) out.push(r);
  return out;
}

describe("live indexer", () => {
  let store: Awaited<ReturnType<typeof makeStore>>;

  beforeEach(async () => {
    store = await makeStore();
  });

  test("full build on start: indexes all markdown files", async () => {
    const { vault } = makeVault({
      "a.md": "alpha",
      "b.md": "bravo---CHUNK---bravo two",
    });
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();
    await indexer.stop();

    expect(store.size()).toBe(3); // 1 + 2
    expect(embeds()).toEqual(
      expect.arrayContaining(["alpha", "bravo", "bravo\nbravo two"]),
    );
    const recs = await collect(store);
    expect(new Set(recs.map((r) => r.filePath))).toEqual(
      new Set(["a.md", "b.md"]),
    );
  });

  test("modify event re-embeds only changed chunks (chunk-delta)", async () => {
    const { vault, files, emit } = makeVault({
      "f.md": "one---CHUNK---two---CHUNK---three",
    });
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();

    expect(embeds()).toEqual(["one", "one\ntwo", "two\nthree"]);

    // Edit: replace chunk 2 only.
    files.set("f.md", "one---CHUNK---TWO!---CHUNK---three");
    emit("modify", "f.md");
    await indexer.flush();

    // Only "TWO!" is new — "one" and "three" reuse their existing
    // vectors via contentHash match. Overlap prepends the last sentence
    // of the previous chunk's original text.
    expect(embeds()).toEqual(["one", "one\ntwo", "two\nthree", "one\nTWO!"]);
    expect(store.size()).toBe(3);

    await indexer.stop();
  });

  test("create event embeds new chunks", async () => {
    const { vault, files, emit } = makeVault({});
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();

    expect(store.size()).toBe(0);

    files.set("new.md", "fresh content");
    emit("create", "new.md");
    await indexer.flush();

    expect(embeds()).toEqual(["fresh content"]);
    expect(store.size()).toBe(1);

    await indexer.stop();
  });

  test("delete event removes all chunks for the path", async () => {
    const { vault, files, emit } = makeVault({
      "doomed.md": "a---CHUNK---b---CHUNK---c",
      "kept.md": "x",
    });
    const { embedder } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();

    expect(store.size()).toBe(4);

    files.delete("doomed.md");
    emit("delete", "doomed.md");
    await indexer.flush();

    expect(store.size()).toBe(1);
    const recs = await collect(store);
    expect(recs[0]?.filePath).toBe("kept.md");

    await indexer.stop();
  });

  test("debounce: rapid edits within debounceMs collapse to one process", async () => {
    const { vault, files, emit } = makeVault({
      "f.md": "v1",
    });
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 50,
    });
    await indexer.start();

    files.set("f.md", "v2");
    emit("modify", "f.md");
    files.set("f.md", "v3");
    emit("modify", "f.md");
    files.set("f.md", "v4");
    emit("modify", "f.md");

    // Only one path has a pending timer (the same one keeps getting
    // rescheduled).
    expect(indexer.pending()).toBe(1);

    await indexer.flush();
    // Final state reflects v4. Initial build embedded "v1"; after
    // flush there is exactly one further embed for the new content.
    // Total embeds since start: ["v1", "v4"] — three rapid edits
    // collapsed into one re-process.
    expect(embeds()).toEqual(["v1", "v4"]);
    expect(store.size()).toBe(1);

    await indexer.stop();
  });

  test("stop unsubscribes from vault events (no further processing)", async () => {
    const { vault, files, emit } = makeVault({});
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();
    await indexer.stop();

    files.set("post-stop.md", "should not embed");
    emit("create", "post-stop.md");
    // Wait long enough that any pending timer would have fired.
    await new Promise((r) => setTimeout(r, 80));

    expect(embeds()).toEqual([]); // nothing embedded after stop
    expect(store.size()).toBe(0);
  });

  test("rebuildAll re-processes the entire vault", async () => {
    const { vault, files } = makeVault({
      "a.md": "one",
      "b.md": "two",
    });
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();
    expect(embeds()).toEqual(["one", "two"]);

    // Mutate vault directly without firing events; rebuildAll should
    // pick the new state up.
    files.set("a.md", "ONE!");
    files.set("c.md", "three");
    await indexer.rebuildAll();

    expect(embeds()).toEqual(["one", "two", "ONE!", "three"]);
    expect(store.size()).toBe(3);

    await indexer.stop();
  });

  test("chunker yielding zero chunks deletes any prior records for the path", async () => {
    const { vault, files, emit } = makeVault({
      "f.md": "content",
    });
    const { embedder } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();
    expect(store.size()).toBe(1);

    files.set("f.md", ""); // empty → fakeChunker returns []
    emit("modify", "f.md");
    await indexer.flush();
    expect(store.size()).toBe(0);

    await indexer.stop();
  });

  test("transient read error while path is still listed: records preserved (not a deletion)", async () => {
    const { vault, files, emit } = makeVault({
      "f.md": "one---CHUNK---two",
    });
    const { embedder } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();
    expect(store.size()).toBe(2);

    // Make read() throw while getMarkdownFiles() STILL lists the path
    // (file-lock / transient I/O — not a deletion).
    const realRead = vault.read.bind(vault);
    vault.read = async (p: string) => {
      if (p === "f.md") throw new Error("EBUSY simulated file lock");
      return realRead(p);
    };
    emit("modify", "f.md");
    await indexer.flush();

    // Vectors must survive: a transient error must not be treated as
    // a deletion.
    expect(store.size()).toBe(2);

    // Recover: read works again, no records were lost.
    vault.read = realRead;
    emit("modify", "f.md");
    await indexer.flush();
    expect(store.size()).toBe(2);

    await indexer.stop();
  });

  test("rebuildAll skips processing when isAvailable returns false", async () => {
    const { vault } = makeVault({ "a.md": "content" });
    const embeds: string[] = [];
    const unavailableProvider: EmbeddingProvider = {
      providerKey: "unavailable",
      dimensions: DIM,
      maxInputTokens: 512,
      getMaxInputTokens: async () => 512,
      embed: async (texts, _role) => {
        for (const t of texts) embeds.push(t);
        return texts.map(() => new Float32Array(DIM));
      },
      isAvailable: async () => false,
      getModelSizeBytes: () => 0,
    };
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder: unavailableProvider,
      store,
      debounceMs: 30,
    });
    await indexer.start();
    await indexer.stop();

    expect(embeds).toEqual([]);
    expect(store.size()).toBe(0);
  });

  test("overlap context is prepended to consecutive chunk embed inputs", async () => {
    const { vault } = makeVault({
      "f.md": "first---CHUNK---second---CHUNK---third",
    });
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();
    await indexer.stop();

    // No punctuation → extractLastSentence returns the full previous text.
    // chunk[1] gets "first\nsecond"; chunk[2] gets "second\nthird".
    expect(embeds()).toEqual(["first", "first\nsecond", "second\nthird"]);
  });

  test("read error while path is absent from getMarkdownFiles: genuine deletion", async () => {
    const { vault, files, emit } = makeVault({
      "f.md": "one---CHUNK---two",
    });
    const { embedder } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();
    expect(store.size()).toBe(2);

    // The file is gone: removed from the map so getMarkdownFiles()
    // no longer lists it and read() throws ENOENT.
    files.delete("f.md");
    emit("delete", "f.md");
    await indexer.flush();

    expect(store.size()).toBe(0);

    await indexer.stop();
  });
});

/**
 * Wrap an `EmbeddingStore` so its `flush()` call count can be observed by
 * tests. The wrapper proxies every method to the wrapped store; only
 * `flush` is instrumented.
 */
function wrapStoreWithFlushSpy(store: Awaited<ReturnType<typeof makeStore>>): {
  store: typeof store;
  flushCalls: () => number;
} {
  let calls = 0;
  // Class methods on `store` are not enumerable own properties, so a
  // spread would lose them. Delegate explicitly.
  const wrapped: typeof store = {
    init: () => store.init(),
    size: () => store.size(),
    scan: () => store.scan(),
    recordsFor: (path) => store.recordsFor(path),
    upsert: (records) => store.upsert(records),
    delete: (path) => store.delete(path),
    close: () => store.close(),
    flush: async () => {
      calls++;
      await store.flush();
    },
  };
  return { store: wrapped, flushCalls: () => calls };
}

describe("live indexer — flush debounce", () => {
  let rawStore: Awaited<ReturnType<typeof makeStore>>;

  beforeEach(async () => {
    rawStore = await makeStore();
  });

  test("create event flushes store after flushDebounceMs of idle", async () => {
    const { vault, files, emit } = makeVault({});
    const { embedder } = fakeEmbeddingProvider();
    const { store, flushCalls } = wrapStoreWithFlushSpy(rawStore);

    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 10,
      flushDebounceMs: 20,
    });
    await indexer.start();
    expect(flushCalls()).toBe(0);

    files.set("new.md", "fresh content");
    emit("create", "new.md");

    // Wait for processFile debounce + flush debounce + slack.
    await new Promise((r) => setTimeout(r, 80));
    expect(flushCalls()).toBeGreaterThanOrEqual(1);

    await indexer.stop();
  });

  test("modify event flushes store after flushDebounceMs", async () => {
    const { vault, files, emit } = makeVault({ "a.md": "v1" });
    const { embedder } = fakeEmbeddingProvider();
    const { store, flushCalls } = wrapStoreWithFlushSpy(rawStore);

    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 10,
      flushDebounceMs: 20,
    });
    await indexer.start();
    const startCalls = flushCalls();

    files.set("a.md", "v2");
    emit("modify", "a.md");
    await new Promise((r) => setTimeout(r, 80));

    expect(flushCalls()).toBeGreaterThan(startCalls);

    await indexer.stop();
  });

  test("delete event flushes store after flushDebounceMs", async () => {
    const { vault, files, emit } = makeVault({ "a.md": "v1" });
    const { embedder } = fakeEmbeddingProvider();
    const { store, flushCalls } = wrapStoreWithFlushSpy(rawStore);

    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 10,
      flushDebounceMs: 20,
    });
    await indexer.start();
    const startCalls = flushCalls();

    files.delete("a.md");
    emit("delete", "a.md");
    await new Promise((r) => setTimeout(r, 80));

    expect(flushCalls()).toBeGreaterThan(startCalls);

    await indexer.stop();
  });

  test("rapid burst of edits coalesces to a single debounced flush", async () => {
    const { vault, files, emit } = makeVault({ "a.md": "v1" });
    const { embedder } = fakeEmbeddingProvider();
    const { store, flushCalls } = wrapStoreWithFlushSpy(rawStore);

    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 10,
      flushDebounceMs: 50,
    });
    await indexer.start();
    const startCalls = flushCalls();

    // Three edits, each within the flush debounce window.
    files.set("a.md", "v2");
    emit("modify", "a.md");
    await new Promise((r) => setTimeout(r, 20));
    files.set("a.md", "v3");
    emit("modify", "a.md");
    await new Promise((r) => setTimeout(r, 20));
    files.set("a.md", "v4");
    emit("modify", "a.md");

    // Wait for the final debounce cycle to settle.
    await new Promise((r) => setTimeout(r, 120));

    // Exactly one flush for the whole burst.
    expect(flushCalls() - startCalls).toBe(1);

    await indexer.stop();
  });

  test("stop() forces pending debounced flush to run", async () => {
    const { vault, files, emit } = makeVault({});
    const { embedder } = fakeEmbeddingProvider();
    const { store, flushCalls } = wrapStoreWithFlushSpy(rawStore);

    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 5,
      // Long enough that the timer would not fire before stop() does.
      flushDebounceMs: 10_000,
    });
    await indexer.start();
    const startCalls = flushCalls();

    files.set("new.md", "fresh");
    emit("create", "new.md");
    // Wait only long enough for processFile to complete and schedule the
    // flush timer — not long enough for the 10-second timer to fire.
    await new Promise((r) => setTimeout(r, 40));

    await indexer.stop();

    // stop() must have drained the pending flush.
    expect(flushCalls() - startCalls).toBe(1);
  });

  test("public flush() drains pending debounced flush", async () => {
    const { vault, files, emit } = makeVault({});
    const { embedder } = fakeEmbeddingProvider();
    const { store, flushCalls } = wrapStoreWithFlushSpy(rawStore);

    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 5,
      flushDebounceMs: 10_000,
    });
    await indexer.start();
    const startCalls = flushCalls();

    files.set("new.md", "fresh");
    emit("create", "new.md");

    // flush() drains both the pending processFile timer AND the pending
    // flush timer, so the caller observes "fully persisted" synchronously.
    await indexer.flush();

    expect(flushCalls() - startCalls).toBeGreaterThanOrEqual(1);

    await indexer.stop();
  });
});

describe("live indexer — start({ initialRebuild: false })", () => {
  let rawStore: Awaited<ReturnType<typeof makeStore>>;

  beforeEach(async () => {
    rawStore = await makeStore();
  });

  test("subscribes without running rebuildAll", async () => {
    const { vault } = makeVault({
      "a.md": "alpha",
      "b.md": "bravo",
    });
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store: rawStore,
      debounceMs: 10,
      flushDebounceMs: 10,
    });

    await indexer.start({ initialRebuild: false });

    // No embeds because rebuildAll was skipped.
    expect(embeds()).toEqual([]);
    expect(rawStore.size()).toBe(0);

    await indexer.stop();
  });

  test("subscribes so a subsequent vault create event triggers processFile + flush", async () => {
    const { vault, files, emit } = makeVault({});
    const { embedder, embeds } = fakeEmbeddingProvider();
    const { store, flushCalls } = wrapStoreWithFlushSpy(rawStore);

    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 10,
      flushDebounceMs: 20,
    });
    await indexer.start({ initialRebuild: false });
    expect(embeds()).toEqual([]);

    // The whole point of an auto-subscribed DLC indexer: future events
    // flow into the store + persist to disk without an explicit rebuild.
    files.set("new.md", "fresh content");
    emit("create", "new.md");
    await new Promise((r) => setTimeout(r, 80));

    expect(embeds()).toContain("fresh content");
    expect(store.size()).toBeGreaterThan(0);
    expect(flushCalls()).toBeGreaterThanOrEqual(1);

    await indexer.stop();
  });

  test("explicit rebuildAll() after subscribe-only start still indexes the vault", async () => {
    const { vault } = makeVault({ "a.md": "alpha" });
    const { embedder, embeds } = fakeEmbeddingProvider();

    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store: rawStore,
      debounceMs: 5,
      flushDebounceMs: 5,
    });
    await indexer.start({ initialRebuild: false });
    expect(embeds()).toEqual([]);

    await indexer.rebuildAll();
    expect(embeds()).toContain("alpha");

    await indexer.stop();
  });
});

/** mtime-aware in-memory vault for the low-power tests. */
function makeMtimeVault(
  initial: Record<string, { content: string; mtime: number }>,
): {
  vault: VaultLike;
  files: Map<string, { content: string; mtime: number }>;
} {
  const files = new Map(Object.entries(initial));
  const vault: VaultLike = {
    getMarkdownFiles: () =>
      Array.from(files.entries()).map(([path, { mtime }]) => ({ path, mtime })),
    read: async (path) => {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v.content;
    },
    on: () => () => undefined, // low-power doesn't subscribe
  };
  return { vault, files };
}

/** Adapter that counts writeBinary calls so we can assert batching. */
function countingAdapter(): {
  adapter: VaultAdapter;
  writeBinaryCount: () => number;
} {
  const f = new Map<string, string>();
  const b = new Map<string, ArrayBuffer>();
  let writeBinary = 0;
  const adapter: VaultAdapter = {
    async exists(p) {
      return f.has(p) || b.has(p);
    },
    async read(p) {
      const v = f.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async write(p, d) {
      f.set(p, d);
    },
    async readBinary(p) {
      const v = b.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v.slice(0);
    },
    async writeBinary(p, d) {
      writeBinary += 1;
      b.set(p, d.slice(0));
    },
    async remove(p) {
      f.delete(p);
      b.delete(p);
    },
    async mkdir() {},
  };
  return { adapter, writeBinaryCount: () => writeBinary };
}

describe("low-power indexer", () => {
  test("first start processes every file (lastSeenMtime is empty)", async () => {
    const localStore = await makeStore();
    const { vault } = makeMtimeVault({
      "a.md": { content: "alpha", mtime: 100 },
      "b.md": { content: "bravo", mtime: 200 },
    });
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLowPowerIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store: localStore,
      intervalMs: 10_000,
    });
    await indexer.start();
    expect(embeds()).toEqual(expect.arrayContaining(["alpha", "bravo"]));
    expect(localStore.size()).toBe(2);
    await indexer.stop();
  });

  test("second cycle skips files whose mtime did not advance", async () => {
    const localStore = await makeStore();
    const { vault, files } = makeMtimeVault({
      "a.md": { content: "alpha", mtime: 100 },
    });
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLowPowerIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store: localStore,
      intervalMs: 10_000,
    });
    await indexer.start();
    expect(embeds()).toEqual(["alpha"]);

    // Same mtime → next cycle is a no-op for this file.
    await indexer.flush();
    expect(embeds()).toEqual(["alpha"]); // no new embeds

    // Bump mtime + change content → cycle picks it up.
    files.set("a.md", { content: "alpha v2", mtime: 200 });
    await indexer.flush();
    expect(embeds()).toEqual(["alpha", "alpha v2"]);

    await indexer.stop();
  });

  test("disappeared files are dropped from the index on the next cycle", async () => {
    const localStore = await makeStore();
    const { vault, files } = makeMtimeVault({
      "doomed.md": { content: "go away", mtime: 100 },
      "kept.md": { content: "stays", mtime: 100 },
    });
    const { embedder } = fakeEmbeddingProvider();
    const indexer = createLowPowerIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store: localStore,
      intervalMs: 10_000,
    });
    await indexer.start();
    expect(localStore.size()).toBe(2);

    files.delete("doomed.md");
    await indexer.flush();
    expect(localStore.size()).toBe(1);
    const recs: EmbeddingRecord[] = [];
    for await (const r of localStore.scan()) recs.push(r);
    expect(recs[0]?.filePath).toBe("kept.md");

    await indexer.stop();
  });

  test("batched flush: one writeBinary per cycle, not one per file", async () => {
    const { adapter, writeBinaryCount } = countingAdapter();
    const localStore = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: DIM,
    });
    await localStore.init();

    const { vault } = makeMtimeVault({
      "a.md": { content: "alpha", mtime: 100 },
      "b.md": { content: "bravo", mtime: 100 },
      "c.md": { content: "charlie", mtime: 100 },
    });
    const { embedder } = fakeEmbeddingProvider();
    const indexer = createLowPowerIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store: localStore,
      intervalMs: 10_000,
    });

    expect(writeBinaryCount()).toBe(0);
    await indexer.start(); // runs the first cycle
    expect(writeBinaryCount()).toBe(1); // one batched flush, not three

    await indexer.stop();
  });

  test("rebuildAll forces a full re-process even if mtimes haven't changed", async () => {
    const localStore = await makeStore();
    const { vault } = makeMtimeVault({
      "a.md": { content: "alpha", mtime: 100 },
    });
    const { embedder, embeds } = fakeEmbeddingProvider();
    const indexer = createLowPowerIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store: localStore,
      intervalMs: 10_000,
    });
    await indexer.start();
    expect(embeds()).toEqual(["alpha"]);

    await indexer.rebuildAll();
    // Content unchanged → contentHash matches → reused vector,
    // no new embed call. The processOnePath helper still runs but
    // chunk-delta keeps embed work to zero.
    expect(embeds()).toEqual(["alpha"]);

    await indexer.stop();
  });

  test("stop clears the interval and waits for in-flight cycle", async () => {
    const localStore = await makeStore();
    const { vault } = makeMtimeVault({
      "a.md": { content: "alpha", mtime: 100 },
    });
    const { embedder } = fakeEmbeddingProvider();
    const indexer = createLowPowerIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store: localStore,
      intervalMs: 10,
    });
    await indexer.start();
    await indexer.stop();
    // Wait long enough that another tick would have fired had stop()
    // not cleared the interval.
    const sizeAfterStop = localStore.size();
    await new Promise((r) => setTimeout(r, 40));
    expect(localStore.size()).toBe(sizeAfterStop);
  });
});

// RFC #238 — honour `Files & Links → Excluded files` in the indexer.
// The exclusion predicate (built from `MetadataCache.isUserIgnored` in
// production) must apply in BOTH the full rebuild path AND the live
// event listener, otherwise a newly edited file in an excluded folder
// re-enters the index on the next vault event.
describe("indexer — isUserIgnored exclusion (#238)", () => {
  function pathsOf(recs: EmbeddingRecord[]): Set<string> {
    return new Set(recs.map((r) => r.filePath));
  }

  test("rebuild path: excluded files are not indexed", async () => {
    const store = await makeStore();
    const { vault } = makeVault({
      "keep.md": "alpha",
      "secret/a.md": "bravo",
      "secret/b.md": "charlie",
    });
    const { embedder } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      isExcluded: (p) => p.startsWith("secret/"),
      debounceMs: 30,
    });
    await indexer.start();
    await indexer.stop();

    // Only the non-excluded file's chunk is indexed (3 files → 1 chunk).
    expect(store.size()).toBe(1);
    expect(pathsOf(await collect(store))).toEqual(new Set(["keep.md"]));
  });

  test("live path: an edit to a file in an excluded folder does NOT re-enter the index", async () => {
    const store = await makeStore();
    const { vault, files, emit } = makeVault({ "keep.md": "alpha" });
    const { embedder } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      isExcluded: (p) => p.startsWith("secret/"),
      debounceMs: 30,
    });
    await indexer.start();
    expect(store.size()).toBe(1);

    // A file appears in an excluded folder and is then edited — the exact
    // follow-on vault event STE flagged. The live listener must drop it.
    files.set("secret/leak.md", "bravo");
    emit("create", "secret/leak.md");
    emit("modify", "secret/leak.md");
    await indexer.flush();

    expect(store.size()).toBe(1);
    expect(pathsOf(await collect(store))).toEqual(new Set(["keep.md"]));
    // No debounce timer was ever armed for the excluded path.
    expect(indexer.pending()).toBe(0);

    await indexer.stop();
  });

  test("low-power path: excluded file skipped, and excluding an already-indexed file does not destructively purge it", async () => {
    const store = await makeStore();
    const { vault } = makeMtimeVault({
      "keep.md": { content: "alpha", mtime: 100 },
      "later.md": { content: "bravo", mtime: 100 },
    });
    const { embedder } = fakeEmbeddingProvider();
    const excluded = new Set<string>();
    const indexer = createLowPowerIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      isExcluded: (p) => excluded.has(p),
      intervalMs: 1_000_000, // never auto-ticks; we drive cycles via flush()
    });
    await indexer.start();
    expect(pathsOf(await collect(store))).toEqual(
      new Set(["keep.md", "later.md"]),
    );

    // Exclude an already-indexed file, then run another scan cycle. D3:
    // its stale chunks stay in place (hidden at query time, physical
    // cleanup only via manual Rebuild) — the vanished-file cleanup must
    // NOT treat an excluded file as deleted.
    excluded.add("later.md");
    await indexer.flush();
    expect(pathsOf(await collect(store))).toEqual(
      new Set(["keep.md", "later.md"]),
    );

    await indexer.stop();
  });
});

/**
 * Proxies every method to the wrapped store and counts delete/upsert
 * calls, so tests can assert that a no-op save never touches the
 * store (which would mark it dirty and trigger a full-store rewrite
 * at the next flush).
 */
function wrapStoreWithWriteSpy(store: Awaited<ReturnType<typeof makeStore>>): {
  store: typeof store;
  writes: () => { deletes: number; upserts: number };
} {
  let deletes = 0;
  let upserts = 0;
  const wrapped: typeof store = {
    init: () => store.init(),
    size: () => store.size(),
    scan: () => store.scan(),
    recordsFor: (path) => store.recordsFor(path),
    upsert: (records) => {
      upserts++;
      return store.upsert(records);
    },
    delete: (path) => {
      deletes++;
      return store.delete(path);
    },
    close: () => store.close(),
    flush: () => store.flush(),
  };
  return { store: wrapped, writes: () => ({ deletes, upserts }) };
}

describe("live indexer — unchanged-file no-op skip", () => {
  test("modify event with identical content skips delete/upsert", async () => {
    const rawStore = await makeStore();
    const { vault, files, emit } = makeVault({
      "a.md": "alpha---CHUNK---beta",
    });
    const { embedder } = fakeEmbeddingProvider();
    const { store, writes } = wrapStoreWithWriteSpy(rawStore);
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 10,
    });
    await indexer.start();
    const afterBuild = writes();

    // Same content saved again: chunking is identical, so the path
    // must not be rewritten.
    files.set("a.md", "alpha---CHUNK---beta");
    emit("modify", "a.md");
    await new Promise((r) => setTimeout(r, 60));

    expect(writes()).toEqual(afterBuild);
    expect(rawStore.size()).toBe(2);

    await indexer.stop();
  });

  test("modify event with changed content still rewrites the path", async () => {
    const rawStore = await makeStore();
    const { vault, files, emit } = makeVault({
      "a.md": "alpha---CHUNK---beta",
    });
    const { embedder } = fakeEmbeddingProvider();
    const { store, writes } = wrapStoreWithWriteSpy(rawStore);
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store,
      debounceMs: 10,
    });
    await indexer.start();
    const afterBuild = writes();

    files.set("a.md", "alpha---CHUNK---gamma");
    emit("modify", "a.md");
    await new Promise((r) => setTimeout(r, 60));

    const afterModify = writes();
    expect(afterModify.deletes).toBe(afterBuild.deletes + 1);
    expect(afterModify.upserts).toBe(afterBuild.upserts + 1);
    expect(rawStore.size()).toBe(2);

    await indexer.stop();
  });
});

describe("live indexer — batched embed calls", () => {
  test("a modified file embeds only its changed chunks, in one call", async () => {
    const rawStore = await makeStore();
    const { vault, files, emit } = makeVault({
      "a.md": "one---CHUNK---two---CHUNK---three",
    });
    const { embedder, embedCalls } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store: rawStore,
      debounceMs: 10,
    });
    await indexer.start();
    // Full build: one batched call with all three chunks (overlap
    // wrapper prepends the previous chunk's text).
    expect(embedCalls()).toEqual([["one", "one\ntwo", "two\nthree"]]);

    // Change two chunks, keep the first.
    files.set("a.md", "one---CHUNK---TWO---CHUNK---THREE");
    emit("modify", "a.md");
    await new Promise((r) => setTimeout(r, 60));

    const calls = embedCalls();
    expect(calls).toHaveLength(2);
    // Reused "one" not re-embedded; the two changed chunks ride in
    // one batched call.
    expect(calls[1]).toEqual(["one\nTWO", "TWO\nTHREE"]);
    expect(rawStore.size()).toBe(3);

    await indexer.stop();
  });

  test("duplicate chunks within a file embed once and share the vector", async () => {
    const rawStore = await makeStore();
    // After the overlap wrapper, chunks 2 and 3 are both "same\nsame".
    const { vault } = makeVault({
      "a.md": "same---CHUNK---same---CHUNK---same",
    });
    const { embedder, embedCalls } = fakeEmbeddingProvider();
    const indexer = createLiveIndexer({
      vault,
      chunker: fakeChunker,
      embedder,
      store: rawStore,
      debounceMs: 10,
    });
    await indexer.start();
    // contentHash is computed on the raw chunk text (pre-overlap), so
    // all three "same" chunks share one hash and embed exactly once —
    // consistent with the existing reuse path, which already treats
    // equal hashes as vector-interchangeable across re-indexes.
    expect(embedCalls()).toEqual([["same"]]);
    const records = Array.from(rawStore.recordsFor("a.md"));
    expect(records).toHaveLength(3);
    const vecs = records.map((r) => r.vector);
    expect(vecs[1]).toBe(vecs[0] as Float32Array);
    expect(vecs[2]).toBe(vecs[0] as Float32Array);
    await indexer.stop();
  });
});
