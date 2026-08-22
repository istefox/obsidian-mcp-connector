import { beforeEach, describe, expect, test } from "bun:test";
import { composeToolRegistry } from "$/composeToolRegistry";
import { SessionPromotions } from "$/features/adaptive-tool-loading/sessionPromotions";
import {
  mockApp,
  mockPlugin,
  resetMockVault,
  setMockFile,
  setMockMetadata,
  setMockTags,
} from "$/test-setup";
import type McpToolsPlugin from "$/main";

/**
 * Registry-wide behavioural sweep for the folder-exclusion policy
 * (ADR-0020 T13, parts 1-2).
 *
 * `composeToolRegistry.test.ts` proves the seam is wired for a handful of
 * representative tools. This file sweeps EVERY registered tool against a
 * seeded canary fixture, so a tool added later that forgets to route
 * through the guarded App fails here instead of shipping a leak.
 */

const SECRET_DIR = "Secret";
const SECRET_FILE = "Secret/canary.md";
const SECRET_HEADING = "Canary Secret Heading";
const SECRET_TAG = "canary-secret-tag";
const SECRET_BODY_MARKER = "CANARY-THERAPY-BODY-42";
const SECRET_BODY = `## ${SECRET_HEADING}\n\n${SECRET_BODY_MARKER} #${SECRET_TAG}\n`;

const PUBLIC_FILE = "Public/note.md";
const PUBLIC_BODY = "Ordinary public note, nothing to see here.";

/** The four sentinels a leak must never surface, per the plan. */
const NEEDLES = [SECRET_BODY_MARKER, SECRET_TAG, SECRET_HEADING, SECRET_FILE];

/** Meta-tools carry no vault content, so they cannot leak by construction. */
const META_TOOLS = new Set(["tool_catalog", "activate_tool", "activate_tools"]);

function pluginWithFolders(folders?: string[]): McpToolsPlugin {
  return mockPlugin({
    loadData: async () =>
      folders === undefined ? {} : { mcpTools: { excludedFolders: folders } },
  } as Partial<McpToolsPlugin>);
}

async function compose(folders?: string[]) {
  return composeToolRegistry({
    app: mockApp(),
    plugin: pluginWithFolders(folders),
    pluginVersion: "0.0.0-test",
    session: new SessionPromotions(),
  });
}

type Registry = Awaited<ReturnType<typeof compose>>["toolRegistry"];

/** Dispatch a tool the way the transport does, and flatten the result. */
async function call(
  registry: Registry,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await registry.dispatch({ name, arguments: args } as never, {
    server: {} as never,
  });
  return JSON.stringify(result);
}

/**
 * Hand-authored per-tool arguments (ADR-0020 T13 part 1).
 *
 * Every path/directory-shaped field points at the canary fixture; every
 * query/tag-shaped field points at one of its sentinels. Tools with no
 * path- or query-shaped argument (get_vault_overview, list_tags,
 * tool_catalog, ...) still need their minimal required args so the sweep
 * can dispatch them at all.
 */
