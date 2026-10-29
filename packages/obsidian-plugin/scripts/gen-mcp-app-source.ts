#!/usr/bin/env bun
import { writeFileSync } from "fs";
import { join } from "path";
import prettier from "prettier";
import { encodeAppHtml } from "./mcp-apps/encodeAppHtml";
import { generateSearchResultsHtml } from "./mcp-apps/generateAppHtml";

const outPath = join(
  import.meta.dir,
  "../src/features/mcp-apps/assets/searchResultsAppSource.ts",
);
const { html, bundle } = await generateSearchResultsHtml();
const encoded = encodeAppHtml(html);

// Recomputed from the actual compiled view and SDK on every generation.
const bundleBytes = Buffer.byteLength(bundle, "utf8");
const bundleJsonBytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");

const header = [
  "// AUTO-GENERATED — do not edit by hand.",
  "// Source: packages/obsidian-plugin/assets/mcp-apps/searchResults.html",
  "//         + assets/mcp-apps/searchResults.js and the ext-apps SDK (compiled inline)",
  "// Regenerate: bun run gen:mcp-app (from packages/obsidian-plugin)",
  "// Read it through searchResultsAppHtml() in ./searchResultsAppHtml.ts.",
  "//",
  `// Inline view + ext-apps bundle: ${bundleBytes} B raw, ${bundleJsonBytes} B JSON.stringify-escaped (compiler-dependent, informational).`,
  `// Whole page: ${Buffer.byteLength(html, "utf8")} B, ${encoded.length} B gzipped and base64-encoded (#629).`,
].join("\n");
const raw = `${header}\nexport const SEARCH_RESULTS_APP_HTML_GZIP_BASE64 = ${JSON.stringify(encoded)};\n`;

// Prettier before writing, as gen-shim-source.ts does: the output lands
// under `src/`, which `format:check` globs.
const config = await prettier.resolveConfig(outPath);
const formatted = await prettier.format(raw, {
  ...config,
  parser: "typescript",
});

writeFileSync(outPath, formatted);
console.warn(`Wrote ${outPath} (${html.length} chars)`);
