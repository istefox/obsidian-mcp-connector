/**
 * The settings host the shared transport code expects (`loadData` /
 * `saveData`, `app`, `manifest`), backed by memory for stdio and by a JSON
 * state file outside the vault for the HTTP service. The file holds the
 * bearer token, so it is written atomically with mode 0600 in a 0700
 * directory.
 *
 * The shared transport and tool code is typed with the Obsidian plugin
 * class. Headless leaves that code as it is and hands it a host with the
 * members the code really reads (see `HeadlessHost`), cast once by
 * `asPlugin`.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { App } from "obsidian";
import type McpToolsPlugin from "$/main";
import type { PluginDataLike } from "$/shared/types";

export type HostParts = {
  app: App;
  manifest: { id?: string; version: string; dir?: string };
};

/**
 * What the shared transport and tool code reads from the plugin object at
 * runtime: the settings store (`loadData` / `saveData`), the `app` and the
 * manifest. The entry also assigns `mcpTransportState` once the HTTP
 * listener is bound, which `get_server_info` reads, and
 * `semanticSearchState`, which `search_vault_smart` reads.
 */
export type HeadlessHost = PluginDataLike &
  HostParts & {
    mcpTransportState?: { server: { port: number } };
    semanticSearchState?: unknown;
  };

/**
 * The one place the host is presented as the plugin class. Keeping the
 * shared code typed with the class costs a cast here and saves editing
 * every shared signature, so the desktop bundle stays untouched.
 */
export function asPlugin(host: HeadlessHost): McpToolsPlugin {
  return host as unknown as McpToolsPlugin;
}

/** Settings kept in memory only; nothing outlives the process. */
export function createMemoryHost(parts: HostParts): HeadlessHost {
  let data: unknown = {};
  return {
    ...parts,
    loadData: async () => data,
    saveData: async (next) => {
      data = next;
    },
  };
}

/**
 * A host whose `mcpTransport.port` is `port` for as long as the process
 * runs, whatever the stored settings say. It makes `--port` a fixed port
 * for the shared transport setup without writing the flag into the state
 * file: a later run without `--port` gets the stored value back.
 */
export function withFixedPort(host: HeadlessHost, port: number): HeadlessHost {
  const slice = (data: unknown): Record<string, unknown> => {
    const value = (data as Record<string, unknown> | null | undefined)
      ?.mcpTransport;
    return typeof value === "object" && value !== null
      ? { ...(value as Record<string, unknown>) }
      : {};
  };
  return {
    ...host,
    loadData: async () => {
      const data = (await host.loadData()) as Record<string, unknown> | null;
      return { ...data, mcpTransport: { ...slice(data), port } };
    },
    saveData: async (next) => {
      const stored = slice(await host.loadData()).port;
      const transport = slice(next);
      if (stored === undefined) delete transport.port;
      else transport.port = stored;
      await host.saveData({
        ...(next as Record<string, unknown> | null),
        mcpTransport: transport,
      });
    },
  };
}

/**
 * `<config>/obsidian-mcp-connector/<vault-name>-<8 hex of the vault's
 * realpath hash>.json`, where `<config>` is $XDG_CONFIG_HOME or ~/.config.
 * Two vaults with the same folder name get distinct files.
 */
export function defaultDataPath(
  vaultRealPath: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const config = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const hash = createHash("sha256")
    .update(vaultRealPath)
    .digest("hex")
    .slice(0, 8);
  return path.join(
    config,
    "obsidian-mcp-connector",
    `${path.basename(vaultRealPath)}-${hash}.json`,
  );
}

const SEPARATORS = path.sep === "\\" ? /[\\/]/ : "/";

/**
 * Throw when the state file would land inside the vault, where the tools
 * could read the bearer token. Creates the file's directory and returns the
 * canonical path the file must be read and written through.
 */
export async function checkDataOutsideVault(
  file: string,
  vaultDir: string,
): Promise<string> {
  const root = await fs.realpath(vaultDir);
  const base = file.split(SEPARATORS).pop();
  if (!base || base === "." || base === "..") {
    throw new Error(`The state file ${file} needs a file name`);
  }
  const absolute = path.isAbsolute(file)
    ? file
    : process.cwd() + path.sep + file;
  const real = path.join(
    await makeDirOutside(path.dirname(absolute), root, file),
    base,
  );
  refuseInside(real, root, file);
  const isLink = await fs.lstat(real).then(
    (stat) => stat.isSymbolicLink(),
    () => false,
  );
  if (isLink) {
    throw new Error(
      `The state file ${file} is a symlink; point --data at a regular file`,
    );
  }
  return real;
}

/**
 * `mkdir -p` that returns the directory's realpath and refuses before a
 * level would be created inside the vault. Each component is resolved by
 * the kernel from its parent's realpath, so `..` steps back from where a
 * symlink really leads; it is never handed to realpath, which Bun
 * normalises lexically.
 */
async function makeDirOutside(
  dir: string,
  root: string,
  file: string,
): Promise<string> {
  let real = path.parse(dir).root;
  for (const name of dir.slice(real.length).split(SEPARATORS)) {
    if (name === "" || name === ".") continue;
    if (name === "..") {
      real = path.dirname(real);
      continue;
    }
    const next = path.join(real, name);
    const exists = await fs.lstat(next).then(
      () => true,
      () => false,
    );
    if (!exists) {
      refuseInside(real, root, file);
      await fs.mkdir(next, { mode: 0o700 }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      });
    }
    // A dangling symlink exists but does not resolve; it would be followed
    // on write, so it is refused.
    real = await fs.realpath(next).catch(() => {
      throw new Error(`Cannot resolve ${file}`);
    });
  }
  return real;
}

function refuseInside(real: string, root: string, file: string): void {
  if (real === root || real.startsWith(root + path.sep)) {
    throw new Error(
      `The state file ${file} is inside the vault; choose a --data path outside it`,
    );
  }
}

/** Settings persisted to `file`, read once and written through on every save. */
export async function createFileHost(
  parts: HostParts,
  file: string,
): Promise<HeadlessHost> {
  let data: unknown = {};
  try {
    data = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Cannot read the state file ${file}: ${(err as Error).message}`,
      );
    }
  }
  return {
    ...parts,
    loadData: async () => data,
    saveData: async (next) => {
      data = next;
      await writePrivateFile(file, JSON.stringify(next, null, 2));
    },
  };
}

async function writePrivateFile(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
