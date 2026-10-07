import { createHash, randomUUID } from "crypto";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { logger } from "$/shared/logger";
import {
  CLAUDE_CODE_TOKEN_ENV_VAR,
  parseClaudeCodeProjectPath,
} from "./generators";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 30_000;

export type CodexConnection = {
  /** The entry key, `vaultServerId` like every other client config. */
  serverId: string;
  /** The vault token of the row the entry is made for. */
  accessToken: string;
  /** From resolveClientEndpoint, like every other client config. */
  url: string;
  /**
   * Name of an environment variable Codex reads the bearer token from. When
   * set, the snippet carries `bearer_token_env_var` instead of a static
   * `http_headers` block, so the token is not written to `config.toml`. Codex
   * must then be started with that variable set.
   */
  bearerTokenEnvVar?: string;
  /** Emitted as `startup_timeout_sec`. */
  startupTimeoutSec?: number;
};

export function codexConfigSnippet(input: CodexConnection): string {
  const { serverId, url } = input;
  if (!/^[a-zA-Z0-9_-]+$/.test(serverId))
    throw new Error("Invalid connection entry identity");
  const envVar = input.bearerTokenEnvVar?.trim();
  if (envVar !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar))
    throw new Error("Invalid environment variable name");
  const timeout = input.startupTimeoutSec;
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0))
    throw new Error("startupTimeoutSec must be a positive integer");
  return [
    `[mcp_servers.${serverId}]`,
    `url = ${tomlString(url)}`,
    envVar
      ? `bearer_token_env_var = ${tomlString(envVar)}`
      : `http_headers = { Authorization = ${tomlString(`Bearer ${input.accessToken}`)} }`,
    "enabled = true",
    "required = false",
    ...(timeout !== undefined ? [`startup_timeout_sec = ${timeout}`] : []),
  ].join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value)
    .replace(/\\u2028/g, "\\u2028")
    .replace(/\\u2029/g, "\\u2029");
}

// ---------------------------------------------------------------------------
// Generators and locations (ADR-0028 D2, D5, D6, D7)
// ---------------------------------------------------------------------------

export const CODEX_STARTUP_TIMEOUT_SEC = 30;

/** Shared with Claude Code, so the two variable names cannot drift. */
export const CODEX_TOKEN_ENV_VAR: typeof CLAUDE_CODE_TOKEN_ENV_VAR =
  CLAUDE_CODE_TOKEN_ENV_VAR;

export type CodexTokenForm = "literal" | "env";

/** The Codex entry for one token row (ADR-0028 D2). */
export function codexEntryFor(input: {
  serverId: string;
  url: string;
  token: string;
  tokenForm: CodexTokenForm;
}): CodexConnection {
  return {
    serverId: input.serverId,
    accessToken: input.token,
    url: input.url,
    ...(input.tokenForm === "env"
      ? { bearerTokenEnvVar: CODEX_TOKEN_ENV_VAR }
      : {}),
    startupTimeoutSec: CODEX_STARTUP_TIMEOUT_SEC,
  };
}

/**
 * `codex mcp add` for one entry (ADR-0028 D7). Single quotes keep both
 * arguments literal in POSIX shells and in PowerShell once every quote
 * character is refused, so one string serves both. The Codex CLI has no
 * flag for a static header, so the command never carries a token.
 */
