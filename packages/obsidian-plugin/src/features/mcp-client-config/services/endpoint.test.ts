import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fsp from "fs/promises";
import { FileSystemAdapter } from "obsidian";
import os from "os";
import path from "path";
import type { DiscoveryStatus } from "./discoveryBroker";
import {
  brokerRouteUrl,
  clientEndpointUrl,
  directVaultUrl,
  resolveClientEndpoint,
  resolveClientEndpointDetails,
  type EndpointPlugin,
} from "./endpoint";

const routeId = "123e4567-e89b-42d3-a456-426614174000";
const routeUrl = `http://127.0.0.1:27200/v1/${routeId}/mcp`;
const pluginId = "mcp-tools-istefox";
/** The port the running route registered, its direct fallback. */
const transportPort = 27204;

function plugin(
  data: Record<string, unknown>,
  routed = true,
  status: DiscoveryStatus = { state: "connected" },
): EndpointPlugin {
  return {
    loadData: async () => data,
    saveData: async () => {},
    app: { vault: { adapter: {}, configDir: ".obsidian" } },
    manifest: { id: pluginId },
    discoveryState: routed ? { routeId, status, transportPort } : undefined,
  };
}

describe("clientEndpointUrl", () => {
  test("points at the broker route by default and at a fixed port directly", () => {
    expect(brokerRouteUrl(routeId)).toBe(routeUrl);
    expect(directVaultUrl(27210)).toBe("http://127.0.0.1:27210/mcp");
    expect(clientEndpointUrl({ routeId })).toBe(routeUrl);
    expect(clientEndpointUrl({ routeId, fixedPort: 27210 })).toBe(
      "http://127.0.0.1:27210/mcp",
    );
  });
});

describe("resolveClientEndpoint", () => {
  test("uses the broker route for a vault on the automatic range", async () => {
    expect(
      await resolveClientEndpoint(
        plugin({ mcpTransport: { livePort: 27203 } }),
      ),
    ).toBe(routeUrl);
  });

  test("uses the fixed port directly, including a legacy fixed 27200", async () => {
    expect(
      await resolveClientEndpoint(plugin({ mcpTransport: { port: 27210 } })),
    ).toBe("http://127.0.0.1:27210/mcp");
    expect(
      await resolveClientEndpoint(
        plugin({ mcpTransport: { port: 27200 } }, false),
      ),
    ).toBe("http://127.0.0.1:27200/mcp");
  });

  test("ignores an invalid saved fixed port like the transport does", async () => {
    expect(
      await resolveClientEndpoint(plugin({ mcpTransport: { port: "27210" } })),
    ).toBe(routeUrl);
  });

  test("hands out no route before it starts", async () => {
    expect(await resolveClientEndpoint(plugin({}, false))).toBeNull();
  });
});

describe("resolveClientEndpoint by route status", () => {
  const direct = `http://127.0.0.1:${transportPort}/mcp`;

  test.each<[DiscoveryStatus["state"], string, string]>([
    ["connecting", routeUrl, "broker"],
    ["connected", routeUrl, "broker"],
    // A dropped control, such as a failover between hosting vaults
    ["retrying", routeUrl, "broker"],
    ["rejected", direct, "direct"],
    ["unavailable", direct, "direct"],
    // The broker routes this route ID to another vault
    ["conflict", direct, "direct"],
  ])("a %s route resolves to %s", async (state, url, kind) => {
    const p = plugin({ mcpTransport: { livePort: 27203 } }, true, { state });
    expect(await resolveClientEndpoint(p)).toBe(url);
    expect(await resolveClientEndpointDetails(p)).toEqual({
      url,
      kind: kind as "broker" | "direct",
    });
  });

  test("a fixed port stays direct whatever the route status", async () => {
    for (const state of ["connected", "rejected"] as const) {
      expect(
        await resolveClientEndpointDetails(
          plugin({ mcpTransport: { port: 27210 } }, true, { state }),
        ),
      ).toEqual({ url: "http://127.0.0.1:27210/mcp", kind: "fixed" });
    }
  });
});

describe("resolveClientEndpoint while the vault location is unresolved", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-endpoint-"));
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * A vault anchored at a real directory whose saved route is bound to
   * `savedPath`, or to the vault's own data file.
   */
  async function located(
    port: number | undefined,
    routed: boolean,
    savedPath?: string,
    status?: DiscoveryStatus,
  ): Promise<EndpointPlugin> {
    const vault = path.join(tempDir, "vault");
    const pluginDir = path.join(vault, ".obsidian", "plugins", pluginId);
    await fsp.mkdir(pluginDir, { recursive: true });
    const own = path.join(await fsp.realpath(pluginDir), "data.json");
    const p = plugin(
      {
        mcpTransport: { port },
        mcpClientConfig: {
          codexDiscovery: {
            enabled: false,
            routeId,
            accessToken: "synthetic-route-credential".padEnd(40, "x"),
            tokenId: null,
            dataPath:
              savedPath ??
              (process.platform === "win32" ? own.toLowerCase() : own),
          },
        },
      },
      routed,
      status,
    );
    p.app.vault.adapter = Object.assign(new FileSystemAdapter(), {
      getBasePath: () => vault,
    });
    return p;
  }

  const elsewhere = () =>
    path.join(
      tempDir,
      "original",
      ".obsidian",
      "plugins",
      pluginId,
      "data.json",
    );

  test.each([
    ["the broker route", undefined, true],
    ["a fixed port", 27210, true],
    ["a fixed port after a failed route start", 27210, false],
    ["a legacy fixed 27200, which registers no route", 27200, false],
  ])(
    "hands out nothing for %s, read from the saved settings",
    async (_label, port, routed) => {
      expect(
        await resolveClientEndpoint(await located(port, routed, elsewhere())),
      ).toBeNull();
    },
  );

  test("hands out no direct fallback either while the location is unresolved", async () => {
    expect(
      await resolveClientEndpoint(
        await located(undefined, true, elsewhere(), {
          state: "rejected",
          message: "refused",
        }),
      ),
    ).toBeNull();
  });

  test("hands out the endpoint again once the location is resolved", async () => {
    expect(await resolveClientEndpoint(await located(undefined, true))).toBe(
      routeUrl,
    );
    expect(await resolveClientEndpoint(await located(27200, false))).toBe(
      "http://127.0.0.1:27200/mcp",
    );
  });

  test("fails closed when the vault's own location cannot be read", async () => {
    const p = await located(27210, false, elsewhere());
    p.app.vault.adapter = {};
    expect(await resolveClientEndpoint(p)).toBeNull();
  });
});
