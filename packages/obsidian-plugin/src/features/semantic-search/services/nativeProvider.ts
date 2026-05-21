/**
 * NativeProvider — semantic search backed by Transformers.js + the
 * local embedding store. Implements `SemanticSearchProvider`; the
 * provider factory selects it from the user's tri-state setting.
 *
 * Algorithm:
 *   1. Embed the query (LRU-cached at the embedder layer).
 *   2. Iterate `store.scan()`, applying folder include/exclude
 *      filters before scoring. The filter check before cosine cuts
 *      ~CPU proportional to filtered-out fraction; for excluded
 *      large folders this matters at ~100k chunks.
 *   3. Cosine similarity with vectorized typed-array math.
 *   4. Sort descending by score, slice to `limit`, build result
 *      objects with file path + heading + bounded excerpt.
 *
 * Excerpt resolution is injected (`excerptResolver`) so the provider
 * stays pure-logic and the production wiring (T8) supplies a
 * function that reads the file via `app.vault.cachedRead` and slices
 * from the chunk's offset. If no resolver is provided, the excerpt
 * falls back to the heading + a "(no preview)" sentinel — useful for
 * tests and for environments where vault reads are too expensive.
 */

import type { Embedder } from "./embedder";
import type { EmbeddingRecord, EmbeddingStore } from "./store";
import type {
  SearchOpts,
  SearchResult,
  SemanticSearchProvider,
} from "$/features/semantic-search";

const DEFAULT_LIMIT = 10;
const EXCERPT_MAX_LENGTH = 200;

export type ExcerptResolver = (
  filePath: string,
  offset: number,
  maxLen: number,
) => Promise<string>;

export type NativeProviderOpts = {
  embedder: Embedder;
  store: EmbeddingStore;
  excerptResolver?: ExcerptResolver;
};

class NativeProviderImpl implements SemanticSearchProvider {
  constructor(private opts: NativeProviderOpts) {}

  /**
   * The native provider is functionally always ready — even with an
   * empty store the contract is to return zero results, not error.
   * The factory (T8) rejects partial wiring before constructing this
   * instance, so by the time it lives the embedder + store have been
   * initialized.
   */
  isReady(): boolean {
    return true;
  }

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const queryVec = await this.opts.embedder.embed(query);

    const candidates: Array<{ record: EmbeddingRecord; score: number }> = [];
    for await (const record of this.opts.store.scan()) {
      if (!matchesFolders(record.filePath, opts)) continue;
      const score = cosineSimilarity(queryVec, record.vector);
      candidates.push({ record, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const top = candidates.slice(0, limit);

    return Promise.all(
      top.map(async ({ record, score }) => ({
        filePath: record.filePath,
        heading: record.heading,
        excerpt: await this.makeExcerpt(record),
        score,
      })),
    );
  }

  private async makeExcerpt(record: EmbeddingRecord): Promise<string> {
    let body = "";
    if (this.opts.excerptResolver) {
      try {
        body = await this.opts.excerptResolver(
          record.filePath,
          record.offset,
          EXCERPT_MAX_LENGTH,
        );
      } catch {
        // Failure to read the file should not fail the whole search;
        // the excerpt degrades to heading-only.
        body = "";
      }
    }

    if (record.heading) {
      const prefix = `${record.heading}: `;
      const remaining = Math.max(0, EXCERPT_MAX_LENGTH - prefix.length);
      const tail = body.slice(0, remaining);
      const out = prefix + tail;
      return out.length > EXCERPT_MAX_LENGTH
        ? out.slice(0, EXCERPT_MAX_LENGTH)
        : out;
    }

    if (body.length === 0) return "(no preview)";
    return body.length > EXCERPT_MAX_LENGTH
      ? body.slice(0, EXCERPT_MAX_LENGTH)
      : body;
  }
}

/**
 * Folder filter: include filter (if non-empty) requires a startsWith
 * match against any of the listed folders. Exclude filter rejects on
 * any startsWith match. Includes are checked before excludes — the
 * exclude wins on overlap.
 */
function matchesFolders(filePath: string, opts: SearchOpts): boolean {
  if (opts.folders && opts.folders.length > 0) {
    const inc = opts.folders.some((f) => startsWithFolder(filePath, f));
    if (!inc) return false;
  }
  if (opts.excludeFolders && opts.excludeFolders.length > 0) {
    const exc = opts.excludeFolders.some((f) => startsWithFolder(filePath, f));
    if (exc) return false;
  }
  return true;
}

function startsWithFolder(filePath: string, folder: string): boolean {
  // Normalize trailing slash so "Notes/" matches "Notes/a.md" but
  // not "NotesArchive/a.md".
  const f = folder.endsWith("/") ? folder : folder + "/";
  return filePath === folder || filePath.startsWith(f);
}

/**
 * Vectorized cosine similarity over Float32 typed arrays. Returns 0
 * for zero-norm inputs so the call site does not need a guard. The
 * result is in [-1, 1] for any non-zero pair.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function createNativeProvider(
  opts: NativeProviderOpts,
): SemanticSearchProvider {
  return new NativeProviderImpl(opts);
}
