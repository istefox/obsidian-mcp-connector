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
// two numbers are recorded by hand, per ADR-0018 R-08: re-measure with a
// clean `bun run build` and update them here whenever the page or the
// bundle changes, or the header keeps quoting a build nobody can reproduce.
// `before` is the same tree with the placeholder asset in its place, so it
// only moves when something outside this feature enters the bundle.
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
  "//   after:  3,007,439 B",
  "//   delta:  +357,848 B, +13.51% — below the +20% Alternative G trigger",
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
