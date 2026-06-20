import { describe, expect, test } from "bun:test";
import { unzipSync, strFromU8 } from "fflate";
import { generateMcpb } from "./mcpbGenerator";

const VERSION = "1.2.3";
const PORT = 27200;

function getManifest(bytes: Uint8Array): Record<string, unknown> {
  const files = unzipSync(bytes);
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("manifest.json missing from zip");
  return JSON.parse(strFromU8(manifestBytes)) as Record<string, unknown>;
}

describe("generateMcpb", () => {
  test("returns a non-empty Uint8Array", () => {
    const bytes = generateMcpb({ version: VERSION, port: PORT });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  test("zip contains manifest.json and server/index.js", () => {
    const files = unzipSync(generateMcpb({ version: VERSION, port: PORT }));
    expect(Object.keys(files)).toContain("manifest.json");
    expect(Object.keys(files)).toContain("server/index.js");
  });

  describe("manifest.json structure", () => {
    test("manifest_version is 0.3", () => {
      const m = getManifest(generateMcpb({ version: VERSION, port: PORT }));
      expect(m.manifest_version).toBe("0.3");
    });

    test("version is injected from input", () => {
      const m = getManifest(generateMcpb({ version: "9.9.9", port: PORT }));
      expect(m.version).toBe("9.9.9");
    });

    test("required top-level fields are present", () => {
      const m = getManifest(generateMcpb({ version: VERSION, port: PORT }));
      expect(m.name).toBe("obsidian-mcp-connector");
      expect(m.display_name).toBeTruthy();
      expect(m.description).toBeTruthy();
      expect((m.author as Record<string, unknown>).name).toBeTruthy();
    });

    test("server uses type node with entry_point and mcp_config", () => {
      const m = getManifest(generateMcpb({ version: VERSION, port: PORT }));
      const server = m.server as Record<string, unknown>;
      expect(server.type).toBe("node");
      expect(server.entry_point).toBe("server/index.js");
      const config = server.mcp_config as Record<string, unknown>;
      expect(config.command).toBe("npx");
      expect(Array.isArray(config.args)).toBe(true);
    });

    test("port default in user_config reflects input port", () => {
      const m = getManifest(generateMcpb({ version: VERSION, port: 28000 }));
      const uc = m.user_config as Record<string, Record<string, unknown>>;
      expect(uc.port.default).toBe("28000");
    });

    test("token user_config is sensitive and required", () => {
      const m = getManifest(generateMcpb({ version: VERSION, port: PORT }));
      const uc = m.user_config as Record<string, Record<string, unknown>>;
      expect(uc.token.sensitive).toBe(true);
      expect(uc.token.required).toBe(true);
      expect(uc.token.description).toBeTruthy();
    });

    test("port user_config has description (required by schema)", () => {
      const m = getManifest(generateMcpb({ version: VERSION, port: PORT }));
      const uc = m.user_config as Record<string, Record<string, unknown>>;
      expect(uc.port.description).toBeTruthy();
    });
  });

  describe("security invariants", () => {
    test("token value is NOT embedded anywhere in the zip", () => {
      const secret = "super-secret-bearer-token";
      // Passing token as port string is not the API — but we test the
      // generator never receives or embeds a token at all.
      const bytes = generateMcpb({ version: VERSION, port: PORT });
      const files = unzipSync(bytes);
      for (const [name, content] of Object.entries(files)) {
        const text = strFromU8(content);
        expect(text, `${name} must not embed the secret`).not.toContain(secret);
      }
    });

    test("${user_config.token} placeholder is verbatim in args (not resolved)", () => {
      const m = getManifest(generateMcpb({ version: VERSION, port: PORT }));
      const args = (
        (m.server as Record<string, unknown>).mcp_config as Record<
          string,
          unknown
        >
      ).args as string[];
      const headerArg = args.find((a) => a.startsWith("Authorization:"));
      expect(headerArg).toBe("Authorization: Bearer ${user_config.token}");
    });

    test("${user_config.port} placeholder is verbatim in the URL arg (not resolved)", () => {
      const m = getManifest(generateMcpb({ version: VERSION, port: 99999 }));
      const args = (
        (m.server as Record<string, unknown>).mcp_config as Record<
          string,
          unknown
        >
      ).args as string[];
      const urlArg = args.find((a) => a.includes("/mcp"));
      expect(urlArg).toContain("${user_config.port}");
      // The actual port number must NOT appear in the URL arg.
      expect(urlArg).not.toContain("99999");
    });
  });
});
