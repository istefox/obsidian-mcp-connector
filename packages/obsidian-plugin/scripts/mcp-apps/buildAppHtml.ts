/**
 * Assembles the search-results MCP App page from a hand-written shell and
 * the `@modelcontextprotocol/ext-apps` view bundle (ADR-0018 D10). Pure and
 * I/O-free: the generator and the drift test both read the two inputs
 * themselves and call this with the file contents.
 */

/** The shell's splice point. Must appear exactly once in the shell. */
export const BUNDLE_MARKER = "__MCP_APPS_BUNDLE_SOURCE__";

const SCRIPT_CLOSE_PATTERN = /<\/script/gi;

/**
 * Splices `bundle` into `shell` at {@link BUNDLE_MARKER}.
 *
 * `bundle` is inserted verbatim inside an inline `<script>` element, so a
 * `</script` sequence anywhere in it would close that element early and
 * truncate the page — checked before splicing, not after, so the failure
 * names the offending byte instead of shipping a broken page.
 *
 * Uses split/join rather than `String.prototype.replace`, whose
 * replacement-string argument treats `$&`, `` $` ``, `$'` and `$<n>` as
 * pattern references — exactly the kind of sequence 337 KB of minified JS
 * can contain by accident.
 */
export function buildSearchResultsHtml(shell: string, bundle: string): string {
  const offendingIndex = bundle.search(SCRIPT_CLOSE_PATTERN);
  if (offendingIndex !== -1) {
    throw new Error(
      `ext-apps bundle contains a "</script" sequence at index ${offendingIndex}; ` +
        "splicing it into an inline <script> element would truncate the page.",
    );
  }
  return shell.split(BUNDLE_MARKER).join(bundle);
}
