/**
 * What else points at a renamed file besides the notes that link to it:
 * canvases and `.base` files. Both are text in the vault that neither the
 * metadata cache nor the link resolver reads, so the rename reads them
 * itself.
 *
 * - A canvas is JSON. A file node names its file by vault path, so it
 *   follows `moves`. A text node holds markdown, so its links are
 *   rewritten like a note's.
 * - A `.base` file is YAML whose filters and formulas are expressions.
 *   Nothing here can tell which strings in an expression are paths, and a
 *   rewrite of "any link-shaped text" would change a filter value such as
 *   `note.text == "[[old]]"`. So a rename never modifies a base. It lists
 *   every base that refers to what moved, in a link or in a quoted path,
 *   so the caller can tell the user to check it by hand.
 */

import type { LinkRewriter } from "./renameLinks";

export type Rewritten = { content: string; unwritable: string[] };

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The indent Obsidian wrote the canvas with (a tab, or a run of spaces),
 * so rewriting it does not reformat the whole file.
 */
function canvasIndent(content: string): string | number {
  const indented = /^([ \t]+)\S/m.exec(content)?.[1];
  if (indented === undefined) return 2;
  return indented.startsWith("\t") ? "\t" : Math.min(indented.length, 8);
}

/**
 * `content` of the canvas that was at `oldSource`, with the file nodes that
 * name a moved file pointing at its new path and the links in its text
 * nodes rewritten. A canvas that is not valid JSON, or has no `nodes`
 * list, is returned as it is.
 */
export function rewriteCanvas(
  content: string,
  rewriter: LinkRewriter,
  moves: ReadonlyMap<string, string>,
  oldSource: string,
): Rewritten {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return { content, unwritable: [] };
  }
  if (!isObject(doc) || !Array.isArray(doc.nodes)) {
    return { content, unwritable: [] };
  }
  const unwritable: string[] = [];
  let changed = false;
  for (const node of doc.nodes) {
    if (!isObject(node)) continue;
    if (node.type === "file" && typeof node.file === "string") {
      const next = moves.get(node.file);
      if (next !== undefined) {
        node.file = next;
        changed = true;
      }
    } else if (node.type === "text" && typeof node.text === "string") {
      const result = rewriter.rewrite(node.text, null, oldSource);
      unwritable.push(...result.unwritable);
      if (result.content !== node.text) {
        node.text = result.content;
        changed = true;
      }
    }
  }
  if (!changed) return { content, unwritable };
  const text = JSON.stringify(doc, null, canvasIndent(content));
  return {
    content: content.endsWith("\n") ? `${text}\n` : text,
    unwritable,
  };
}

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a base still names `oldPath` as a quoted string: the whole path,
 * a folder it is the start of, or (for a note) the path without `.md`, with
 * an optional `#heading` or `|alias` after it. That is how a filter or a
 * formula spells a path, for example `file.folder == "Projects"` or
 * `link("Notes/old")`.
 */
export function mentionsOldPath(content: string, oldPath: string): boolean {
  const forms = [oldPath];
  if (oldPath.toLowerCase().endsWith(".md")) forms.push(oldPath.slice(0, -3));
  return forms.some((form) =>
    new RegExp(`(["'])${escapeRegExp(form)}(?=["'/#|])`).test(content),
  );
}

/**
 * Whether the base that was at `oldSource` refers to what a rename moved:
 * through a wikilink or a markdown link that leads to a moved file, whether
 * or not a new spelling of it could be written, or through a quoted path
 * (see `mentionsOldPath`) for `from`, the renamed file or folder. Reading
 * only: the text is not changed.
 */
export function baseRefersToRename(
  content: string,
  rewriter: LinkRewriter,
  oldSource: string,
  from: string,
): boolean {
  const links = rewriter.rewriteText(content, oldSource);
  return (
    links.content !== content ||
    links.unwritable.length > 0 ||
    mentionsOldPath(content, from)
  );
}
