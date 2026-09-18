import { expect, test } from "bun:test";
import { generateSearchResultsHtml } from "../../../../scripts/mcp-apps/generateAppHtml";
import { SEARCH_RESULTS_APP_HTML } from "./searchResultsAppSource";

test("generated page matches shell, view entry and installed SDK", async () => {
  const { html } = await generateSearchResultsHtml();
  expect(SEARCH_RESULTS_APP_HTML, "Run bun run gen:mcp-app").toBe(html);
});
