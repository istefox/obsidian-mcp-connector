import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { App } from "obsidian";
import { activateToolHandler } from "$/features/mcp-tools/tools/activateTool";
import { activateToolsHandler } from "$/features/mcp-tools/tools/activateTools";
import { logger } from "$/shared/logger";
import {
  checkDataOutsideVault,
  createFileHost,
  createExclusionsHost,
  createMemoryHost,
  defaultCachePath,
  defaultCacheRoot,
  defaultDataPath,
  withFixedPort,
} from "./hostData";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostdata-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const parts = { app: {} as App, manifest: { version: "0.0.0" } };

describe("defaultDataPath", () => {
  test("lives under XDG_CONFIG_HOME and tells same-named vaults apart", () => {
    const env = { XDG_CONFIG_HOME: "/cfg" };
    const a = defaultDataPath("/one/notes", env);
    const b = defaultDataPath("/two/notes", env);
    expect(a).toMatch(
      /^\/cfg\/obsidian-mcp-connector\/notes-[0-9a-f]{8}\.json$/,
    );
    expect(a).not.toBe(b);
    expect(defaultDataPath("/one/notes", env)).toBe(a);
  });
});

describe("defaultCachePath", () => {
  test("lives under XDG_CACHE_HOME, one folder per vault path", () => {
    const env = { XDG_CACHE_HOME: "/cache" };
    expect(defaultCacheRoot(env)).toBe("/cache/obsidian-mcp-connector");
    const a = defaultCachePath("/one/notes", env);
    expect(a).toMatch(/^\/cache\/obsidian-mcp-connector\/notes-[0-9a-f]{8}$/);
    expect(defaultCachePath("/two/notes", env)).not.toBe(a);
    expect(defaultCachePath("/one/notes", env)).toBe(a);
  });

  test("shares its vault key with the state file name", () => {
    const env = { XDG_CACHE_HOME: "/c", XDG_CONFIG_HOME: "/f" };
    const key = path.basename(defaultCachePath("/v/notes", env));
    expect(path.basename(defaultDataPath("/v/notes", env))).toBe(`${key}.json`);
  });
});

describe("createFileHost", () => {
  test("persists privately and reloads", async () => {
    const file = path.join(dir, "state", "vault.json");
    const host = await createFileHost(parts, file);
    expect(await host.loadData()).toEqual({});
    await host.saveData({ token: "t" });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["vault.json"]);

    const again = await createFileHost(parts, file);
    expect(await again.loadData()).toEqual({ token: "t" });
  });

  test("refuses a corrupt state file rather than minting over it", async () => {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{not json");
    await expect(createFileHost(parts, file)).rejects.toThrow("state file");
  });
});

// A directory the process can no longer write to is how a full or read-only
// state folder looks after startup. Root ignores the mode bits.
const asRoot = process.getuid?.() === 0;

/**
 * A file host whose state folder (a name with a space, so any leak of it is
 * easy to spot) stops being writable once the host is up.
 */
async function hostWithLockedState() {
  const stateDir = path.join(dir, "Private Config");
  const host = await createFileHost(parts, path.join(stateDir, ".state.json"));
  await host.saveData({ before: true });
  fs.chmodSync(stateDir, 0o500);
  return { host, stateDir };
}

