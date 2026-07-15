import { describe, expect, test } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { generateMcpb } from "./mcpbGenerator";

const VERSION = "1.2.3";
const VAULT_PATH = "/Users/test/Obsidian/MockVault";

function getManifest(bytes: Uint8Array): Record<string, unknown> {
  const files = unzipSync(bytes);
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("manifest.json missing from zip");
  return JSON.parse(strFromU8(manifestBytes)) as Record<string, unknown>;
}

function getFiles(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

function getShimSource(bytes: Uint8Array): string {
  const files = getFiles(bytes);
  const shimBytes = files["server/index.js"];
  if (!shimBytes) throw new Error("server/index.js missing from zip");
  return strFromU8(shimBytes);
}

describe("generateMcpb", () => {
  test("returns a non-empty Uint8Array", () => {
    const bytes = generateMcpb({ version: VERSION, vaultPath: VAULT_PATH });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  test("zip contains manifest.json, server/index.js, and icon.png", () => {
    const files = getFiles(
      generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
    );
    expect(Object.keys(files)).toContain("manifest.json");
    expect(Object.keys(files)).toContain("server/index.js");
    expect(Object.keys(files)).toContain("icon.png");
  });

  test("icon.png is non-empty", () => {
    const files = getFiles(
      generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
    );
    expect(files["icon.png"].length).toBeGreaterThan(0);
  });

  describe("manifest.json structure", () => {
    test("manifest_version is 0.3", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(m.manifest_version).toBe("0.3");
    });

    test("version is injected from input", () => {
      const m = getManifest(
        generateMcpb({ version: "9.9.9", vaultPath: VAULT_PATH }),
      );
      expect(m.version).toBe("9.9.9");
    });

    test("required top-level fields are present", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(m.name).toBe("obsidian-mcp-connector");
      expect(m.display_name).toBeTruthy();
      expect(m.description).toBeTruthy();
      expect((m.author as Record<string, unknown>).name).toBeTruthy();
    });

    test("icon field points to icon.png", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(m.icon).toBe("icon.png");
    });

    test("server invokes the entry_point shim via mcp_config — no bypass", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      const server = m.server as Record<string, unknown>;
      expect(server.type).toBe("node");
      expect(server.entry_point).toBe("server/index.js");
      expect(server.mcp_config).toEqual({
        command: "node",
        args: ["${__dirname}/server/index.js"],
      });
    });

    test("no user_config block — zero-prompt install", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(m.user_config).toBeUndefined();
    });
  });

  describe("dynamic port/token resolution (shim)", () => {
    test("manifest.json contains no port or token literal", () => {
      const manifest = strFromU8(
        getFiles(generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }))[
          "manifest.json"
        ],
      );
      expect(manifest).not.toMatch(/Bearer /);
      expect(manifest).not.toMatch(/127\.0\.0\.1:\d+/);
    });

    test("shim bakes in the vault path", () => {
      const shim = getShimSource(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(shim).toContain(VAULT_PATH);
    });

    test("shim reads data.json under the plugin's own folder id", () => {
      const shim = getShimSource(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(shim).toContain(
        '".obsidian", "plugins", "mcp-tools-istefox", "data.json"',
      );
    });

    test("shim resolves port and token from mcpTransport, not from literals", () => {
      const shim = getShimSource(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(shim).toContain("transport.livePort");
      expect(shim).toContain("transport.bearerToken");
      expect(shim).not.toMatch(/127\.0\.0\.1:\d+/);
      expect(shim).not.toMatch(/Bearer [A-Za-z0-9_-]{10,}/);
    });

    test("shim exits non-zero with a clear message when data.json is unreadable", () => {
      const shim = getShimSource(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(shim).toContain("process.exit(1)");
      expect(shim).toContain("could not read");
    });

    test("different vault paths produce different bundles", () => {
      const a = generateMcpb({ version: VERSION, vaultPath: "/vault/a" });
      const b = generateMcpb({ version: VERSION, vaultPath: "/vault/b" });
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    });
  });

  describe("wait-for-server retry (server not listening yet)", () => {
    test("shim probes a real TCP connection instead of assuming the port is open", () => {
      const shim = getShimSource(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(shim).toContain('require("net")');
      expect(shim).toContain("net.createConnection");
    });

    test("shim bounds the retry window instead of retrying forever", () => {
      const shim = getShimSource(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(shim).toContain("RETRY_WINDOW_MS");
      expect(shim).toContain("30000");
      expect(shim).toContain("while (Date.now() < deadline)");
    });

    test("shim re-reads data.json on every retry attempt, not just once", () => {
      const shim = getShimSource(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      const loopStart = shim.indexOf("while (Date.now() < deadline)");
      const readCallInLoop = shim.indexOf("readTransport()", loopStart);
      expect(loopStart).toBeGreaterThan(-1);
      expect(readCallInLoop).toBeGreaterThan(loopStart);
    });

    test("shim reports a clear timeout message pointing at Obsidian, not a raw connection error", () => {
      const shim = getShimSource(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      expect(shim).toContain("is Obsidian open with the vault loaded?");
    });

    test("mcp-remote is only spawned after the wait-for-server promise resolves", () => {
      const shim = getShimSource(
        generateMcpb({ version: VERSION, vaultPath: VAULT_PATH }),
      );
      const waitCall = shim.indexOf("await waitForServer()");
      const spawnCall = shim.indexOf('spawn("npx"');
      expect(waitCall).toBeGreaterThan(-1);
      expect(spawnCall).toBeGreaterThan(waitCall);
    });
  });
});
