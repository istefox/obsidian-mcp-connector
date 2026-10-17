import type {
  BlockCache,
  CachedMetadata,
  EmbedCache,
  FrontmatterLinkCache,
  HeadingCache,
  LinkCache,
  ListItemCache,
  Loc,
  Pos,
  TagCache,
} from "obsidian";
import { parseDocument } from "yaml";
import { escapeLinkPath } from "./linkResolution";

// Pure markdown metadata extractor that mimics the subset of Obsidian's
// `CachedMetadata` the MCP vault tools read. It runs in plain Node (no
// "obsidian" import at runtime: that package ships .d.ts files only), so the
// headless server can serve the same tools without a running Obsidian.
//
// It is deliberately NOT a CommonMark parser. It is a line-oriented scanner
// that reproduces the block structure Obsidian's cache exposes (headings,
// paragraphs, lists, quotes, tables, code fences) closely enough for the
// fields the tools consume. Not produced, because no tool reads them: setext
// headings, footnotes, reference links and `sections`.

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The leading `---` YAML block of a note, located but not interpreted beyond
 * parsing. Offsets are UTF-16 string indices into the original content, so a
 * caller can re-serialise `data` and splice the result back with
 * `content.slice(0, openEnd) + newYaml + content.slice(closeStart)`.
 */
export interface FrontmatterBlock {
  /**
   * Parsed YAML mapping. `{}` for an empty block. `null` when the YAML is
   * invalid or does not parse to a mapping (Obsidian leaves such blocks
   * uncached, and so does `parseMetadata`).
   */
  data: Record<string, unknown> | null;
  /** Raw YAML text between the delimiters, without the final line break. */
  yaml: string;
  /** Offset of the opening `---` (after a BOM, if any). */
  start: number;
  /** Offset just after the closing delimiter text (before its line break). */
  end: number;
  /** Offset of the first character of the YAML text (after the opening line break). */
  openEnd: number;
  /** Offset of the first character of the closing delimiter line. */
  closeStart: number;
  /** Offset where the note body begins (after the closing line break, or EOF). */
  bodyStart: number;
  /** Line break used by the opening delimiter line: `"\n"` or `"\r\n"`. */
  eol: "\n" | "\r\n";
  /** Span of the block including both delimiters. */
  position: Pos;
}

/**
 * Locates the leading `---` YAML block.
 *
 * The note must start (after an optional BOM) with a `---` line. The block
 * ends at the first following line that is `---` or `...` (trailing blanks
 * allowed). Returns `null` when there is no opening delimiter or no closing
 * one. Handles both LF and CRLF files.
 */