const CANARY_ARGS: Record<string, Record<string, unknown>> = {
  get_server_info: {},
  get_active_file: {},
  update_active_file: { content: "sweep content" },
  append_to_active_file: { content: "sweep content" },
  patch_active_file: {
    operation: "append",
    targetType: "heading",
    target: "Some Heading",
    content: "sweep content",
  },
  delete_active_file: {},
  show_file_in_obsidian: { filename: SECRET_FILE },
  list_vault_files: { directory: SECRET_DIR },
  get_vault_file: { path: SECRET_FILE },
  get_vault_files: { paths: [SECRET_FILE] },
  create_vault_file: { path: SECRET_FILE, content: "sweep content" },
  create_vault_binary_file: { path: "Secret/canary.bin", content: "eA==" },
  append_to_vault_file: { path: SECRET_FILE, content: "sweep content" },
  patch_vault_file: {
    path: SECRET_FILE,
    operation: "append",
    targetType: "heading",
    target: SECRET_HEADING,
    content: "sweep content",
  },
  delete_vault_file: { path: SECRET_FILE },
  rename_vault_file: { from: SECRET_FILE, to: "Renamed/unused-target.md" },
  rename_heading: {
    path: SECRET_FILE,
    from: { text: SECRET_HEADING },
    to: "Renamed Heading",
  },
  create_vault_directory: { path: "Secret/NewDir" },
  delete_vault_directory: { path: "Secret/NewDir" },
  list_tags: {},
  get_files_by_tag: { tag: SECRET_TAG },
  get_note_property: { path: SECRET_FILE, key: "title" },
  set_note_property: { path: SECRET_FILE, key: "title", value: "x" },
  delete_note_property: { path: SECRET_FILE, key: "title" },
  list_property_values: { key: "title", folder: SECRET_DIR },
  get_recent_files: {},
  get_vault_overview: {},
  get_vault_file_partial: {
    filename: SECRET_FILE,
    mode: "heading",
    target: SECRET_HEADING,
  },
  get_outgoing_links: { path: SECRET_FILE },
  get_backlinks: { path: SECRET_FILE },
  find_broken_links: { scope: [SECRET_DIR] },
  find_orphaned_notes: {},
  search_and_replace: {
    pattern: SECRET_BODY_MARKER,
    replacement: "x",
    dry_run: true,
    scope: [SECRET_DIR],
  },
  get_note_outline: { path: SECRET_FILE },
  list_bookmarks: {},
  get_canvas: { path: SECRET_FILE },
  add_canvas_node: { path: SECRET_FILE, type: "text", text: "hello" },
  connect_canvas_nodes: { path: SECRET_FILE, fromNode: "a", toNode: "b" },
  search_vault: { query: SECRET_BODY_MARKER },
  search_vault_simple: { query: SECRET_BODY_MARKER },
  search_vault_smart: { query: SECRET_BODY_MARKER },
  execute_dataview_query: { query: "LIST", sourcePath: SECRET_FILE },
  list_obsidian_commands: {},
  execute_obsidian_command: { commandId: "canary-cmd" },
  get_or_create_daily_note: {},
  get_or_create_periodic_note: { period: "daily" },
  append_to_periodic_note: { content: "sweep content" },
  fetch: { url: "https://example.com/canary" },
  execute_template: {
    templatePath: SECRET_FILE,
    targetPath: "Secret/newfile.md",
  },
  tool_catalog: {},
  activate_tool: { name: "get_vault_file" },
  activate_tools: { names: ["get_vault_file"] },
};

function seedVault(): void {
  resetMockVault();
  setMockFile(SECRET_FILE, SECRET_BODY);
  setMockMetadata(SECRET_FILE, {
    headings: [{ heading: SECRET_HEADING, level: 2, line: 0 }],
    tags: [{ tag: `#${SECRET_TAG}`, line: 2 }],
  });
  setMockTags({ [`#${SECRET_TAG}`]: 1 });
  setMockFile(PUBLIC_FILE, PUBLIC_BODY);
}

/**
 * Every string leaf reachable from a (possibly nested) args object.
 *
 * A tool echoing back a value the caller itself supplied (`"File not
 * found: Secret/canary.md"` for a call made WITH `path: "Secret/canary.md"`)
 * is not a disclosure — the caller already knew it. That is exactly the
 * ADR-0020 D3 property the indistinguishability sweep below verifies
 * directly (same shape for an excluded path and one that never existed).
 * This sweep is only interested in a needle the SERVER introduced on its
 * own, so a needle that merely equals a supplied argument value is
 * excluded from the violation set.
 */
function flattenStrings(
  value: unknown,
  out: Set<string> = new Set(),
): Set<string> {
  if (typeof value === "string") {
    out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) flattenStrings(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) flattenStrings(v, out);
  }
  return out;
}

beforeEach(() => {
  seedVault();
});

