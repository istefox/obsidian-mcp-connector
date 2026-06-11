/**
 * Shared MCP tool response builders.
 *
 * The same three shapes were copy-pasted (with drift) across the tool
 * handlers: a plain-text error, a JSON-stringified payload, and a plain
 * text success. Centralizing them keeps the wire format identical in
 * every tool. The exact message strings stay at the call sites — these
 * helpers only own the envelope.
 */

export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

/** Plain-text error: `{ content: [text], isError: true }`. */
export function errorText(message: string): ToolResponse & { isError: true } {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * JSON error payload (pretty-printed, 2-space indent) with a stable
 * `error` + `errorCode` shape, plus any extra context fields.
 */
export function errorJson(
  error: string,
  errorCode: string,
  extras?: Record<string, unknown>,
): ToolResponse & { isError: true } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error, errorCode, ...extras }, null, 2),
      },
    ],
    isError: true,
  };
}

/** Plain-text success: `{ content: [text] }`. */
export function successText(text: string): ToolResponse {
  return {
    content: [{ type: "text", text }],
  };
}

/** JSON success payload, pretty-printed with 2-space indent. */
export function successJson(value: unknown): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}