export function parseFrontmatterBlock(
  content: string,
): FrontmatterBlock | null {
  const bom = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open = /^---[ \t]*(\r?\n)/.exec(content.slice(bom));
  if (!open) return null;
  const eol = open[1] === "\r\n" ? "\r\n" : "\n";
  const openEnd = bom + open[0].length;

  let pos = openEnd;
  let closeStart = -1;
  let end = -1;
  let bodyStart = content.length;
  while (pos <= content.length) {
    const nl = content.indexOf("\n", pos);
    const lineEnd = nl === -1 ? content.length : nl;
    let text = content.slice(pos, lineEnd);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (/^(?:---|\.\.\.)[ \t]*$/.test(text)) {
      closeStart = pos;
      end = pos + text.length;
      bodyStart = nl === -1 ? content.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return null;

  const yamlText = content.slice(openEnd, closeStart).replace(/\r?\n$/, "");

  // `parseDocument` rather than `parse`: with `logLevel: "silent"`, `parse`
  // swallows syntax errors and returns a half-recovered value, whereas the
  // document keeps them in `errors` so invalid YAML can be rejected like
  // Obsidian does. Silent also stops the yaml library printing a warning on
  // stderr for each odd note, which would only be noise in the server log.
  let data: Record<string, unknown> | null = null;
  try {
    const doc = parseDocument(yamlText, { logLevel: "silent" });
    if (doc.errors.length === 0) {
      const parsed: unknown = doc.toJS();
      if (parsed === null || parsed === undefined) data = {};
      else if (typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    }
  } catch {
    data = null;
  }

  const endLine = countNewlines(content, closeStart);
  const lastLineStart = closeStart;
  return {
    data,
    yaml: yamlText,
    start: bom,
    end,
    openEnd,
    closeStart,
    bodyStart,
    eol,
    position: {
      start: { line: 0, col: bom, offset: bom },
      end: { line: endLine, col: end - lastLineStart, offset: end },
    },
  };
}

function countNewlines(text: string, upTo: number): number {
  let n = 0;
  let i = text.indexOf("\n");
  while (i !== -1 && i < upTo) {
    n++;
    i = text.indexOf("\n", i + 1);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared patterns
// ─────────────────────────────────────────────────────────────────────────────

/** Block quote prefix, possibly nested: `> `, `>> `, `> > `. */
const QUOTE_PREFIX = /^(?: {0,3}>[ \t]?)+/;
/** `^id` at the end of a line, preceded by whitespace or starting the line. */
const BLOCK_ID_END = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/;
/** A line that holds nothing but a block id. */
const BLOCK_ID_ALONE = /^[ \t]*\^([A-Za-z0-9-]+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const TASK_BOX = /^\[(.)\](?:[ \t]|$)/;
const FENCE_OPEN = /^( *)(`{3,}|~{3,})(.*)$/;
const HEADING = /^( {0,3})(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const WIKILINK = /(!?)\[\[([^[\]\n]*)\]\]/g;
const MD_LINK =
  /(!?)\[((?:[^[\]\n\\]|\\.)*)\]\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
// A tag is `#` plus Unicode letters/digits and `_`, `-`, `/` (and emoji).
// The lookbehind rejects `a#b`, `##x`, `&#123;` and the escaped `\#x`.
const TAG =
  /(?<![\p{L}\p{N}_#&\\])#((?:[\p{L}\p{N}_\-/]|\p{Extended_Pictographic})+)/gu;
const TAG_NON_NUMERIC = /[^\p{N}\-/]/u;

function blanks(s: string): string {
  return " ".repeat(s.length);
}

/**
 * Column where a list item's content starts, relative to the text after any
 * quote prefix, which starts at column `from`: past the marker and one to
 * four columns of blanks. With none, or five or more (which start indented
 * code), it is one past the marker.
 */
function contentColumn(lm: RegExpExecArray, from: number): number {
  const marker = indentWidth(lm[1], from) + lm[2].length;
  const gap = indentWidth(
    lm[0].slice(lm[1].length + lm[2].length),
    from + marker,
  );
  return marker + (gap >= 1 && gap <= 4 ? gap : 1);
}

/** Column after `s` when it starts at column `from`, with tab stops of 4. */
function columnAfter(s: string, from = 0): number {
  let w = from;
  for (const ch of s) w = ch === "\t" ? w + 4 - (w % 4) : w + 1;
  return w;
}

/** Width of the blanks that start `s`, when `s` starts at column `from`. */
function indentWidth(s: string, from = 0): number {
  return columnAfter(/^[ \t]*/.exec(s)![0], from) - from;
}

/** A fence opener; a backtick fence's info string holds no backtick. */
function fenceOpener(s: string): RegExpExecArray | null {
  const fo = FENCE_OPEN.exec(s);
  return fo && !(fo[2][0] === "`" && fo[3].includes("`")) ? fo : null;
}

/** A block quote in a container stack. A list item is its content column. */
const QUOTE = -1;

/** A line split after its container prefixes. */
interface Prefix {
  /** Text after the prefixes and the blanks that follow them. */
  rest: string;
  /** Column where `rest` starts. */
  col: number;
  /** Content column of the innermost container, 0 at the top level. */
  content: number;
  /** Number of quotes around `rest`. */
  depth: number;
  /** How many containers of the open stack the line continues. */
  matched: number;
  /** Those containers, then the ones the line opens. */
  open: number[];
}

/**
 * Consumes the container prefixes of a line in order: first those that
 * continue the `open` stack (a quote's `>`, a list item's indentation up to
 * its content column, which a blank line also continues), then, with `nest`,
 * the quote and list markers that open new containers, each at most 3
 * columns past the content column before it. A tab that crosses a content
 * column is left in `rest`, so its remaining width still counts as indent.
 */
function containerPrefix(
  text: string,
  open: readonly number[],
  nest: boolean,
): Prefix {
  let pos = 0;
  let col = 0;
  let content = 0;
  let depth = 0;
  const out: number[] = [];
  const quote = (): boolean => {
    const rest = text.slice(pos);
    const qm = /^[ \t]*>[ \t]?/.exec(rest);
    if (!qm || col + indentWidth(rest, col) - content > 3) return false;
    pos += qm[0].length;
    col = content = columnAfter(qm[0], col);
    depth++;
    return true;
  };
  for (const c of open) {
    if (c === QUOTE) {
      if (!quote()) break;
    } else {
      const rest = text.slice(pos);
      if (rest.trim() !== "") {
        if (col + indentWidth(rest, col) < c) break;
        while (columnAfter(text[pos], col) <= c) {
          col = columnAfter(text[pos++], col);
        }
      }
      content = c;
    }
    out.push(c);
  }
  const matched = out.length;
  while (nest) {
    const rest = text.slice(pos);
    if (quote()) {
      out.push(QUOTE);
      continue;
    }
    const lm = THEMATIC_BREAK.test(rest) ? null : LIST_MARKER.exec(rest);
    if (!lm || col + indentWidth(rest, col) - content > 3) break;
    content = col + contentColumn(lm, col);
    pos += lm[1].length + lm[2].length;
    col = columnAfter(lm[1] + lm[2], col);
    out.push(content);
  }
  const lead = /^[ \t]*/.exec(text.slice(pos))![0];
  return {
    rest: text.slice(pos + lead.length),
    col: columnAfter(lead, col),
    content,
    depth,
    matched,
    open: out,
  };
}

/**
 * Blanks out inline code spans, keeping the string length so offsets stay
 * valid. A span opens at a backtick run and closes at the next run of the
 * same length. An unmatched run is literal text.
 */
function maskInlineCode(text: string): string {
  const runs: Array<{ idx: number; len: number }> = [];
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // A lone backslash-escaped backtick is literal.
    if (m.index > 0 && text[m.index - 1] === "\\" && m[0].length === 1) {
      continue;
    }
    runs.push({ idx: m.index, len: m[0].length });
  }
  if (runs.length === 0) return text;
  const chars = text.split("");
  for (let a = 0; a < runs.length; a++) {
    let b = -1;
    for (let k = a + 1; k < runs.length; k++) {
      if (runs[k].len === runs[a].len) {
        b = k;
        break;
      }
    }
    if (b === -1) continue;
    const to = runs[b].idx + runs[b].len;
    for (let p = runs[a].idx; p < to; p++) {
      if (chars[p] !== "\n") chars[p] = " ";
    }
    a = b;
  }
  return chars.join("");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The `link` of a markdown link's destination. The destination is split at
 * its first literal `#` before anything is decoded: the text after it is a
 * subpath, and a `#` in the path part is written `%23` and is a character
 * of a name. The path part is then decoded, and a `#` or `%` that decoding
 * produced is escaped again (see `escapeLinkPath`), so the string still
 * says where the file part ends.
 */
export function markdownLinkTarget(dest: string): string {
  const hash = dest.indexOf("#");
  const path = hash === -1 ? dest : dest.slice(0, hash);
  const fragment = hash === -1 ? "" : safeDecode(dest.slice(hash));
  return escapeLinkPath(safeDecode(path)) + fragment;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────────

interface SourceLine {
  text: string;
  /** Offset of the line's first character in the content. */
  start: number;
}

function splitLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let pos = 0;
  for (;;) {
    const nl = content.indexOf("\n", pos);
    if (nl === -1) {
      lines.push({ text: content.slice(pos), start: pos });
      return lines;
    }
    const end = nl > pos && content[nl - 1] === "\r" ? nl - 1 : nl;
    lines.push({ text: content.slice(pos, end), start: pos });
    pos = nl + 1;
  }
}

interface Span {
  sl: number;
  sc: number;
  el: number;
  ec: number;
}

interface Unit {
  kind: "paragraph" | "quote" | "table" | "list" | "code" | "heading";
  span: Span;
}

interface Tracker {
  active: boolean;
  /** Open items: marker indent and start line. */
  stack: Array<{ indent: number; line: number }>;
  first: number;
  item: ListItemCache | null;
  itemIndent: number;
  span: Span | null;
}

function newTracker(): Tracker {
  return {
    active: false,
    stack: [],
    first: -1,
    item: null,
    itemIndent: 0,
    span: null,
  };
}

/**
 * Computes the cache Obsidian would hold for `content`.
 *
 * Produced fields: `frontmatter`, `frontmatterPosition`, `frontmatterLinks`,
 * `headings`, `tags` (inline only), `links`, `embeds`, `blocks`, `listItems`.
 * Empty collections are omitted, like Obsidian does. Frontmatter tags are NOT
 * mirrored into `tags`: Obsidian keeps them in `frontmatter.tags`, and the
 * tools combine the two sources themselves.
 */
export function parseMetadata(content: string): CachedMetadata {
  const lines = splitLines(content);
  const fm = parseFrontmatterBlock(content);
  const firstBodyLine = fm ? fm.position.end.line + 1 : 0;

  const meta: CachedMetadata = {};
  const headings: HeadingCache[] = [];
  const tags: TagCache[] = [];
  const links: LinkCache[] = [];
  const embeds: EmbedCache[] = [];
  const listItems: ListItemCache[] = [];
  const blocks: Record<string, BlockCache> = Object.create(null);

  const loc = (line: number, col: number): Loc => ({
    line,
    col,
    offset: lines[line].start + col,
  });
  const posOf = (s: Span): Pos => ({
    start: loc(s.sl, s.sc),
    end: loc(s.el, s.ec),
  });
  const registerBlock = (id: string, span: Span): void => {
    if (Object.prototype.hasOwnProperty.call(blocks, id)) return;
    blocks[id] = { id, position: posOf(span) };
  };

  // Per-line quote prefix length and leading chars blanked before inline scan.
  const preOf: number[] = new Array(lines.length).fill(0);
  const headMask: number[] = new Array(lines.length).fill(0);

  // ── Inline scanning (links, embeds, tags) ─────────────────────────────────
  // Lines are scanned in "runs": consecutive lines of one paragraph, list
  // item, quote or heading. Inline code is masked per run because a code span
  // may continue onto the next line of the same paragraph.
  let run: number[] = [];

  const scanLine = (i: number, masked: string): void => {
    const pre = preOf[i];
    const orig = lines[i].text.slice(pre);
    const found: Array<{ col: number; embed: boolean; ref: LinkCache }> = [];

    // Link syntax inside a markdown link (its title or destination) is part
    // of that link, not another one.
    const mdSpans: Array<[number, number]> = [];
    MD_LINK.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MD_LINK.exec(masked)) !== null) {
      mdSpans.push([m.index, m.index + m[0].length]);
      let dest = m[3];
      if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1);
      dest = dest.trim();
      if (dest === "" || URL_SCHEME.test(dest) || dest.startsWith("//")) {
        continue;
      }
      const col = pre + m.index;
      found.push({
        col,
        embed: m[1] === "!",
        ref: {
          link: markdownLinkTarget(dest),
          original: orig.slice(m.index, m.index + m[0].length),
          displayText: orig.slice(
            m.index + m[1].length + 1,
            m.index + m[1].length + 1 + m[2].length,
          ),
          position: posOf({
            sl: i,
            sc: col,
            el: i,
            ec: col + m[0].length,
          }),
        },
      });
    }

    WIKILINK.lastIndex = 0;
    while ((m = WIKILINK.exec(masked)) !== null) {
      const at = m.index;
      if (mdSpans.some(([from, to]) => at >= from && at < to)) continue;
      const inner = orig.slice(
        m.index + 2 + m[1].length,
        m.index + m[0].length - 2,
      );
      const sep = inner.search(/\\?\|/);
      const target = (sep === -1 ? inner : inner.slice(0, sep)).trim();
      if (target === "") continue;
      const alias =
        sep === -1
          ? undefined
          : inner
              .slice(sep)
              .replace(/^\\?\|/, "")
              .trim();
      const col = pre + m.index;
      found.push({
        col,
        embed: m[1] === "!",
        ref: {
          link: target,
          original: orig.slice(m.index, m.index + m[0].length),
          displayText: alias || target,
          position: posOf({
            sl: i,
            sc: col,
            el: i,
            ec: col + m[0].length,
          }),
        },
      });
    }

    found.sort((a, b) => a.col - b.col);
    for (const f of found) (f.embed ? embeds : links).push(f.ref);

    // Tags: hide link syntax and URLs first so `[[a#b]]` and
    // `https://x/#frag` never yield tags.
    const forTags = masked
      .replace(/!?\[\[[^\]\n]*\]\]/g, blanks)
      .replace(/\]\([^)\n]*\)/g, blanks)
      .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>)\]]*/g, blanks);
    TAG.lastIndex = 0;
    while ((m = TAG.exec(forTags)) !== null) {
      if (!TAG_NON_NUMERIC.test(m[1])) continue;
      const col = pre + m.index;
      tags.push({
        tag: `#${m[1]}`,
        position: posOf({ sl: i, sc: col, el: i, ec: col + m[0].length }),
      });
    }
  };

  const flushRun = (): void => {
    if (run.length === 0) return;
    const parts = run.map((i) => {
      const inner = lines[i].text.slice(preOf[i]);
      return headMask[i] > 0
        ? blanks(inner.slice(0, headMask[i])) + inner.slice(headMask[i])
        : inner;
    });
    const maskedParts = maskInlineCode(parts.join("\n")).split("\n");
    run.forEach((i, k) => scanLine(i, maskedParts[k]));
    run = [];
  };

  // ── Block structure ───────────────────────────────────────────────────────
  const prev: { unit: Unit | null } = { unit: null };
  const pushUnit = (u: Unit): void => {
    prev.unit = u;
  };

  const topList = newTracker();
  const quoteList = newTracker();

  const finishItem = (t: Tracker): void => {
    const item = t.item;
    if (!item) return;
    const last = item.position.end.line;
    const text = lines[last].text.slice(preOf[last]);
    const m = BLOCK_ID_END.exec(text);
    if (m) {
      item.id = m[1];
      registerBlock(m[1], {
        sl: item.position.start.line,
        sc: item.position.start.col,
        el: item.position.end.line,
        ec: item.position.end.col,
      });
    }
    t.item = null;
  };

  const closeTracker = (t: Tracker, asUnit: boolean): void => {
    finishItem(t);
    if (asUnit && t.active && t.span) {
      pushUnit({ kind: "list", span: t.span });
    }
    t.active = false;
    t.stack = [];
    t.first = -1;
    t.span = null;
  };

  const addItem = (
    t: Tracker,
    i: number,
    markerCol: number,
    indent: number,
    task: string | undefined,
  ): void => {
    finishItem(t);
    const len = lines[i].text.length;
    if (!t.active) {
      t.active = true;
      t.stack = [];
      t.first = i;
      t.span = { sl: i, sc: markerCol, el: i, ec: len };
    }
    while (t.stack.length && t.stack[t.stack.length - 1].indent >= indent) {
      t.stack.pop();
    }
    // Root items carry the negated first line of their list. Line 0 would
    // negate to -0, which callers' `>= 0` checks read as a real parent, so
    // that one case uses -1 (a list that starts on the first line).
    const parent = t.stack.length
      ? t.stack[t.stack.length - 1].line
      : t.first === 0
        ? -1
        : -t.first;
    t.stack.push({ indent, line: i });
    const item: ListItemCache = {
      parent,
      position: posOf({ sl: i, sc: markerCol, el: i, ec: len }),
    };
    if (task !== undefined) item.task = task;
    listItems.push(item);
    t.item = item;
    t.itemIndent = indent;
    t.span!.el = i;
    t.span!.ec = len;
  };

  const extendItem = (t: Tracker, i: number): void => {
    if (!t.item) return;
    const len = lines[i].text.length;
    t.item.position.end = loc(i, len);
    if (t.span) {
      t.span.el = i;
      t.span.ec = len;
    }
  };

  type Group = { kind: "paragraph" | "quote" | "table"; span: Span };
  // Held in an object: closures reassign it, which TypeScript's flow
  // analysis cannot see through a plain `let`.
  const st: { grp: Group | null } = { grp: null };

  const closeGroup = (): void => {
    const g = st.grp;
    if (!g) return;
    st.grp = null;
    if (g.kind === "table") {
      pushUnit({ kind: "table", span: g.span });
      return;
    }
    if (g.kind === "quote") {
      const itemOwnsId =
        quoteList.item !== null &&
        quoteList.item.position.end.line === g.span.el;
      closeTracker(quoteList, false);
      if (!itemOwnsId) {
        const m = BLOCK_ID_END.exec(
          lines[g.span.el].text.slice(preOf[g.span.el]),
        );
        if (m) registerBlock(m[1], g.span);
      }
      pushUnit({ kind: "quote", span: g.span });
      return;
    }
    // Paragraph. A paragraph that is only `^id` names the block before it.
    if (g.span.sl === g.span.el) {
      const alone = BLOCK_ID_ALONE.exec(lines[g.span.sl].text);
      const before = prev.unit;
      if (alone && before && before.kind !== "heading") {
        registerBlock(alone[1], before.span);
        return;
      }
    }
    const m = BLOCK_ID_END.exec(lines[g.span.el].text);
    if (m) registerBlock(m[1], g.span);
    pushUnit({ kind: "paragraph", span: g.span });
  };

  const closeList = (): void => closeTracker(topList, true);

  // Adds line `i` to the open quote group, or starts one there.
  const enterQuote = (i: number, pre: number): boolean => {
    const g = st.grp;
    const len = lines[i].text.length;
    if (g && g.kind === "quote") {
      g.span.el = i;
      g.span.ec = len;
      return true;
    }
    flushRun();
    closeGroup();
    // A quote inside a list item leaves the list open for the items after it.
    if ((open[0] ?? QUOTE) === QUOTE) closeList();
    const sc = indentWidth(lines[i].text.slice(0, pre));
    st.grp = { kind: "quote", span: { sl: i, sc, el: i, ec: len } };
    return false;
  };

  // Containers open after the previous line (see `containerPrefix`), and
  // whether the innermost one holds a paragraph a line may continue.
  let open: number[] = [];
  let para = false;
  let fence: {
    ch: string;
    len: number;
    startLine: number;
    /** Quote depth of the container the fence opened in. */
    depth: number;
  } | null = null;
  let afterBlank = false;
  let indentedCode: Unit | null = null;

  for (let i = firstBodyLine; i < lines.length; i++) {
    const text = lines[i].text;

    // Fenced code: everything up to the closing fence is opaque, until the
    // fence closes or a line leaves a container the fence opened in (a
    // quote, a list item). That line is then read normally.
    if (fence) {
      const c = containerPrefix(text, open, false);
      if (c.matched === open.length) {
        if (fence.depth > 0 && st.grp) {
          st.grp.span.el = i;
          st.grp.span.ec = text.length;
        }
        const close = /^(`{3,}|~{3,})[ \t]*$/.exec(c.rest);
        if (
          close &&
          close[1][0] === fence.ch &&
          close[1].length >= fence.len &&
          c.col - c.content <= 3
        ) {
          if (fence.depth === 0) {
            pushUnit({
              kind: "code",
              span: { sl: fence.startLine, sc: 0, el: i, ec: text.length },
            });
          }
          fence = null;
        }
        continue;
      }
      // Nothing is left open for this line to continue lazily.
      fence = null;
      afterBlank = true;
    }

    // Code is told apart past the line's containers. Indented code sits four
    // columns past the content column where no paragraph continues, a fence
    // opener at most three. A lazy paragraph line keeps the containers it
    // skips.
    const c = containerPrefix(text, open, true);
    const blank = c.rest.trim() === "";
    const paragraphOpen: boolean = para && c.open.length === c.matched;
    const indented: boolean =
      !blank && !paragraphOpen && c.col - c.content >= 4;
    const fo = c.col - c.content <= 3 ? fenceOpener(c.rest) : null;
    const opener = fo && {
      ch: fo[2][0],
      len: fo[2].length,
      startLine: i,
      depth: c.depth,
    };
    if (!paragraphOpen || blank || fo || HEADING.test(c.rest)) open = c.open;
    para = !blank && !indented && !fo;

    const q = QUOTE_PREFIX.exec(text);
    const pre = q ? q[0].length : 0;
    preOf[i] = pre;
    const inner = text.slice(pre);
    // Column where `inner` starts, so tabs in it reach the right tab stop.
    const preCol = columnAfter(text.slice(0, pre));

    if (inner.trim() === "") {
      if (pre > 0 && st.grp && st.grp.kind === "quote") {
        // Empty quote line (`>`): stays inside the quote.
        flushRun();
        const g = st.grp!;
        g.span.el = i;
        g.span.ec = text.length;
        continue;
      }
      flushRun();
      closeGroup();
      afterBlank = true;
      continue;
    }

    const indent = indentWidth(inner, preCol);
    const inItem = open.some((k) => k !== QUOTE);
    const lm = THEMATIC_BREAK.test(inner) ? null : LIST_MARKER.exec(inner);
    // A line that opens a list item is read as one below, even when the
    // item starts with code.
    const newItem =
      lm !== null && c.open.slice(c.matched).some((k) => k !== QUOTE);

    // Indented code is opaque like fenced code. Blank lines in between do
    // not end it.
    if (indented && !newItem) {
      flushRun();
      if (open.length > 0) {
        indentedCode = null;
        if (pre > 0) enterQuote(i, pre);
        if (inItem) extendItem(pre > 0 ? quoteList : topList, i);
        afterBlank = false;
        continue;
      }
      closeList();
      if (indentedCode) {
        indentedCode.span.el = i;
        indentedCode.span.ec = text.length;
      } else {
        indentedCode = {
          kind: "code",
          span: { sl: i, sc: 0, el: i, ec: text.length },
        };
        pushUnit(indentedCode);
      }
      afterBlank = false;
      continue;
    }
    indentedCode = null;

    // Fence opener.
    if (opener && !newItem) {
      flushRun();
      if (pre > 0) {
        enterQuote(i, pre);
      } else {
        closeGroup();
        if (!inItem) closeList();
      }
      fence = opener;
      afterBlank = false;
      continue;
    }

    // ATX heading.
    const hm = pre === 0 ? HEADING.exec(inner) : null;
    if (hm) {
      flushRun();
      closeGroup();
      closeList();
      para = false;
      const raw = (hm[3] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trimEnd();
      const span = { sl: i, sc: hm[1].length, el: i, ec: text.length };
      headings.push({
        heading: raw,
        level: hm[2].length,
        position: posOf(span),
      });
      pushUnit({ kind: "heading", span });
      headMask[i] = hm[1].length + hm[2].length;
      run = [i];
      flushRun();
      afterBlank = false;
      continue;
    }

    // List item.
    if (lm) {
      const markerCol = pre + lm[1].length;
      const tm = TASK_BOX.exec(inner.slice(lm[0].length));
      const task = tm ? tm[1] : undefined;
      flushRun();
      if (pre === 0) closeGroup();
      else enterQuote(i, pre);
      addItem(
        pre > 0 ? quoteList : topList,
        i,
        markerCol,
        indentWidth(lm[1], preCol),
        task,
      );
      if (opener) fence = opener;
      else if (!indented) run = [i];
      afterBlank = false;
      continue;
    }

    // Table row.
    if (pre === 0 && indent <= 3 && inner.trim().startsWith("|")) {
      flushRun();
      if (st.grp && st.grp.kind === "table") {
        st.grp.span.el = i;
        st.grp.span.ec = text.length;
      } else {
        closeGroup();
        closeList();
        st.grp = {
          kind: "table",
          span: { sl: i, sc: indent, el: i, ec: text.length },
        };
      }
      run = [i];
      flushRun();
      afterBlank = false;
      continue;
    }

    // Quote line without a list marker.
    if (pre > 0) {
      if (enterQuote(i, pre)) {
        if (quoteList.item && indent > quoteList.itemIndent) {
          extendItem(quoteList, i);
        } else {
          if (quoteList.active) {
            finishItem(quoteList);
            quoteList.active = false;
            quoteList.stack = [];
          }
          if (run.length === 0 || afterBlank) flushRun();
        }
      }
      run.push(i);
      afterBlank = false;
      continue;
    }

    // Plain text.
    if (
      topList.active &&
      topList.item &&
      (!afterBlank || indent > topList.itemIndent)
    ) {
      extendItem(topList, i);
      run.push(i);
    } else if (st.grp && st.grp.kind !== "table") {
      // Paragraph continuation, or lazy continuation of a quote.
      const g = st.grp;
      g.span.el = i;
      g.span.ec = text.length;
      if (g.kind === "quote" && quoteList.item) extendItem(quoteList, i);
      run.push(i);
    } else {
      flushRun();
      closeGroup();
      closeList();
      st.grp = {
        kind: "paragraph",
        span: { sl: i, sc: indent, el: i, ec: text.length },
      };
      run = [i];
    }
    afterBlank = false;
  }

  flushRun();
  closeGroup();
  closeList();

  // ── Frontmatter ───────────────────────────────────────────────────────────
  const frontmatterLinks: FrontmatterLinkCache[] = [];
  if (fm) {
    meta.frontmatterPosition = fm.position;
    if (fm.data && Object.keys(fm.data).length > 0) {
      meta.frontmatter = fm.data;
      // YAML aliases can make the data cyclic (`a: &self` with `next:
      // *self`), so each object is walked once.
      const seen = new Set<object>();
      const walk = (value: unknown, key: string): void => {
        if (value && typeof value === "object") {
          if (seen.has(value)) return;
          seen.add(value);
        }
        if (typeof value === "string") {
          const re = /\[\[([^[\]\n]*)\]\]/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(value)) !== null) {
            const sep = m[1].search(/\\?\|/);
            const target = (sep === -1 ? m[1] : m[1].slice(0, sep)).trim();
            if (target === "") continue;
            const alias =
              sep === -1
                ? undefined
                : m[1]
                    .slice(sep)
                    .replace(/^\\?\|/, "")
                    .trim();
            frontmatterLinks.push({
              key,
              link: target,
              original: m[0],
              displayText: alias || target,
            });
          }
        } else if (Array.isArray(value)) {
          value.forEach((v, idx) => walk(v, `${key}.${idx}`));
        } else if (value && typeof value === "object") {
          for (const k of Object.keys(value)) {
            walk((value as Record<string, unknown>)[k], `${key}.${k}`);
          }
        }
      };
      for (const k of Object.keys(fm.data)) walk(fm.data[k], k);
    }
  }

  if (frontmatterLinks.length) meta.frontmatterLinks = frontmatterLinks;
  if (headings.length) meta.headings = headings;
  if (tags.length) meta.tags = tags;
  if (links.length) meta.links = links;
  if (embeds.length) meta.embeds = embeds;
  if (listItems.length) meta.listItems = listItems;
  if (Object.keys(blocks).length) meta.blocks = blocks;
  return meta;
}
