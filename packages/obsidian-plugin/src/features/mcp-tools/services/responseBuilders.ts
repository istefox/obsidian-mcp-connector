/**
 * Shared MCP tool response builders.
 *
 * The same shapes were copy-pasted (with drift) across the tool handlers:
 * a JSON error payload, a JSON success payload and a plain text success.
 * Centralizing them keeps the wire format identical in every tool. The
 * exact message strings stay at the call sites — these helpers only own
 * the envelope.
 *
 * Every failure goes through {@link errorJson}: the text is always a JSON
 * body `{ error, errorCode, ...extras }` with a stable snake_case
 * `errorCode`, so a client branches on the code and shows the message.
 * The code vocabulary is listed in `docs/error-codes.md`; reuse an
 * existing code before inventing one.
 */

export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

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

export type SuccessJsonOptions = {
  /**
   * Also emit the payload as `structuredContent`. Off by default: the
   * text block already carries the whole payload, no tool declares an
   * `outputSchema`, and the second copy doubles the response (#627).
   * Turn it on for a tool whose clients are known to read
   * `structuredContent` alone.
   */
  structured?: boolean;
};

/**
 * JSON success payload, compact (no indentation). The payload travels in
 * the text block; `structuredContent` is added only when the call opts in
 * with `{ structured: true }` (ADR-0009, amended for #627).
 */
export function successJson(
  value: unknown,
  options: SuccessJsonOptions = {},
): ToolResponse {
  // JSON.stringify(undefined) returns the JS value `undefined`, not a string,
  // which would drop the required `text` field on serialization. Emit valid
  // JSON null for that case and omit structuredContent (no structured payload).
  if (value === undefined) {
    return { content: [{ type: "text", text: "null" }] };
  }
  const text = JSON.stringify(value);
  if (!options.structured) return { content: [{ type: "text", text }] };
  const structuredContent: Record<string, unknown> = isPlainObject(value)
    ? value
    : { result: value };
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}
