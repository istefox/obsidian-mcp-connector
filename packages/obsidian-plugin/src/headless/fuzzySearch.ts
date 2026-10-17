/**
 * Runtime stand-ins for the search helpers `obsidian` exports to plugins:
 * `prepareFuzzySearch`, `sortSearchResults` and `parseFrontMatterAliases`.
 * The shapes match the public typings. Obsidian's scoring itself is not
 * public, so the scorer is an approximation of its behaviour: a query
 * matches when its characters appear in order, a contiguous run beats a
 * scattered match, a match at the start of a word beats one in the middle,
 * and the score is at most 0, where 0 is the best.
 */

import type { SearchMatches, SearchResult } from "obsidian";

/** Added to the score for each text character skipped before the first match. */
const LEADING_SKIP_COST = 0.02;
/** First match in the middle of a word, instead of at the start of one. */
const MID_WORD_START_COST = 0.5;
/** A jump over unmatched text, then per skipped character. */
const GAP_COST = 1;
const GAP_COST_AT_WORD_START = 0.3;
const GAP_CHAR_COST = 0.05;
/** Per text character left after the last match, so a tighter text ranks first. */
const TRAILING_COST = 0.01;

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * `text` folded to lowercase one code point at a time. Folding can change
 * the length (`İ` becomes two units), so each folded unit keeps the code
 * point it came from and the range that code point covers in `text`.
 */
type Folded = {
  lower: string;
  /** The original code point of each folded unit. */
  chars: string[];
  /** True for a folded unit after the first of its code point. */
  extra: boolean[];
  /** Start and end offset in the original text of each folded unit. */
  spans: Array<[number, number]>;
};

function fold(text: string): Folded {
  let lower = "";
  const chars: string[] = [];
  const extra: boolean[] = [];
  const spans: Array<[number, number]> = [];
  let at = 0;
  for (const ch of text) {
    const folded = ch.toLowerCase();
    for (let j = 0; j < folded.length; j++) {
      chars.push(ch);
      extra.push(j > 0);
      spans.push([at, at + ch.length]);
    }
    lower += folded;
    at += ch.length;
  }
  return { lower, chars, extra, spans };
}

/** True when folded unit `i` starts a word: after a separator, or a camelCase hump. */
function startsWord(text: Folded, i: number): boolean {
  if (i === 0) return true;
  if (text.extra[i]) return false;
  const chars = text.chars;
  const prev = chars[i - 1];
  if (!isWordChar(prev)) return true;
  return (
    prev === prev.toLowerCase() &&
    chars[i] !== chars[i].toLowerCase() &&
    chars[i] === chars[i].toUpperCase()
  );
}

/** True when the characters of `token` occur in `lower` in order. */
function isSubsequence(token: string, lower: string): boolean {
  let at = 0;
  for (const ch of token) {
    at = lower.indexOf(ch, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/**
 * The cheapest in-order alignment of `token` in the folded `text`, as the
 * matched indices into it and their cost. Assumes `token` is a subsequence.
 */
function align(
  token: string,
  text: Folded,
): { cost: number; indices: number[] } {
  const { lower } = text;
  const n = lower.length;
  const m = token.length;
  const word = Array.from({ length: n }, (_, i) => startsWord(text, i));
  // cost[j][i]: cheapest alignment of token[0..j] that ends with token[j] at i.
  const cost: number[][] = [];
  const from: number[][] = [];
  for (let j = 0; j < m; j++) {
    const row = new Array<number>(n).fill(Infinity);
    const back = new Array<number>(n).fill(-1);
    // Cheapest earlier end k of the previous row, as cost[j-1][k] - GAP_CHAR_COST * k.
    let bestK = -1;
    let bestVal = Infinity;
    for (let i = 0; i < n; i++) {
      if (j > 0 && i >= 2) {
        const k = i - 2;
        const val = cost[j - 1][k] - GAP_CHAR_COST * k;
        if (val < bestVal) {
          bestVal = val;
          bestK = k;
        }
      }
      if (lower[i] !== token[j]) continue;
      if (j === 0) {
        row[i] = LEADING_SKIP_COST * i + (word[i] ? 0 : MID_WORD_START_COST);
        continue;
      }
      if (i >= 1 && cost[j - 1][i - 1] < row[i]) {
        row[i] = cost[j - 1][i - 1];
        back[i] = i - 1;
      }
      if (bestK >= 0) {
        const jump =
          bestVal +
          GAP_CHAR_COST * (i - 1) +
          (word[i] ? GAP_COST_AT_WORD_START : GAP_COST);
        if (jump < row[i]) {
          row[i] = jump;
          back[i] = bestK;
        }
      }
    }
    cost.push(row);
    from.push(back);
  }
  let end = -1;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const total = cost[m - 1][i] + TRAILING_COST * (n - 1 - i);
    if (total < best) {
      best = total;
      end = i;
    }
  }
  const indices = new Array<number>(m);
  for (let j = m - 1, i = end; j >= 0; i = from[j][i], j--) indices[j] = i;
  return { cost: best, indices };
}

/** Folded indices as ranges of the original text, touching ranges merged. */
function toRanges(indices: number[], text: Folded): SearchMatches {
  const spans = [...new Set(indices)]
    .map((i) => text.spans[i])
    .sort((a, b) => a[0] - b[0]);
  const ranges: SearchMatches = [];
  for (const [start, end] of spans) {
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges;
}

/**
 * Case-insensitive fuzzy matcher for `query`. Whitespace separates words
 * and every word must match, each as an in-order run of characters. An
 * empty query matches everything with score 0.
 */
export function prepareFuzzySearch(
  query: string,
): (text: string) => SearchResult | null {
  // Folded like the candidates, one code point at a time: a whole-string
  // fold would turn a final `Σ` into `ς` where the candidate has `σ`.
  const tokens = query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => fold(token).lower);
  return (text) => {
    if (tokens.length === 0) return { score: 0, matches: [] };
    const folded = fold(text);
    const { lower } = folded;
    let total = 0;
    const indices: number[] = [];
    for (const token of tokens) {
      if (!isSubsequence(token, lower)) return null;
      const found = align(token, folded);
      total += found.cost;
      indices.push(...found.indices);
    }
    return {
      score: total === 0 ? 0 : -Math.round(total * 1e4) / 1e4,
      matches: toRanges(indices, folded),
    };
  };
}

/** Best match first. */
export function sortSearchResults(results: { match: SearchResult }[]): void {
  results.sort((a, b) => b.match.score - a.match.score);
}

/** The `alias` or `aliases` property as a list of names, or null when absent. */
export function parseFrontMatterAliases(frontmatter: unknown): string[] | null {
  if (frontmatter === null || typeof frontmatter !== "object") return null;
  const record = frontmatter as Record<string, unknown>;
  const key = Object.keys(record).find((k) => /^alias(es)?$/i.test(k));
  if (key === undefined) return null;
  const value = record[key];
  const names =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value.filter((v) => v !== null && v !== undefined).map(String)
        : null;
  if (names === null) return null;
  return names.map((n) => n.trim()).filter((n) => n !== "");
}