export function codexMcpAddCommand(input: {
  serverId: string;
  url: string;
}): string {
  if (!/^[A-Za-z0-9_-]+$/.test(input.serverId) || input.serverId[0] === "-")
    throw new Error("Invalid connection entry identity");
  // ASCII quotes, the typographic single quotes PowerShell also accepts,
  // whitespace and control characters
  if (input.url === "" || /['"‘-‛\s\p{Cc}]/u.test(input.url))
    throw new Error("The client endpoint cannot be quoted for a shell");
  return `codex mcp add '${input.serverId}' --url '${input.url}' --bearer-token-env-var ${CODEX_TOKEN_ENV_VAR}`;
}

export type CodexHomeLocation =
  | {
      located: true;
      codexHome: string;
      configPath: string;
      source: "CODEX_HOME" | "default";
      exists: boolean;
    }
  | { located: false; reason: string };

/**
 * Mirror Codex's `find_codex_home` (openai/codex
 * `codex-rs/utils/home-dir/src/lib.rs`, ADR-0028 D5): a non-empty
 * `CODEX_HOME` must name an existing folder and is canonicalized,
 * otherwise the home is `<home dir>/.codex`, which need not exist yet.
 * Reads the environment and the file system only; creates nothing.
 */
export async function locateCodexHome(opts?: {
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  platform?: "win32" | "posix";
}): Promise<CodexHomeLocation> {
  const platform =
    opts?.platform ?? (process.platform === "win32" ? "win32" : "posix");
  const paths = platform === "win32" ? path.win32 : path.posix;
  const configured = (opts?.env ?? process.env).CODEX_HOME;

  if (configured !== undefined && configured !== "") {
    if (!paths.isAbsolute(configured)) {
      return {
        located: false,
        reason: `CODEX_HOME is the relative path ${configured}, which Codex refuses. Copy the snippet instead.`,
      };
    }
    let codexHome: string;
    try {
      codexHome = await fsp.realpath(configured);
      if (!(await fsp.stat(codexHome)).isDirectory()) {
        return {
          located: false,
          reason: `CODEX_HOME points to ${configured}, which is not a folder. Copy the snippet instead.`,
        };
      }
    } catch (error) {
      return {
        located: false,
        reason: `CODEX_HOME points to ${configured}, which cannot be read (${errorCode(error)}). Copy the snippet instead.`,
      };
    }
    return {
      located: true,
      codexHome,
      configPath: paths.join(codexHome, "config.toml"),
      source: "CODEX_HOME",
      exists: true,
    };
  }

  const homeDir = opts?.homeDir ?? os.homedir();
  if (homeDir === "") {
    return {
      located: false,
      reason:
        "The user's home folder is unknown, so the Codex home cannot be located. Copy the snippet instead.",
    };
  }
  const codexHome = paths.join(homeDir, ".codex");
  let exists = false;
  try {
    if (!(await fsp.stat(codexHome)).isDirectory()) {
      return {
        located: false,
        reason: `${codexHome} is not a folder. Copy the snippet instead.`,
      };
    }
    exists = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return {
        located: false,
        reason: `${codexHome} cannot be read (${errorCode(error)}). Copy the snippet instead.`,
      };
    }
  }
  return {
    located: true,
    codexHome,
    configPath: paths.join(codexHome, "config.toml"),
    source: "default",
    exists,
  };
}

export type CodexProjectLocation =
  | {
      located: true;
      projectPath: string;
      configPath: string;
      codexDirExists: boolean;
    }
  | { located: false; reason: string };

/**
 * The project config for the shared project path (ADR-0028 D6). The path
 * goes through Claude Code's validation and must name an existing folder;
 * `.codex` must be a real folder or absent. Creates nothing.
 */
export async function locateCodexProject(
  projectPath: string,
): Promise<CodexProjectLocation> {
  const parsed = parseClaudeCodeProjectPath(projectPath);
  if (!parsed.ok) return { located: false, reason: parsed.error };
  if (parsed.path === "") {
    return {
      located: false,
      reason: "No project path is set. Set one under Project path below.",
    };
  }
  try {
    if (!(await fsp.stat(parsed.path)).isDirectory()) {
      return {
        located: false,
        reason: `The project path ${parsed.path} is not a folder.`,
      };
    }
  } catch (error) {
    return {
      located: false,
      reason:
        errorCode(error) === "ENOENT"
          ? `The project folder ${parsed.path} does not exist.`
          : `The project folder ${parsed.path} cannot be read (${errorCode(error)}).`,
    };
  }
  const codexDir = path.join(parsed.path, ".codex");
  let codexDirExists = false;
  try {
    await assertProjectCodexDir(codexDir);
    codexDirExists = await directoryExists(codexDir);
  } catch (error) {
    return {
      located: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    located: true,
    projectPath: parsed.path,
    configPath: path.join(codexDir, "config.toml"),
    codexDirExists,
  };
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? String(error);
}

// ---------------------------------------------------------------------------
// The installer (ADR-0028 D1, D3, D4, D6, D9), ported from before 4a40dc6
// ---------------------------------------------------------------------------

export type CodexInstallScope = "user" | "project";

export type CodexInstallTarget = {
  scope: CodexInstallScope;
  configPath: string;
};

/**
 * The entry plus this vault's saved route ID (`savedRouteId`), which
 * decides entry ownership. Never the route credential (ADR-0028 D2).
 */
export type CodexInstallInput = CodexConnection & { routeId: string | null };

export type CodexInstallAction = "add" | "replace" | "migrate" | "unchanged";

export type CodexInstallPreview = {
  scope: CodexInstallScope;
  configPath: string;
  serverId: string;
  url: string;
  action: CodexInstallAction;
  previousServerId?: string;
  previousUrl?: string;
  tokenForm: CodexTokenForm;
  createsFile: boolean;
  createsDirectory: boolean;
  revision: string;
  snippet: string;
};

export type CodexInstallResult = CodexInstallPreview & { backupPath?: string };

/** Thrown by installCodexConfig; carries the backup path even when rollback was skipped. */
export class CodexInstallError extends Error {
  constructor(
    message: string,
    readonly backupPath?: string,
  ) {
    super(message);
    this.name = "CodexInstallError";
  }
}

/** Read the target and plan the install. Writes nothing. */
export async function inspectCodexInstall(
  input: CodexInstallInput,
  target: CodexInstallTarget,
): Promise<CodexInstallPreview> {
  const configPath = path.resolve(target.configPath);
  assertTokenFormAllowed(input, target.scope);
  const configDir = path.dirname(configPath);
  if (target.scope === "project") await assertProjectCodexDir(configDir);
  const createsDirectory = !(await directoryExists(configDir));
  await assertSafeConfigPath(configPath);
  const previous = await readOptional(configPath);
  const snippet = codexConfigSnippet(input);
  const edit = planInstall(previous ?? "", input, snippet, configPath);
  return previewOf(input, target.scope, configPath, edit, {
    createsFile: previous === null,
    createsDirectory,
    revision: configRevision(previous),
    snippet,
  });
}

/**
 * Perform the install the user confirmed after its preview. The revision
 * the preview returned is required, so nothing writes without a preview.
 */
export async function installCodexConfig(
  input: CodexInstallInput,
  target: CodexInstallTarget,
  opts: {
    expectedRevision: string;
    /** Test-only seam: invoked right after the atomic rename, before the
     * verification read, so a concurrent-write race can be reproduced
     * deterministically. Never set from production code. */
    afterWrite?: () => Promise<void>;
  },
): Promise<CodexInstallResult> {
  const configPath = path.resolve(target.configPath);
  assertTokenFormAllowed(input, target.scope);
  if (!opts.expectedRevision) {
    throw new CodexInstallError("Preview the Codex install before installing.");
  }
  const snippet = codexConfigSnippet(input);
  const configDir = path.dirname(configPath);
  // Before the lock, so no lock or backup lands through a linked .codex
  if (target.scope === "project") await assertProjectCodexDir(configDir);
  const createsDirectory = !(await directoryExists(configDir));
  if (createsDirectory) {
    if (target.scope === "user")
      await fsp.mkdir(configDir, { recursive: true, mode: 0o700 });
    // A project's own folder must already exist; only .codex is created
    else await fsp.mkdir(configDir);
  }

  return withConfigLock(configPath, async () => {
    await assertSafeConfigPath(configPath);
    const previous = await readOptional(configPath);
    const revision = configRevision(previous);
    if (opts.expectedRevision !== revision) {
      throw new Error(
        "Codex config changed after the preview. Review the installer action again.",
      );
    }
    const edit = planInstall(previous ?? "", input, snippet, configPath);
    const planned = previewOf(input, target.scope, configPath, edit, {
      createsFile: previous === null,
      createsDirectory,
      revision,
      snippet,
    });
    if (edit.action === "unchanged") return planned;

    const backupPath =
      previous === null ? undefined : await backupConfig(configPath, previous);
    if ((await readOptional(configPath)) !== previous) {
      throw new CodexInstallError(
        "Client configuration changed during installation. Review the preview again",
        backupPath,
      );
    }
    try {
      await writeAtomic(configPath, edit.content, previous);
      await opts.afterWrite?.();
      const written = await fsp.readFile(configPath, "utf8");
      if (written !== edit.content) {
        // `fsp.rename` is atomic: once it resolved, this file held exactly
        // `edit.content` until someone else wrote to it. A verify mismatch
        // here can therefore only mean a concurrent editor's write landed
        // between our rename and this read — never a corruption of our own
        // write. There is nothing to roll back: whatever is on disk now
        // belongs to that other writer, not to us, and overwriting or
        // deleting it would destroy their edit instead of repairing ours.
        // (Do not "fix" this back into a rollback — that was tried and is
        // exactly the bug this comment documents.)
        throw new Error(
          "Codex config was changed by another process during installation. The pre-installation config is in the backup.",
        );
      }
    } catch (error) {
      throw new CodexInstallError(
        error instanceof Error ? error.message : String(error),
        backupPath,
      );
    }
    return { ...planned, ...(backupPath ? { backupPath } : {}) };
  });
}

type InstallEdit = {
  action: CodexInstallAction;
  content: string;
  previousServerId?: string;
  previousUrl?: string;
};

function previewOf(
  input: CodexInstallInput,
  scope: CodexInstallScope,
  configPath: string,
  edit: InstallEdit,
  facts: Pick<
    CodexInstallPreview,
    "createsFile" | "createsDirectory" | "revision" | "snippet"
  >,
): CodexInstallPreview {
  return {
    scope,
    configPath,
    serverId: input.serverId,
    url: input.url,
    action: edit.action,
    ...(edit.previousServerId
      ? { previousServerId: edit.previousServerId }
      : {}),
    ...(edit.previousUrl !== undefined
      ? { previousUrl: edit.previousUrl }
      : {}),
    tokenForm: input.bearerTokenEnvVar?.trim() ? "env" : "literal",
    ...facts,
  };
}

/** A project file may be committed, so it never holds a literal token (ADR-0028 D6). */
function assertTokenFormAllowed(
  input: CodexInstallInput,
  scope: CodexInstallScope,
): void {
  if (scope === "project" && !input.bearerTokenEnvVar?.trim()) {
    throw new CodexInstallError(
      "A project's Codex config may be committed, so the installer writes only the environment variable form there.",
    );
  }
}

/** `.codex` in a project must be a real folder or absent (ADR-0028 D6). */
async function assertProjectCodexDir(codexDir: string): Promise<void> {
  try {
    const stat = await fsp.lstat(codexDir);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${codexDir} is a link, so the installer will not write through it. Copy the snippet instead.`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`${codexDir} is not a folder.`);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    if (!(await fsp.stat(dir)).isDirectory())
      throw new Error(`${dir} is not a folder.`);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function configRevision(raw: string | null): string {
  return createHash("sha256")
    .update(raw === null ? "missing\0" : `present\0${raw}`, "utf8")
    .digest("hex");
}

async function assertSafeConfigPath(configPath: string): Promise<void> {
  try {
    const stat = await fsp.lstat(configPath);
    if (stat.isSymbolicLink()) {
      throw new Error(
        "Codex config is a symbolic link, so the installer will not replace it. Copy the snippet instead.",
      );
    }
    if (!stat.isFile()) {
      throw new Error("Codex config path is not a regular file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// ---------------------------------------------------------------------------
// Ownership and migration (ADR-0028 D3, D4)
// ---------------------------------------------------------------------------

type EndpointShape =
  | { kind: "route"; routeId: string; port: string }
  | { kind: "direct"; port: string }
  | { kind: "other" };

/** Where an entry's URL points, read from its path, never from its port. */
function endpointShape(url: string | undefined): EndpointShape {
  if (url === undefined) return { kind: "other" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "other" };
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname.toLowerCase())
  )
    return { kind: "other" };
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const route = /^\/v1\/([^/]+)\/mcp$/.exec(parsed.pathname);
  if (route) return { kind: "route", routeId: route[1].toLowerCase(), port };
  if (parsed.pathname === "/mcp") return { kind: "direct", port };
  return { kind: "other" };
}

/** Every header under `[mcp_servers.<key>…]`, grouped by key. */
function serverEntries(headers: Header[]): Map<string, Header[]> {
  const entries = new Map<string, Header[]>();
  for (const header of headers) {
    if (header.parts[0] !== "mcp_servers" || header.parts.length < 2) continue;
    const key = header.parts[1];
    entries.set(key, [...(entries.get(key) ?? []), header]);
  }
  return entries;
}

function tableText(raw: string, headers: Header[], header: Header): string {
  return raw.slice(header.start, headers[headers.indexOf(header) + 1]?.start);
}

/** The entry's one root table, or a refusal when it has none or several. */
function singleRoot(serverId: string, owned: Header[]): Header {
  const roots = owned.filter(
    (header) => header.parts.length === 2 && !header.array,
  );
  if (owned.some((header) => header.array) || roots.length !== 1) {
    throw new Error(
      `Codex config contains an ambiguous entry for '${serverId}'. Copy the snippet and edit the file manually.`,
    );
  }
  return roots[0];
}

/** The `url` the entry's root table sets, comments skipped. */
function entryUrl(
  raw: string,
  headers: Header[],
  owned: Header[],
): string | undefined {
  const root = owned.find(
    (header) => header.parts.length === 2 && !header.array,
  );
  if (!root) return undefined;
  return /^[ \t]*url[ \t]*=[ \t]*(["'])(.*?)\1/m.exec(
    tableText(raw, headers, root),
  )?.[2];
}

/** The static bearer of the entry, inline or in its `http_headers` table. */
function entryBearer(
  raw: string,
  headers: Header[],
  owned: Header[],
): string | undefined {
  const text = owned
    .filter(
      (header) =>
        header.parts.length === 2 ||
        (header.parts.length === 3 && header.parts[2] === "http_headers"),
    )
    .map((header) => tableText(raw, headers, header))
    .join("\n")
    .split(/\r?\n/)
    .filter((line) => !/^[ \t]*#/.test(line))
    .join("\n");
  return /\bAuthorization["']?[ \t]*=[ \t]*(["'])Bearer[ \t]+(.*?)\1/.exec(
    text,
  )?.[2];
}

/**
 * Refuse an existing plain-key entry that is not this vault's (ADR-0028
 * D3): a route URL counts as this vault's only for the saved route, a
 * direct `/mcp` URL only when it equals the URL being installed or sends
 * the row token, and anything else cannot be attributed.
 */
function assertOwnEntry(
  raw: string,
  headers: Header[],
  owned: Header[],
  input: CodexInstallInput,
  configPath: string,
): string | undefined {
  const url = entryUrl(raw, headers, owned);
  const shape = endpointShape(url);
  if (shape.kind === "route") {
    if (input.routeId !== null && shape.routeId === input.routeId.toLowerCase())
      return url;
    throw new Error(
      `${configPath} already has an entry '${input.serverId}' that belongs to another vault. Rename that entry or one of the vaults, then install again.`,
    );
  }
  if (shape.kind === "direct") {
    const bearer = entryBearer(raw, headers, owned);
    if (
      url === input.url ||
      (input.accessToken !== "" && bearer === input.accessToken)
    )
      return url;
  }
  throw new Error(
    `${configPath} already has an entry '${input.serverId}' that the installer cannot attribute to this vault. Rename or remove it, or copy the snippet instead.`,
  );
}

/**
 * An earlier entry of this vault under another key (ADR-0028 D4): a key
 * ending in `_<route-hex>`, which covers ADR-0021's `obsidian_<route-hex>`
 * and the 2.11 name, or a URL that carries this vault's route on the port
 * being installed. A route URL under another key on another port, such as
 * the old broker port 27206, is left alone.
 */
function isEarlierEntry(
  key: string,
  url: string | undefined,
  input: CodexInstallInput,
): boolean {
  if (key === input.serverId || input.routeId === null) return false;
  const routeId = input.routeId.toLowerCase();
  if (key.toLowerCase().endsWith(`_${routeId.replace(/-/g, "")}`)) return true;
  const shape = endpointShape(url);
  const installed = endpointShape(input.url);
  return (
    shape.kind === "route" &&
    shape.routeId === routeId &&
    installed.kind !== "other" &&
    shape.port === installed.port
  );
}

function refuseSeveral(keys: string[]): never {
  const named = keys.map((key) => `'${key}'`);
  throw new Error(
    keys.length === 2
      ? `Codex config contains both ${named[0]} and ${named[1]} for this vault. Keep one entry and transfer any policy settings manually before installing again.`
      : `Codex config contains the entries ${named.join(", ")} for this vault. Keep one entry and transfer any policy settings manually before installing again.`,
  );
}

/** Decide ownership, then add, replace or migrate this vault's entry. */
function planInstall(
  raw: string,
  input: CodexInstallInput,
  snippet: string,
  configPath: string,
): InstallEdit {
  const serverId = input.serverId;
  const { headers } = scanTomlStructure(raw);
  const entries = serverEntries(headers);
  const earlier = [...entries.entries()]
    .filter(([key, owned]) =>
      isEarlierEntry(key, entryUrl(raw, headers, owned), input),
    )
    .map(([key]) => key);

  const owned = entries.get(serverId);
  if (owned) {
    singleRoot(serverId, owned);
    const previousUrl = assertOwnEntry(raw, headers, owned, input, configPath);
    if (earlier.length > 0) refuseSeveral([...earlier, serverId]);
    return {
      ...planEntryEdit(raw, serverId, snippet),
      ...(previousUrl !== undefined ? { previousUrl } : {}),
    };
  }
  if (earlier.length > 1) refuseSeveral(earlier);
  if (earlier.length === 0) return planEntryEdit(raw, serverId, snippet);

  const previousServerId = earlier[0];
  const legacy = entries.get(previousServerId) ?? [];
  singleRoot(previousServerId, legacy);
  const previousUrl = entryUrl(raw, headers, legacy);
  // Rename only the server ID token of each header. Other key spellings
  // and all values stay intact, including quoted nested keys and
  // multiline values; the replace below then swaps the transport keys.
  let renamed = raw;
  for (const header of [...legacy].reverse()) {
    const range = header.keyRanges[1];
    renamed =
      renamed.slice(0, range.start) + serverId + renamed.slice(range.end);
  }
  return {
    action: "migrate",
    content: planEntryEdit(renamed, serverId, snippet).content,
    previousServerId,
    ...(previousUrl !== undefined ? { previousUrl } : {}),
  };
}

// ---------------------------------------------------------------------------
// TOML scanner and replace planner, as before 4a40dc6
// ---------------------------------------------------------------------------

type Header = {
  start: number;
  keyRanges: { start: number; end: number }[];
  parts: string[];
  array: boolean;
};
type MultilineStringRange = { start: number; end: number };

function parseDottedKey(
  value: string,
  ranges?: { start: number; end: number }[],
): string[] | null {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/\s/.test(value[cursor] ?? "")) cursor += 1;
    if (cursor >= value.length) return null;
    const partStart = cursor;
    const quote =
      value[cursor] === '"' || value[cursor] === "'" ? value[cursor++] : null;
    let part = "";
    if (quote) {
      while (cursor < value.length && value[cursor] !== quote) {
        if (quote === '"' && value[cursor] === "\\") return null;
        part += value[cursor++];
      }
      if (value[cursor++] !== quote) return null;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(value.slice(cursor));
      if (!match) return null;
      part = match[0];
      cursor += part.length;
    }
    parts.push(part);
    ranges?.push({ start: partStart, end: cursor });
    while (/\s/.test(value[cursor] ?? "")) cursor += 1;
    if (cursor === value.length) return parts;
    if (value[cursor++] !== ".") return null;
  }
  return parts;
}

function findClosingDelimiter(
  text: string,
  delimiter: "'''" | '"""',
  start: number,
): number {
  let cursor = start;
  while (cursor < text.length) {
    const found = text.indexOf(delimiter, cursor);
    if (found === -1) return -1;
    if (delimiter === "'''") return found;
    let backslashes = 0;
    for (let index = found - 1; index >= 0 && text[index] === "\\"; index -= 1)
      backslashes += 1;
    if (backslashes % 2 === 0) return found;
    cursor = found + delimiter.length;
  }
  return -1;
}

function findMultilineStart(
  text: string,
): { delimiter: "'''" | '"""'; start: number; end: number } | null {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "#") return null;
    const delimiter = text.slice(index, index + 3);
    if (delimiter === "'''" || delimiter === '"""') {
      return {
        delimiter,
        start: index,
        end: findClosingDelimiter(text, delimiter, index + 3),
      };
    }
    if (character === "'" || character === '"') quote = character;
  }
  return null;
}

/**
 * Net change in unclosed `[`/`]` depth contributed by one line, skipping
 * bracket characters inside quoted strings (single-line quotes only — a
 * multiline string is tracked separately) and anything after a `#` comment
 * outside a string.
 */
function bracketDelta(text: string): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "#") break;
    if (character === "[") depth += 1;
    else if (character === "]") depth -= 1;
    else if (character === "'" || character === '"') quote = character;
  }
  return depth;
}

function scanTomlStructure(raw: string): {
  headers: Header[];
  multilineStrings: MultilineStringRange[];
} {
  const headers: Header[] = [];
  const multilineStrings: MultilineStringRange[] = [];
  const lines = [...raw.matchAll(/^.*(?:\r?\n|$)/gm)].filter(
    (match) => match[0].length > 0,
  );
  let multiline: { delimiter: "'''" | '"""'; start: number } | null = null;
  // Depth of unclosed `[` from a multi-line array value (e.g. `matrix = [`
  // continued over several lines). While positive, a line starting with `[`
  // is an array element, not a table header.
  let arrayDepth = 0;
  for (const line of lines) {
    const rawLine = line[0].replace(/\r?\n$/, "");
    if (multiline) {
      const end = findClosingDelimiter(rawLine, multiline.delimiter, 0);
      if (end !== -1) {
        multilineStrings.push({
          start: multiline.start,
          end: line.index + end + multiline.delimiter.length,
        });
        multiline = null;
      }
      continue;
    }
    const textOffset = line.index === 0 && rawLine.startsWith("\uFEFF") ? 1 : 0;
    const text = rawLine.slice(textOffset);
    if (arrayDepth > 0) {
      arrayDepth = Math.max(0, arrayDepth + bracketDelta(text));
      continue;
    }
    if (/^\s*\[/.test(text)) {
      const match = /^\s*(\[\[|\[)([^\]\r\n]+)(\]\]|\])\s*(?:#.*)?$/.exec(text);
      if (match && (match[1] === "[[") === (match[3] === "]]")) {
        const ranges: { start: number; end: number }[] = [];
        const parts = parseDottedKey(match[2], ranges);
        if (parts) {
          const keyStart = line.index + textOffset + match[0].indexOf(match[2]);
          headers.push({
            start: line.index,
            keyRanges: ranges.map((range) => ({
              start: keyStart + range.start,
              end: keyStart + range.end,
            })),
            parts,
            array: match[1] === "[[",
          });
          continue;
        }
      }
      // An unrecognized table must not become part of the preceding owned table
      throw new Error(
        "Client configuration contains an unsupported table header. Copy the snippet instead",
      );
    }
    const opening = findMultilineStart(text);
    const currentTable = headers[headers.length - 1]?.parts;
    // Assignments directly under [mcp_servers] define inline or dotted entries.
    // Refuse them before adding a named entry that would omit their policy.
    if (
      (headers.length === 0 &&
        /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*[.=]/.test(text)) ||
      (currentTable?.length === 1 &&
        currentTable[0] === "mcp_servers" &&
        text.trim() !== "" &&
        !text.trimStart().startsWith("#"))
    ) {
      throw new Error(
        "Client configuration uses inline or dotted server tables. Copy the snippet instead",
      );
    }
    if (!opening) {
      arrayDepth = Math.max(0, arrayDepth + bracketDelta(text));
      continue;
    }
    const start = line.index + textOffset + opening.start;
    if (opening.end === -1) {
      multiline = { delimiter: opening.delimiter, start };
    } else {
      multilineStrings.push({
        start,
        end: line.index + textOffset + opening.end + opening.delimiter.length,
      });
    }
  }
  if (multiline) {
    throw new Error(
      "Codex config contains an unterminated multiline string. Copy the snippet instead.",
    );
  }
  if (arrayDepth > 0) {
    throw new Error(
      "Codex config contains an unterminated array literal. Copy the snippet instead.",
    );
  }
  return { headers, multilineStrings };
}

/** The bare key a `key = value` line sets, or "" when it is not one. */
function rootKeyOf(line: string): string {
  return /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1] ?? "";
}

function planEntryEdit(
  raw: string,
  serverId: string,
  snippet: string,
): { action: "add" | "replace" | "unchanged"; content: string } {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const normalizedSnippet = snippet.replace(/\n/g, newline);
  const { headers, multilineStrings } = scanTomlStructure(raw);
  const owned = headers.filter(
    (header) =>
      header.parts[0] === "mcp_servers" && header.parts[1] === serverId,
  );
  const roots = owned.filter(
    (header) => header.parts.length === 2 && !header.array,
  );
  const transportTables = new Set(["env", "http_headers", "env_http_headers"]);
  const unrecognizedNested = owned.filter(
    (header) =>
      header.parts.length > 2 &&
      header.parts[2] !== "tools" &&
      header.parts[2] !== "oauth" &&
      !(header.parts.length === 3 && transportTables.has(header.parts[2])),
  );
  if (
    owned.some((header) => header.array) ||
    roots.length > 1 ||
    (owned.length > 0 && roots.length !== 1) ||
    unrecognizedNested.length > 0
  ) {
    throw new Error(
      `Codex config contains an ambiguous entry for '${serverId}'. Copy the snippet and edit the file manually.`,
    );
  }

  if (owned.length === 0) {
    const separator =
      raw.length === 0
        ? ""
        : raw.endsWith(newline)
          ? newline
          : `${newline}${newline}`;
    return {
      action: "add",
      content: `${raw}${separator}${normalizedSnippet}${newline}${newline}`,
    };
  }

  const replaced = owned.filter(
    (header) =>
      header.parts.length === 2 ||
      (header.parts.length === 3 && transportTables.has(header.parts[2])),
  );
  const ranges = replaced.map((header) => {
    const index = headers.indexOf(header);
    return {
      start: header.start,
      end: headers[index + 1]?.start ?? raw.length,
    };
  });
  if (
    multilineStrings.some((string) =>
      ranges.some(
        (range) => string.start < range.end && string.end > range.start,
      ),
    )
  ) {
    throw new Error(
      `Codex config contains a multiline string in '${serverId}', so the installer cannot replace that entry safely. Copy the snippet instead.`,
    );
  }
  const root = roots[0];
  const rootEnd = headers[headers.indexOf(root) + 1]?.start ?? raw.length;
  const { preserved, comments } = splitRootBody(raw.slice(root.start, rootEnd));
  const snippetLines = snippet.split("\n");
  const snippetKeys = new Set(
    snippetLines
      .slice(1)
      .map(rootKeyOf)
      .filter((key) => key !== ""),
  );
  // ADR-0028 D4: an existing startup_timeout_sec is the user's policy and
  // stays, in the place the snippet would put its own value
  const keptTimeout = preserved.filter(
    (segment) => rootKeyOf(segment[0]) === "startup_timeout_sec",
  );
  let content = "";
  let cursor = 0;
  let inserted = false;
  for (const range of ranges) {
    content += raw.slice(cursor, range.start);
    if (!inserted) {
      if (range.start === 0 && raw.startsWith("\uFEFF")) content += "\uFEFF";
      for (const line of snippetLines) {
        const lines =
          rootKeyOf(line) === "startup_timeout_sec" && keptTimeout.length > 0
            ? keptTimeout.flat()
            : [line];
        for (const kept of lines) content += `${kept}${newline}`;
      }
      for (const line of comments) content += `${line}${newline}`;
      for (const segment of preserved) {
        // A key the new snippet states explicitly wins over the old value.
        if (snippetKeys.has(rootKeyOf(segment[0]))) continue;
        for (const line of segment) content += `${line}${newline}`;
      }
      content += newline;
      inserted = true;
    }
    // The root table's own comments and preserved keys were already
    // re-emitted above from splitRootBody; re-running standaloneComments
    // over its own range here would duplicate them.
    if (range.start !== root.start)
      content += standaloneComments(raw.slice(range.start, range.end));
    cursor = range.end;
  }
  content += raw.slice(cursor);
  return {
    action: content === raw ? "unchanged" : "replace",
    content,
  };
}

// Emitted by the generated snippet, so any existing value is overwritten.
const SNIPPET_KEYS = new Set(["url", "http_headers", "enabled", "required"]);
// Belong to the transport being replaced. Codex's RawMcpServerConfig
// (codex-rs/config/src/mcp_types.rs, TryFrom) rejects the stdio ones next
// to a `url`; `command` would flip the entry back to stdio; the three
// header sources would compete with the static `http_headers` the snippet
// writes. None can be carried over into the new HTTP entry.
const DISCARDED_KEYS = new Set([
  "command",
  "args",
  "env",
  "env_vars",
  "cwd",
  "env_http_headers",
  "bearer_token_env_var",
  "http_headers_helper",
]);
// Policy/identity the user configured: carried through the replace verbatim.
// Verified live against openai/codex main (commit 0a2a64e, 2026-10-07,
// codex-rs/config/src/mcp_types.rs, RawMcpServerConfig; checked
// 2026-10-07) — re-check that source if Codex's accepted keys are
// suspected to have drifted. `oauth` and `tools` are sub-tables, handled
// by the table walker, not here.
// `bearer_token` is deliberately excluded from every set: Codex itself
// always rejects it, so leaving it out correctly forces "copy the snippet"
// for a config that has it, which is the safe outcome.
const PRESERVED_KEYS = new Set([
  "environment_id",
  "auth",
  "startup_timeout_sec",
  "startup_timeout_ms",
  "startup_readiness",
  "tool_timeout_sec",
  "tool_input_schema_max_bytes",
  "supports_parallel_tool_calls",
  "omit_tools_from",
  "default_tools_approval_mode",
  "enabled_tools",
  "disabled_tools",
  "scopes",
  "oauth_resource",
  "name",
]);

/**
 * Split a `[mcp_servers.<id>]` root table's raw slice (header line included)
 * into standalone comment lines and the policy key/value segments to carry
 * through a replace verbatim, refusing on any key this installer does not
 * recognize. Assumes the caller has already refused any multiline string
 * overlapping this range, so a value can only span multiple lines via an
 * array literal, tracked here with `bracketDelta`.
 */
function splitRootBody(table: string): {
  preserved: string[][];
  comments: string[];
} {
  const lines = [...table.matchAll(/^.*(?:\r?\n|$)/gm)]
    .filter((match) => match[0].length > 0)
    .map((match) => match[0].replace(/\r?\n$/, ""))
    .slice(1); // drop the table header line (and any BOM riding on it)
  const preserved: string[][] = [];
  const comments: string[] = [];
  let pending: { keep: boolean; lines: string[] } | null = null;
  let depth = 0;
  const refuse = (): never => {
    throw new Error(
      "Client entry contains additional settings that the installer will not discard. Copy the snippet instead",
    );
  };
  const closeIfDone = () => {
    if (!pending) return;
    if (depth <= 0) {
      if (pending.keep) preserved.push(pending.lines);
      pending = null;
      depth = 0;
    }
  };
  for (const line of lines) {
    if (pending) {
      pending.lines.push(line);
      depth += bracketDelta(line);
      closeIfDone();
      continue;
    }
    if (/^[ \t]*$/.test(line)) continue;
    if (/^[ \t]*#/.test(line)) {
      comments.push(line);
      continue;
    }
    const match = /^\s*([^#\r\n=]+)=/.exec(line);
    const key = match ? parseDottedKey(match[1].trim()) : null;
    if (!key || key.length !== 1) return refuse();
    const name = key[0];
    if (
      !SNIPPET_KEYS.has(name) &&
      !DISCARDED_KEYS.has(name) &&
      !PRESERVED_KEYS.has(name)
    )
      refuse();
    pending = { keep: PRESERVED_KEYS.has(name), lines: [line] };
    depth = bracketDelta(line);
    closeIfDone();
  }
  if (pending) refuse(); // unterminated array value inside the owned entry
  return { preserved, comments };
}

function standaloneComments(table: string): string {
  return [...table.matchAll(/^[ \t]*#[^\r\n]*(?:\r?\n|$)/gm)]
    .map((match) => match[0])
    .join("");
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function backupConfig(
  configPath: string,
  content: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.backup-${stamp}-${randomUUID().slice(0, 8)}`;
  await fsp.writeFile(backupPath, content, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return backupPath;
}

async function writeAtomic(
  configPath: string,
  content: string,
  previous: string | null,
): Promise<void> {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const mode = previous === null ? 0o600 : (await fsp.stat(configPath)).mode;
    await fsp.writeFile(tempPath, content, { encoding: "utf8", mode });
    await fsp.rename(tempPath, configPath);
  } finally {
    await fsp.rm(tempPath, { force: true });
  }
}

/** The caller creates the folder first, after its own safety checks. */
async function withConfigLock<T>(
  configPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configPath}.obsidian-mcp.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const lockId = randomUUID();
  const lockContent = JSON.stringify({
    version: 1,
    lockId,
    createdAt: new Date().toISOString(),
  });
  let handle: fsp.FileHandle | undefined;
  while (!handle) {
    try {
      const candidate = await fsp.open(lockPath, "wx", 0o600);
      try {
        await candidate.writeFile(lockContent, "utf8");
        handle = candidate;
      } catch (error) {
        await candidate.close();
        await fsp.rm(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeStaleConfigLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to update ${configPath}.`);
      }
      await new Promise((resolve) => window.setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    try {
      if ((await fsp.readFile(lockPath, "utf8")) === lockContent) {
        await fsp.rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("Failed to remove config lock", { error: String(error) });
      }
    }
  }
}

async function removeStaleConfigLock(lockPath: string): Promise<boolean> {
  let observed: string;
  let modifiedAt: number;
  try {
    observed = await fsp.readFile(lockPath, "utf8");
    modifiedAt = (await fsp.stat(lockPath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (Date.now() - modifiedAt < LOCK_STALE_MS) return false;
  try {
    if ((await fsp.readFile(lockPath, "utf8")) !== observed) return false;
    await fsp.rm(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
