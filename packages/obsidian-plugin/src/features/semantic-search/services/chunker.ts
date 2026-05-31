/**
 * Heading-section chunker for vault markdown.
 *
 * Splits content on H1/H2 boundaries. H3+ stay inside their parent
 * section unless the section exceeds `maxTokens`, in which case H3
 * sub-sections are split before falling back to a sliding window.
 *
 * Frontmatter is emitted as a dedicated chunk with id `"#frontmatter"`
 * so file-level metadata is searchable independently of body prose.
 * Small frontmatter (below `minTokens`) is silently dropped.
 *
 * Code fences are atomic: if a section contains a code fence whose
 * token count exceeds `maxTokens`, the entire section is kept as a
 * single chunk rather than split mid-fence.
 *
 * Token counting is approximate: `text.split(/\s+/)`. The exact MiniLM
 * BPE tokenizer would be more precise but requires loading the model
 * just to size windows, which slows the chunker by an order of
 * magnitude. For the 512/64 window choices the approximation is well
 * within tolerance.
 */

import { logger } from "$/shared/logger";
import type { EmbeddingProvider } from "../types";

export type ChunkOpts = {
  maxTokens?: number;
  overlapTokens?: number;
  minTokens?: number;
};

export type Chunk = {
  id: string;
  text: string;
  heading: string | null;
  offset: number;
  contentHash: string;
};

/** Signature of the chunk() function, used by the indexer and overlap wrapper. */
export type ChunkerFn = (content: string) => Promise<Chunk[]>;

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 64;
const DEFAULT_MIN_TOKENS = 20;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Approximate token count via whitespace split. See file header for
 * the rationale on not loading the BPE tokenizer.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter((s) => s.length > 0).length;
}

/**
 * SHA-256 hex digest, truncated to 16 chars. 64 bits is enough to
 * detect content edits with effectively zero false-positive rate at
 * vault sizes (collision probability ≈ N²/2^64; a 1M-chunk vault
 * has ~2.7e-8 probability of any collision, acceptable for a
 * cache-invalidation key).
 */
export async function hashChunk(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

type Section = { heading: string | null; text: string; offset: number };

/**
 * Extract frontmatter (if present) and return the remaining body plus
 * the offset adjustment for downstream consumers that want to map
 * chunks back to file positions.
 */
function extractFrontmatter(content: string): {
  frontmatter: string | null;
  body: string;
  bodyOffset: number;
} {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: null, body: content, bodyOffset: 0 };
  const fmText = m[1] ?? "";
  return {
    frontmatter: fmText,
    body: content.slice(m[0].length),
    bodyOffset: m[0].length,
  };
}

/**
 * Split body on H1 (`# `) and H2 (`## `) boundaries. H3+ stay inside
 * their parent section. The leading content before the first heading
 * is its own anonymous section (heading = null).
 */
function splitByHeadings(body: string, baseOffset: number): Section[] {
  const lines = body.split(/(\r?\n)/); // keep separators to preserve offsets
  const sections: Section[] = [];
  let current: Section = { heading: null, text: "", offset: baseOffset };
  let cursor = baseOffset;

  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] ?? "";
    const sep = lines[i + 1] ?? "";
    const trimmedLine = line.trimEnd();

    const h1 = trimmedLine.match(/^# (.+)$/);
    const h2 = trimmedLine.match(/^## (.+)$/);
    const heading = h1?.[1] ?? h2?.[1] ?? null;

    if (heading !== null) {
      if (current.text.length > 0) sections.push(current);
      current = { heading, text: line + sep, offset: cursor };
    } else {
      current.text += line + sep;
    }
    cursor += line.length + sep.length;
  }

  if (current.text.length > 0) sections.push(current);
  return sections;
}

/**
 * Split a section further on `### ` boundaries. Returns the original
 * section unchanged (as a single-element array) when no H3 headings
 * are found, so the caller can distinguish "no split" from "split".
 */
function splitSectionByH3(section: Section): Section[] {
  const lines = section.text.split(/(\r?\n)/);
  const sub: Section[] = [];
  let current: Section = {
    heading: section.heading,
    text: "",
    offset: section.offset,
  };
  let cursor = section.offset;

  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i] ?? "";
    const sep = lines[i + 1] ?? "";
    const trimmedLine = line.trimEnd();

    const h3 = trimmedLine.match(/^### (.+)$/);
    if (h3 !== null) {
      if (current.text.length > 0) sub.push(current);
      current = { heading: h3[1] ?? null, text: line + sep, offset: cursor };
    } else {
      current.text += line + sep;
    }
    cursor += line.length + sep.length;
  }

  if (current.text.length > 0) sub.push(current);
  return sub.length > 1 ? sub : [section];
}

