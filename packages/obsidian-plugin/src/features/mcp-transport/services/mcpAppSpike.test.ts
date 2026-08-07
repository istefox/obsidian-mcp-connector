import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ProtocolError } from "@modelcontextprotocol/server";
import { MCP_APP_SPIKE_HTML } from "../assets/mcpAppSpikeSource";
import { ResourceRegistryClass } from "./resourceRegistry";
import { ToolRegistryClass } from "./toolRegistry";
import {
  MCP_APP_MIME_TYPE,
  SPIKE_TOOL_NAME,
  SPIKE_UI_URI,
  wireMcpAppSpike,
} from "./mcpAppSpike";

// Same guard as mcpbGenerator.test.ts's shim check, for the same reason:
// the generator is wired into no build step, so nothing but this test
// stands between an edit to the HTML and a silently stale bundle.
test("assets/mcpAppSpikeSource.ts is in sync with assets/mcpAppSpike.html", () => {
  const onDisk = readFileSync(
    join(import.meta.dir, "../../../../assets/mcpAppSpike.html"),
    "utf8",
  );
  expect(MCP_APP_SPIKE_HTML).toBe(onDisk);
});

describe("wireMcpAppSpike", () => {
  const wire = () => {
    const toolRegistry = new ToolRegistryClass();
    const resourceRegistry = new ResourceRegistryClass();
    wireMcpAppSpike(toolRegistry, resourceRegistry);
    return { toolRegistry, resourceRegistry };
  };

  test("serves the page under the spec's mime type", async () => {
    const { resourceRegistry } = wire();
    const result = await resourceRegistry.read({ uri: SPIKE_UI_URI });
    expect(result.contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(result.contents[0].uri).toBe(SPIKE_UI_URI);
    expect(result.contents[0].text).toBe(MCP_APP_SPIKE_HTML);
  });

  test("rejects any other uri rather than serving the page", async () => {
    const { resourceRegistry } = wire();
    await expect(
      resourceRegistry.read({ uri: "ui://mcp-connector/other" }),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  test("lists the resource with the same uri and mime type it serves", async () => {
    const { resourceRegistry } = wire();
    const { resources } = await resourceRegistry.list();
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe(SPIKE_UI_URI);
    expect(resources[0].mimeType).toBe(MCP_APP_MIME_TYPE);
  });

  test("attaches the ui pointer to exactly one tool", () => {
    const { toolRegistry } = wire();
    // setMeta is name-keyed and lazy, so it records the pointer whether or
    // not the tool is registered in this bare registry; what matters here
    // is that no other name picked one up.
    const registry = toolRegistry as unknown as {
      metaByName: Map<string, Record<string, unknown>>;
    };
    expect([...registry.metaByName.keys()]).toEqual([SPIKE_TOOL_NAME]);
    expect(registry.metaByName.get(SPIKE_TOOL_NAME)).toEqual({
      ui: { resourceUri: SPIKE_UI_URI },
    });
  });
});
