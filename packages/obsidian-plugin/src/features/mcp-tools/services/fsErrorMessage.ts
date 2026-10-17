/**
 * Vault-safe rendering of a caught filesystem error (#88).
 *
 * Node fs errors embed the absolute host path in their message
 * ("ENOENT: no such file or directory, open '/Users/…/vault/Note.md'"),
 * which would expose $HOME, cloud-sync identifiers and the vault folder
 * name to the MCP client. Tool handlers that catch around a vault write,
 * rename, trash or read render the error through this helper instead of
 * `e.message`: known errno codes map to a short caller-actionable phrase,
 * and anything else keeps its message with absolute-path spans replaced
 * by `<path>`. The handler's own prefix already names the vault-relative
 * target, so no information the caller can act on is lost.
 */

const ERRNO_MESSAGES: Record<string, string> = {
  ENOENT: "file or directory does not exist",
  EACCES: "permission denied",
  EPERM: "permission denied",
  ENOTEMPTY: "directory not empty",
  EEXIST: "target already exists",
  EISDIR: "target is a directory",
  ENOTDIR: "a path component is not a directory",
  ENOSPC: "no space left on device",
  EROFS: "file system is read-only",
  EBUSY: "file is in use",
  EMFILE: "too many open files",
  ENFILE: "too many open files",
  ENAMETOOLONG: "file name too long",
};

/**
 * Absolute-path spans in an error message: POSIX (`/Users/…`), Windows
 * drive (`C:\…` or `C:/…`) and UNC (`\\server\…`). The span must start a
 * token (after start-of-string, whitespace, a quote, `(` or `=`), so the
 * separators inside a vault-relative path (`Notes/Daily/x.md`) never
 * match. A URL's `//host/path` tail still does — acceptable collateral
 * in an fs error message, and on the safe side.
 */
const ABSOLUTE_PATH_SPAN =
  /(^|[\s'"`(=])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`]+)/g;

/**
 * A quoted absolute path, which Node uses for every path it reports and
 * which may hold spaces (`'/home/jane/My Vault/sub'`). It runs to the
 * closing quote that ends the token, so a quote inside a name (`O'Brien`)
 * does not cut it short. Applied before the unquoted pattern, which would
 * stop at the first space.
 */
const QUOTED_ABSOLUTE_PATH =
  /(['"`])(?:[A-Za-z]:[\\/]|\\\\|\/).*?\1(?=$|[\s,;:)\]])/g;

/** Message for a caught fs error with absolute host paths suppressed. */
export function fsErrorMessage(e: unknown): string {
  const errno = (e as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errno === "string") {
    const mapped = ERRNO_MESSAGES[errno];
    // An unknown errno still names the failure class without the path
    // trailer — "EIO" beats a scrubbed sentence with holes in it.
    if (mapped !== undefined) return mapped;
    return `file system error (${errno})`;
  }
  const raw = e instanceof Error ? e.message : String(e);
  return raw
    .replace(QUOTED_ABSOLUTE_PATH, "$1<path>$1")
    .replace(ABSOLUTE_PATH_SPAN, "$1<path>");
}
