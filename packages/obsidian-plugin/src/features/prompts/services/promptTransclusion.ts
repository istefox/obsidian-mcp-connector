import type { App, TFile } from "obsidian";
import { stripArgDeclarations, stripFrontmatter } from "./promptRenderer";

/**
 * Cumulative UTF-8 bytes of embedded content a single render may insert.
 *
 * Deliberately not `mcpTools.maxTextOutputKB`: that setting is the
 * `get_vault_file` ceiling, and a user raising it to 10 MB for file reads
 * must not silently uncap prompt payloads. A prompt body also enters the
 * conversation unconditionally — the model never chose to read it — so it
 * warrants a tighter, non-tunable budget than a tool result.
 */
export const MAX_TRANSCLUSION_BYTES = 32 * 1024;

/** Upper bound on expansions per render, so one prompt cannot fan out. */
export const MAX_EMBED_EXPANSIONS = 20;

/**
 * Embeds inside embedded content are not expanded. A depth counter is a
 * strictly stronger guard than cycle detection: a self-embed inlines the body
 * once and the copy's own `![[A]]` stays literal, and `A -> B -> A` inlines
 * `B` once and stops. Neither needs a visited set.
 */
export const MAX_EMBED_DEPTH = 1;

export type EmbedRef = {
  /** The full matched token, e.g. `![[note#Heading|alias]]`. */
  original: string;
  /** Link target with alias and fragment removed, e.g. `note`. */
  linkpath: string;
  /** Heading text after `#`. Absent for a bare or block embed. */
  heading?: string;
  /** Block id after `#^`, caret stripped. Absent otherwise. */
  blockId?: string;
  /** Offset of `original` within the scanned string. */
  index: number;
};

/**
 * A wikilink never spans a line, and the leading `!` is the only thing that
 * separates an embed from a plain link.
 */
const EMBED_PATTERN = /!\[\[([^\]\n]+?)\]\]/g;

/** Pure tokenizer, document order, no vault access. */
export function parseEmbeds(body: string): EmbedRef[] {
  const refs: EmbedRef[] = [];

  for (const match of body.matchAll(EMBED_PATTERN)) {
    const inner = match[1];

    // Split on the first `#`, then on the first `|` in whichever part carries
    // it. Same convention as headingRename.ts, where an alias always comes
    // last and a fragment never contains a bare `|`.
    const hash = inner.indexOf("#");
    let notePart = hash === -1 ? inner : inner.slice(0, hash);
    let heading: string | undefined;
    let blockId: string | undefined;

    if (hash === -1) {
      const pipe = notePart.indexOf("|");
      if (pipe !== -1) notePart = notePart.slice(0, pipe);
    } else {
      const rest = inner.slice(hash + 1);
      const pipe = rest.indexOf("|");
      const fragment = (pipe === -1 ? rest : rest.slice(0, pipe)).trim();
      if (fragment.startsWith("^")) blockId = fragment.slice(1).trim();
      else if (fragment.length > 0) heading = fragment;
    }

    refs.push({
      original: match[0],
      linkpath: notePart.trim(),
      ...(heading === undefined ? {} : { heading }),
      ...(blockId === undefined ? {} : { blockId }),
      index: match.index,
    });
  }

  return refs;
}

export type ExpandEmbedsOptions = {
  maxBytes?: number;
  maxEmbeds?: number;
};

/** UTF-8 size, the unit the budget is denominated in. */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Every non-expansion keeps the original token and says why.
 *
 * The token is itself useful — a model can follow it with `get_vault_file` —
 * and the marker is an HTML comment, so it stays invisible if the text is
 * ever rendered. Dropping the embed silently would be a silent failure in
 * text the model reads as instructions.
 */
function skipMarker(original: string, reason: string): string {
  return `${original} <!-- prompt-transclusion: not expanded (${reason}) -->`;
}

type HeadingEntry = {
  heading: string;
  level: number;
  position: { start: { line: number } };
};

type BlockEntry = {
  position: { start: { line: number }; end: { line: number } };
};

/**
 * Lines of the section a heading opens, up to the next heading of the same or
 * a higher level. Offsets come from `metadataCache` and are absolute in the
 * raw file, so this must run before frontmatter is stripped.
 */
