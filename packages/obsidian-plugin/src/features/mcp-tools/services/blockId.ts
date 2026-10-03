/**
 * Where a `^block-id` lives for a given line, per Obsidian's own rules
 * (obsidian.md/help/links, read 2026-10-03): a plain paragraph takes
 * ` ^id` at the end of its last line, a list item takes it directly on
 * its own line, and a multi-line block (table, fenced code, quote or
 * callout) takes it on a separate line after the block with a blank line
 * before and after. Pure functions over the file's lines; the caller owns
 * the read-modify-write.
 */

export const BLOCK_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const TRAILING_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
const OWN_LINE_ID = /^\^([A-Za-z0-9-]+)\s*$/;
const HEADING = /^#{1,6}\s/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const TABLE_ROW = /^\s*\|/;
const QUOTE = /^\s*>/;
const FENCE = /^\s*(```|~~~)/;

export type BlockPlacement =
  | { kind: "inline"; startLine: number; endLine: number }
  | { kind: "own-line"; startLine: number; endLine: number }
  | { kind: "blank" }
  | { kind: "heading" };

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** Lines that open or close a fence, as a set of fence line indexes paired. */
function fenceRanges(lines: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: { line: number; marker: string } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = FENCE.exec(lines[i]);
    if (!m) continue;
    if (open === null) open = { line: i, marker: m[1] };
    else if (m[1] === open.marker) {
      ranges.push([open.line, i]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open.line, lines.length - 1]);
  return ranges;
}

/** The block the target line belongs to, and how an id attaches to it. */
export function locateBlock(lines: string[], line: number): BlockPlacement {
  const text = lines[line];
  if (isBlank(text)) return { kind: "blank" };
  const fence = fenceRanges(lines).find(([a, b]) => line >= a && line <= b);
  if (fence)
    return { kind: "own-line", startLine: fence[0], endLine: fence[1] };
  if (HEADING.test(text)) return { kind: "heading" };
  if (LIST_ITEM.test(text))
    return { kind: "inline", startLine: line, endLine: line };
  const extent = (test: (l: string) => boolean): [number, number] => {
    let a = line;
    let b = line;
    while (a > 0 && test(lines[a - 1])) a -= 1;
    while (b + 1 < lines.length && test(lines[b + 1])) b += 1;
    return [a, b];
  };
  if (TABLE_ROW.test(text)) {
    const [a, b] = extent((l) => TABLE_ROW.test(l));
    return { kind: "own-line", startLine: a, endLine: b };
  }
  if (QUOTE.test(text)) {
    const [a, b] = extent((l) => QUOTE.test(l));
    return { kind: "own-line", startLine: a, endLine: b };
  }
  // A paragraph runs over contiguous lines that start no other block.
  const plain = (l: string): boolean =>
    !isBlank(l) &&
    !HEADING.test(l) &&
    !LIST_ITEM.test(l) &&
    !TABLE_ROW.test(l) &&
    !QUOTE.test(l) &&
    !FENCE.test(l) &&
    !OWN_LINE_ID.test(l);
  const [a, b] = extent(plain);
  return { kind: "inline", startLine: a, endLine: b };
}

/**
 * The id already attached to the block, if any: the trailing ` ^id` of an
 * inline block, or the own-line `^id` that follows a multi-line block
 * (directly or after one blank line).
 */
export function existingBlockId(
  lines: string[],
  placement: Extract<BlockPlacement, { kind: "inline" | "own-line" }>,
): { id: string; line: number } | null {
  if (placement.kind === "inline") {
    const m = TRAILING_ID.exec(lines[placement.endLine]);
    return m ? { id: m[1], line: placement.endLine } : null;
  }
  for (const offset of [1, 2]) {
    const i = placement.endLine + offset;
    if (i >= lines.length) return null;
    if (offset === 1 && isBlank(lines[i])) continue;
    const m = OWN_LINE_ID.exec(lines[i]);
    return m ? { id: m[1], line: i } : null;
  }
  return null;
}

/** Every block id written anywhere in the content, trailing or own-line. */
export function allBlockIds(lines: string[]): Set<string> {
  const ids = new Set<string>();
  for (const l of lines) {
    const m = TRAILING_ID.exec(l) ?? OWN_LINE_ID.exec(l);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** Returns the new lines array with `id` attached, and the line it sits on. */
export function attachBlockId(
  lines: string[],
  placement: Extract<BlockPlacement, { kind: "inline" | "own-line" }>,
  id: string,
): { lines: string[]; line: number } {
  const out = [...lines];
  if (placement.kind === "inline") {
    out[placement.endLine] = `${out[placement.endLine].trimEnd()} ^${id}`;
    return { lines: out, line: placement.endLine };
  }
  const after = placement.endLine + 1;
  // Blank line before, then the id, then a blank line unless one follows.
  const needsBlankAfter = after < out.length && !isBlank(out[after]);
  out.splice(after, 0, "", `^${id}`, ...(needsBlankAfter ? [""] : []));
  return { lines: out, line: after + 1 };
}

/** Obsidian-style 6-character lowercase alphanumeric id, unique in `taken`. */
export function generateBlockId(
  taken: ReadonlySet<string>,
  gen?: () => string,
): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const defaultGen = (): string => {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  };
  const next = gen ?? defaultGen;
  for (let i = 0; i < 100; i += 1) {
    const id = next();
    if (!taken.has(id)) return id;
  }
  throw new Error("Could not generate a unique block id");
}
