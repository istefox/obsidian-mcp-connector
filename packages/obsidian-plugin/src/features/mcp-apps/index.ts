/**
 * MCP Apps feature (ADR-0018, OMC-016): the `ui://` resource that renders
 * `search_vault_smart` and `search_vault_simple` results as a ranked,
 * clickable list in a host that speaks the MCP Apps extension.
 *
 * `wireSearchResultsApp` is the feature's whole public surface: it fills
 * an already-constructed `ResourceRegistry` with the one static page and
 * points the two search tools at it via `_meta`. Composed at
 * `composeToolRegistry`, alongside the other features that fill the
 * registries the transport only serves.
 */

import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { ResourceRegistry } from "$/features/mcp-transport/services/resourceRegistry";
import type { ToolRegistry } from "$/features/mcp-transport/services/toolRegistry";
import { SEARCH_RESULTS_APP_HTML } from "./assets/searchResultsAppSource";

/** Naming fixed by ADR-0018 — do not derive or re-invent either value. */
export const SEARCH_RESULTS_RESOURCE_URI = "ui://mcp-connector/search-results";
export const SEARCH_RESULTS_MIME_TYPE = "text/html;profile=mcp-app";

export function wireSearchResultsApp(
  toolRegistry: ToolRegistry,
  resourceRegistry: ResourceRegistry,
): void {
  // Listed as well as readable, though the extension permits omitting
  // UI-only resources from resources/list (R-02). One static entry: the
  // registry is populated at setup, from a static declaration, with no
  // discovery and no per-request work.
  resourceRegistry.setLister(async () => [
    {
      uri: SEARCH_RESULTS_RESOURCE_URI,
      name: "Search results",
      description:
        "Ranked list view for search_vault_smart and search_vault_simple",
      mimeType: SEARCH_RESULTS_MIME_TYPE,
    },
  ]);

  resourceRegistry.setReader(async (uri) => {
    if (uri !== SEARCH_RESULTS_RESOURCE_URI) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Resource not found: ${uri}`,
      );
    }
    return {
      contents: [
        {
          uri,
          mimeType: SEARCH_RESULTS_MIME_TYPE,
          text: SEARCH_RESULTS_APP_HTML,
        },
      ],
    };
  });

  // Both key forms are written because registerAppTool in ext-apps@1.7.5
  // does exactly that, and hosts are told to read either (ADR-0018 D4).
  toolRegistry.setMeta({
    search_vault_simple: {
      ui: { resourceUri: SEARCH_RESULTS_RESOURCE_URI },
      "ui/resourceUri": SEARCH_RESULTS_RESOURCE_URI,
    },
    search_vault_smart: {
      ui: { resourceUri: SEARCH_RESULTS_RESOURCE_URI },
      "ui/resourceUri": SEARCH_RESULTS_RESOURCE_URI,
    },
  });
}
