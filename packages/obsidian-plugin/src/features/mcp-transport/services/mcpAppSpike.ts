import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { MCP_APP_SPIKE_HTML } from "../assets/mcpAppSpikeSource";
import type { ResourceRegistry } from "./resourceRegistry";
import type { ToolRegistry } from "./toolRegistry";

/**
 * SPIKE (#427), throwaway — remove before this merges.
 *
 * Wires the smallest possible MCP App: one `ui://` resource carrying a
 * static page, and one tool pointing at it. It answers one question and
 * no other — whether Claude Desktop fetches and renders a `ui://`
 * resource served by this connector.
 *
 * The tool's own text result is untouched, which is not a courtesy: the
 * extension spec requires a UI-enabled tool to keep returning meaningful
 * content, and that requirement is what makes it safe to advertise the
 * `_meta` to every client without knowing which of them read it.
 */

/** The extension mandates this exact type; a bare text/html is not it. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const SPIKE_UI_URI = "ui://mcp-connector/spike";

/** The tool that carries the spike's UI pointer. */
export const SPIKE_TOOL_NAME = "search_vault_simple";

export function wireMcpAppSpike(
  toolRegistry: ToolRegistry,
  resourceRegistry: ResourceRegistry,
): void {
  toolRegistry.setMeta({
    [SPIKE_TOOL_NAME]: { ui: { resourceUri: SPIKE_UI_URI } },
  });

  // Listed as well as readable, though the extension permits omitting
  // UI-only resources from resources/list. During a spike the cheap
  // diagnostic is worth more than the tidiness: a client that lists but
  // never reads is a different answer from one that does neither.
  resourceRegistry.setLister(async () => [
    {
      uri: SPIKE_UI_URI,
      name: "MCP Connector spike",
      description: "Static page used to verify MCP Apps rendering (#427)",
      mimeType: MCP_APP_MIME_TYPE,
    },
  ]);

  resourceRegistry.setReader(async (uri) => {
    if (uri !== SPIKE_UI_URI) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Resource not found: ${uri}`,
      );
    }
    return {
      contents: [
        { uri, mimeType: MCP_APP_MIME_TYPE, text: MCP_APP_SPIKE_HTML },
      ],
    };
  });
}