/**
 * Returns true if the text contains a code fence whose own token count
 * exceeds `maxTokens` — signals that the section should be kept atomic
 * rather than split mid-fence.
 */
function hasOversizedCodeFence(text: string, maxTokens: number): boolean {
  const lines = text.split("\n");
  let inFence = false;
  let fenceStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      if (!inFence) {
        inFence = true;
        fenceStart = i;
      } else {
        const fenceText = lines.slice(fenceStart, i + 1).join("\n");
        if (countTokens(fenceText) > maxTokens) return true;
        inFence = false;
      }
    }
  }
  return false;
}

/**
 * Sliding-window split for sections that exceed `maxTokens`. Each
 * window has at most `maxTokens` whitespace-delimited tokens; adjacent
 * windows share `overlapTokens` tokens. The first heading line of the
 * section is repeated at the head of every window so each chunk
 * carries its context.
 */
function slidingWindows(
  text: string,
  heading: string | null,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  // Preserve the heading line on every window.
  let prefix = "";
  let body = text;
  if (heading !== null) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline !== -1) {
      prefix = text.slice(0, firstNewline + 1);
      body = text.slice(firstNewline + 1);
    }
  }

  const tokens = body.split(/(\s+)/); // keep whitespace tokens to recover spacing
  // Compress to alternating word/whitespace runs and index only the
  // word tokens so the window step is in real tokens.
  const wordIndices: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if ((tokens[i] ?? "").trim().length > 0) wordIndices.push(i);
  }

  if (wordIndices.length <= maxTokens) return [prefix + body];

  const windows: string[] = [];
  const step = Math.max(1, maxTokens - overlapTokens);
  for (let start = 0; start < wordIndices.length; start += step) {
    const end = Math.min(start + maxTokens, wordIndices.length);
    const fromIdx = wordIndices[start];
    if (fromIdx === undefined) break;
    const toIdx =
      end >= wordIndices.length
        ? tokens.length
        : (wordIndices[end] ?? tokens.length);
    const slice = tokens.slice(fromIdx, toIdx).join("");
    windows.push(prefix + slice);
    if (end >= wordIndices.length) break;
  }
  return windows;
}

/**
 * Emit chunks for one section into `out`. Tries H3 sub-split first
 * for oversized sections; falls back to sliding windows. Code fences
 * that alone exceed `maxTokens` are kept atomic.
 */
async function emitSectionChunks(
  section: Section,
  maxTokens: number,
  overlapTokens: number,
  minTokens: number,
  out: Chunk[],
): Promise<void> {
  const text = section.text.trimEnd();
  const tokenCount = countTokens(text);
  if (tokenCount < minTokens) return;

  if (tokenCount <= maxTokens) {
    out.push({
      id: String(out.length),
      text,
      heading: section.heading,
      offset: section.offset,
      contentHash: await hashChunk(text),
    });
    return;
  }

  // Oversized: check for atomic code fence before splitting.
  if (hasOversizedCodeFence(text, maxTokens)) {
    logger.debug("embedding chunker: oversized code fence kept atomic", {
      heading: section.heading,
      tokens: tokenCount,
    });
    out.push({
      id: String(out.length),
      text,
      heading: section.heading,
      offset: section.offset,
      contentHash: await hashChunk(text),
    });
    return;
  }

  // Try H3 sub-split before sliding window.
  const subSections = splitSectionByH3(section);
  if (subSections.length > 1) {
    for (const sub of subSections) {
      const subText = sub.text.trimEnd();
      const subTokens = countTokens(subText);
      if (subTokens < minTokens) continue;
      if (subTokens <= maxTokens) {
        out.push({
          id: String(out.length),
          text: subText,
          heading: sub.heading,
          offset: sub.offset,
          contentHash: await hashChunk(subText),
        });
      } else {
        const windows = slidingWindows(
          subText,
          sub.heading,
          maxTokens,
          overlapTokens,
        );
        for (const w of windows) {
          out.push({
            id: String(out.length),
            text: w,
            heading: sub.heading,
            offset: sub.offset,
            contentHash: await hashChunk(w),
          });
        }
      }
    }
    return;
  }

  // No H3 sub-sections — sliding window.
  const windows = slidingWindows(
    text,
    section.heading,
    maxTokens,
    overlapTokens,
  );
  for (const w of windows) {
    out.push({
      id: String(out.length),
      text: w,
      heading: section.heading,
      offset: section.offset,
      contentHash: await hashChunk(w),
    });
  }
}

