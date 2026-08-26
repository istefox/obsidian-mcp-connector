/**
 * Write-precondition policy for `create_vault_file` and
 * `create_vault_binary_file` (ADR-0022).
 *
 * ADR-0019 built `expectedContent` for the patch tools but never covered
 * these two — a genuine gap, closed here. Two pure, exported decision
 * functions mirror `checkReplacePrecondition` (`patchHelpers.ts`) in style:
 * no App, no vault, no file, so the policy is unit-testable on its own.
 *
 * Text and binary get an asymmetric guard. `create_vault_file` compares
 * whole-file text via `expectedContent`, because the reported failure mode
 * (#517) is an agent holding stale/partial content it intends to write —
 * a content problem. `create_vault_binary_file` takes a plain `overwrite`
 * boolean instead: there is no meaningful whole-file diff to show a caller
 * for binary bytes, and the risk there is a wrong path, not stale content.
 */
import { normalizeForPreconditionCompare } from "./patchHelpers";

/**
 * Decides whether `create_vault_file` may proceed. Returns `null` to
 * proceed, or the refusal text.
 *
 * `require` (the vault-level `requireWritePreconditions` setting) bites
 * ONLY the overwrite branch (`exists: true`, `expectedContent` absent) —
 * creating a brand-new file must never be blocked by the toggle.
 *
 * An absent `expectedContent` and an empty one are different when the path
 * does NOT exist: absent is simply unguarded, but a non-empty
 * `expectedContent` against a path that turns out not to exist means the
 * caller's belief about the vault is already stale, so that is refused
 * regardless of the toggle. `""` is not treated as a stale expectation —
 * empty is exactly what a non-existent file holds.
 */
export function checkCreatePrecondition(args: {
  exists: boolean;
  currentContent: string;
  expectedContent: string | undefined;
  require: boolean;
}): string | null {
  if (!args.exists) {
    if (!args.expectedContent) return null;
    return (
      `Refusing to create — expectedContent was non-empty, but no file exists at this path yet. ` +
      `If you intend to create a new file, omit expectedContent (or pass an empty string). If you ` +
      `believed this file already held that content, it may have been moved or deleted since you ` +
      `last read it — re-check with get_vault_file or list_vault_files and decide again.`
    );
  }
  if (args.expectedContent === undefined) {
    if (!args.require) return null;
    return (
      `Refusing to create — this vault requires a write precondition and a file already exists at ` +
      `this path. Pass expectedContent with the text you believe currently occupies the whole file, ` +
      `read via get_vault_file, so a change made since your read cannot be overwritten unnoticed.`
    );
  }
  const expected = normalizeForPreconditionCompare(args.expectedContent);
  const actual = normalizeForPreconditionCompare(args.currentContent);
  if (expected === actual) return null;
  return (
    `Refusing to overwrite — the file no longer matches expectedContent, so overwriting it would ` +
    `destroy a change you have not seen. Re-read the file with get_vault_file and decide again. The ` +
    `most likely cause is the user editing the note or Obsidian Sync landing a change, not a bug. If ` +
    `you meant to change only part of the file, use patch_vault_file instead — this comparison is ` +
    `over the whole file.`
  );
}

/**
 * Decides whether `create_vault_binary_file` may proceed. Returns `null`
 * to proceed, or the refusal text.
 *
 * `require` bites only the overwrite branch (`exists: true`, `overwrite`
 * absent), same as the text function above — creating a brand-new binary
 * file is never blocked by the toggle.
 */
export function checkCreateBinaryPrecondition(args: {
  exists: boolean;
  overwrite: boolean | undefined;
  require: boolean;
}): string | null {
  if (!args.exists) return null;
  if (args.overwrite === undefined) {
    if (!args.require) return null;
    return (
      `Refusing to overwrite — this vault requires a write precondition and a file already exists at ` +
      `this path. Pass overwrite: true if you intend to replace it, having confirmed its content is ` +
      `safe to lose (e.g. by checking it was your own prior write, or previewing a text sibling via ` +
      `get_vault_file).`
    );
  }
  if (args.overwrite) return null;
  return (
    `Refusing to overwrite — a file already exists at this path and overwrite was false. The most ` +
    `likely cause is the user creating or editing that file since you last checked, or a path chosen ` +
    `by mistake. Pass overwrite: true to replace it deliberately, or choose a different path.`
  );
}
