/**
 * Phase 3 end-to-end integration test.
 *
 * Wires the real chunker + a deterministic bag-of-words embedder +
 * the persistent store + the live indexer + the native provider all
 * the way through. Asserts that:
 *   1. A full vault build indexes every file.
 *   2. A query returns the top-K notes by cosine similarity.
 *   3. A live modify event re-embeds the changed chunk and a re-run
 *      of the same query promotes the newly relevant file.
 *
 * No Transformers.js download. No MCP transport. No Obsidian app.
 * Just the Phase 3 services composed together so we can prove the
 * pieces actually work in concert.
 */

import { describe, expect, test } from "bun:test";
import { chunk, type Chunk } from "./services/chunker";
import { createEmbeddingStore, type VaultAdapter } from "./services/store";
import {
  createLiveIndexer,
  type VaultEvent,
  type VaultLike,
} from "./services/indexer";
import { createNativeProvider } from "./services/nativeProvider";
import type { Embedder } from "./services/embedder";

const VOCAB = [
  "apple",
  "banana",
  "cherry",
  "music",
  "code",
  "vault",
  "obsidian",
  "search",
] as const;

/**
 * Bag-of-words embedder over a fixed vocabulary. Each dimension
 * counts occurrences of one keyword, normalized to unit norm. Cosine
 * similarity between two texts is then a function of their lexical
 * overlap — perfect for an integration test where we want
 * deterministic, predictable rankings.
 */
function bowEmbedder(): Embedder {
  return {
    embed: async (text) => embedText(text),
    embedBatch: async (texts) => texts.map(embedText),
    unload: async () => undefined,
    isLoaded: () => true,
  };
}

function embedText(text: string): Float32Array {
  const v = new Float32Array(VOCAB.length);
  const lower = text.toLowerCase();
  for (let i = 0; i < VOCAB.length; i++) {
    const word = VOCAB[i] ?? "";
    let count = 0;
    let from = 0;
    while (true) {
      const idx = lower.indexOf(word, from);
      if (idx === -1) break;
      count += 1;
      from = idx + word.length;
    }
    v[i] = count;
  }
  // Normalize so cosine reduces to dot product without loss of
  // generality; helps the test assertions stay readable.
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += (v[i] ?? 0) ** 2;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  }
  return v;
}

function memVaultAdapter(): VaultAdapter {
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
  };
}

function memVault(initial: Record<string, string>): {
  vault: VaultLike;
  files: Map<string, string>;
  emit: (event: VaultEvent, path: string) => void;
} {
  const files = new Map(Object.entries(initial));
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
  return {
    vault,
    files,
    emit: (event, path) => {
      for (const h of handlers[event]) h(path);
    },
  };
}

/** Real chunker, but tuned to keep the test fixtures small. */
const integrationChunker = (content: string): Promise<Chunk[]> =>
  chunk(content, { maxTokens: 512, overlapTokens: 64, minTokens: 5 });

