import { type } from "arktype";
import { type App } from "obsidian";
import { resolveLinkTarget } from "../services/resolveLinkTarget";
import { resolveTFile } from "../services/resolveTFile";
import { errorText, successJson } from "../services/responseBuilders";

export const getOutgoingLinksSchema = type({
  name: '"get_outgoing_links"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the source file."),
    "includeEmbeds?": type("boolean").describe(
      "Default `true`: embeds included, marked `embed: true`. `false` returns only regular links.",
    ),
    "includeUnresolved?": type("boolean").describe(
      "Default `true`: unresolved links included with `resolved: false`. `false` filters them out.",
    ),
    "limit?": type("number>0").describe("Max results returned (default 200)."),
  },
}).describe(
  "Returns every link in a file: body links, embeds (`![[…]]`), and frontmatter links. Each entry has linkpath, original syntax, display text, layer (`body` | `frontmatter`), embed flag, resolution status, and resolved path. Document order. `isError: true` if the file does not exist.",
);

export type GetOutgoingLinksContext = {
  arguments: {
    path: string;
    includeEmbeds?: boolean;
    includeUnresolved?: boolean;
    limit?: number;
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
  const resolved = resolveTFile(ctx.app.vault, sourcePath);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorText(`File not found: ${sourcePath}`)
      : errorText(`Path is a folder: ${sourcePath}`);
  }
  const file = resolved.file;

  const cache = ctx.app.metadataCache.getFileCache(file) as {
    links?: RawLink[];
    embeds?: RawLink[];
    frontmatterLinks?: Array<RawLink & { key: string }>;
  } | null;

  const includeEmbeds = ctx.arguments.includeEmbeds ?? true;
  const includeUnresolved = ctx.arguments.includeUnresolved ?? true;

  // Resolution helper: the file portion must resolve to a vault file, and
  // any `#heading`/`#^block` subpath must resolve against that file's
  // cache (see #525 — a link was previously reported resolved whenever it
  // merely started with "#", with no check that the anchor existed).
  const resolve = (
    linkpath: string,
  ): { resolved: boolean; targetPath: string | null } => {
    const r = resolveLinkTarget(ctx.app, linkpath, file);
    return r.resolved
      ? { resolved: true, targetPath: r.file.path }
      : { resolved: false, targetPath: null };
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

  const limit = Math.min(
    1000,
    Math.max(1, Math.floor(ctx.arguments.limit ?? 200)),
  );
  const truncated = filtered.length > limit;

  const output = {
    source: sourcePath,
    totalLinks: filtered.length,
    ...(truncated ? { truncated: true } : {}),
    links: truncated ? filtered.slice(0, limit) : filtered,
  };

  return successJson(output);
}
