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
  releaseAutoWriteOwner,
  resolveAutoWriteOwner,
  setAutoWriteOwner,
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

/**
 * `readTokens` drops any record whose secret is under the 32-byte floor,
 * so the fixtures have to clear it or the token list reads as empty and
 * every ownership assertion passes for the wrong reason.
 */
function secretFor(id: string): string {
  return `${id}-secret-`.padEnd(40, "x");
}

function tokenList(...ids: string[]) {
  return ids.map((id, i) => ({
    id,
    label: id,
    token: secretFor(id),
    createdAt: i,
  }));
}

/** Data.json with a real token list and the flag/owner already set. */
function withTokens(
  ids: string[],
  clientConfig: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mcpTransport: { tokens: tokenList(...ids) },
    mcpClientConfig: clientConfig,
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

describe("setAutoWriteOwner", () => {
  test("persists flag + owner together and preserves other keys", async () => {
    const p = fakePlugin({
      mcpTransport: { bearerToken: "tok" },
      mcpClientConfig: { someOtherKey: "preserved" },
      semanticSearch: { provider: "auto" },
    });

    await setAutoWriteOwner(p, "tok-b");

    const slice = (p._data as Record<string, unknown>)
      .mcpClientConfig as Record<string, unknown>;
    expect(slice.autoWriteClaudeDesktopConfig).toBe(true);
    expect(slice.autoWriteTokenId).toBe("tok-b");
    expect(slice.someOtherKey).toBe("preserved");

    const data = p._data as Record<string, unknown>;
    expect(data.mcpTransport).toEqual({ bearerToken: "tok" });
    expect(data.semanticSearch).toEqual({ provider: "auto" });
  });

  test("creates the slice if absent", async () => {
    const p = fakePlugin({});
    await setAutoWriteOwner(p, "tok-a");

    const data = p._data as Record<string, unknown>;
    expect(data.mcpClientConfig).toEqual({
      autoWriteClaudeDesktopConfig: true,
      autoWriteTokenId: "tok-a",
    });
  });

  test("null releases: flag false and owner null, never left disagreeing", async () => {
    const p = fakePlugin({});
    await setAutoWriteOwner(p, "tok-a");
    await setAutoWriteOwner(p, null);
    expect(await getAutoWriteEnabled(p)).toBe(false);

    const slice = (p._data as Record<string, unknown>)
      .mcpClientConfig as Record<string, unknown>;
    expect(slice.autoWriteClaudeDesktopConfig).toBe(false);
    expect(slice.autoWriteTokenId).toBeNull();
  });

  test("handing ownership over replaces the previous owner", async () => {
    const p = fakePlugin({});
    await setAutoWriteOwner(p, "tok-a");
    await setAutoWriteOwner(p, "tok-b");

    const slice = (p._data as Record<string, unknown>)
      .mcpClientConfig as Record<string, unknown>;
    expect(slice.autoWriteTokenId).toBe("tok-b");
  });
});

describe("resolveAutoWriteOwner", () => {
  test("flag OFF → null, and nothing is written", async () => {
    const p = fakePlugin(withTokens(["a", "b"]));
    const before = JSON.stringify(p._data);
    expect(await resolveAutoWriteOwner(p)).toBeNull();
    expect(JSON.stringify(p._data)).toBe(before);
  });

  test("stored owner is returned as-is when the token still exists", async () => {
    const p = fakePlugin(
      withTokens(["a", "b"], {
        autoWriteClaudeDesktopConfig: true,
        autoWriteTokenId: "b",
      }),
    );
    expect(await resolveAutoWriteOwner(p)).toBe("b");
  });

  test("legacy data (flag ON, no owner) resolves tokens[0] AND persists it", async () => {
    // The write-through is the point: left as a live tokens[0] lookup,
    // revoking the first token would move ownership to the survivor.
    const p = fakePlugin(
      withTokens(["a", "b"], { autoWriteClaudeDesktopConfig: true }),
    );

    expect(await resolveAutoWriteOwner(p)).toBe("a");

    const slice = (p._data as Record<string, unknown>)
      .mcpClientConfig as Record<string, unknown>;
    expect(slice.autoWriteTokenId).toBe("a");
  });

  test("a persisted legacy owner does not drift when tokens[0] changes", async () => {
    const p = fakePlugin(
      withTokens(["a", "b"], { autoWriteClaudeDesktopConfig: true }),
    );
    await resolveAutoWriteOwner(p);

    // "a" is revoked; "b" is now first. Ownership must NOT follow.
    (p._data as Record<string, unknown>).mcpTransport = {
      tokens: tokenList("b"),
    };
    expect(await resolveAutoWriteOwner(p)).toBeNull();
  });

  test("an owner naming a token that no longer exists → null, never a survivor", async () => {
    const p = fakePlugin(
      withTokens(["a", "b"], {
        autoWriteClaudeDesktopConfig: true,
        autoWriteTokenId: "gone",
      }),
    );
    expect(await resolveAutoWriteOwner(p)).toBeNull();
  });

  test("flag ON with no tokens at all → null, no write", async () => {
    const p = fakePlugin({
      mcpClientConfig: { autoWriteClaudeDesktopConfig: true },
    });
    expect(await resolveAutoWriteOwner(p)).toBeNull();
    const slice = (p._data as Record<string, unknown>)
      .mcpClientConfig as Record<string, unknown>;
    expect(slice.autoWriteTokenId).toBeUndefined();
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

  const CFG_REL =
    "Library/Application Support/Claude/claude_desktop_config.json";
  const configPath = () => path.join(tmpRoot, CFG_REL);

  async function readConfig(): Promise<Record<string, never> | null> {
    try {
      return JSON.parse(await fsp.readFile(configPath(), "utf8"));
    } catch {
      return null;
    }
  }

  test("disabled flag → applied=false, reason=disabled, no file write", async () => {
    const p = fakePlugin(withTokens(["a"]));
    p.mcpTransportState = {
      bearerToken: secretFor("a"),
      server: { port: 27200 },
    };

    const result = await applyAutoWrite(p, "a");
    expect(result).toEqual({ applied: false, reason: "disabled" });

    // We can verify no Claude config got written: probe the macOS path.
    if (os.platform() === "darwin") {
      expect(await readConfig()).toBeNull();
    }
  });

  test("enabled flag but transport offline → applied=false, reason=transport-offline", async () => {
    const p = fakePlugin(
      withTokens(["a"], {
        autoWriteClaudeDesktopConfig: true,
        autoWriteTokenId: "a",
      }),
    );
    p.mcpTransportState = undefined;

    const result = await applyAutoWrite(p, "a");
    expect(result).toEqual({
      applied: false,
      reason: "transport-offline",
    });
  });

  test("acting on a token that does not own the config → not-owner, no file write", async () => {
    // The 1.0.0 regression test. Before the owner field, regenerating
    // "b" wrote tokens[0]'s secret into Claude Desktop's config and
    // announced it as a successful sync.
    if (os.platform() !== "darwin") return;
    const p = fakePlugin(
      withTokens(["a", "b"], {
        autoWriteClaudeDesktopConfig: true,
        autoWriteTokenId: "a",
      }),
    );
    p.mcpTransportState = {
      bearerToken: secretFor("a"),
      server: { port: 27200 },
    };

    const result = await applyAutoWrite(p, "b");
    expect(result).toEqual({ applied: false, reason: "not-owner" });
    expect(await readConfig()).toBeNull();
  });

  test("writes the OWNER's own secret, not the transport mirror (macOS)", async () => {
    if (os.platform() !== "darwin") {
      // The default config path resolution branches by platform; this
      // behavioral test is the primary user platform.
      return;
    }
    const p = fakePlugin(
      withTokens(["a", "b"], {
        autoWriteClaudeDesktopConfig: true,
        autoWriteTokenId: "b",
      }),
    );
    // The mirror still holds tokens[0]'s secret — reading it here is the
    // bug, so the assertion below pins "b" explicitly.
    p.mcpTransportState = {
      bearerToken: secretFor("a"),
      server: { port: 27200 },
    };

    const result = await applyAutoWrite(p, "b");
    expect(result).toEqual({ applied: true });

    const written = (await readConfig()) as unknown as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(written.mcpServers[FORK_PLUGIN_ID]).toEqual({
      command: "npx",
      args: [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:27200/mcp",
        "--header",
        `Authorization: Bearer ${secretFor("b")}`,
      ],
    });
  });

  test("legacy vault (flag ON, no owner) still syncs on tokens[0] (macOS)", async () => {
    if (os.platform() !== "darwin") return;
    const p = fakePlugin(
      withTokens(["a", "b"], { autoWriteClaudeDesktopConfig: true }),
    );
    p.mcpTransportState = {
      bearerToken: secretFor("a"),
      server: { port: 27200 },
    };

    expect(await applyAutoWrite(p, "a")).toEqual({ applied: true });

    const written = (await readConfig()) as unknown as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(written.mcpServers[FORK_PLUGIN_ID].args).toContain(
      `Authorization: Bearer ${secretFor("a")}`,
    );
  });
});

describe("releaseAutoWriteOwner", () => {
  let tmpRoot: string;
  let homedirSpy: Mock<typeof os.homedir>;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-tools-autorel-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tmpRoot);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  async function seedConfig(extra: Record<string, unknown> = {}) {
    const dir = path.join(tmpRoot, "Library/Application Support/Claude");
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, "claude_desktop_config.json");
    await fsp.writeFile(
      file,
      JSON.stringify({
        mcpServers: { [FORK_PLUGIN_ID]: { command: "npx" }, ...extra },
      }),
      "utf8",
    );
    return file;
  }

  test("revoking the owner clears both keys and removes the entry", async () => {
    if (os.platform() !== "darwin") return;
    const file = await seedConfig({ "some-other-server": { command: "x" } });
    const p = fakePlugin(
      withTokens(["a"], {
        autoWriteClaudeDesktopConfig: true,
        autoWriteTokenId: "b",
      }),
    );

    expect(await releaseAutoWriteOwner(p, "b")).toEqual({ released: true });

    const slice = (p._data as Record<string, unknown>)
      .mcpClientConfig as Record<string, unknown>;
    expect(slice.autoWriteClaudeDesktopConfig).toBe(false);
    expect(slice.autoWriteTokenId).toBeNull();

    const written = JSON.parse(await fsp.readFile(file, "utf8"));
    expect(written.mcpServers[FORK_PLUGIN_ID]).toBeUndefined();
    // Entries this plugin does not own must survive.
    expect(written.mcpServers["some-other-server"]).toEqual({ command: "x" });
  });

  test("revoking a non-owner is a no-op on both the settings and the file", async () => {
    if (os.platform() !== "darwin") return;
    const file = await seedConfig();
    const p = fakePlugin(
      withTokens(["a", "b"], {
        autoWriteClaudeDesktopConfig: true,
        autoWriteTokenId: "a",
      }),
    );

    expect(await releaseAutoWriteOwner(p, "b")).toEqual({ released: false });

    const slice = (p._data as Record<string, unknown>)
      .mcpClientConfig as Record<string, unknown>;
    expect(slice.autoWriteClaudeDesktopConfig).toBe(true);
    expect(slice.autoWriteTokenId).toBe("a");

    const written = JSON.parse(await fsp.readFile(file, "utf8"));
    expect(written.mcpServers[FORK_PLUGIN_ID]).toEqual({ command: "npx" });
  });
});
