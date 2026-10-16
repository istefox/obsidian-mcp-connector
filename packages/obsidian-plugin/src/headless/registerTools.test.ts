import { describe, expect, test } from "bun:test";
import type McpToolsPlugin from "$/main";
import { registerTools as registerDesktopTools } from "$/features/mcp-tools";
import { ToolRegistryClass } from "$/features/mcp-transport/services/toolRegistry";
import { mockApp } from "$/test-setup";
import { registerTools as registerHeadlessTools } from "./registerTools";
import { DESKTOP_ONLY_TOOLS as DESKTOP_ONLY } from "./toolSets";

/**
 * Desktop tools that the headless server serves too, but only from a
 * later commit of the series that adds it. Empty once the series is
 * complete.
 */
const NOT_YET_SERVED = [
  "search_files_by_name",
  "rename_vault_file",
  "search_vault_smart",
  "fetch",
  "get_or_create_daily_note",
  "get_or_create_periodic_note",
  "append_to_periodic_note",
];

/** Tools only the headless server has. */
const HEADLESS_ONLY: string[] = [];

type Host = { semanticSearchState?: unknown };

async function listTools(
  register: typeof registerDesktopTools,
  host: Host = {},
) {
  const registry = new ToolRegistryClass();
  await register(registry, {
    app: mockApp(),
    plugin: host as McpToolsPlugin,
    pluginVersion: "0.0.0-test",
  });
  return registry.list().tools;
}

describe("headless tool set", () => {
  test("is the desktop set minus the desktop-only tools, plus nothing", async () => {
    const desktop = (
      await listTools(registerDesktopTools, { semanticSearchState: {} })
    ).map((t) => t.name);
    const headless = (await listTools(registerHeadlessTools)).map(
      (t) => t.name,
    );

    for (const name of [...DESKTOP_ONLY, ...NOT_YET_SERVED]) {
      expect(desktop).toContain(name);
    }
    const expected = desktop
      .filter((n) => !DESKTOP_ONLY.includes(n) && !NOT_YET_SERVED.includes(n))
      .concat(HEADLESS_ONLY);
    expect(headless).toEqual(expected);
  });

  test("shares every schema, description, annotation and title with the desktop", async () => {
    const desktop = await listTools(registerDesktopTools, {
      semanticSearchState: {},
    });
    const headless = await listTools(registerHeadlessTools);
    expect(headless.length).toBeGreaterThan(30);
    for (const tool of headless) {
      expect(tool).toEqual(desktop.find((t) => t.name === tool.name)!);
    }
  });
});
