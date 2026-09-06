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

// R-06 registry-wide assertion: after normalizeInputSchema's unwrap/collapse
// pass, no tool's emitted inputSchema should still contain a single-member
// anyOf or a const-union anyOf. Walks every schema node recursively — the
// offending shape can be nested arbitrarily deep inside `properties`.
function findOffendingAnyOf(
  node: unknown,
  path: string,
): { path: string; anyOf: unknown[] } | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = findOffendingAnyOf(node[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const obj = node as Record<string, unknown>;

  if (Array.isArray(obj.anyOf)) {
    const members = obj.anyOf;
    const isSingleMember = members.length === 1;
    const isConstUnion =
      members.length > 0 &&
      members.every((m) => typeof m === "object" && m !== null && "const" in m);
    if (isSingleMember || isConstUnion) {
      return { path: `${path}.anyOf`, anyOf: members };
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    const hit = findOffendingAnyOf(value, `${path}.${key}`);
    if (hit) return hit;
  }
  return null;
}

test("no tool's inputSchema contains a single-member or const-union anyOf (R-06)", async () => {
  const registry = new ToolRegistryClass();
  const plugin = {} as McpToolsPlugin;
  await registerTools(registry, {
    app: mockApp(),
    plugin,
    pluginVersion: "0.0.0-test",
  });

  const { tools } = registry.list();
  const offenders = tools
    .map((t) => ({ name: t.name, hit: findOffendingAnyOf(t.inputSchema, "") }))
    .filter((r): r is { name: string; hit: NonNullable<typeof r.hit> } =>
      Boolean(r.hit),
    );
  expect(offenders).toEqual([]);
});