describe.skipIf(asRoot)(
  "createFileHost when the state folder is locked",
  () => {
    afterEach(() => {
      for (const entry of fs.readdirSync(dir)) {
        fs.chmodSync(path.join(dir, entry), 0o700);
      }
    });

    test("fails with fixed text and the code, and logs the detail", async () => {
      const { host, stateDir } = await hostWithLockedState();
      const logged = spyOn(logger, "error").mockImplementation(() => {});
      try {
        const failure = await host.saveData({ after: true }).then(
          () => undefined,
          (err: unknown) => err as Error,
        );
        expect(failure).toBeInstanceOf(Error);
        expect(failure!.message).toBe(
          "The server settings could not be saved (EACCES). Details are in the server log.",
        );
        expect(failure!.message).not.toContain("Private Config");
        expect(failure!.message).not.toContain(dir);
        expect(JSON.stringify(logged.mock.calls)).toContain(stateDir);
      } finally {
        logged.mockRestore();
      }
    });

    test("leaves the client no path when a persisted activation fails", async () => {
      const { host } = await hostWithLockedState();
      const logged = spyOn(logger, "error").mockImplementation(() => {});
      const registry = {
        listAll: () => [
          {
            name: "rename_vault_file",
            description: "d",
            enabled: false,
            userDisabled: false,
          },
          {
            name: "find_broken_links",
            description: "d",
            enabled: false,
            userDisabled: false,
          },
        ],
      };
      const server = {
        server: { notification: async () => {} },
      } as unknown as McpServer;
      const scope = { id: "tok", active: new Set<string>(), allowed: null };
      try {
        const messages: string[] = [];
        for (const run of [
          () =>
            activateToolHandler({
              arguments: { name: "rename_vault_file", persist: true },
              registry,
              plugin: host,
              server,
              scope,
            }),
          () =>
            activateToolsHandler({
              arguments: { names: ["find_broken_links"], persist: true },
              registry,
              plugin: host,
              server,
              scope,
            }),
        ]) {
          const error = await run().then(
            () => undefined,
            (err: unknown) => err as Error,
          );
          expect(error).toBeInstanceOf(Error);
          messages.push(error!.message);
        }
        for (const message of messages) {
          expect(message).toContain("(EACCES)");
          expect(message).not.toContain("Private Config");
          expect(message).not.toContain(dir);
        }
      } finally {
        logged.mockRestore();
      }
    });
  },
);

describe("createMemoryHost", () => {
  test("keeps data in memory", async () => {
    const host = createMemoryHost(parts);
    await host.saveData({ a: 1 });
    expect(await host.loadData()).toEqual({ a: 1 });
  });
});

describe("createExclusionsHost", () => {
  test("reads mcpTools from the source and keeps every other write in memory", async () => {
    const file = path.join(dir, "state.json");
    const source = await createFileHost(parts, file);
    await source.saveData({ mcpTools: { excludedFolders: ["Hidden"] } });
    const host = createExclusionsHost(parts, source);

    expect(await host.loadData()).toEqual({
      mcpTools: { excludedFolders: ["Hidden"] },
    });

    await host.saveData({
      mcpTools: { excludedFolders: ["Stale"] },
      semanticSearch: { provider: "native" },
    });
    // The source's slice wins on read, and the state file is untouched.
    expect(await host.loadData()).toEqual({
      mcpTools: { excludedFolders: ["Hidden"] },
      semanticSearch: { provider: "native" },
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      mcpTools: { excludedFolders: ["Hidden"] },
    });

    // A later change to the source shows through.
    await source.saveData({ mcpTools: { excludedFolders: ["Other"] } });
    expect(await host.loadData()).toEqual({
      mcpTools: { excludedFolders: ["Other"] },
      semanticSearch: { provider: "native" },
    });
  });

  test("a source without mcpTools yields none", async () => {
    const host = createExclusionsHost(parts, createMemoryHost(parts));
    expect(await host.loadData()).toEqual({});
  });
});

