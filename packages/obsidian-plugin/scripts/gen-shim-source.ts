#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const srcPath = join(
  import.meta.dir,
  "../src/features/mcp-client-config/services/connectorShim.js",
);
const outPath = join(
  import.meta.dir,
  "../src/features/mcp-client-config/assets/connectorShimSource.ts",
);

const source = readFileSync(srcPath, "utf8");
const header = [
  "// AUTO-GENERATED — do not edit by hand.",
  "// Source: packages/obsidian-plugin/src/features/mcp-client-config/services/connectorShim.js",
  "// Regenerate: bun run packages/obsidian-plugin/scripts/gen-shim-source.ts",
].join("\n");
writeFileSync(
  outPath,
  `${header}\nexport const CONNECTOR_SHIM_SOURCE = ${JSON.stringify(source)};\n`,
);
console.warn(`Wrote ${outPath} (${source.length} chars)`);
