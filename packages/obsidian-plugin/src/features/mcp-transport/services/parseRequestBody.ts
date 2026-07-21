import type { IncomingMessage } from "node:http";

/**
 * Tools whose handler may emit a server-initiated notification
 * (`notifications/tools/list_changed` for the activation tools;
 * `notifications/progress` for `search_vault_smart` while the semantic
 * index is building, #344). A call to one of these must get an SSE
 * response so the notification can ride back on its own POST stream (see
 * mcpServer.ts / activateTool.ts / searchVaultSmart.ts).
 */
const SSE_NOTIFICATION_TOOLS = new Set([
  "activate_tool",
  "activate_tools",
  "search_vault_smart",
]);

/**
 * Whether a parsed JSON-RPC request body targets a tool whose handler may
 * emit a server-initiated notification (`SSE_NOTIFICATION_TOOLS`).
 *
 * Accepts either a single JSON-RPC request object or a batch array, and
 * returns true if ANY member is a `tools/call` whose `params.name` is in
 * that set. Everything else (notifications, responses, other tool calls,
 * malformed shapes) returns false.
 *
 * Used by the transport to decide whether the response must be delivered
 * as SSE (so a notification the handler emits can ride back on the same
 * POST stream) instead of the default JSON mode.
 */
export function bodyTargetsSseNotificationTool(parsed: unknown): boolean {
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.some((m) => {
    if (typeof m !== "object" || m === null) return false;
    const msg = m as { method?: unknown; params?: unknown };
    if (msg.method !== "tools/call") return false;
    const params = msg.params;
    if (typeof params !== "object" || params === null) return false;
    const name = (params as { name?: unknown }).name;
    return typeof name === "string" && SSE_NOTIFICATION_TOOLS.has(name);
  });
}

/**
 * Read an IncomingMessage body into a UTF-8 string, aborting once more
 * than `cap` bytes have arrived.
 *
 * `httpServer.ts` only rejects oversize bodies via the declared
 * Content-Length; a chunked request with no length still reaches here, so
 * we re-cap while buffering. Returns `null` when the cap is exceeded so a
 * hostile payload never accumulates unbounded in the renderer; the caller
 * must answer 413 and destroy the request instead of handing the drained
 * stream to the SDK.
 *
 * Precondition: the stream must not have been consumed yet. The caller
 * passes the parsed result back to `transport.handleRequest(req, res,
 * parsedBody)` so the SDK does not attempt to re-read the drained stream.
 */
export async function readBodyWithCap(
  req: IncomingMessage,
  cap: number,
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > cap) {
        aborted = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!aborted) reject(err);
    });
  });
}
