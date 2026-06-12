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
const EXCERPT_MAX_LENGTH = 500;

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
    const limit = opts.limit ?? DEFAULT_LIMIT;

    // Bounded top-k selection (descending, ties keep scan order — same
    // outcome as the previous full sort+slice, without holding every
    // candidate and without the O(n log n) sort). Scoring is a plain
    // dot product: every vector written to the store is L2-normalized
    // at embed time, so dot ≡ cosine at a third of the FLOPs.
    const top: Array<{ record: EmbeddingRecord; score: number }> = [];
    for await (const record of this.opts.store.scan()) {
      if (!matchesFolders(record.filePath, opts)) continue;
      const score = dotProduct(queryVec, record.vector);
      const worst = top[top.length - 1];
      if (top.length === limit && worst && score <= worst.score) continue;
      // Binary insert into the descending-sorted window.
      let lo = 0;
      let hi = top.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const at = top[mid];
        if (at && at.score >= score) lo = mid + 1;
        else hi = mid;
      }
      top.splice(lo, 0, { record, score });
      if (top.length > limit) top.pop();
    }

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
        body = "";
      }
    }
    return truncateExcerpt(body);
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
 * Plain dot product over Float32 typed arrays. Equals cosine
 * similarity when both vectors are L2-normalized — which every vector
 * in the store is (normalize: true on all embed paths) — at a third
 * of the FLOPs and with no per-element guards, so V8 keeps the loop
 * in pure float arithmetic.
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`dot: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Vectorized cosine similarity over Float32 typed arrays. Returns 0
 * for zero-norm inputs so the call site does not need a guard. The
 * result is in [-1, 1] for any non-zero pair. Kept for callers with
 * non-normalized inputs; the search hot loop uses dotProduct.
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

function truncateExcerpt(body: string): string {
  if (body.length === 0) return "(no preview)";
  if (body.length <= EXCERPT_MAX_LENGTH) return body;
  const cut = body.lastIndexOf(" ", EXCERPT_MAX_LENGTH);
  return (
    (cut > 0 ? body.slice(0, cut) : body.slice(0, EXCERPT_MAX_LENGTH)) + "..."
  );
}

export function createNativeProvider(
  opts: NativeProviderOpts,
): SemanticSearchProvider {
  return new NativeProviderImpl(opts);
}
