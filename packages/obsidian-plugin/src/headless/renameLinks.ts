/**
 * Link rewriting for a rename or move, as pure text edits.
 *
 * A rename changes where links point in two ways. Links in other notes
 * that target a moved file need a new target. Links inside a moved note
 * that were relative, or that resolved by their place in the folder tree,
 * may need a new spelling to keep their target. Both are one question per
 * link: where did it point before the move, and does its text still lead
 * there afterwards? Two resolvers answer it, one built over the file set
 * before the move and one over the file set after it. A link whose text
 * still resolves to the moved target is left alone, so a folder rename
 * does not touch `[[note]]`. Any other link is rewritten in the style it
 * was written in:
 *
 * - relative (`./x.md`, `../x.md`) stays relative to the note that holds it
 * - a bare name (`[[x]]`) stays the shortest form: the name when exactly
 *   one file has it, else the full path
 * - a path that spells the target's whole path stays a full path
 * - a leading `/` stays rooted
 * - `.md` is kept or dropped as the link had it, the alias, subpath,
 *   embed mark, markdown link text, title, angle brackets and URL encoding
 *   carry over
 *
 * Positions come from the metadata cache (`LinkCache.position`). Frontmatter
 * links have no position, so the frontmatter is parsed as YAML and each
 * string value (never a key) that holds a link is rewritten through its
 * source range, in its own quoting style.
 *
 * Every new spelling is parsed back on its own and resolved, and only one
 * that leads to the target is written. A link with no such spelling, such
 * as a relative link to a file in a folder named `a#b`, is left as written
 * and reported.
 *
 * The same rewriting serves a canvas text node (`rewrite`, it is markdown)
 * and a `.base` file (`rewriteText`, which finds links in text that is not
 * markdown). `renameReferences.ts` adds the parts that are not links: a
 * canvas file node's path, and a mention of the old path in a base filter.
 *
 * Limits: the same-name tie-break of the resolver is the only ambiguity
 * rule, and a link that did not resolve before the move is left as written.
 */

import type { CachedMetadata } from "obsidian";
import { isCollection, parseDocument, visit, type Scalar } from "yaml";
import {
  createLinkResolver,
  escapeLinkPath,
  type LinkResolver,
} from "./linkResolution";
import { parseFrontmatterBlock, parseMetadata } from "./parseMetadata";

export type LinkRewriter = {
  /**
   * `content` of the note that was at `oldSource` before the move, with its
   * links updated, and the original text of each link left as written
   * because no spelling of it leads to its target. `cache` must describe
   * exactly `content`, or be null to parse it here.
   */
  rewrite(
    content: string,
    cache: CachedMetadata | null,
    oldSource: string,
  ): { content: string; unwritable: string[] };
  /**
   * `rewrite` for text that is not a note: every wikilink and markdown link
   * found anywhere in it is updated, with no regard for code spans or
   * fences. For a `.base` file, which is YAML.
   */
  rewriteText(
    content: string,
    oldSource: string,
  ): { content: string; unwritable: string[] };
};

/**
 * Build the rewriter for one move. `before` lists every file path before
 * it, `moves` maps each moved file's old path to its new one.
 */
