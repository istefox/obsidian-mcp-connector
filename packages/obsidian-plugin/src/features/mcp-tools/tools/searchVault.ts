import { type } from "arktype";
import type { App } from "obsidian";
import { requestUrl } from "obsidian";
import type McpToolsPlugin from "$/main";

export const searchVaultSchema = type({
  name: '"search_vault"',
  arguments: {
    query: type("string>0").describe(
      "Dataview DQL query (e.g. 'TABLE FROM \"Notes\"') or JsonLogic expression.",
    ),
    "queryType?": type('"dataview"|"jsonlogic"').describe(
      "Query language. Default: dataview.",
    ),
  },
}).describe(
  "Run a Dataview DQL or JsonLogic query against the vault. Requires the Local REST API plugin (with Dataview installed for DQL queries).",
);

export type SearchVaultContext = {
  arguments: { query: string; queryType?: "dataview" | "jsonlogic" };
  app: App;
  plugin: McpToolsPlugin;
};

/**
 * Handler for the `search_vault` tool.
 *
 * Routes the DQL/JsonLogic query through the Local REST API plugin's
 * `/search/` endpoint, which delegates to Dataview for DQL queries.
 * If Local REST API is not installed or its API handle is not loaded,
 * returns an actionable error block explaining the missing dependency.
 *
 * The handler accesses `plugin.localRestApi` (public field on McpToolsPlugin)
 * to check runtime availability, and `plugin.getLocalRestApiKey()` to obtain
 * the bearer token for the legacy REST endpoint.
 */
export async function searchVaultHandler(ctx: SearchVaultContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const restApi = ctx.plugin.localRestApi;
  const apiKey = ctx.plugin.getLocalRestApiKey();

  // Guard: both the API handle (provided by the Local REST API plugin at
  // runtime) and the API key must be present. If either is missing, the
  // search cannot proceed — return an actionable error with install hints.
  if (!restApi?.api || !apiKey) {
    return {
      content: [
        {
          type: "text",
          text: "search_vault requires the Local REST API plugin (with Dataview installed for DQL queries). Install both from Obsidian community plugins, configure the REST API key, then retry. The default plugin endpoint search uses Dataview's TABLE/LIST syntax.",
        },
      ],
      isError: true,
    };
  }

  // Map the queryType to the Content-Type the Local REST API /search/
  // endpoint understands. See:
  // https://coddingtonbear.github.io/obsidian-local-rest-api/#/Search/post_search_
  const queryType = ctx.arguments.queryType ?? "dataview";
  const contentType =
    queryType === "dataview"
      ? "application/vnd.olrapi.dataview.dql+txt"
      : "application/vnd.olrapi.jsonlogic+json";

  const response = await requestUrl({
    url: `${ctx.plugin.getLocalRestApiUrl()}/search/`,
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Authorization: `Bearer ${apiKey}`,
    },
    // Both DQL and JsonLogic are sent as the raw body string.
    // For JsonLogic the caller must pass a valid JSON string.
    body: ctx.arguments.query,
    // Prevent Obsidian from throwing on 4xx/5xx so we can surface the
    // error text ourselves with a useful message.
    throw: false,
  } as Parameters<typeof requestUrl>[0]);

  if (response.status >= 400) {
    return {
      content: [
        {
          type: "text",
          text: `Local REST API error ${response.status}: ${response.text}`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: response.text }],
  };
}