describe("registry-wide folder-exclusion sweep (ADR-0020 T13)", () => {
  test("no registered tool leaks a canary sentinel through an excluded folder", async () => {
    const { toolRegistry } = await compose([SECRET_DIR]);
    const empty = await compose();

    const before = await call(empty.toolRegistry, "list_vault_files", {
      directory: SECRET_DIR,
    });

    const violations: Array<{ tool: string; leakedFragment: string }> = [];
    for (const { name } of toolRegistry.list().tools) {
      if (META_TOOLS.has(name)) continue;
      const args = CANARY_ARGS[name] ?? {};
      const supplied = flattenStrings(args);
      const out = await call(toolRegistry, name, args);
      for (const needle of NEEDLES) {
        if (out.includes(needle) && !supplied.has(needle)) {
          violations.push({ tool: name, leakedFragment: needle });
        }
      }
    }

    // The diff names the offender, rather than a bare pass/fail boolean.
    expect(violations).toEqual([]);

    const after = await call(empty.toolRegistry, "list_vault_files", {
      directory: SECRET_DIR,
    });
    expect(after).toBe(before);
  });

  // Proves the harness itself can detect a leak: if nothing leaks here
  // either, the assertion above is checking nothing. Measured empirically
  // (see the coder's report) — a handful of tools genuinely return the
  // canary body/tag/heading unfiltered once no policy is in force.
  // Each tool gets its own freshly reseeded vault, unlike the leak sweep
  // above: a mutating tool dispatched earlier in registration order (e.g.
  // delete_vault_file, which really deletes under an empty policy) would
  // otherwise remove the canary before a later read tool ever saw it,
  // undercounting how many tools genuinely leak. The leak sweep itself
  // stays a single continuous pass because ITS point is the opposite one
  // — that an excluded folder is never touched across the whole run.
  test("anti-vacuity: the same sweep against an empty policy DOES leak", async () => {
    const leakingTools = new Set<string>();
    const { toolRegistry: probe } = await compose();
    for (const { name } of probe.list().tools) {
      if (META_TOOLS.has(name)) continue;
      seedVault();
      const { toolRegistry } = await compose();
      const args = CANARY_ARGS[name] ?? {};
      const supplied = flattenStrings(args);
      const out = await call(toolRegistry, name, args);
      if (
        NEEDLES.some((needle) => out.includes(needle) && !supplied.has(needle))
      ) {
        leakingTools.add(name);
      }
    }

    // Measured empirically at authoring time: 10 tools leak genuinely once
    // no policy is in force (list_vault_files, get_vault_file,
    // get_vault_files, get_files_by_tag, get_recent_files,
    // get_vault_file_partial, find_orphaned_notes, search_and_replace,
    // get_note_outline, search_vault_simple). Asserting a conservative
    // floor below that measured count so a future minor refactor doesn't
    // make this test flaky over a one- or two-tool swing.
    expect(leakingTools.size).toBeGreaterThanOrEqual(5);
  });

  /**
   * Every string-shaped (or string-array-shaped) top-level argument must be
   * classified as either a vault-path reference or not. A newly added tool
   * with an unclassified path-shaped argument fails here until someone
   * decides which bucket it belongs in and, if it is a path, adds it to
   * CANARY_ARGS above.
   */
  const KNOWN_PATH_KEYS = new Set([
    "path",
    "directory",
    "filename",
    "paths",
    "from",
    "to",
    "scope",
    "exclude_folders",
    "folder",
    "sourcePath",
    "templatePath",
    "targetPath",
    "file",
    "target",
  ]);
  const KNOWN_NON_PATH_KEYS = new Set([
    "content",
    "expectedContent",
    "targetDelimiter",
    "query",
    "tag",
    "key",
    "pattern",
    "replacement",
    "flags",
    "commandId",
    "filter",
    "url",
    "date",
    "text",
    "label",
    "color",
    "subpath",
    "fromNode",
    "toNode",
    "name",
    "names",
    "underHeading",
  ]);

  test("every tool's string-shaped argument is classified path or non-path", async () => {
    const { toolRegistry } = await compose([SECRET_DIR]);

    type JsonSchemaProp = {
      type?: string;
      items?: { type?: string };
    };

    const unclassified: string[] = [];
    for (const entry of toolRegistry.list().tools) {
      const properties = (entry.inputSchema.properties ?? {}) as Record<
        string,
        JsonSchemaProp
      >;
      for (const [prop, schema] of Object.entries(properties)) {
        const isStringy =
          schema.type === "string" ||
          (schema.type === "array" && schema.items?.type === "string");
        if (!isStringy) continue;
        if (KNOWN_PATH_KEYS.has(prop) || KNOWN_NON_PATH_KEYS.has(prop)) {
          continue;
        }
        unclassified.push(`${entry.name}.${prop}`);
      }
    }

    expect(unclassified).toEqual([]);
  });
});

