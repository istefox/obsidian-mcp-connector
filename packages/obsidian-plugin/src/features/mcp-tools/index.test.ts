import { expect, test } from "bun:test";
import { registerTools } from "./index";
import { ToolRegistryClass } from "$/features/mcp-transport/services/toolRegistry";
import { mockApp } from "$/test-setup";
import type McpToolsPlugin from "$/main";

// Regression guard for the 0.27.2–0.27.6 get_vault_file breakage: the MCP
// SDK client hard-fails (-32600) every non-error response of a tool that
// advertises an outputSchema unless it carries structuredContent, so a
// polymorphic tool (text OR image OR audio OR JSON-hint output) must never
// declare one. No registered tool does today; if a future tool with a
// uniform structured output legitimately declares a schema, allowlist it
// here explicitly after verifying EVERY success path of its handler
// returns a conforming structuredContent.
test("no registered tool declares an MCP outputSchema", async () => {
  const registry = new ToolRegistryClass();
  // plugin is only captured lazily inside handler closures at
  // registration time, so a bare stub is enough to enumerate the list.
  const plugin = {} as McpToolsPlugin;
  await registerTools(registry, {
    app: mockApp(),
    plugin,
    pluginVersion: "0.0.0-test",
  });

  const { tools } = registry.list();
  expect(tools.length).toBeGreaterThan(40);
  const withSchema = tools.filter((t) => "outputSchema" in t);
  expect(withSchema.map((t) => t.name)).toEqual([]);
});
