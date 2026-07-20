import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { unzipSync, strFromU8 } from "fflate";
import { generateMcpb, type McpbManifest } from "./mcpbGenerator";
import { CONNECTOR_SHIM_SOURCE } from "../assets/connectorShimSource";

const VERSION = "1.2.3";
const VAULT_PATH = "/Users/test/Obsidian/MockVault";
const CONFIG_DIR = ".obsidian";

function getManifest(bytes: Uint8Array): McpbManifest {
  const files = unzipSync(bytes);
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("manifest.json missing from zip");
  return JSON.parse(strFromU8(manifestBytes)) as McpbManifest;
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

test("assets/connectorShimSource.ts is in sync with scripts/connectorShim.js", () => {
  const onDisk = readFileSync(
    join(import.meta.dir, "../../../../scripts/connectorShim.js"),
    "utf8",
  );
  expect(CONNECTOR_SHIM_SOURCE).toBe(onDisk);
});

describe("generateMcpb", () => {
  test("returns a non-empty Uint8Array", () => {
    const bytes = generateMcpb({
      version: VERSION,
      vaultPath: VAULT_PATH,
      configDir: CONFIG_DIR,
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  test("zip contains manifest.json, server/index.js, and icon.png", () => {
    const files = getFiles(
      generateMcpb({
        version: VERSION,
        vaultPath: VAULT_PATH,
        configDir: CONFIG_DIR,
      }),
    );
    expect(Object.keys(files)).toContain("manifest.json");
    expect(Object.keys(files)).toContain("server/index.js");
    expect(Object.keys(files)).toContain("icon.png");
  });

  test("icon.png is non-empty", () => {
    const files = getFiles(
      generateMcpb({
        version: VERSION,
        vaultPath: VAULT_PATH,
        configDir: CONFIG_DIR,
      }),
    );
    expect(files["icon.png"].length).toBeGreaterThan(0);
  });

  describe("manifest.json structure", () => {
    test("manifest_version is 0.3", () => {
      const m = getManifest(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(m.manifest_version).toBe("0.3");
    });

    test("version is injected from input", () => {
      const m = getManifest(
        generateMcpb({
          version: "9.9.9",
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(m.version).toBe("9.9.9");
    });

    test("required top-level fields are present", () => {
      const m = getManifest(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(m.name).toBe("obsidian-mcp-connector");
      expect(m.display_name).toBeTruthy();
      expect(m.description).toBeTruthy();
      expect(m.author.name).toBeTruthy();
    });

    test("icon field points to icon.png", () => {
      const m = getManifest(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(m.icon).toBe("icon.png");
    });

    test("server invokes the entry_point shim via mcp_config — no bypass", () => {
      const m = getManifest(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      const server = m.server;
      expect(server.type).toBe("node");
      expect(server.entry_point).toBe("server/index.js");
      expect(server.mcp_config).toEqual({
        command: "node",
        args: ["${__dirname}/server/index.js"],
      });
    });

    test("no user_config block — zero-prompt install", () => {
      const m = getManifest(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(m.user_config).toBeUndefined();
    });

    test("manifest matches the McpbManifest shape end-to-end", () => {
      const m: McpbManifest = getManifest(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      // Reading the concrete fields without casts is the point: a rename like
      // entry_point -> entrypoint would now fail to compile.
      expect(m.manifest_version).toBe("0.3");
      expect(m.server.type).toBe("node");
      expect(m.server.entry_point).toBe("server/index.js");
      expect(m.server.mcp_config.command).toBe("node");
      expect(m.server.mcp_config.args).toEqual([
        "${__dirname}/server/index.js",
      ]);
    });
  });

  describe("dynamic port/token resolution (shim)", () => {
    test("manifest.json contains no port or token literal", () => {
      const manifest = strFromU8(
        getFiles(
          generateMcpb({
            version: VERSION,
            vaultPath: VAULT_PATH,
            configDir: CONFIG_DIR,
          }),
        )["manifest.json"],
      );
      expect(manifest).not.toMatch(/Bearer /);
      expect(manifest).not.toMatch(/127\.0\.0\.1:\d+/);
    });

    test("shim bakes in the vault path", () => {
      const shim = getShimSource(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(shim).toContain(VAULT_PATH);
    });

    test("shim reads data.json under the plugin's own folder id", () => {
      const shim = getShimSource(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(shim).toContain('const configDir = ".obsidian";');
      expect(shim).toContain(
        'configDir, "plugins", "mcp-tools-istefox", "data.json"',
      );
    });

    test("shim bakes in a custom config dir when the vault uses one", () => {
      const shim = getShimSource(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: ".obsidian-custom",
        }),
      );
      expect(shim).toContain('const configDir = ".obsidian-custom";');
      expect(shim).not.toContain('const configDir = ".obsidian";');
    });

    test("shim resolves port and token from mcpTransport, not from literals", () => {
      const shim = getShimSource(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(shim).toContain("transport.livePort");
      expect(shim).toContain("transport.bearerToken");
      expect(shim).not.toMatch(/127\.0\.0\.1:\d+/);
      expect(shim).not.toMatch(/Bearer [A-Za-z0-9_-]{10,}/);
    });

    test("shim reports a clear message when data.json is unreadable, without exiting the process", () => {
      const shim = getShimSource(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(shim).toContain("could not read");
      expect(shim).not.toContain("process.exit(1)");
    });

    test("different vault paths produce different bundles", () => {
      const a = generateMcpb({
        version: VERSION,
        vaultPath: "/vault/a",
        configDir: CONFIG_DIR,
      });
      const b = generateMcpb({
        version: VERSION,
        vaultPath: "/vault/b",
        configDir: CONFIG_DIR,
      });
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    });
  });

  describe("shim contents (embedded via CONNECTOR_SHIM_SOURCE)", () => {
    test("no npx / mcp-remote anywhere in the generated shim", () => {
      const shim = getShimSource(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(shim).not.toContain("npx");
      expect(shim).not.toContain("mcp-remote");
      expect(shim).not.toContain("spawn");
    });

    test("shim uses fetch, not a child process, to reach the server", () => {
      const shim = getShimSource(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(shim).toContain("fetch");
      expect(shim).not.toContain('require("child_process")');
    });

    test("shim retains bounded retry + per-request timeout constants", () => {
      const shim = getShimSource(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(shim).toContain("RETRY_WINDOW_MS");
      expect(shim).toContain("20000");
      expect(shim).toContain("requestTimeoutMs");
    });

    test("shim reports a clear timeout message pointing at Obsidian, not a raw connection error", () => {
      const shim = getShimSource(
        generateMcpb({
          version: VERSION,
          vaultPath: VAULT_PATH,
          configDir: CONFIG_DIR,
        }),
      );
      expect(shim).toContain("is Obsidian open with the vault loaded?");
    });
  });
});
