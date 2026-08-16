import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { buildSearchResultsHtml } from "../../../../scripts/mcp-apps/buildAppHtml";
import { SEARCH_RESULTS_APP_HTML } from "./searchResultsAppSource";

const shellPath = join(
  import.meta.dir,
  "../../../../assets/mcp-apps/searchResults.html",
);
// Resolved the same way scripts/gen-mcp-app-source.ts resolves it, not a
// hardcoded node_modules path: this devDependency is a workspace-level
// install and bun hoists it to the monorepo root's node_modules, not this
// package's own — Bun.resolveSync walks the real ancestor chain the way
// require/import would.
const bundlePath = Bun.resolveSync(
  "@modelcontextprotocol/ext-apps/app-with-deps",
  import.meta.dir,
);

test("searchResultsAppSource.ts is in sync with the shell and the installed ext-apps bundle", () => {
  // Rebuilds the constant from the same two disk inputs and the same pure
  // function the generator calls, rather than diffing a single file the
  // way the .mcpb shim-identity check does: this fails both when the shell
  // is edited without regenerating and when ext-apps is bumped without
  // regenerating.
  const shell = readFileSync(shellPath, "utf8");
  const bundle = readFileSync(bundlePath, "utf8");
  expect(
    SEARCH_RESULTS_APP_HTML,
    "src/features/mcp-apps/assets/searchResultsAppSource.ts is stale — run: " +
      "bun run gen:mcp-app (from packages/obsidian-plugin)",
  ).toBe(buildSearchResultsHtml(shell, bundle));
});
