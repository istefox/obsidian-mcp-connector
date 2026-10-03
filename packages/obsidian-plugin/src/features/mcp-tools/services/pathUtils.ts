/**
 * Path helpers shared by the tools that take a `folder` or a directory
 * `path`. Before this module each tool carried its own copy of the
 * slash-trimming regex, and the copies had drifted: only some of them
 * treated `"/"` as the vault root.
 */

/** Strips leading and trailing slashes: `"/a/b/"` is `"a/b"`. */
export function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/**
 * The `startsWith` prefix for a `folder` argument, or `null` when there is
 * nothing to filter on: the argument is absent, or it names the vault root
 * (`""`, `"/"`). `"Notes"`, `"/Notes"` and `"Notes/"` all give `"Notes/"`.
 */
export function folderPrefix(folder: string | undefined): string | null {
  if (folder === undefined) return null;
  const trimmed = trimSlashes(folder);
  return trimmed === "" ? null : `${trimmed}/`;
}

/**
 * The order every listing tool uses for paths and names: English collation,
 * case- and accent-sensitive, so the output does not depend on the host's
 * locale across macOS, Linux and Windows.
 */
export const comparePaths: (a: string, b: string) => number = new Intl.Collator(
  "en",
  { sensitivity: "variant" },
).compare;
