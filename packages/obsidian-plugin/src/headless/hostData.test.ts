import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "obsidian";
import {
  checkDataOutsideVault,
  createFileHost,
  createMemoryHost,
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

describe("createMemoryHost", () => {
  test("keeps data in memory", async () => {
    const host = createMemoryHost(parts);
    await host.saveData({ a: 1 });
    expect(await host.loadData()).toEqual({ a: 1 });
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