/**
 * Extracts the last sentence from text using punctuation-based split.
 * Returns the entire trimmed text when no sentence boundary is found; returns `""` for empty input.
 */
function extractLastSentence(text: string): string {
  const trimmed = text.trimEnd();
  const parts = trimmed.split(/(?<=[.!?])\s+/);
  return parts[parts.length - 1]?.trim() ?? "";
}

/**
 * Wraps a chunker to prepend the last sentence of the previous chunk's
 * text to each subsequent chunk before it reaches the embedder. The
 * stored `Chunk.text` and `contentHash` are unchanged — only the text
 * passed to `embed()` is enriched with one sentence of overlap.
 *
 * `#frontmatter` chunks are skipped as overlap sources since metadata
 * context does not carry meaningfully into body prose.
 */
export function wrapChunkerWithOverlap(chunker: ChunkerFn): ChunkerFn {
  return async (content: string): Promise<Chunk[]> => {
    const chunks = await chunker(content);
    return chunks.map((c, i) => {
      if (i === 0) return c;
      const prev = chunks[i - 1]!;
      if (prev.id === "#frontmatter") return c;
      const overlap = extractLastSentence(prev.text);
      if (!overlap) return c;
      return { ...c, text: overlap + "\n" + c.text };
    });
  };
}

/**
 * Main chunker. Accepts the full markdown content of a file and
 * returns the chunks ready for embedding. Pure function: no I/O, no
 * Obsidian API access, no globals. The caller (indexer) supplies
 * the file path and composes the persistent chunkId.
 *
 * Frontmatter (if large enough) is emitted first as a `#frontmatter`
 * chunk. Body chunks are numbered ordinally starting from `"0"`.
 */
export async function chunk(
  content: string,
  opts: ChunkOpts = {},
): Promise<Chunk[]> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS;

  const { frontmatter, body, bodyOffset } = extractFrontmatter(content);

  let fmChunk: Chunk | null = null;
  if (frontmatter !== null) {
    const fmText = frontmatter.trim();
    if (countTokens(fmText) >= minTokens) {
      fmChunk = {
        id: "#frontmatter",
        text: fmText,
        heading: null,
        offset: 0,
        contentHash: await hashChunk(fmText),
      };
    }
  }

  const sections = splitByHeadings(body, bodyOffset);
  const bodyChunks: Chunk[] = [];

  for (const section of sections) {
    await emitSectionChunks(
      section,
      maxTokens,
      overlapTokens,
      minTokens,
      bodyChunks,
    );
  }

  return fmChunk ? [fmChunk, ...bodyChunks] : bodyChunks;
}

/**
 * Headroom subtracted from `provider.getMaxInputTokens()` so the longest
 * task-prompt prefix can be prepended at embed time without exceeding
 * the model's hard cap. Gemma's `"task: search result | query: "` is ≈8
 * BPE tokens; 16 gives ample slack for prompt variants while keeping
 * chunks near the model's effective context.
 */
const TASK_PROMPT_HEADROOM = 16;

/**
 * Absolute floor for chunk size. Guards against pathological provider
 * caps (e.g. a misconfigured small-context model) producing chunks too
 * tiny for `chunk()`'s `minTokens` heuristic to make sense.
 */
const MIN_CHUNK_MAX_TOKENS = 64;

/**
 * Build a `ChunkerFn` whose token budget tracks the provider's effective
 * `getMaxInputTokens()` (backend-resolved). The headroom subtraction
 * accounts for the task-prompt prefix prepended at embed time, so the
 * rendered prompted text stays within the model's hard cap.
 */
export function makeChunkerForProvider(
  provider: EmbeddingProvider,
): ChunkerFn {
  let logged = false;
  return async (content: string): Promise<Chunk[]> => {
    const maxInputTokens = await provider.getMaxInputTokens();
    const maxTokens = Math.max(
      MIN_CHUNK_MAX_TOKENS,
      maxInputTokens - TASK_PROMPT_HEADROOM,
    );
    if (!logged) {
      logged = true;
      logger.info("semantic-search: chunker bound to provider", {
        providerKey: provider.providerKey,
        maxInputTokens,
        chunkMaxTokens: maxTokens,
      });
    }
    return chunk(content, { maxTokens });
  };
}
