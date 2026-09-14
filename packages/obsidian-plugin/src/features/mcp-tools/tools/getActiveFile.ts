import { type } from "arktype";
import { errorText, successText } from "../services/responseBuilders";
import { resolveHeadingForUri } from "../services/anchorTargets";
import {
  buildObsidianUri,
  headingNotFoundError,
  withUriBlock,
} from "../services/buildObsidianUri";
import type { App } from "obsidian";

export const getActiveFileSchema = type({
  name: '"get_active_file"',
  arguments: {
    "format?": '"markdown"|"json"',
    "heading?": type("string>0").describe(
      "A heading in the file. When present, the returned obsidian:// URI navigates directly to it. Use get_note_outline to discover a file's headings.",
    ),
  },
}).describe(
  "Returns content of the currently active note. Default format is markdown; pass format=json to receive an object with content, frontmatter, tags, stat, and path.",
);

export type GetActiveFileContext = {
  arguments: { format?: "markdown" | "json"; heading?: string };
  app: App;
};

export async function getActiveFileHandler(ctx: GetActiveFileContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const file = ctx.app.workspace.getActiveFile();
  if (!file) {
    return errorText("No active file.");
  }

  const content = await ctx.app.vault.read(file);

  const vaultName = ctx.app.vault.getName();
  let uri: string;
  if (ctx.arguments.heading) {
    const cache = ctx.app.metadataCache.getFileCache(file);
    const resolution = resolveHeadingForUri(
      cache,
      content.split("\n"),
      ctx.arguments.heading,
    );
    if (!resolution.ok) {
      return headingNotFoundError(ctx.arguments.heading, file.path);
    }
    uri = buildObsidianUri(vaultName, file.path, resolution.heading);
  } else {
    uri = buildObsidianUri(vaultName, file.path);
  }

  // Plain markdown — return raw content, no parsing overhead.
  if (ctx.arguments.format !== "json") {
    return withUriBlock(successText(content), uri);
  }

  // JSON shape: matches the ApiNoteJson contract (content, frontmatter, path,
  // stat, tags) so consumers get the same fields regardless of whether they
  // talk to the REST API or the embedded server.
  const cache = ctx.app.metadataCache.getFileCache(file);
  const frontmatter = (cache?.frontmatter as Record<string, unknown>) ?? {};

  // Tags can live in frontmatter as an array or as inline Obsidian tags via
  // cache.tags — prefer frontmatter.tags when present to stay consistent with
  // the REST API behaviour.
  const tags = Array.isArray(frontmatter.tags)
    ? (frontmatter.tags as string[])
    : [];

  const body = {
    path: file.path,
    content,
    frontmatter,
    tags,
    stat: {
      ctime: file.stat.ctime,
      mtime: file.stat.mtime,
      size: file.stat.size,
    },
    uri,
  };

  return successText(JSON.stringify(body));
}
