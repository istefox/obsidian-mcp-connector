import { beforeEach, describe, expect, test } from "bun:test";
import { composeToolRegistry } from "./composeToolRegistry";
import { SessionPromotions } from "$/features/adaptive-tool-loading/sessionPromotions";
import { mockApp, mockPlugin, resetMockVault, setMockFile } from "$/test-setup";
import type McpToolsPlugin from "$/main";
import {
  DENY_ALL_POLICY,
  EMPTY_POLICY,
  compilePolicy,
} from "$/shared/pathPolicy";

/**
 * Proves the enforcement seam is actually IN the path, not merely
 * written (ADR-0020 §D1).
 *
 * Everything else about the facade is covered in `guardedApp.test.ts`
 * against a hand-built `App`. What that cannot show is whether
 * `composeToolRegistry` hands the guarded one to `registerTools` — and a
 * facade that is wired nowhere passes every test it has.
 */

const SECRET = "Therapy/session.md";
const SECRET_BODY = "CANARY-THERAPY-BODY";
const PUBLIC = "Public/note.md";
const PUBLIC_BODY = "ordinary note";

function pluginWithFolders(folders?: string[]): McpToolsPlugin {
  return mockPlugin({
    loadData: async () =>
      folders === undefined ? {} : { mcpTools: { excludedFolders: folders } },
  } as Partial<McpToolsPlugin>);
}

async function buildRegistry(folders?: string[]) {
  const { toolRegistry } = await compose(folders);
  return toolRegistry;
}

async function compose(folders?: string[]) {
  return composeToolRegistry({
    app: mockApp(),
    plugin: pluginWithFolders(folders),
    pluginVersion: "0.0.0-test",
    session: new SessionPromotions(),
  });
}

/** Dispatch a tool the way the transport does, and flatten the result. */
async function call(
  registry: Awaited<ReturnType<typeof buildRegistry>>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  // Same escape hatch toolRegistry.test.ts uses: HandlerContext is not
  // exported, and no path under test touches `server`.
  const result = await registry.dispatch({ name, arguments: args } as never, {
    server: {} as never,
  });
  return JSON.stringify(result);
}

beforeEach(() => {
  resetMockVault();
  setMockFile(SECRET, SECRET_BODY);
  setMockFile(PUBLIC, PUBLIC_BODY);
});

describe("composeToolRegistry — the seam is wired", () => {
  test("with no exclusion configured, tools see the whole vault", async () => {
    const registry = await buildRegistry();
    expect(await call(registry, "get_vault_file", { path: SECRET })).toContain(
      SECRET_BODY,
    );
    expect(
      await call(registry, "list_vault_files", { directory: "" }),
    ).toContain(SECRET);
  });

  // The one that matters. If the guarded App were not passed through,
  // this would return the therapy note's body.
  test("an excluded file is unreadable through the composed registry", async () => {
    const registry = await buildRegistry(["Therapy"]);
    const out = await call(registry, "get_vault_file", { path: SECRET });
    expect(out).not.toContain(SECRET_BODY);
  });

  test("an excluded file is absent from a listing", async () => {
    const registry = await buildRegistry(["Therapy"]);
    const out = await call(registry, "list_vault_files", { directory: "" });
    expect(out).not.toContain(SECRET);
    expect(out).toContain(PUBLIC);
  });

  test("plain-text search cannot reach into an excluded folder", async () => {
    const registry = await buildRegistry(["Therapy"]);
    const out = await call(registry, "search_vault_simple", {
      query: "CANARY",
    });
    expect(out).not.toContain(SECRET_BODY);
    expect(out).not.toContain(SECRET);
  });

  test("everything outside the excluded folder still works", async () => {
    const registry = await buildRegistry(["Therapy"]);
    expect(await call(registry, "get_vault_file", { path: PUBLIC })).toContain(
      PUBLIC_BODY,
    );
  });

  // ADR-0020 D3: the refusal a client sees must be the one it would see
  // for a path that was never there. A distinguishable message confirms
  // the folder exists, which is what the feature exists to hide.
  test("the refusal is indistinguishable from a path that never existed", async () => {
    const registry = await buildRegistry(["Therapy"]);
    const hidden = await call(registry, "get_vault_file", { path: SECRET });
    const absent = await call(registry, "get_vault_file", {
      path: "Nowhere/ghost.md",
    });
    // Same shape, same wording; only the echoed path differs.
    expect(hidden.replace(SECRET, "<P>")).toBe(
      absent.replace("Nowhere/ghost.md", "<P>"),
    );
  });

  test("a write into an excluded folder does not land", async () => {
    const registry = await buildRegistry(["Therapy"]);
    await call(registry, "create_vault_file", {
      path: "Therapy/new.md",
      content: "should not exist",
    });
    const out = await call(registry, "list_vault_files", { directory: "" });
    expect(out).not.toContain("Therapy/new.md");
  });
});

describe("composeToolRegistry — which tools a policy refuses", () => {
  // The composition root owns this join because it is the only module
  // that legitimately knows both features. mcp-transport never imports
  // mcp-tools, so the registry is handed the answer, not the inputs.
  test("no policy in force refuses nothing", async () => {
    const { refusedToolsFor } = await compose();
    expect(refusedToolsFor(EMPTY_POLICY)).toBeUndefined();
  });

  test("a configured folder refuses exactly the three unfilterable tools", async () => {
    const { refusedToolsFor } = await compose(["Therapy"]);
    const refused = refusedToolsFor(compilePolicy(["Therapy"]));
    expect([...(refused?.keys() ?? [])].sort()).toEqual([
      "execute_dataview_query",
      "execute_obsidian_command",
      "execute_template",
    ]);
  });

  test("every refusal carries a reason, so the message can say why", async () => {
    const { refusedToolsFor } = await compose(["Therapy"]);
    const refused = refusedToolsFor(compilePolicy(["Therapy"]));
    for (const [name, reason] of refused ?? []) {
      expect(reason.length).toBeGreaterThan(30);
      expect(reason).not.toContain(name);
    }
  });

  test("list_bookmarks is never refused", async () => {
    const { refusedToolsFor } = await compose(["Therapy"]);
    expect(
      refusedToolsFor(compilePolicy(["Therapy"]))?.has("list_bookmarks"),
    ).toBe(false);
  });

  // The pre-first-read posture refuses everything, so it must refuse
  // these too — a list-based check would leave all three live at exactly
  // the moment nothing is known.
  test("the deny-all posture refuses them as well", async () => {
    const { refusedToolsFor } = await compose();
    expect(refusedToolsFor(DENY_ALL_POLICY)?.size).toBe(3);
  });

  // End to end through the real registry, with the map the transport
  // would supply.
  test("a refused tool does not execute through the composed registry", async () => {
    const { toolRegistry, refusedToolsFor } = await compose(["Therapy"]);
    const policy = compilePolicy(["Therapy"]);
    const result = await toolRegistry.dispatch(
      { name: "execute_dataview_query", arguments: { query: "LIST" } } as never,
      { server: {} as never, refusedTools: refusedToolsFor(policy) },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      "disabled while folders are hidden",
    );
  });
});