/**
 * ADR-0020 D3: the refusal a client sees for an excluded path must be the
 * one it would see for a path that never existed. `composeToolRegistry.
 * test.ts` proves this for `get_vault_file`; this generalises it to every
 * read/lookup tool that takes a single vault-path-shaped argument.
 *
 * Deliberately scoped to READ/lookup tools only. A create-or-auto-vivify
 * tool (create_vault_file, create_vault_directory, append_to_vault_file,
 * show_file_in_obsidian, add_canvas_node, execute_template, the
 * get-or-create periodic-note family, ...) behaves DIFFERENTLY for a path
 * that never existed (it creates it) than for an excluded one (refused) —
 * comparing those would fail for a reason that has nothing to do with
 * indistinguishability, so they are out of scope here.
 */
describe("registry-wide sweep — refusal is indistinguishable from absence", () => {
  const GHOST_DIR = (tool: string) => `Nowhere/ghost-${tool}`;
  const GHOST_FILE = (tool: string) => `Nowhere/ghost-${tool}.md`;

  const INDIST: Record<string, (target: string) => Record<string, unknown>> = {
    get_vault_file: (p) => ({ path: p }),
    get_vault_files: (p) => ({ paths: [p] }),
    get_vault_file_partial: (p) => ({
      filename: p,
      mode: "heading",
      target: "Whatever",
    }),
    get_outgoing_links: (p) => ({ path: p }),
    get_backlinks: (p) => ({ path: p }),
    get_note_outline: (p) => ({ path: p }),
    get_canvas: (p) => ({ path: p }),
    get_note_property: (p) => ({ path: p, key: "title" }),
    delete_vault_file: (p) => ({ path: p }),
    delete_vault_directory: (p) => ({ path: p }),
    patch_vault_file: (p) => ({
      path: p,
      operation: "append",
      targetType: "heading",
      target: "Whatever",
      content: "x",
    }),
    rename_vault_file: (p) => ({ from: p, to: "Renamed/unused-target.md" }),
    rename_heading: (p) => ({
      path: p,
      from: { text: "Whatever" },
      to: "Renamed",
    }),
    set_note_property: (p) => ({ path: p, key: "title", value: "x" }),
    delete_note_property: (p) => ({ path: p, key: "title" }),
    list_vault_files: (p) => ({ directory: p }),
    list_property_values: (p) => ({ key: "title", folder: p }),
    find_broken_links: (p) => ({ scope: [p] }),
  };

  const DIR_SHAPED = new Set([
    "list_vault_files",
    "list_property_values",
    "find_broken_links",
  ]);

  test("excluded path vs. a path that structurally never existed", async () => {
    const { toolRegistry } = await compose([SECRET_DIR]);

    const mismatches: Array<{ tool: string; excluded: string; ghost: string }> =
      [];
    for (const [tool, buildArgs] of Object.entries(INDIST)) {
      const excludedTarget = DIR_SHAPED.has(tool) ? SECRET_DIR : SECRET_FILE;
      const ghostTarget = DIR_SHAPED.has(tool)
        ? GHOST_DIR(tool)
        : GHOST_FILE(tool);

      const excludedOut = await call(
        toolRegistry,
        tool,
        buildArgs(excludedTarget),
      );
      const ghostOut = await call(toolRegistry, tool, buildArgs(ghostTarget));

      const normalizedExcluded = excludedOut.split(excludedTarget).join("<P>");
      const normalizedGhost = ghostOut.split(ghostTarget).join("<P>");

      if (normalizedExcluded !== normalizedGhost) {
        mismatches.push({
          tool,
          excluded: normalizedExcluded,
          ghost: normalizedGhost,
        });
      }
    }

    expect(mismatches).toEqual([]);
  });
});
