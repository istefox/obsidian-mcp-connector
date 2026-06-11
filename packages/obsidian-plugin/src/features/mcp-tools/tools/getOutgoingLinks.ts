import { type } from "arktype";
import { TFile, type App } from "obsidian";
import { errorText, successJson } from "../services/responseBuilders";

export const getOutgoingLinksSchema = type({
  name: '"get_outgoing_links"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the source file."),
    "includeEmbeds?": type('"true" | "false"').describe(
      'Default `"true"`: embeds included, marked `embed: true`. `"false"` returns only regular links.',
    ),
    "includeUnresolved?": type('"true" | "false"').describe(
      'Default `"true"`: unresolved links included with `resolved: false`. `"false"` filters them out.',
    ),
  },
}).describe(
  "Returns every link in a file: body links, embeds (`![[…]]`), and frontmatter links. Each entry has linkpath, original syntax, display text, layer (`body` | `frontmatter`), embed flag, resolution status, and resolved path. Document order. `isError: true` if the file does not exist.",
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
    return errorText(`File not found: ${sourcePath}`);
  }
  if (!(abstract instanceof TFile)) {
    return errorText(`Path is a folder: ${sourcePath}`);
  }
  const file = abstract;

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

  return successJson(output);
}
