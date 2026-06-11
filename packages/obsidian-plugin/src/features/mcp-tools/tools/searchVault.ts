import { type } from "arktype";
import { errorText, successText } from "../services/responseBuilders";
import type { App } from "obsidian";
import { apply as applyJsonLogic } from "json-logic-js";
import { executeDataviewQueryHandler } from "./executeDataviewQuery";

export const searchVaultSchema = type({
  name: '"search_vault"',
  arguments: {
    query: type("string>0").describe(
      "Dataview DQL query (e.g. 'TABLE FROM \"Notes\"') or JsonLogic expression (JSON string).",
    ),
    "queryType?": type('"dataview"|"jsonlogic"').describe(
      "Query language. Default: dataview.",
    ),
  },
}).describe(
  'Run a Dataview DQL or JsonLogic query against the vault. DQL: in-process via the Dataview plugin API — requires the Dataview community plugin (`errorCode: "dataview_not_installed"` if absent). JsonLogic: filter all vault markdown files by frontmatter/tags/path using a JsonLogic rule (JSON string); no additional plugin required. Returns the Dataview query result for DQL, or a JSON array of matching `{path}` objects for JsonLogic.',
);

export type SearchVaultContext = {
  arguments: { query: string; queryType?: "dataview" | "jsonlogic" };
  app: App;
};

export async function searchVaultHandler(ctx: SearchVaultContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { query, queryType = "dataview" } = ctx.arguments;

  if (queryType === "jsonlogic") {
    let rule: unknown;
    try {
      rule = JSON.parse(query);
    } catch {
      return errorText(
        'JsonLogic query must be a valid JSON string. Example: {"==": [{"var": "frontmatter.status"}, "active"]}',
      );
    }

    const results = ctx.app.vault
      .getMarkdownFiles()
      .filter((file) => {
        const cache = ctx.app.metadataCache.getFileCache(file);
        const doc = {
          path: file.path,
          basename: file.basename,
          tags: (cache?.tags ?? []).map((t) => t.tag),
          frontmatter: cache?.frontmatter ?? {},
          created: file.stat.ctime,
          modified: file.stat.mtime,
          size: file.stat.size,
        };
        try {
          return !!applyJsonLogic(rule as object | boolean, doc);
        } catch {
          return false;
        }
      })
      .map((f) => ({ path: f.path }));

    return successText(JSON.stringify(results));
  }

  return executeDataviewQueryHandler({ arguments: { query }, app: ctx.app });
}
