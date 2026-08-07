#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import prettier from "prettier";

const srcPath = join(import.meta.dir, "../assets/mcpAppSpike.html");
const outPath = join(
  import.meta.dir,
  "../src/features/mcp-transport/assets/mcpAppSpikeSource.ts",
);

const source = readFileSync(srcPath, "utf8");
const header = [
  "// AUTO-GENERATED — do not edit by hand.",
  "// Source: packages/obsidian-plugin/assets/mcpAppSpike.html",
  "// Regenerate: bun run packages/obsidian-plugin/scripts/gen-mcp-app-source.ts",
].join("\n");
const raw = `${header}\nexport const MCP_APP_SPIKE_HTML = ${JSON.stringify(source)};\n`;

// Same two constraints as gen-shim-source.ts, for the same reasons.
// JSON.stringify rather than a template literal: HTML carries backticks
// and `${...}` the moment anyone adds a script, and a raw embed would
// break on them silently. Prettier before writing: the output lands under
// `src/`, which `format:check` globs, and Prettier rewrites the literal's
// quoting every time — emitting the unformatted form fails CI before any
// sync test can report the real problem.
const config = await prettier.resolveConfig(outPath);
const formatted = await prettier.format(raw, {
  ...config,
  parser: "typescript",
});

writeFileSync(outPath, formatted);
console.warn(`Wrote ${outPath} (${source.length} chars)`);
