/**
 * Builds an `obsidian://open` deep link for a note, and the small set of
 * response-shaping helpers every note-identifying tool needs around it
 * (issue #533, ADR-0026).
 *
 * Pure — no `obsidian` import, no `App`, no I/O — so it is unit-testable
 * without a vault fixture.
 */

import { errorJson, type ToolResponse } from "./responseBuilders";

/**
 * `obsidian://open?vault=<vault>&file=<path>[#<heading>]`.
 *
 * When `heading` is present it is joined to `path` with a literal `#`
 * *before* encoding, so the single `encodeURIComponent` call over the
 * combined value emits `%23` for the separator — the heading lives inside
 * the `file` parameter's value, per Obsidian's own URI grammar
 * (`Note%23Heading`), never as a URI fragment after the query string
 * (ADR-0026 D2, Alternative C). `encodeURIComponent` is used deliberately
 * over the narrower escaping `headingRename.ts` uses for markdown link
 * text — that answers what round-trips through a human reading a note; this
 * answers what a URI parser must not misinterpret (ADR-0026 D3).
 */
export function buildObsidianUri(
  vaultName: string,
  path: string,
  heading?: string,
): string {
  const fileValue = heading ? `${path}#${heading}` : path;
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(fileValue)}`;
}

/**
 * Appends `uri` as a second, trailing text block, leaving `content[0]`
 * (and every other key) untouched — the byte-identical-leading-block
 * requirement a raw-text tool result cannot satisfy by mutating its single
 * block (ADR-0026 D4, Alternative B). No-op on an error result, mirroring
 * `withSearchResultsPayload`'s shape-preserving pattern (ADR-0018 D5).
 */
export function withUriBlock<T extends ToolResponse>(
  result: T,
  uri: string,
): T {
  if (result.isError) return result;
  return {
    ...result,
    content: [...result.content, { type: "text", text: `URI: ${uri}` }],
  };
}

/**
 * The single `heading_not_found` error shape (ADR-0026 D9), shared by
 * `get_vault_file`, `get_active_file` and `get_or_create_daily_note` so the
 * three tools cannot drift on wording.
 */
export function headingNotFoundError(
  heading: string,
  path: string,
): ToolResponse & { isError: true } {
  return errorJson(
    `Heading "${heading}" not found in "${path}".`,
    "heading_not_found",
    { heading, path },
  );
}
