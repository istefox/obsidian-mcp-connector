/**
 * Whole-file write precondition for the tools that replace or remove an
 * existing file in one step: `update_active_file`, `delete_vault_file` and
 * `delete_active_file` (ADR-0022, addendum).
 *
 * ADR-0019 covered the patch tools and ADR-0022 the two create tools; these
 * three were left as the last unguarded whole-file writers. The policy is the
 * one `checkCreatePrecondition` already applies to `create_vault_file`'s
 * overwrite branch, generalised over the verb so the refusal text names the
 * action the caller asked for and the read tool it should use to re-check.
 *
 * Pure: no App, no vault, no file, so it is unit-testable on its own.
 */
import { normalizeForPreconditionCompare } from "./patchHelpers";

export type WholeFileAction = "overwrite" | "delete";

/**
 * Decides whether a whole-file overwrite or delete may proceed. Returns
 * `null` to proceed, or the refusal text.
 *
 * `require` (the vault-level `requireWritePreconditions` setting) bites when
 * `expectedContent` is absent: the file always exists on these paths, so there
 * is no "brand-new file" branch to exempt, unlike `checkCreatePrecondition`.
 */
export function checkWholeFilePrecondition(args: {
  action: WholeFileAction;
  currentContent: string;
  expectedContent: string | undefined;
  require: boolean;
  readTool: "get_vault_file" | "get_active_file";
}): string | null {
  const verb = args.action === "delete" ? "delete" : "overwrite";
  if (args.expectedContent === undefined) {
    if (!args.require) return null;
    return (
      `Refusing to ${verb} — this vault requires a write precondition. Pass expectedContent with ` +
      `the text you believe currently occupies the whole file, read via ${args.readTool}, so a ` +
      `change made since your read cannot be ${verb === "delete" ? "deleted" : "overwritten"} unnoticed.`
    );
  }
  const expected = normalizeForPreconditionCompare(args.expectedContent);
  const actual = normalizeForPreconditionCompare(args.currentContent);
  if (expected === actual) return null;
  const tail =
    args.action === "delete"
      ? `Re-read the file with ${args.readTool} and decide again.`
      : `Re-read the file with ${args.readTool} and decide again. If you meant to change only part ` +
        `of the file, use the patch tool instead — this comparison is over the whole file.`;
  return (
    `Refusing to ${verb} — the file no longer matches expectedContent, so ${verb === "delete" ? "deleting" : "overwriting"} ` +
    `it would destroy a change you have not seen. ${tail} The most likely cause is the user editing ` +
    `the note or Obsidian Sync landing a change, not a bug.`
  );
}
