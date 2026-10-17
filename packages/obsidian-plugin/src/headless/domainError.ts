/**
 * Errors the headless side raises to explain a refusal, as opposed to the
 * operating system's own failures.
 *
 * The tools render an error that has a `code` as a generic phrase for that
 * errno ("file system error (ECODE)") and drop its message, so no host path
 * reaches a client. A domain error has to say what happened and what to do,
 * so it carries a `reason` and no `code`: its message is kept. The tools
 * scrub absolute paths from it only on a best-effort basis, so it must never
 * name a path outside the vault. Code that branches on an errno reads
 * `code`, which only errors that stand for a real errno carry.
 */

export type DomainError = Error & { reason: string };

export function errorWithReason(message: string, reason: string): DomainError {
  return Object.assign(new Error(message), { reason });
}
