import { readFileSync } from "fs";
import { join } from "path";
import { buildSearchResultsHtml } from "./buildAppHtml";

/** Compile public SDK imports and view together; no runtime Blob import. */
export async function generateSearchResultsHtml() {
  const assets = join(import.meta.dir, "../../assets/mcp-apps");
  const result = await Bun.build({
    entrypoints: [join(assets, "searchResults.js")],
    target: "browser",
    format: "esm",
    minify: true,
    splitting: false,
  });
  if (!result.success)
    throw new Error(`MCP App build failed: ${result.logs.join("\n")}`);
  if (result.outputs.length !== 1)
    throw new Error("MCP App must be self-contained");
  const bundle = await result.outputs[0].text();
  const html = buildSearchResultsHtml(
    readFileSync(join(assets, "searchResults.html"), "utf8"),
    bundle,
  );
  return { html, bundle };
}
