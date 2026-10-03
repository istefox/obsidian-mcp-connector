/**
 * Regex compilation shared by the tools that take a user pattern
 * (`search_and_replace`, `search_vault_simple` with `regex: true`).
 * Obsidian runs on the renderer's main thread with no regex timeout, so a
 * pattern with nested quantifiers could freeze the app; such patterns are
 * refused up front with `unsafe_regex`, a pattern that does not compile
 * with `invalid_regex`.
 */
export type SafeRegexResult =
  | { ok: true; regex: RegExp }
  | { ok: false; errorCode: "invalid_regex" | "unsafe_regex"; message: string };

const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*?]/;
const NESTED_ALTERNATION = /\((?:[^()]*[+*?][^()]*\|)+[^()]+\)[+*?{]/;

export function compileSafeRegex(
  pattern: string,
  flags: string,
): SafeRegexResult {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorCode: "invalid_regex",
      message: `Invalid regex: ${msg}`,
    };
  }
  if (NESTED_QUANTIFIER.test(pattern) || NESTED_ALTERNATION.test(pattern)) {
    return {
      ok: false,
      errorCode: "unsafe_regex",
      message:
        "Pattern contains nested quantifiers (ReDoS risk). Simplify the pattern.",
    };
  }
  return { ok: true, regex };
}

/**
 * Path predicate for a `scope` argument: each entry is a file path (with
 * or without `.md`) or a folder prefix. An empty or missing scope matches
 * everything.
 */
export function makeScopeFilter(
  scope: readonly string[] | undefined,
): (path: string) => boolean {
  if (!scope || scope.length === 0) return () => true;
  return (path: string) =>
    scope.some(
      (s) =>
        path === s ||
        path === `${s}.md` ||
        path.startsWith(s.endsWith("/") ? s : `${s}/`),
    );
}
