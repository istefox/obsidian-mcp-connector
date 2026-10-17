/**
 * The settings host the shared transport code expects (`loadData` /
 * `saveData`, `app`, `manifest`), backed by memory for stdio and by a JSON
 * state file outside the vault for the HTTP service. The file holds the
 * bearer token, so it is written atomically with mode 0600 in a 0700
 * directory.
 *
 * The shared transport and tool code is typed with the Obsidian plugin
 * class. Headless leaves that code as it is and hands it a host with the
 * members the code really reads (see `HeadlessHost`), cast in `asPlugin`
 * and, for code that is handed the class, back in `hostOf`.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { App } from "obsidian";
import type McpToolsPlugin from "$/main";
import type { SemanticSearchState } from "$/features/semantic-search";
import { logger } from "$/shared/logger";
import type { PluginDataLike } from "$/shared/types";
import { codeOf, fixedMessage } from "./clientMessage";

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
 *
 * `semanticGate` is headless's own. It is set when semantic search is on:
 * the tool registration lists `search_vault_smart` only then, and runs the
 * gate before each call (see semanticSearch.ts), which also sets
 * `semanticSearchState` once the feature is wired.
 */
export type HeadlessHost = PluginDataLike &
  HostParts & {
    mcpTransportState?: { server: { port: number } };
    semanticSearchState?: SemanticSearchState;
    semanticGate?: () => Promise<string | undefined>;
  };

/**
 * The one place the host is presented as the plugin class. Keeping the
 * shared code typed with the class costs a cast here and saves editing
 * every shared signature, so the desktop bundle stays untouched.
 */
export function asPlugin(host: HeadlessHost): McpToolsPlugin {
  return host as unknown as McpToolsPlugin;
}

/** The inverse of `asPlugin`, for headless code that is handed the plugin type. */
export function hostOf(plugin: McpToolsPlugin): HeadlessHost {
  return plugin as unknown as HeadlessHost;
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
 * Settings kept in memory, except the `mcpTools` slice (the folder
 * exclusions), which is always read from `source`. Semantic search uses
 * it so its own settings never reach the HTTP state file while the index
 * still honors the exclusions the tools enforce. Writes to `mcpTools` are
 * dropped: this host never owns that slice.
 */
export function createExclusionsHost(
  parts: HostParts,
  source: HeadlessHost,
): HeadlessHost {
  let own: Record<string, unknown> = {};
  return {
    ...parts,
    loadData: async () => {
      const shared = (await source.loadData()) as
        | Record<string, unknown>
        | null
        | undefined;
      const mcpTools = shared?.mcpTools;
      return mcpTools === undefined ? { ...own } : { ...own, mcpTools };
    },
    saveData: async (next) => {
      const { mcpTools: _dropped, ...rest } = (next ?? {}) as Record<
        string,
        unknown
      >;
      own = rest;
    },
  };
}

/** `<vault-name>-<8 hex of the vault's realpath hash>`: distinct per vault path. */
function vaultKey(vaultRealPath: string): string {
  const hash = createHash("sha256")
    .update(vaultRealPath)
    .digest("hex")
    .slice(0, 8);
  return `${path.basename(vaultRealPath)}-${hash}`;
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
  return path.join(
    config,
    "obsidian-mcp-connector",
    `${vaultKey(vaultRealPath)}.json`,
  );
}

/**
 * `<cache>/obsidian-mcp-connector`, where `<cache>` is $XDG_CACHE_HOME or
 * ~/.cache. Holds what every vault shares (downloaded models, the ONNX
 * runtime files) and one folder per vault.
 */
export function defaultCacheRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const cache = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cache, "obsidian-mcp-connector");
}

/** The cache folder of one vault: `<cache root>/<vault-name>-<8 hex>`. */
export function defaultCachePath(
  vaultRealPath: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(defaultCacheRoot(env), vaultKey(vaultRealPath));
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

/** What the client reads when the state file cannot be written. */
export const SETTINGS_SAVE_FAILED = "The server settings could not be saved";

/**
 * Settings persisted to `file`, read once and written through on every save.
 * A save runs inside a tool call (`activate_tool` with `persist`), and the
 * error of a failed one would reach the client with the state file's path in
 * it. The client gets fixed text and the error's code instead (see
 * clientMessage.ts), and the whole error goes to the log.
 */
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
      try {
        await writePrivateFile(file, JSON.stringify(next, null, 2));
      } catch (err) {
        logger.error(`state file: ${SETTINGS_SAVE_FAILED}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw new Error(fixedMessage(SETTINGS_SAVE_FAILED, codeOf(err)));
      }
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