describe("Phase 3 end-to-end integration", () => {
  test("full pipeline: chunker → embedder → store → indexer → provider returns the expected top-K", async () => {
    const { vault } = memVault({
      "fruits/apple.md":
        "# Apple\n\nApple harvest notes — apple varieties and apple recipes.",
      "fruits/banana.md":
        "# Banana\n\nBanana ripening curve and banana storage tricks.",
      "fruits/cherry.md":
        "# Cherry\n\nCherry season report and cherry pie recipe.",
      "music/album.md": "# Album\n\nFavorite album list with music reviews.",
      "code/obsidian.md":
        "# Obsidian\n\nNotes on the Obsidian vault and search workflows.",
    });

    const adapter = memVaultAdapter();
    const store = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: VOCAB.length,
    });
    await store.init();

    const embedder = bowEmbedder();

    const indexer = createLiveIndexer({
      vault,
      chunker: integrationChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();

    // Every file produced at least one chunk.
    expect(store.size()).toBeGreaterThanOrEqual(5);

    const provider = createNativeProvider({ embedder, store });
    const results = await provider.search("apple recipes", { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    // The apple note dominates because every chunk's vector aligns
    // strongly with the "apple" dimension of the bag-of-words.
    expect(results[0]?.filePath).toBe("fruits/apple.md");

    await indexer.stop();
  });

  test("live modify reranks the next query: changing content shifts which file dominates", async () => {
    const { vault, files, emit } = memVault({
      "a.md":
        "# A\n\nApple, apple, apple — apple-only file with the apple keyword.",
      "b.md":
        "# B\n\nBanana, banana, banana — banana-only file with the banana keyword.",
      "c.md":
        "# C\n\nCherry, cherry, cherry — cherry-only file with the cherry keyword.",
    });
    const adapter = memVaultAdapter();
    const store = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: VOCAB.length,
    });
    await store.init();

    const embedder = bowEmbedder();
    const indexer = createLiveIndexer({
      vault,
      chunker: integrationChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();

    const provider = createNativeProvider({ embedder, store });

    // Before modification: querying "banana" puts b.md on top.
    const before = await provider.search("banana smoothie", { limit: 3 });
    expect(before[0]?.filePath).toBe("b.md");

    // Modify: rewrite a.md to be all banana now.
    files.set(
      "a.md",
      "# A\n\nBanana, banana, banana — pivoted to banana from apple.",
    );
    emit("modify", "a.md");
    await indexer.flush();

    const after = await provider.search("banana smoothie", { limit: 3 });
    // Both a.md and b.md now align with banana. The exact order
    // depends on chunk count, but a.md must be in the top 2 (it
    // wasn't there before — only the modify path can cause that).
    const topPaths = after.slice(0, 2).map((r) => r.filePath);
    expect(topPaths).toContain("a.md");

    await indexer.stop();
  });

  test("delete event drops a file from subsequent queries", async () => {
    const { vault, files, emit } = memVault({
      "ephemeral.md":
        "# E\n\nMusic recommendations: jazz music and ambient music.",
      "lasting.md":
        "# L\n\nMusic theory cheatsheet: scales, intervals, music notation.",
    });
    const adapter = memVaultAdapter();
    const store = createEmbeddingStore({
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: VOCAB.length,
    });
    await store.init();

    const embedder = bowEmbedder();
    const indexer = createLiveIndexer({
      vault,
      chunker: integrationChunker,
      embedder,
      store,
      debounceMs: 30,
    });
    await indexer.start();

    const provider = createNativeProvider({ embedder, store });
    const before = await provider.search("music", { limit: 5 });
    expect(before.map((r) => r.filePath)).toEqual(
      expect.arrayContaining(["ephemeral.md", "lasting.md"]),
    );

    files.delete("ephemeral.md");
    emit("delete", "ephemeral.md");
    await indexer.flush();

    const after = await provider.search("music", { limit: 5 });
    expect(after.map((r) => r.filePath)).not.toContain("ephemeral.md");
    expect(after.map((r) => r.filePath)).toContain("lasting.md");

    await indexer.stop();
  });

  test("results round-trip across a store close/init cycle", async () => {
    const { vault } = memVault({
      "x.md": "# X\n\nObsidian vault search and Obsidian markdown search.",
    });
    const adapter = memVaultAdapter();
    const opts = {
      adapter,
      binPath: "/p/embeddings.bin",
      indexPath: "/p/embeddings.index.json",
      vectorDim: VOCAB.length,
    };
    const store1 = createEmbeddingStore(opts);
    await store1.init();
    const embedder = bowEmbedder();
    const indexer1 = createLiveIndexer({
      vault,
      chunker: integrationChunker,
      embedder,
      store: store1,
      debounceMs: 30,
    });
    await indexer1.start();
    await store1.close(); // flush + clear in-memory state
    await indexer1.stop();

    // Reopen and run a query against the persisted state.
    const store2 = createEmbeddingStore(opts);
    await store2.init();
    expect(store2.size()).toBeGreaterThan(0);
    const provider = createNativeProvider({ embedder, store: store2 });
    const results = await provider.search("obsidian", { limit: 2 });
    expect(results[0]?.filePath).toBe("x.md");
  });
});
