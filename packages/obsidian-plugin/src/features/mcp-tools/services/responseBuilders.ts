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
  structuredContent?: Record<string, unknown>;
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
 * JSON error payload (compact, no indentation — consumers are LLMs,
 * whitespace is pure token cost) with a stable `error` + `errorCode`
 * shape, plus any extra context fields.
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
        text: JSON.stringify({ error, errorCode, ...extras }),
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON success payload, compact (no indentation). Emits `structuredContent` for structured-aware clients. */
export function successJson(value: unknown): ToolResponse {
  // JSON.stringify(undefined) returns the JS value `undefined`, not a string,
  // which would drop the required `text` field on serialization. Emit valid
  // JSON null for that case and omit structuredContent (no structured payload).
  if (value === undefined) {
    return { content: [{ type: "text", text: "null" }] };
  }
  const text = JSON.stringify(value);
  const structuredContent: Record<string, unknown> = isPlainObject(value)
    ? value
    : { result: value };
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}
