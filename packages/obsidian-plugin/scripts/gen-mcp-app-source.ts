#!/usr/bin/env bun
import { writeFileSync } from "fs";
import { join } from "path";
import prettier from "prettier";
import { generateSearchResultsHtml } from "./mcp-apps/generateAppHtml";

const outPath = join(
  import.meta.dir,
  "../src/features/mcp-apps/assets/searchResultsAppSource.ts",
);
const { html, bundle } = await generateSearchResultsHtml();

// Recomputed from the actual compiled view and SDK on every generation.
const bundleBytes = Buffer.byteLength(bundle, "utf8");
const bundleJsonBytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");

const header = [
  "// AUTO-GENERATED — do not edit by hand.",
  "// Source: packages/obsidian-plugin/assets/mcp-apps/searchResults.html",
  "//         + assets/mcp-apps/searchResults.js and the ext-apps SDK (compiled inline)",
  "// Regenerate: bun run gen:mcp-app (from packages/obsidian-plugin)",
  "//",
  `// Inline view + ext-apps bundle: ${bundleBytes} B raw, ${bundleJsonBytes} B JSON.stringify-escaped.`,
  `// Generated with Bun ${Bun.version}; CI pins this compiler for the drift check.`,
].join("\n");
const raw = `${header}\nexport const SEARCH_RESULTS_APP_HTML = ${JSON.stringify(html)};\n`;

// Same two constraints as gen-shim-source.ts, for the same reasons:
// JSON.stringify rather than a template literal because the payload is
// full of backticks and quotes, Prettier-before-write because the output
// lands under `src/`, which `format:check` globs.
const config = await prettier.resolveConfig(outPath);
const formatted = await prettier.format(raw, {
  ...config,
  parser: "typescript",
});

writeFileSync(outPath, formatted);
console.warn(`Wrote ${outPath} (${html.length} chars)`);
