#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import prettier from "prettier";
import { buildSearchResultsHtml } from "./mcp-apps/buildAppHtml";

const shellPath = join(
  import.meta.dir,
  "../assets/mcp-apps/searchResults.html",
);
// Resolved rather than joined onto a fixed "../node_modules" path: this
// devDependency is a workspace-level install and bun hoists it to the
// monorepo root's node_modules, not this package's own — Bun.resolveSync
// walks the real ancestor chain the way `require`/`import` would.
const bundlePath = Bun.resolveSync(
  "@modelcontextprotocol/ext-apps/app-with-deps",
  import.meta.dir,
);
const outPath = join(
  import.meta.dir,
  "../src/features/mcp-apps/assets/searchResultsAppSource.ts",
);

const shell = readFileSync(shellPath, "utf8");
const bundle = readFileSync(bundlePath, "utf8");
const html = buildSearchResultsHtml(shell, bundle);

// Bundle size figures are cheap to recompute on every generation and stay
// accurate by construction. `main.js` before/after is not: it needs two
// full production builds, which this generator does not orchestrate. Those
// two numbers are a measurement recorded once, by hand, per ADR-0018 R-08 —
// see the task report for the run that produced them.
const bundleBytes = Buffer.byteLength(bundle, "utf8");
const bundleJsonBytes = Buffer.byteLength(JSON.stringify(bundle), "utf8");

const header = [
  "// AUTO-GENERATED — do not edit by hand.",
  "// Source: packages/obsidian-plugin/assets/mcp-apps/searchResults.html",
  "//         + node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js",
  "// Regenerate: bun run gen:mcp-app (from packages/obsidian-plugin)",
  "//",
  `// ext-apps bundle: ${bundleBytes} B raw, ${bundleJsonBytes} B JSON.stringify-escaped.`,
  "// main.js (clean `bun run build`), ADR-0018 R-08 measurement:",
  "//   before: 2,649,591 B",
  "//   after:  2,993,253 B",
  "//   delta:  +343,662 B, +12.97% — below the +20% Alternative G trigger",
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