export function createLinkRewriter(
  before: Iterable<string>,
  moves: ReadonlyMap<string, string>,
): LinkRewriter {
  const prePaths = [...before];
  const postPaths = prePaths.map((p) => moves.get(p) ?? p);
  const pre = createLinkResolver(prePaths);
  const post = createLinkResolver(postPaths);
  const nameCount = new Map<string, number>();
  for (const p of postPaths) {
    const key = basename(p).toLowerCase();
    nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
  }
  const ctx: Context = { pre, post, nameCount, moves };

  return {
    rewrite(content, cache, oldSource) {
      const note: Note = {
        ...ctx,
        oldSource,
        newSource: moves.get(oldSource) ?? oldSource,
        unwritable: [],
      };
      const meta = cache ?? parseMetadata(content);
      const edits: Edit[] = [];

      // Link syntax inside a larger link (a markdown link's title) is part
      // of that link, so only the outer one is edited.
      const refs = [...(meta.links ?? []), ...(meta.embeds ?? [])].sort(
        (a, b) =>
          a.position.start.offset - b.position.start.offset ||
          b.position.end.offset - a.position.end.offset,
      );
      let outerEnd = -1;
      for (const ref of refs) {
        const { start, end } = ref.position;
        if (start.offset < outerEnd && end.offset <= outerEnd) continue;
        outerEnd = Math.max(outerEnd, end.offset);
        const text = rewriteBodyLink(ref.original, note);
        if (text !== null) {
          edits.push({
            start: ref.position.start.offset,
            end: ref.position.end.offset,
            text,
          });
        }
      }

      if (meta.frontmatterLinks?.length) {
        edits.push(...frontmatterEdits(content, note));
      }

      edits.sort((a, b) => b.start - a.start);
      // The edits all use offsets of the original text: if two overlap, the
      // result would be garbage, so the note is left as it is.
      for (let i = 1; i < edits.length; i++) {
        if (edits[i].end > edits[i - 1].start) {
          throw new Error("Link edits overlap");
        }
      }
      return {
        content: applyEdits(content, edits),
        unwritable: note.unwritable,
      };
    },

    rewriteText(content, oldSource) {
      const note: Note = {
        ...ctx,
        oldSource,
        newSource: moves.get(oldSource) ?? oldSource,
        unwritable: [],
      };
      const edits: Edit[] = [];
      for (const found of content.matchAll(TEXT_LINK)) {
        const text = rewriteBodyLink(found[0], note);
        if (text !== null) {
          edits.push({
            start: found.index,
            end: found.index + found[0].length,
            text,
          });
        }
      }
      return {
        content: applyEdits(content, edits),
        unwritable: note.unwritable,
      };
    },
  };
}

/** What `rewriteText` takes for a link: a wikilink, or a bracket pair with a parenthesis after it. */
const TEXT_LINK =
  /!?\[\[[^[\]\n]*\]\]|!?\[(?:[^[\]\n\\]|\\.)*\]\([^\n)]*(?:\([^\n)]*\)[^\n)]*)*\)/g;

/** `edits` applied to `content`, last first so the offsets stay valid. */
function applyEdits(content: string, edits: Edit[]): string {
  let out = content;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Frontmatter                                                         */
/* ------------------------------------------------------------------ */

const FRONTMATTER_LINK = /\[\[[^[\]\n]*\]\]/g;

/**
 * Edits for the links in the frontmatter's string values (never its keys).
 * Each value that holds a link to rewrite is replaced as a whole through
 * its source range, spelled in its own quoting style when that can hold
 * the new text. The rest of the block is not touched.
 */
function frontmatterEdits(content: string, note: Note): Edit[] {
  const block = parseFrontmatterBlock(content);
  if (block === null) return [];
  const text = content.slice(block.openEnd, block.closeStart);
  const doc = parseDocument(text, { logLevel: "silent" });
  if (doc.errors.length > 0) return [];

  const replaceLinks = (value: string): string =>
    value.replace(
      FRONTMATTER_LINK,
      (m) => rewriteWikilink(m, note, readFrontmatterLink) ?? m,
    );
  const edits: Edit[] = [];
  visit(doc, {
    // A complex mapping key (`? [...]`) is a key all the way down.
    Collection(key) {
      if (key === "key") return visit.SKIP;
    },
    Scalar(key, node, path) {
      if (key === "key" || typeof node.value !== "string" || !node.range) {
        return;
      }
      const [start, end] = node.range;
      if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") {
        // The content is raw text after the header line: edit it in place.
        const header = text.indexOf("\n", start) + 1;
        if (header === 0 || header > end) return;
        const next = replaceLinks(text.slice(header, end));
        if (next !== text.slice(header, end)) {
          edits.push({
            start: block.openEnd + header,
            end: block.openEnd + end,
            text: next,
          });
        }
        return;
      }
      const next = replaceLinks(node.value);
      if (next === node.value) return;
      const inFlow = path.some((p) => isCollection(p) && p.flow === true);
      edits.push({
        start: block.openEnd + start,
        end: block.openEnd + end,
        text: spellScalar(next, node.type, inFlow),
      });
    },
  });
  return edits;
}