function sectionForHeading(
  headings: HeadingEntry[],
  target: string,
  lines: string[],
): string | null {
  const wanted = target.toLowerCase();
  const index = headings.findIndex(
    (entry) => entry.heading.trim().toLowerCase() === wanted,
  );
  if (index === -1) return null;

  const { level } = headings[index];
  const start = headings[index].position.start.line;
  let end = lines.length;
  for (let i = index + 1; i < headings.length; i += 1) {
    if (headings[i].level <= level) {
      end = headings[i].position.start.line;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

/** Lines of a block, end inclusive. Same absolute-offset caveat as above. */
function sectionForBlock(
  blocks: Record<string, BlockEntry>,
  id: string,
  lines: string[],
): string | null {
  const block = blocks[id];
  if (!block) return null;
  return lines
    .slice(block.position.start.line, block.position.end.line + 1)
    .join("\n")
    .trimEnd();
}

/**
 * Annotate embeds found inside inserted content, which are not expanded
 * because of {@link MAX_EMBED_DEPTH}. Without this they would sit in the
 * output looking like embeds the renderer simply failed to notice.
 */
function annotateNested(content: string): string {
  const refs = parseEmbeds(content);
  if (refs.length === 0) return content;

  let out = "";
  let cursor = 0;
  for (const ref of refs) {
    out += content.slice(cursor, ref.index);
    out += skipMarker(ref.original, `depth limit ${MAX_EMBED_DEPTH}`);
    cursor = ref.index + ref.original.length;
  }
  return out + content.slice(cursor);
}

/**
 * Replace each expandable `![[…]]` in `body` with the target's content.
 *
 * Runs after argument substitution, so `![[{{note}}]]` resolves through an
 * argument value. Placeholders *inside* embedded content are deliberately
 * left literal: an embedded note is data, not a template, and substituting
 * into it would let any vault note consume the prompt's arguments.
 */
export async function expandEmbeds(
  app: App,
  sourcePath: string,
  body: string,
  options: ExpandEmbedsOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_TRANSCLUSION_BYTES;
  const maxEmbeds = options.maxEmbeds ?? MAX_EMBED_EXPANSIONS;

  const refs = parseEmbeds(body);
  if (refs.length === 0) return body;

  let out = "";
  let cursor = 0;
  let spent = 0;
  let expanded = 0;

  for (const ref of refs) {
    out += body.slice(cursor, ref.index);
    cursor = ref.index + ref.original.length;

    if (expanded >= maxEmbeds) {
      out += skipMarker(ref.original, `embed limit ${maxEmbeds}`);
      continue;
    }
    if (ref.linkpath === "") {
      out += skipMarker(ref.original, "no target");
      continue;
    }

    const dest: TFile | null = app.metadataCache.getFirstLinkpathDest(
      ref.linkpath,
      sourcePath,
    );
    if (dest === null) {
      out += skipMarker(ref.original, "not found");
      continue;
    }
    if (dest.extension !== "md") {
      out += skipMarker(ref.original, `not markdown (.${dest.extension})`);
      continue;
    }

    const raw = await app.vault.cachedRead(dest);

    // Slice by metadata offsets first: they index the raw file, so stripping
    // frontmatter beforehand would shift every line.
    let selected: string;
    if (ref.heading !== undefined || ref.blockId !== undefined) {
      const cache = app.metadataCache.getFileCache(dest) as {
        headings?: HeadingEntry[];
        blocks?: Record<string, BlockEntry>;
      } | null;
      const lines = raw.split("\n");
      const sliced =
        ref.heading !== undefined
          ? sectionForHeading(cache?.headings ?? [], ref.heading, lines)
          : sectionForBlock(cache?.blocks ?? {}, ref.blockId as string, lines);
      if (sliced === null) {
        out += skipMarker(
          ref.original,
          ref.heading !== undefined ? "heading not found" : "block not found",
        );
        continue;
      }
      selected = sliced;
    } else {
      selected = raw;
    }

    // Obsidian never renders frontmatter in a transclusion, and embedding a
    // shared preamble that is itself a prompt file must not leak its
    // `<% tp.mcpTools.prompt(…) %>` line into the rendered output.
    const content = annotateNested(
      stripArgDeclarations(stripFrontmatter(selected)),
    );

    const size = utf8ByteLength(content);
    if (spent + size > maxBytes) {
      // Skipped whole, never truncated: a note cut mid-sentence is worse
      // input than a pointer the model can follow deliberately.
      out += skipMarker(ref.original, `size budget ${maxBytes} bytes`);
      continue;
    }

    spent += size;
    expanded += 1;
    out += content;
  }

  return out + body.slice(cursor);
}
