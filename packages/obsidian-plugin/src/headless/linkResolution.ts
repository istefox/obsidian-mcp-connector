import type {
  BlockSubpathResult,
  CachedMetadata,
  HeadingCache,
  HeadingSubpathResult,
  ListItemCache,
} from "obsidian";

// Pure link resolution over plain data (a list of vault paths and a
// `CachedMetadata`). It stands in for `metadataCache.getFirstLinkpathDest`,
// `resolveSubpath` and `stripHeading` when no Obsidian runtime is present.
// Nothing here touches the filesystem or imports "obsidian" at runtime.

// ─────────────────────────────────────────────────────────────────────────────
// Linkpath resolution
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkResolver {
  /**
   * Resolves a linkpath written in `sourcePath` to a vault path, or `null`.
   * Same contract as `getFirstLinkpathDest`.
   */
  resolve(linkpath: string, sourcePath: string): string | null;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function segmentCount(path: string): number {
  let n = 1;
  for (let i = 0; i < path.length; i++) if (path[i] === "/") n++;
  return n;
}

/**
 * Collapses `.` and `..` segments and empty segments. Returns `null` when a
 * `..` climbs above the vault root.
 */
function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Builds the lookup indexes once so each `resolve` call avoids scanning the
 * vault. On a 10k-note vault the build is a single pass over the paths.
 *
 * Indexes (all keys lowercase, all path keys keep their file extension):
 * - `exact`: every path, for case-sensitive exact hits.
 * - `byBasename`: `note.md` -> every path whose file name is `note.md`.
 * - `bySuffix`: every multi-segment tail of every path (`b/c.md` and
 *   `a/b/c.md` for `a/b/c.md`) so `folder/note` can match `x/folder/note.md`.
 *
 * A linkpath that starts with `./` or `../` is explicitly relative: it
 * resolves against the source note's folder only, with no fallback, so
 * `./A.md` in `sub/S.md` means `sub/A.md` even when `A.md` exists too.
 *
 * Resolution order for every other linkpath, mirroring Obsidian:
 * 1. Exact vault path (`.md` appended when the linkpath does not end in it).
 * 2. Path relative to the source note's folder (`./` and `../` normalised).
 * 3. Basename match (no `/` in the linkpath) or path-suffix match (with `/`).
 *    Case-insensitive, but a case-exact candidate wins when there is one.
 *    Among several candidates: same folder as the source first, then the
 *    fewest path segments, then the shortest string, then alphabetical, so
 *    the result is deterministic.
 */
/**
 * A link's file part as the resolver takes it when a name holds a `#` or a
 * `%`. A `#` ends the file part and starts a subpath, and a link written in
 * a markdown destination has its `%` escapes decoded, so after decoding a
 * `#` that was part of the name (`a%23b.md`) cannot be told from the start
 * of a subpath, nor a `%` that was part of it (`100%2525.md`) from an
 * escape. Both are written back as `%23` and `%25`. The resolver tries the
 * text as it is first, then with those two escapes undone.
 */
export function escapeLinkPath(path: string): string {
  return path.replace(/[%#]/g, (c) => (c === "%" ? "%25" : "%23"));
}

const ESCAPED = /%(23|25)/i;

function unescapeLinkPath(path: string): string {
  return path.replace(/%(23|25)/gi, (_, code: string) =>
    code === "23" ? "#" : "%",
  );
}

export function createLinkResolver(paths: Iterable<string>): LinkResolver {
  const exact = new Set<string>();
  const byBasename = new Map<string, string[]>();
  const bySuffix = new Map<string, string[]>();

  for (const p of paths) {
    if (exact.has(p)) continue;
    exact.add(p);
    pushTo(byBasename, basename(p).toLowerCase(), p);
    const lower = p.toLowerCase();
    let i = lower.indexOf("/");
    while (i !== -1) {
      const tail = lower.slice(i + 1);
      if (tail.includes("/")) pushTo(bySuffix, tail, p);
      i = lower.indexOf("/", i + 1);
    }
    // The full path is itself a suffix (the "no leading folders" form).
    if (lower.includes("/")) pushTo(bySuffix, lower, p);
  }

  /** `lp` as given, then with `.md` appended (unless it already ends in it). */
  const variants = (lp: string): string[] =>
    lp.toLowerCase().endsWith(".md") ? [lp] : [lp, `${lp}.md`];

  const pickBest = (
    candidates: string[],
    spellings: string[],
    sourceDir: string,
  ): string => {
    // A candidate spelled exactly as written beats case-insensitive ones.
    const exactCase = candidates.filter((c) =>
      spellings.some((v) => c.endsWith(v)),
    );
    const ranked = (exactCase.length > 0 ? exactCase : candidates).slice();
    ranked.sort((a, b) => {
      const aSame = dirname(a) === sourceDir ? 0 : 1;
      const bSame = dirname(b) === sourceDir ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      const segs = segmentCount(a) - segmentCount(b);
      if (segs !== 0) return segs;
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return ranked[0];
  };

  return {
    resolve(linkpath, sourcePath) {
      // Defensive: callers should pass only the file part of a link.
      let lp = linkpath;
      const pipe = lp.indexOf("|");
      if (pipe !== -1) lp = lp.slice(0, pipe);
      const hash = lp.indexOf("#");
      if (hash !== -1) lp = lp.slice(0, hash);
      lp = lp.trim();
      if (lp === "") return sourcePath;
      const found = resolveText(lp, sourcePath);
      // A link that was written with a `#` or `%` in a file name has them
      // as `%23` and `%25` (see `escapeLinkPath`): try the name they spell.
      if (found === null && ESCAPED.test(lp)) {
        return resolveText(unescapeLinkPath(lp), sourcePath);
      }
      return found;
    },
  };

  function resolveText(lp: string, sourcePath: string): string | null {
    const sourceDir = dirname(sourcePath);
    if (lp.startsWith("./") || lp.startsWith("../")) {
      const rel = normalizePath(sourceDir === "" ? lp : `${sourceDir}/${lp}`);
      if (rel === null || rel === "") return null;
      for (const v of variants(rel)) if (exact.has(v)) return v;
      return null;
    }

    // 1. Exact vault path. A leading slash means "from the vault root".
    const rooted = lp.startsWith("/") ? lp.slice(1) : lp;
    const normalized = normalizePath(rooted);
    if (normalized !== null && normalized !== "") {
      for (const v of variants(normalized)) if (exact.has(v)) return v;
    }

    // 2. Relative to the source note's folder.
    if (!lp.startsWith("/")) {
      const rel = normalizePath(sourceDir === "" ? lp : `${sourceDir}/${lp}`);
      if (rel !== null && rel !== "") {
        for (const v of variants(rel)) if (exact.has(v)) return v;
      }
    }

    // 3. Basename or path-suffix match.
    const cleaned = normalizePath(rooted);
    if (cleaned === null || cleaned === "") return null;
    const index = cleaned.includes("/") ? bySuffix : byBasename;
    const spellings = variants(cleaned);
    const found = new Set<string>();
    for (const v of spellings) {
      const hit = index.get(v.toLowerCase());
      if (hit) for (const h of hit) found.add(h);
    }
    if (found.size === 0) return null;
    return pickBest([...found], spellings, sourceDir);
  }
}

/**
 * Wraps `resolver` so each (linkpath, source folder) pair is resolved once,
 * however many notes in that folder carry the link. A result depends on the
 * source note only through its folder, except that a link to the note
 * itself answers with the source path, so such a result is never shared.
 */
export function memoizeByFolder(resolver: LinkResolver): LinkResolver {
  const memo = new Map<string, string | null>();
  return {
    resolve(linkpath, sourcePath) {
      const key = `${dirname(sourcePath)}\0${linkpath}`;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const dest = resolver.resolve(linkpath, sourcePath);
      if (dest !== sourcePath) memo.set(key, dest);
      return dest;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Heading normalisation and subpath resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises heading text for comparison, like Obsidian's `stripHeading` plus
 * the case folding its link matcher applies.
 *
 * Rule (an approximation of Obsidian's, which is not specified in its typings):
 * 1. Replace each of ``! " # $ % & ( ) * + , . : ; < = > ? @ ^ ` { | } ~ / \ [ ]``
 *    with a space. Letters, digits, `_`, `-`, `'` and non-ASCII text stay.
 * 2. Collapse whitespace runs to one space.
 * 3. Trim and lowercase.
 *
 * Apply it to both sides of a comparison.
 */
export function stripHeading(text: string): string {
  return text
    .replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Heading result of {@link resolveSubpath}. Same as Obsidian's
 * `HeadingSubpathResult` except `next` is `null` for the last section (the
 * typings declare it non-null, but there is no next heading to return).
 */
export type HeadingSubpath = Omit<HeadingSubpathResult, "next"> & {
  next: HeadingCache | null;
};

export type BlockSubpath = BlockSubpathResult;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Resolves a `#Heading`, `#A#B` (nested) or `#^blockid` subpath against a
 * note's cache, like Obsidian's `resolveSubpath`. A missing leading `#` is
 * tolerated. Returns `null` for an empty or unresolvable subpath.
 *
 * Headings: each segment is compared with {@link stripHeading}. The first may
 * match anywhere. Every later segment must sit inside the previous match's
 * region, which runs from that heading to the next heading of the same or a
 * higher level. The result's `start` is the matched heading's start and `end`
 * is the start of the next same-or-higher-level heading, or `null` when the
 * section runs to the end of the file (as Obsidian does).
 *
 * Blocks: the id is looked up case-sensitively in `cache.blocks`. `list` is
 * set when the block is a list item.
 */
export function resolveSubpath(
  cache: CachedMetadata,
  subpath: string,
): HeadingSubpath | BlockSubpath | null {
  const normalized = subpath.startsWith("#") ? subpath : `#${subpath}`;
  const segments = normalized.slice(1).split("#");
  if (segments.length === 0 || segments.some((s) => s.trim() === "")) {
    return null;
  }

  // Block reference: `#^id`.
  const last = segments[segments.length - 1];
  if (last.startsWith("^")) {
    if (segments.length !== 1) return null;
    const id = last.slice(1).trim();
    const blocks = cache.blocks;
    if (id === "" || !blocks || !hasOwn(blocks, id)) return null;
    const block = blocks[id];
    const list: ListItemCache | undefined = (cache.listItems ?? []).find(
      (item) =>
        item.id === id ||
        (item.position.start.line === block.position.start.line &&
          item.position.start.col === block.position.start.col),
    );
    const result: BlockSubpath = {
      type: "block",
      block,
      start: block.position.start,
      end: block.position.end,
    };
    if (list) result.list = list;
    return result;
  }
  if (segments.some((s) => s.startsWith("^"))) return null;

  // Heading path: `#A#B`.
  const headings = cache.headings ?? [];
  let prevIndex = -1;
  let limit = headings.length;
  let currentIndex = -1;
  for (const segment of segments) {
    const wanted = stripHeading(segment);
    let found = -1;
    for (let i = prevIndex + 1; i < limit; i++) {
      if (stripHeading(headings[i].heading) === wanted) {
        found = i;
        break;
      }
    }
    if (found === -1) return null;
    currentIndex = found;
    prevIndex = found;
    limit = headings.length;
    for (let i = found + 1; i < headings.length; i++) {
      if (headings[i].level <= headings[found].level) {
        limit = i;
        break;
      }
    }
  }

  const current = headings[currentIndex];
  const next = limit < headings.length ? headings[limit] : null;
  return {
    type: "heading",
    current,
    next,
    start: current.position.start,
    end: next ? next.position.start : null,
  };
}