/**
 * `value` as YAML text for a scalar written in style `type`, or in the
 * first of single-quoted and double-quoted that holds it when `type`
 * cannot. Every spelling is parsed back and must give `value` again.
 */
function spellScalar(
  value: string,
  type: Scalar.Type | null | undefined,
  inFlow: boolean,
): string {
  const spell: Record<string, (v: string) => string | null> = {
    PLAIN: (v) => (v.includes("\n") ? null : v),
    QUOTE_SINGLE: (v) =>
      v.includes("\n") ? null : `'${v.replace(/'/g, "''")}'`,
    QUOTE_DOUBLE: (v) =>
      JSON.stringify(v).replace(
        /[\x7f-\x9f\u2028\u2029\ufeff]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
  };
  for (const style of [type ?? "PLAIN", "QUOTE_SINGLE", "QUOTE_DOUBLE"]) {
    const text = spell[style]?.(value) ?? null;
    if (text === null) continue;
    const parsed = parseDocument(inFlow ? `[${text}]` : `k: ${text}`, {
      logLevel: "silent",
    });
    if (parsed.errors.length > 0) continue;
    const got: unknown = parsed.toJS();
    const scalar = inFlow
      ? (got as unknown[])[0]
      : (got as Record<string, unknown>).k;
    if (scalar === value) return text;
  }
  return JSON.stringify(value);
}

type Edit = { start: number; end: number; text: string };

type Context = {
  pre: LinkResolver;
  post: LinkResolver;
  /** Files per lowercase file name after the move. */
  nameCount: ReadonlyMap<string, number>;
  moves: ReadonlyMap<string, string>;
};

/** One note being rewritten. */
type Note = Context & {
  oldSource: string;
  newSource: string;
  /** Links left as written: no spelling of them leads to their target. */
  unwritable: string[];
};

/* ------------------------------------------------------------------ */
/* Path helpers                                                        */
/* ------------------------------------------------------------------ */

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function stripMd(p: string): string {
  return p.toLowerCase().endsWith(".md") ? p.slice(0, -3) : p;
}

/** `to` as a path relative to the folder `fromDir`, always with `./` or `../`. */
function relativePath(fromDir: string, to: string): string {
  const from = fromDir === "" ? [] : fromDir.split("/");
  const target = to.split("/");
  let common = 0;
  while (
    common < from.length &&
    common < target.length - 1 &&
    from[common] === target[common]
  ) {
    common += 1;
  }
  const ups = from.length - common;
  const rest = target.slice(common).join("/");
  return ups === 0 ? `./${rest}` : `${"../".repeat(ups)}${rest}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/* ------------------------------------------------------------------ */
/* One link                                                            */
/* ------------------------------------------------------------------ */

type Style = "relative" | "rooted" | "full" | "shortest";

function styleOf(linkpath: string, oldTarget: string): Style {
  if (linkpath.startsWith("./") || linkpath.startsWith("../")) {
    return "relative";
  }
  if (linkpath.startsWith("/")) return "rooted";
  if (
    linkpath.includes("/") &&
    stripMd(linkpath).toLowerCase() === stripMd(oldTarget).toLowerCase()
  ) {
    return "full";
  }
  return "shortest";
}

/**
 * The new linkpaths to try, best first, for a link written as `linkpath`
 * in the note, or null when it needs no change (or cannot be resolved).
 * Also returns the file it points at before and after the move.
 */
function retarget(
  linkpath: string,
  note: Note,
): { candidates: string[]; oldTarget: string; target: string } | null {
  const { pre, post, nameCount, moves, oldSource, newSource } = note;
  if (linkpath === "") return null;
  // The resolver ends a file part at a `#`, so a `#` or `%` that is part of
  // a name is handed over escaped, as the parser does for a link.
  const key = escapeLinkPath(linkpath);
  const oldTarget = pre.resolve(key, oldSource);
  if (oldTarget === null) return null;
  const target = moves.get(oldTarget) ?? oldTarget;
  if (post.resolve(key, newSource) === target) return null;

  const keepMd = linkpath.toLowerCase().endsWith(".md");
  const spell = (p: string) =>
    p.toLowerCase().endsWith(".md") && !keepMd ? p.slice(0, -3) : p;
  const full = spell(target);
  const unique = nameCount.get(basename(target).toLowerCase()) === 1;
  const shortest = unique ? spell(basename(target)) : full;
  const style = styleOf(linkpath, oldTarget);
  const candidates =
    style === "relative"
      ? [spell(relativePath(dirname(newSource), target)), full]
      : style === "rooted"
        ? [`/${full}`, full]
        : style === "full"
          ? [full]
          : [shortest, full];
  // The last resort is the exact path with its extension.
  return { candidates: [...candidates, target], oldTarget, target };
}

/**
 * The link text `spell` builds from the first candidate of `next` that
 * reads back, through `read`, as a link that leads to the target. Null
 * when the link needs no change, or when no candidate does: the link is
 * then left as written and recorded.
 */
function respell(
  original: string,
  linkpath: string,
  next: { candidates: string[]; target: string },
  note: Note,
  spell: (path: string) => string | null,
  read: (text: string) => string | null,
): string | null {
  for (const path of next.candidates) {
    const text = spell(path);
    const link = text === null ? null : read(text);
    if (link === null) continue;
    if (note.post.resolve(link, note.newSource) !== next.target) continue;
    return path === linkpath ? null : text;
  }
  note.unwritable.push(original);
  return null;
}

/**
 * The link `text` holds when it stands alone in a note body, or null when
 * it does not read as exactly one link.
 */
function readBodyLink(text: string): string | null {
  const meta = parseMetadata(text);
  const whole = [...(meta.links ?? []), ...(meta.embeds ?? [])].filter(
    (r) =>
      r.position.start.offset === 0 && r.position.end.offset === text.length,
  );
  return whole.length === 1 ? whole[0].link : null;
}

/**
 * The link `text` holds as a frontmatter string value, or null when it does
 * not read as exactly one link.
 */
function readFrontmatterLink(text: string): string | null {
  const value = spellScalar(text, "QUOTE_DOUBLE", false);
  const links = parseMetadata(`---\nk: ${value}\n---\n`).frontmatterLinks ?? [];
  return links.length === 1 && links[0].original === text
    ? links[0].link
    : null;
}

/**
 * `[[target#sub|alias]]` or `![[...]]`; null when it needs no change or
 * cannot be written. `read` parses a link in the place it is written.
 */
function rewriteWikilink(
  original: string,
  note: Note,
  read: (text: string) => string | null,
): string | null {
  const m = /^(!?)\[\[([\s\S]*)\]\]$/.exec(original);
  if (!m) return null;
  const inner = m[2];
  const sep = inner.search(/\\?\|/);
  const targetRaw = sep < 0 ? inner : inner.slice(0, sep);
  const tail = sep < 0 ? "" : inner.slice(sep);
  const lead = /^\s*/.exec(targetRaw)![0];
  const target = targetRaw.trim();
  const trail = targetRaw.slice(lead.length + target.length);
  const hash = target.indexOf("#");
  const linkpath = hash < 0 ? target : target.slice(0, hash);
  const subpath = hash < 0 ? "" : target.slice(hash);
  const next = retarget(linkpath, note);
  if (next === null) return null;
  // In a note body a backtick can pair with one later in the paragraph into
  // a code span, which a link read on its own cannot show.
  const spell = (path: string) =>
    read === readBodyLink && path.includes("`")
      ? null
      : `${m[1]}[[${lead}${path}${subpath}${trail}${tail}]]`;
  return respell(original, linkpath, next, note, spell, read);
}

const MARKDOWN_LINK =
  /^(!?)\[((?:[^[\]\n\\]|\\.)*)\]\((\s*)(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(\s+(?:"[^"\n]*"|'[^'\n]*'))?(\s*)\)$/;

/** What a markdown destination holds as written: see `encodeDestination`. */
const RAW = /[\p{L}\p{M}\p{N}/._~-]/u;
const RAW_ASCII = /[A-Za-z0-9/._~-]/;
const utf8 = new TextEncoder();

/**
 * `path` as a markdown destination. Every code point other than a letter,
 * a mark, a number or one of `/ . _ ~ -` is written as its UTF-8 percent
 * escapes, so nothing in the name can end the destination, start a
 * subpath, read as a URL scheme, open a code span or count as whitespace.
 * The parser here and desktop Obsidian both decode the escapes. Inside
 * `<...>` an ASCII space stays raw, and when the original spelled
 * non-ASCII text as escapes, every non-ASCII character is escaped too.
 */
function encodeDestination(
  path: string,
  angle: boolean,
  likeOriginal: string,
): string {
  const raw = /%[89a-f][0-9a-f]/i.test(likeOriginal) ? RAW_ASCII : RAW;
  return path.replace(/[^]/gu, (c) =>
    raw.test(c) || (angle && c === " ")
      ? c
      : Array.from(
          utf8.encode(c),
          (b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
        ).join(""),
  );
}

/**
 * Whether a file or folder may be renamed to `name`, so every link written
 * to it reads back as the same link. A wikilink cannot escape anything:
 * `[ ] | # ^` end or split it, and a backtick can pair with another one
 * later in the paragraph into a code span that swallows it. Whitespace at
 * either end of a link is trimmed, in every link form.
 */
export function isLinkableName(name: string): boolean {
  return !/[[\]|#^`]|^\s|\s$/.test(name);
}

/**
 * `[text](dest)` or `![alt](dest)`; null when it needs no change or
 * cannot be written.
 */
function rewriteMarkdownLink(original: string, note: Note): string | null {
  const m = MARKDOWN_LINK.exec(original);
  if (!m) return null;
  const [, embed, text, before, rawDest, titleAndSpace = "", after] = m;
  const angle = rawDest.startsWith("<") && rawDest.endsWith(">");
  const dest = angle ? rawDest.slice(1, -1).trim() : rawDest;
  const hash = dest.indexOf("#");
  const rawPath = hash < 0 ? dest : dest.slice(0, hash);
  const subpath = hash < 0 ? "" : dest.slice(hash);
  const linkpath = safeDecode(rawPath);
  const next = retarget(linkpath, note);
  if (next === null) return null;
  // Link text that was the old file's name follows the new name.
  const oldName = basename(next.oldTarget);
  const newName = basename(next.target);
  const newText =
    text === stripMd(oldName) && oldName !== newName
      ? stripMd(newName)
      : text === oldName
        ? newName
        : text;
  const spell = (path: string) => {
    const written = encodeDestination(path, angle, rawPath);
    const newDest = angle ? `<${written}${subpath}>` : `${written}${subpath}`;
    return `${embed}[${newText}](${before}${newDest}${titleAndSpace}${after})`;
  };
  return respell(original, linkpath, next, note, spell, readBodyLink);
}

function rewriteBodyLink(original: string, note: Note): string | null {
  return /^!?\[\[/.test(original)
    ? rewriteWikilink(original, note, readBodyLink)
    : rewriteMarkdownLink(original, note);
}
