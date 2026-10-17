/**
 * What a client may read about a failure that did not start in the vault:
 * the model cache, the semantic index, the ONNX runtime files, the index
 * lock. Their messages name paths and URLs of the host (the user's home,
 * their cache folder, a cloud-sync folder), and no scrub of free text can
 * be trusted to cut every one out: a path with a space, a Windows path or a
 * `file:` URL gets through. So the client is never given the text. It gets
 * what failed and, when the error has one, its errno-style code, which is a
 * short token and holds no path. The whole error goes to the log, which is
 * stderr on the server.
 */

/** A code such as `EACCES` or `ERR_SQLITE_ERROR`, and nothing longer or looser. */
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/** The start of a Node fs error message: `EACCES: permission denied, open …`. */
const LEADING_ERRNO = /^(E[A-Z0-9]{2,15}): /;

/** What the runtime-file failure says, shared so a search can keep it. */
export const RUNTIME_FILES_FAILED =
  "the ONNX runtime files could not be downloaded or stored";

/**
 * The code of `err`, or of its `cause` (a failed `fetch` carries the
 * network error there), when it is a plain token.
 */
export function codeOf(err: unknown): string | undefined {
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  for (const candidate of [err, cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === "string" && CODE.test(code)) return code;
  }
  return undefined;
}

/** The errno a Node fs error message starts with, for an error seen only as text. */
export function leadingErrno(message: string): string | undefined {
  return LEADING_ERRNO.exec(message)?.[1];
}

/** `what` failed, with its code if it has a plain one, and where to read more. */
export function fixedMessage(what: string, code?: string): string {
  const shown = code !== undefined && CODE.test(code) ? ` (${code})` : "";
  return `${what}${shown}. Details are in the server log.`;
}

const OWN_RUNTIME_FAILURE = new RegExp(
  `^Semantic search failed: ${RUNTIME_FILES_FAILED}(?: \\([A-Z][A-Z0-9_]{1,39}\\))?\\. Details are in the server log\\.$`,
);

/**
 * Whether `message` is the fixed text of a runtime-file failure, as the
 * shared search handler wraps it, and so safe to pass on as it is.
 */
export function isOwnRuntimeFailure(message: string): boolean {
  return OWN_RUNTIME_FAILURE.test(message);
}
