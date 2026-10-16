/**
 * A side channel from a rename to the tool that asked for it.
 *
 * `fileManager.renameFile` returns nothing, so it has no way to say that a
 * `.base` file still names the old path in a filter. The shared
 * `rename_vault_file` handler reports `{ ok, path }` and cannot be changed
 * from here. The headless registration of that tool runs the handler
 * inside `collectRenameWarnings`, the file manager reports into the
 * collector of the call it runs under, and the registration adds what was
 * collected to the result. A rename outside any collector reports to no
 * one.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const collectors = new AsyncLocalStorage<string[]>();

/** Run `fn`, and return what it reported next to what it returned. */
export async function collectRenameWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const result = await collectors.run(warnings, fn);
  return { result, warnings };
}

/** Add a warning to the rename this call belongs to, if any. */
export function reportRenameWarning(message: string): void {
  collectors.getStore()?.push(message);
}

type ToolText = { content: Array<{ type: "text"; text: string }> };

/**
 * `result` with the warnings added as a `warnings` list of strings in its
 * JSON text, success or failure alike. A result with no warnings, or whose
 * text is not a JSON object, is returned as it is, so the shape clients
 * already read does not change.
 */
export function withRenameWarnings<T extends ToolText>(
  result: T,
  warnings: readonly string[],
): T {
  if (warnings.length === 0) return result;
  const first = result.content[0];
  if (first?.type !== "text") return result;
  let body: unknown;
  try {
    body = JSON.parse(first.text);
  } catch {
    return result;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return result;
  }
  return {
    ...result,
    content: [
      { ...first, text: JSON.stringify({ ...body, warnings }) },
      ...result.content.slice(1),
    ],
  };
}
