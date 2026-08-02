#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import prettier from "prettier";

const srcPath = join(import.meta.dir, "connectorShim.js");
const outPath = join(
  import.meta.dir,
  "../src/features/mcp-client-config/assets/connectorShimSource.ts",
);

const source = readFileSync(srcPath, "utf8");
const header = [
  "// AUTO-GENERATED — do not edit by hand.",
  "// Source: packages/obsidian-plugin/scripts/connectorShim.js",
  "// Regenerate: bun run packages/obsidian-plugin/scripts/gen-shim-source.ts",
].join("\n");
const raw = `${header}\nexport const CONNECTOR_SHIM_SOURCE = ${JSON.stringify(source)};\n`;

// Prettier-format before writing. The output lands under `src/`, which
// `format:check` globs, and Prettier rewrites this file every time: it
// breaks the assignment after `=` and re-quotes the literal to single
// quotes (its "fewer escapes wins" heuristic beats `singleQuote: false`
// here, because the shim's source is full of `"`). Emitting the raw form
// therefore made every regeneration fail CI until someone remembered
// `bun run format` — CI runs `format:check` first, so it failed before
// the sync test could even report the real problem.
//
// This only changes how the literal is WRITTEN, never what it decodes
// to, which is what `mcpbGenerator.test.ts`'s sync test compares.
const config = await prettier.resolveConfig(outPath);
const formatted = await prettier.format(raw, {
  ...config,
  parser: "typescript",
});

writeFileSync(outPath, formatted);
console.warn(`Wrote ${outPath} (${source.length} chars)`);
