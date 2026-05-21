import { type } from "arktype";
import type { App } from "obsidian";

export const getActiveFileSchema = type({
  name: '"get_active_file"',
  arguments: {
    "format?": '"markdown"|"json"',
  },
}).describe(
  "Returns content of the currently active note. Default format is markdown; pass format=json to receive an object with content, frontmatter, tags, stat, and path.",
);

export type GetActiveFileContext = {
  arguments: { format?: "markdown" | "json" };
  app: App;
};

export async function getActiveFileHandler(ctx: GetActiveFileContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const file = ctx.app.workspace.getActiveFile();
  if (!file) {
    return {
      content: [{ type: "text", text: "No active file." }],
      isError: true,
    };
  }

  const content = await ctx.app.vault.read(file);

  // Plain markdown — return raw content, no parsing overhead.
  if (ctx.arguments.format !== "json") {
    return { content: [{ type: "text", text: content }] };
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
  };

  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
  };
}
