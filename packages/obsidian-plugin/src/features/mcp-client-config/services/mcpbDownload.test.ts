import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { unzipSync, strFromU8 } from "fflate";
import { FileSystemAdapter } from "obsidian";
import { mockPlugin } from "$/test-setup";
import type McpToolsPlugin from "$/main";
import { revokeToken } from "$/features/mcp-transport/services/tokenStore";
import { downloadMcpb, downloadMcpbForFirstToken } from "./mcpbDownload";

/**
 * `mcpbDownload` is the layer between the tested generator and the
 * tested shim, and it was the one with no test file — which is exactly
 * where the id-less-export defect lived (ADR-0014 §11).
 *
 * Bundles land in the vault fallback at `mcpbDownload.ts:81`, because
 * `require("electron")` throws under Bun so `electronDialog()` returns
 * null. The mock adapter records every write, so a test can assert that
 * nothing was written — "returned a refusal" and "wrote no bundle" are
 * different claims.
 */
const MIRROR = "a".repeat(43);
const SECOND = "b".repeat(43);

function twoTokenData() {
  return {
    mcpTransport: {
      livePort: 27200,
      bearerToken: MIRROR,
      tokens: [
        { id: "default", label: "Default", token: MIRROR, createdAt: 1 },
        { id: "claude", label: "claude.ai", token: SECOND, createdAt: 2 },
      ],
    },
  };
}

type Adapter = FileSystemAdapter & {
  writes: { path: string; bytes: ArrayBuffer }[];
};

function makePlugin(initial: Record<string, unknown> = twoTokenData()) {
  let data: Record<string, unknown> = structuredClone(initial);
  const adapter = new FileSystemAdapter() as Adapter;
  const plugin = mockPlugin({
    app: {
      vault: { adapter, configDir: ".obsidian" },
    } as unknown as McpToolsPlugin["app"],
    loadData: async () => structuredClone(data),
    saveData: async (next: unknown) => {
      data = next as Record<string, unknown>;
    },
  });
  return { plugin, adapter, getData: () => data };
}

/** The `shimTokenId` literal baked into the bundle's shim. */
function bakedTokenId(bytes: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(bytes));
  const shim = files["server/index.js"];
  if (!shim) throw new Error("server/index.js missing from zip");
  const match = /const shimTokenId = (.+);/.exec(strFromU8(shim));
  if (!match) throw new Error("shimTokenId not found in shim");
  return match[1];
}

describe("downloadMcpbForFirstToken", () => {
  test("bakes the first token's id, never a null that resolves the mirror", async () => {
    const { plugin, adapter } = makePlugin();

    await downloadMcpbForFirstToken(plugin);

    expect(adapter.writes).toHaveLength(1);
    expect(bakedTokenId(adapter.writes[0].bytes)).toBe('"default"');
  });

  test("agrees with the per-row export for the same token", async () => {
    const a = makePlugin();
    const b = makePlugin();

    await downloadMcpbForFirstToken(a.plugin);
    await downloadMcpb(b.plugin, "default");

    // Compare the baked id, not the bytes: zipSync stamps an mtime.
    expect(bakedTokenId(a.adapter.writes[0].bytes)).toBe(
      bakedTokenId(b.adapter.writes[0].bytes),
    );
  });

  test("refuses when the token list is empty", async () => {
    const { plugin, adapter } = makePlugin({
      mcpTransport: { livePort: 27200, bearerToken: MIRROR },
    });

    const message = await downloadMcpbForFirstToken(plugin);

    expect(message).toMatch(/no token/i);
    expect(adapter.writes).toHaveLength(0);
  });

  test("refuses when the token list cannot be read", async () => {
    const adapter = new FileSystemAdapter() as Adapter;
    const plugin = mockPlugin({
      app: {
        vault: { adapter, configDir: ".obsidian" },
      } as unknown as McpToolsPlugin["app"],
      loadData: async () => {
        throw new Error("disk on fire");
      },
    });

    const message = await downloadMcpbForFirstToken(plugin);

    expect(message).toMatch(/disk on fire/);
    expect(adapter.writes).toHaveLength(0);
  });
});

describe("downloadMcpb", () => {
  test("refuses an id that is not in the live token list", async () => {
    const { plugin, adapter } = makePlugin();

    const message = await downloadMcpb(plugin, "ghost-id");

    expect(message).toMatch(/no longer configured/i);
    expect(adapter.writes).toHaveLength(0);
  });

  test.each([
    ["empty", ""],
    ["blank", "   "],
  ])(
    "refuses a %s id instead of degrading to the legacy branch",
    async (_label, id) => {
      const { plugin, adapter } = makePlugin();

      const message = await downloadMcpb(plugin, id);

      // `connectorShim.js` branches on truthiness, so "" would silently
      // resolve `bearerToken` — the original defect in a different hat.
      expect(message).toMatch(/token id/i);
      expect(adapter.writes).toHaveLength(0);
    },
  );
});

describe("ADR-0014 §11 end to end", () => {
  /**
   * The security promise as a test: export for tokens[0], revoke
   * tokens[0], and the bundle must fail closed rather than resolve
   * whichever token is now first. Runs the REAL shim resolver against a
   * real `data.json`, so nothing about the contract is mocked.
   */
  test("a bundle exported for tokens[0] dies when tokens[0] is revoked", async () => {
    const { plugin, adapter, getData } = makePlugin();

    await downloadMcpbForFirstToken(plugin);
    const baked = JSON.parse(bakedTokenId(adapter.writes[0].bytes)) as string;

    await revokeToken(plugin, "default");

    const dir = mkdtempSync(join(tmpdir(), "mcpb-revoke-"));
    const dataPath = join(dir, "data.json");
    writeFileSync(dataPath, JSON.stringify(getData()), "utf8");

    const { readTransport } =
      (await import("../../../../scripts/connectorShim.js")) as {
        readTransport: (
          p: string,
          o: Record<string, unknown>,
          id?: string,
        ) => { port?: number; token?: string; error?: string };
      };
    const result = readTransport(dataPath, {}, baked);

    expect(result.error).toMatch(/re-export/);
    expect(result.token).toBeUndefined();
    // Naming the survivor's secret states the property, not a shape.
    expect(result.token).not.toBe(SECOND);
  });
});
