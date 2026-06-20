import { describe, expect, test } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { generateMcpb } from "./mcpbGenerator";

const VERSION = "1.2.3";
const PORT = 27200;
const TOKEN = "test-bearer-tok-abcdef1234567890";

function getManifest(bytes: Uint8Array): Record<string, unknown> {
  const files = unzipSync(bytes);
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("manifest.json missing from zip");
  return JSON.parse(strFromU8(manifestBytes)) as Record<string, unknown>;
}

function getFiles(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

describe("generateMcpb", () => {
  test("returns a non-empty Uint8Array", () => {
    const bytes = generateMcpb({ version: VERSION, port: PORT, token: TOKEN });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  test("zip contains manifest.json, server/index.js, and icon.png", () => {
    const files = getFiles(
      generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
    );
    expect(Object.keys(files)).toContain("manifest.json");
    expect(Object.keys(files)).toContain("server/index.js");
    expect(Object.keys(files)).toContain("icon.png");
  });

  test("icon.png is non-empty", () => {
    const files = getFiles(
      generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
    );
    expect(files["icon.png"].length).toBeGreaterThan(0);
  });

  describe("manifest.json structure", () => {
    test("manifest_version is 0.3", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
      );
      expect(m.manifest_version).toBe("0.3");
    });

    test("version is injected from input", () => {
      const m = getManifest(
        generateMcpb({ version: "9.9.9", port: PORT, token: TOKEN }),
      );
      expect(m.version).toBe("9.9.9");
    });

    test("required top-level fields are present", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
      );
      expect(m.name).toBe("obsidian-mcp-connector");
      expect(m.display_name).toBeTruthy();
      expect(m.description).toBeTruthy();
      expect((m.author as Record<string, unknown>).name).toBeTruthy();
    });

    test("icon field points to icon.png", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
      );
      expect(m.icon).toBe("icon.png");
    });

    test("server uses type node with entry_point and mcp_config", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
      );
      const server = m.server as Record<string, unknown>;
      expect(server.type).toBe("node");
      expect(server.entry_point).toBe("server/index.js");
      const config = server.mcp_config as Record<string, unknown>;
      expect(config.command).toBe("npx");
      expect(Array.isArray(config.args)).toBe(true);
    });

    test("no user_config block — zero-prompt install", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
      );
      expect(m.user_config).toBeUndefined();
    });
  });

  describe("token and port embedding", () => {
    test("literal token is in the Authorization arg", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
      );
      const args = (
        (m.server as Record<string, unknown>).mcp_config as Record<
          string,
          unknown
        >
      ).args as string[];
      const headerArg = args.find((a) => a.startsWith("Authorization:"));
      expect(headerArg).toBe(`Authorization: Bearer ${TOKEN}`);
    });

    test("literal port is in the URL arg", () => {
      const m = getManifest(
        generateMcpb({ version: VERSION, port: 28000, token: TOKEN }),
      );
      const args = (
        (m.server as Record<string, unknown>).mcp_config as Record<
          string,
          unknown
        >
      ).args as string[];
      const urlArg = args.find((a) => a.includes("/mcp"));
      expect(urlArg).toContain(":28000/");
    });

    test("${user_config.token} placeholder is absent", () => {
      const files = getFiles(
        generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
      );
      for (const [name, content] of Object.entries(files)) {
        if (name === "icon.png") continue;
        const text = strFromU8(content);
        expect(
          text,
          `${name} must not contain user_config placeholder`,
        ).not.toContain("${user_config.token}");
      }
    });

    test("${user_config.port} placeholder is absent", () => {
      const files = getFiles(
        generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
      );
      for (const [name, content] of Object.entries(files)) {
        if (name === "icon.png") continue;
        const text = strFromU8(content);
        expect(
          text,
          `${name} must not contain user_config placeholder`,
        ).not.toContain("${user_config.port}");
      }
    });

    test("token value IS embedded in the manifest args", () => {
      const files = getFiles(
        generateMcpb({ version: VERSION, port: PORT, token: TOKEN }),
      );
      const manifest = strFromU8(files["manifest.json"]);
      expect(manifest).toContain(TOKEN);
    });

    test("different tokens produce different bundles", () => {
      const a = generateMcpb({
        version: VERSION,
        port: PORT,
        token: "token-aaa",
      });
      const b = generateMcpb({
        version: VERSION,
        port: PORT,
        token: "token-bbb",
      });
      // Manifests differ; zip bytes will differ.
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    });
  });
});
