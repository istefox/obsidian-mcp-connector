import { type } from "arktype";
import type { App, TFile } from "obsidian";

export const getOutgoingLinksSchema = type({
  name: '"get_outgoing_links"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the source file."),
    "includeEmbeds?": type('"true" | "false"').describe(
      'When `"true"` (default), embedded references (`![[link]]`) are returned alongside regular links, marked with `embed: true`. When `"false"`, only regular links are returned.',
    ),
    "includeUnresolved?": type('"true" | "false"').describe(
      'When `"true"` (default), unresolved links (link target text that does not match any vault file) are included with `resolved: false` and `targetPath: null`. Set to `"false"` to filter them out.',
    ),
  },
}).describe(
  "Returns every link emanating from the given file: body links (`[[wikilink]]`, `[md](path)`), embeds (`![[…]]`), and frontmatter links (e.g. `parent: [[Other]]`). Each entry carries its raw linkpath, original syntax, optional display text, source layer (`body` | `frontmatter`), embed flag, resolution status, and the resolved vault path when available. Order preserves document position. Returns `isError: true` when the source file does not exist.",
);

export type GetOutgoingLinksContext = {
  arguments: {
    path: string;
    includeEmbeds?: "true" | "false";
    includeUnresolved?: "true" | "false";
  };
  app: App;
};

type LinkEntry = {
  link: string;
  original: string;
  displayText?: string;
  source: "body" | "frontmatter";
  embed: boolean;
  resolved: boolean;
  targetPath: string | null;
};

type RawLink = {
  link: string;
  original: string;
  displayText?: string;
};

export async function getOutgoingLinksHandler(
  ctx: GetOutgoingLinksContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const sourcePath = ctx.arguments.path;
  const abstract = ctx.app.vault.getAbstractFileByPath(sourcePath);
  if (!abstract) {
    return {
      content: [{ type: "text", text: `File not found: ${sourcePath}` }],
      isError: true,
    };
  }
  const file = abstract as TFile;

  const cache = ctx.app.metadataCache.getFileCache(file) as {
    links?: RawLink[];
    embeds?: RawLink[];
    frontmatterLinks?: Array<RawLink & { key: string }>;
  } | null;

  const includeEmbeds = (ctx.arguments.includeEmbeds ?? "true") === "true";
  const includeUnresolved =
    (ctx.arguments.includeUnresolved ?? "true") === "true";

  // Resolution helper. `getFirstLinkpathDest` is the documented public
  // API for turning a linkpath (e.g. `"Note Name"` or `"folder/Note"`)
  // into a concrete `TFile`; using it here means the caller gets the
  // resolved vault path without an extra round-trip to a separate tool.
  const resolve = (
    linkpath: string,
  ): { resolved: boolean; targetPath: string | null } => {
    const dest = ctx.app.metadataCache.getFirstLinkpathDest(
      linkpath,
      sourcePath,
    );
    if (dest) return { resolved: true, targetPath: dest.path };
    return { resolved: false, targetPath: null };
  };

  const buildEntry = (
    raw: RawLink,
    layer: "body" | "frontmatter",
    embed: boolean,
  ): LinkEntry => {
    const { resolved, targetPath } = resolve(raw.link);
    const entry: LinkEntry = {
      link: raw.link,
      original: raw.original,
      source: layer,
      embed,
      resolved,
      targetPath,
    };
    if (raw.displayText !== undefined) entry.displayText = raw.displayText;
    return entry;
  };

  const out: LinkEntry[] = [];
  for (const l of cache?.links ?? []) {
    out.push(buildEntry(l, "body", false));
  }
  if (includeEmbeds) {
    for (const e of cache?.embeds ?? []) {
      out.push(buildEntry(e, "body", true));
    }
  }
  for (const f of cache?.frontmatterLinks ?? []) {
    out.push(buildEntry(f, "frontmatter", false));
  }

  const filtered = includeUnresolved ? out : out.filter((l) => l.resolved);

  const output = {
    source: sourcePath,
    totalLinks: filtered.length,
    links: filtered,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
  };
}
