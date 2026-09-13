import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { DISCOVERY_BROKER_SOURCE } from "./discoveryBrokerSource";

const srcPath = join(import.meta.dir, "../../../../scripts/discoveryBroker.js");

test("discoveryBrokerSource.ts is in sync with scripts/discoveryBroker.js", () => {
  // Reads the generator's disk input directly and compares it to the
  // committed constant, the same comparison scripts/gen-discovery-broker-source.ts
  // makes when it wraps the file with JSON.stringify: this fails whenever
  // discoveryBroker.js is edited without regenerating the asset, the one
  // drift trap this generated asset had none for.
  const source = readFileSync(srcPath, "utf8");
  expect(
    DISCOVERY_BROKER_SOURCE,
    "src/features/mcp-client-config/assets/discoveryBrokerSource.ts is stale — run: " +
      "bun run gen:discovery-broker (from packages/obsidian-plugin)",
  ).toBe(source);
});
