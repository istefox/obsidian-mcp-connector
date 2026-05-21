import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import {
  applyAutoWrite,
  getAutoWriteEnabled,
  setAutoWriteEnabled,
} from "./autoWrite";
import { FORK_PLUGIN_ID } from "./claudeDesktop";

/**
 * Tests for the auto-write toggle persistence + sync action.
 *
 * Strategy: a fake plugin with in-memory `loadData/saveData` and an
 * optional `mcpTransportState`. `applyAutoWrite` resolves
 * `defaultClaudeDesktopConfigPath()` (which uses os.homedir), so we
 * stub `os.homedir` to a tmpdir and let it write a real file there.
 */

type StoredData = Record<string, unknown> | null;

function fakePlugin(initial: StoredData = {}) {
  let data: StoredData = initial;
  return {
    async loadData() {
      return data;
    },
    async saveData(next: unknown) {
      data = next as StoredData;
    },
    get _data() {
      return data;
    },
    set _data(v: StoredData) {
      data = v;
    },
    mcpTransportState: undefined as
      | { bearerToken: string; server: { port: number } }
      | undefined,
  };
}

describe("getAutoWriteEnabled", () => {
  test("returns false on null/empty data", async () => {
    const p = fakePlugin(null);
    expect(await getAutoWriteEnabled(p)).toBe(false);
  });

  test("returns false when slice missing", async () => {
    const p = fakePlugin({ otherFeature: { foo: "bar" } });
    expect(await getAutoWriteEnabled(p)).toBe(false);
  });

  test("returns false when flag is missing", async () => {
    const p = fakePlugin({ mcpClientConfig: {} });
    expect(await getAutoWriteEnabled(p)).toBe(false);
  });

  test("returns true only on explicit boolean true", async () => {
    const p = fakePlugin({
      mcpClientConfig: { autoWriteClaudeDesktopConfig: true },
    });
    expect(await getAutoWriteEnabled(p)).toBe(true);
  });

  test("coerces non-boolean values to false (defensive)", async () => {
    const p1 = fakePlugin({
      mcpClientConfig: { autoWriteClaudeDesktopConfig: "true" },
    });
    expect(await getAutoWriteEnabled(p1)).toBe(false);

    const p2 = fakePlugin({
      mcpClientConfig: { autoWriteClaudeDesktopConfig: 1 },
    });
    expect(await getAutoWriteEnabled(p2)).toBe(false);
  });
});

describe("setAutoWriteEnabled", () => {
  test("persists the flag and preserves other keys", async () => {
    const p = fakePlugin({
      mcpTransport: { bearerToken: "tok" },
      mcpClientConfig: { someOtherKey: "preserved" },
      semanticSearch: { provider: "auto" },
    });

    await setAutoWriteEnabled(p, true);

    const data = p._data as Record<string, unknown>;
    expect(
      (data.mcpClientConfig as Record<string, unknown>)
        .autoWriteClaudeDesktopConfig,
    ).toBe(true);
    expect((data.mcpClientConfig as Record<string, unknown>).someOtherKey).toBe(
      "preserved",
    );
    expect(data.mcpTransport).toEqual({ bearerToken: "tok" });
    expect(data.semanticSearch).toEqual({ provider: "auto" });
  });

  test("creates the slice if absent", async () => {
    const p = fakePlugin({});
    await setAutoWriteEnabled(p, true);

    const data = p._data as Record<string, unknown>;
    expect(data.mcpClientConfig).toEqual({
      autoWriteClaudeDesktopConfig: true,
    });
  });

  test("flipping ON then OFF lands at false (not undefined)", async () => {
    const p = fakePlugin({});
    await setAutoWriteEnabled(p, true);
    await setAutoWriteEnabled(p, false);
    expect(await getAutoWriteEnabled(p)).toBe(false);

    const data = p._data as Record<string, unknown>;
    expect(
      (data.mcpClientConfig as Record<string, unknown>)
        .autoWriteClaudeDesktopConfig,
    ).toBe(false);
  });
});

describe("applyAutoWrite", () => {
  let tmpRoot: string;
  let homedirSpy: Mock<typeof os.homedir>;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-tools-autowrite-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpRoot);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  test("disabled flag → applied=false, reason=disabled, no file write", async () => {
    const p = fakePlugin({});
    p.mcpTransportState = {
      bearerToken: "tok",
      server: { port: 27200 },
    };

    const result = await applyAutoWrite(p);
    expect(result).toEqual({ applied: false, reason: "disabled" });

    // We can verify no Claude config got written: probe the macOS path.
    if (os.platform() === "darwin") {
      const cfg = path.join(
        tmpRoot,
        "Library/Application Support/Claude/claude_desktop_config.json",
      );
      const exists = await fsp
        .stat(cfg)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    }
  });

  test("enabled flag but transport offline → applied=false, reason=transport-offline", async () => {
    const p = fakePlugin({
      mcpClientConfig: { autoWriteClaudeDesktopConfig: true },
    });
    p.mcpTransportState = undefined;

    const result = await applyAutoWrite(p);
    expect(result).toEqual({
      applied: false,
      reason: "transport-offline",
    });
  });

  test("enabled + transport up → writes Claude config and returns applied=true (macOS)", async () => {
    if (os.platform() !== "darwin") {
      // The default config path resolution branches by platform; this
      // behavioral test is the primary user platform.
      return;
    }
    const p = fakePlugin({
      mcpClientConfig: { autoWriteClaudeDesktopConfig: true },
    });
    p.mcpTransportState = {
      bearerToken: "tok-applied",
      server: { port: 27200 },
    };

    const result = await applyAutoWrite(p);
    expect(result).toEqual({ applied: true });

    const cfg = path.join(
      tmpRoot,
      "Library/Application Support/Claude/claude_desktop_config.json",
    );
    const written = JSON.parse(await fsp.readFile(cfg, "utf8"));
    expect(written.mcpServers[FORK_PLUGIN_ID]).toEqual({
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:27200/mcp",
        "--header",
        "Authorization: Bearer tok-applied",
      ],
    });
  });
});