describe("checkDataOutsideVault", () => {
  test("refuses a state file inside the vault, also through a symlink", async () => {
    const vault = path.join(dir, "vault");
    fs.mkdirSync(path.join(vault, "sub"), { recursive: true });
    fs.symlinkSync(path.join(vault, "sub"), path.join(dir, "link"));
    for (const file of [
      path.join(vault, "state.json"),
      path.join(vault, "new", "deeper", "state.json"),
      path.join(dir, "link", "state.json"),
    ]) {
      await expect(checkDataOutsideVault(file, vault)).rejects.toThrow(
        "inside the vault",
      );
    }
  });

  test("accepts a state file next to the vault", async () => {
    const vault = path.join(dir, "vault");
    fs.mkdirSync(vault);
    const real = fs.realpathSync(dir);
    expect(
      await checkDataOutsideVault(path.join(dir, "vault-state.json"), vault),
    ).toBe(path.join(real, "vault-state.json"));
    expect(
      await checkDataOutsideVault(path.join(dir, "x", "state.json"), vault),
    ).toBe(path.join(real, "x", "state.json"));
  });

  test("resolves .. after a symlink from its target, as the kernel does", async () => {
    const vault = path.join(dir, "vault");
    fs.mkdirSync(path.join(vault, "sub"), { recursive: true });
    fs.mkdirSync(path.join(dir, "x"));
    fs.symlinkSync(path.join(vault, "sub"), path.join(dir, "x", "jump"));
    const file = `${path.join(dir, "x", "jump")}/../state.json`;
    await expect(checkDataOutsideVault(file, vault)).rejects.toThrow(
      "inside the vault",
    );

    // The returned path is where the file really lands, so the host writes
    // exactly what was checked.
    fs.mkdirSync(path.join(dir, "out", "deep"), { recursive: true });
    fs.symlinkSync(path.join(dir, "out", "deep"), path.join(dir, "x", "hop"));
    const ok = await checkDataOutsideVault(
      `${path.join(dir, "x", "hop")}/../state.json`,
      vault,
    );
    expect(ok).toBe(path.join(fs.realpathSync(dir), "out", "state.json"));
    const host = await createFileHost(parts, ok);
    await host.saveData({ token: "t" });
    expect(fs.existsSync(path.join(dir, "out", "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "x", "state.json"))).toBe(false);
  });

  test("lets the kernel resolve .. after a missing directory", async () => {
    const vault = path.join(dir, "vault");
    fs.mkdirSync(path.join(vault, "sub"), { recursive: true });
    fs.mkdirSync(path.join(dir, "out"));
    fs.symlinkSync(path.join(vault, "sub"), path.join(dir, "out", "jump"));
    for (const file of [
      `${path.join(dir, "out", "missing")}/../jump/state.json`,
      `${path.join(dir, "out", "new")}/../jump/deeper/state.json`,
    ]) {
      await expect(checkDataOutsideVault(file, vault)).rejects.toThrow(
        "inside the vault",
      );
    }
    // Refused before anything was created inside the vault.
    expect(fs.readdirSync(path.join(vault, "sub"))).toEqual([]);
  });

  test("refuses a state file that is itself a symlink into the vault", async () => {
    const vault = path.join(dir, "vault");
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(vault, "note.md"), "{}");
    for (const target of ["note.md", "missing.json"]) {
      const link = path.join(dir, `${target}.link`);
      fs.symlinkSync(path.join(vault, target), link);
      await expect(checkDataOutsideVault(link, vault)).rejects.toThrow(
        "symlink",
      );
    }
  });

  test("refuses a path without a file name", async () => {
    const vault = path.join(dir, "vault");
    fs.mkdirSync(vault);
    for (const file of [`${dir}/`, `${dir}/.`, `${dir}/x/..`]) {
      await expect(checkDataOutsideVault(file, vault)).rejects.toThrow(
        "needs a file name",
      );
    }
  });

  test("refuses a dangling symlink on the way", async () => {
    const vault = path.join(dir, "vault");
    fs.mkdirSync(vault);
    fs.symlinkSync(path.join(vault, "gone"), path.join(dir, "dangling"));
    await expect(
      checkDataOutsideVault(path.join(dir, "dangling", "state.json"), vault),
    ).rejects.toThrow("Cannot resolve");
  });
});

describe("withFixedPort", () => {
  test("shows the port to the transport setup and keeps the other settings", async () => {
    const base = createMemoryHost(parts);
    await base.saveData({ mcpTransport: { livePort: 27205 }, other: 1 });
    const host = withFixedPort(base, 31000);
    expect(await host.loadData()).toEqual({
      mcpTransport: { livePort: 27205, port: 31000 },
      other: 1,
    });
  });

  test("never writes the flag to the stored settings", async () => {
    const base = createMemoryHost(parts);
    const host = withFixedPort(base, 31000);
    await host.saveData({ mcpTransport: { port: 31000, livePort: 31000 } });
    expect(await base.loadData()).toEqual({
      mcpTransport: { livePort: 31000 },
    });
  });

  test("keeps a port the stored settings already had", async () => {
    const base = createMemoryHost(parts);
    await base.saveData({ mcpTransport: { port: 28000 } });
    const host = withFixedPort(base, 31000);
    await host.saveData({ mcpTransport: { port: 31000, livePort: 31000 } });
    expect(await base.loadData()).toEqual({
      mcpTransport: { port: 28000, livePort: 31000 },
    });
  });

  test("works on settings that are empty", async () => {
    const host = withFixedPort(createMemoryHost(parts), 31000);
    expect(await host.loadData()).toEqual({ mcpTransport: { port: 31000 } });
  });
});
