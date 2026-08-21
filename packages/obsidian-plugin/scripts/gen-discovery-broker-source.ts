#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import prettier from "prettier";

const srcPath = join(import.meta.dir, "discoveryBroker.js");
const outPath = join(
  import.meta.dir,
  "../src/features/mcp-client-config/assets/discoveryBrokerSource.ts",
);

const source = readFileSync(srcPath, "utf8");
const header = [
  "// AUTO-GENERATED — do not edit by hand.",
  "// Source: packages/obsidian-plugin/scripts/discoveryBroker.js",
  "// Regenerate: bun run packages/obsidian-plugin/scripts/gen-discovery-broker-source.ts",
].join("\n");
const raw = `${header}\nexport const DISCOVERY_BROKER_SOURCE = ${JSON.stringify(source)};\n`;
const config = await prettier.resolveConfig(outPath);
const formatted = await prettier.format(raw, {
  ...config,
  parser: "typescript",
});

writeFileSync(outPath, formatted);
console.warn(`Wrote ${outPath} (${source.length} chars)`);
