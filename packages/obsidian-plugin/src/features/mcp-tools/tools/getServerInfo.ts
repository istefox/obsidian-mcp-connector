import { type } from "arktype";
import { successText } from "../services/responseBuilders";

export const getServerInfoSchema = type({
  name: '"get_server_info"',
  arguments: {},
}).describe("Returns health status and version of the MCP Connector server.");

export type LocalTransportInfo = {
  protocol: "http";
  host: string;
  port: number;
  path: string;
};

export type GetServerInfoContext = {
  // `object` (not `Record<string, never>`) to match the ToolRegistry
  // constraint which uses `object` for no-arg tools (see toolRegistry.ts).
  arguments: object;
  pluginVersion: string;
  // Resolved per-request because the registry is built before the HTTP
  // server binds — the port is unknown at registration time but
  // guaranteed available by the time a tool call lands here. Returns
  // undefined defensively so tests (and any future caller that wires
  // the registry without a live transport) can opt out.
  getLocalTransport?: () => LocalTransportInfo | undefined;
};

export async function getServerInfoHandler(
  ctx: GetServerInfoContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const localTransport = ctx.getLocalTransport?.();
  const body = {
    status: "ok",
    version: ctx.pluginVersion,
    transport: "streamable-http",
    ...(localTransport ? { localTransport } : {}),
  };
  return successText(JSON.stringify(body));
}
