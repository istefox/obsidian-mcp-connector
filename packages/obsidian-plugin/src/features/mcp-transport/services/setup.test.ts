import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mockPlugin } from "$/test-setup";
import { setup, teardown, type McpTransportState } from "./setup";
import type McpToolsPlugin from "$/main";

/**
 * `mcpTransport.livePort` is the actually-bound port, written back after
 * every successful startup so the generated .mcpb (mcpbGenerator.ts) can
 * resolve it fresh at connect time instead of embedding a stale value.
 */

const active: McpTransportState[] = [];
afterEach(async () => {
  for (const s of active.splice(0)) await teardown(s);
});

function makePlugin(initialData: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = { ...initialData };
  const plugin = mockPlugin({
    loadData: async () => data,
    saveData: async (next: unknown) => {
      data = next as Record<string, unknown>;
    },
  } as Partial<McpToolsPlugin>);
  return { plugin, getData: () => data };
}

describe("setup — livePort persistence", () => {
  test("persists the actually-bound port as mcpTransport.livePort", async () => {
    const { plugin, getData } = makePlugin();
    const result = await setup(plugin);
    expect(result.success).toBe(true);
    if (!result.success) return;
    active.push(result.state);

    const slice = getData()?.mcpTransport as Record<string, unknown>;
    expect(slice.livePort).toBe(result.state.server.port);
    expect(typeof slice.bearerToken).toBe("string");
  });

  test("preserves the existing bearerToken when writing livePort", async () => {
    const { plugin, getData } = makePlugin({
      mcpTransport: { bearerToken: "a".repeat(32) },
    });
    const result = await setup(plugin);
    expect(result.success).toBe(true);
    if (!result.success) return;
    active.push(result.state);

    const slice = getData()?.mcpTransport as Record<string, unknown>;
    expect(slice.bearerToken).toBe("a".repeat(32));
    expect(slice.livePort).toBe(result.state.server.port);
  });

  test("livePort reflects a fallback port, not the first PORT_RANGE entry", async () => {
    // Occupy 27200 ourselves so the test is deterministic in CI. If it is
    // already taken (e.g. a real Obsidian instance running on the dev
    // machine), that already satisfies the precondition — skip creating
    // our own blocker rather than fail on the double-bind.
    let blocker: Server | null = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        blocker!.once("error", reject);
        blocker!.listen(27200, "127.0.0.1", () => resolve());
      });
    } catch {
      blocker = null;
    }
    try {
      const { plugin, getData } = makePlugin();
      const result = await setup(plugin);
      expect(result.success).toBe(true);
      if (!result.success) return;
      active.push(result.state);

      expect(result.state.server.port).not.toBe(27200);
      const slice = getData()?.mcpTransport as Record<string, unknown>;
      expect(slice.livePort).toBe(result.state.server.port);
    } finally {
      if (blocker) {
        await new Promise<void>((resolve) => blocker!.close(() => resolve()));
      }
    }
  });
});
