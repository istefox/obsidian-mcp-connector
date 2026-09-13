import { createHash, randomUUID } from "crypto";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { logger } from "$/shared/logger";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 30_000;

export type CodexConnection = {
  vaultName: string;
  routeId: string;
  accessToken: string;
  brokerPort: number;
  serverId?: string;
};

export type CodexConfigLocation =
  | { located: true; configPath: string; source: "CODEX_HOME" | "default" }
  | { located: false; reason: string };

export type CodexInstallPreview = {
  configPath: string;
  serverId: string;
  action: "add" | "replace" | "unchanged";
  snippet: string;
  revision: string;
};

export type CodexInstallResult = CodexInstallPreview & {
  backupPath?: string;
};

/** Thrown by installCodexConfig; carries the backup path even when rollback was skipped. */
export class CodexInstallError extends Error {
  constructor(
    message: string,
    readonly backupPath?: string,
  ) {
    super(message);
  }
}

export function codexServerId(vaultName: string, routeId?: string): string {
  if (routeId) return `obsidian_${routeId.replace(/-/g, "")}`;
  const suffix = vaultName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (suffix.length === 0) {
    throw new Error(
      "The vault name must contain at least one letter or number.",
    );
  }
  return `obsidian_${suffix}`;
}

export function codexConfigSnippet(input: CodexConnection): string {
  const serverId = connectionServerId(input);
  const url = `http://127.0.0.1:${input.brokerPort}/v1/${input.routeId}/mcp`;
  return [
    `[mcp_servers.${serverId}]`,
    `url = ${tomlString(url)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${input.accessToken}`)} }`,
    "enabled = true",
    "required = false",
  ].join("\n");
}

function connectionServerId(input: CodexConnection): string {
  const id = input.serverId ?? codexServerId(input.vaultName, input.routeId);
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("Invalid connection entry identity");
  return id;
}

/** Locate only the user-level Codex config. Project configs are intentionally out of scope. */
export async function locateCodexConfig(opts?: {
  codexHome?: string;
  homeDir?: string;
}): Promise<CodexConfigLocation> {
  const configuredHome = opts?.codexHome ?? process.env.CODEX_HOME;
  if (configuredHome && configuredHome.trim().length > 0) {
    return {
      located: true,
      configPath: path.join(path.resolve(configuredHome), "config.toml"),
      source: "CODEX_HOME",
    };
  }

  const defaultHome = path.join(opts?.homeDir ?? os.homedir(), ".codex");
  try {
    const stat = await fsp.stat(defaultHome);
    if (stat.isDirectory()) {
      return {
        located: true,
        configPath: path.join(defaultHome, "config.toml"),
        source: "default",
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    located: false,
    reason:
      "Codex config was not found through CODEX_HOME or the default ~/.codex directory.",
  };
}

export async function inspectCodexInstall(
  input: CodexConnection,
  opts?: { configPath?: string },
): Promise<CodexInstallPreview> {
  const configPath = await resolveConfigPath(opts?.configPath);
  await assertSafeConfigPath(configPath);
  const previous = await readOptional(configPath);
  const raw = previous ?? "";
  const snippet = codexConfigSnippet(input);
  const edit = planEntryEdit(raw, connectionServerId(input), snippet);
  return {
    configPath,
    serverId: connectionServerId(input),
    action: edit.action,
    snippet,
    revision: configRevision(previous),
  };
}

/** Perform the explicit, one-time install after the UI has shown a preview. */
export async function installCodexConfig(
  input: CodexConnection,
  opts?: {
    configPath?: string;
    expectedRevision?: string;
    /** Test-only seam: invoked right after the atomic rename, before the
     * verification read, so a concurrent-write race can be reproduced
     * deterministically. Never set from production code. */
    afterWrite?: () => Promise<void>;
  },
): Promise<CodexInstallResult> {
  const configPath = await resolveConfigPath(opts?.configPath);
  const serverId = connectionServerId(input);
  const snippet = codexConfigSnippet(input);

  return withConfigLock(configPath, async () => {
    await assertSafeConfigPath(configPath);
    const previous = await readOptional(configPath);
    const revision = configRevision(previous);
    if (
      opts?.expectedRevision !== undefined &&
      opts.expectedRevision !== revision
    ) {
      throw new Error(
        "Codex config changed after the preview. Review the installer action again.",
      );
    }
    const edit = planEntryEdit(previous ?? "", serverId, snippet);
    if (edit.action === "unchanged") {
      return {
        configPath,
        serverId,
        action: edit.action,
        snippet,
        revision,
      };
    }

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
      await opts?.afterWrite?.();
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
    return {
      configPath,
      serverId,
      action: edit.action,
      snippet,
      revision,
      backupPath,
    };
  });
}

async function resolveConfigPath(explicit?: string): Promise<string> {
  if (explicit) return path.resolve(explicit);
  const location = await locateCodexConfig();
  if (!location.located) throw new Error(location.reason);
  return location.configPath;
}

function tomlString(value: string): string {
  return JSON.stringify(value)
    .replace(/\\u2028/g, "\\u2028")
    .replace(/\\u2029/g, "\\u2029");
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

type Header = { start: number; parts: string[]; array: boolean };
type MultilineStringRange = { start: number; end: number };

function parseDottedKey(value: string): string[] | null {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/\s/.test(value[cursor] ?? "")) cursor += 1;
    if (cursor >= value.length) return null;
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
 * bracket characters inside quoted strings (single-line quotes only \u2014 a
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
        const parts = parseDottedKey(match[2]);
        if (parts) {
          headers.push({
            start: line.index,
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
    if (
      headers.length === 0 &&
      /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*[.=]/.test(text)
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

function planEntryEdit(
  raw: string,
  serverId: string,
  snippet: string,
): { action: CodexInstallPreview["action"]; content: string } {
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
  let content = "";
  let cursor = 0;
  let inserted = false;
  for (const range of ranges) {
    content += raw.slice(cursor, range.start);
    if (!inserted) {
      if (range.start === 0 && raw.startsWith("\uFEFF")) content += "\uFEFF";
      content += `${normalizedSnippet}${newline}`;
      for (const line of comments) content += `${line}${newline}`;
      for (const segment of preserved)
        for (const line of segment) content += `${line}${newline}`;
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
// (codex-rs/config/src/mcp_types.rs, TryFrom) rejects several of these next
// to a `url`, so they cannot be carried over into the new HTTP entry.
const DISCARDED_KEYS = new Set([
  "command",
  "args",
  "env",
  "cwd",
  "env_http_headers",
  "bearer_token_env_var",
]);
// Policy/identity the user configured: carried through the replace verbatim.
// Verified live against openai/codex main (commit 1715e55..., 2026-09-13,
// codex-rs/config/src/mcp_types.rs, RawMcpServerConfig) \u2014 re-check that
// source if Codex's accepted keys are suspected to have drifted.
// `bearer_token` is deliberately excluded from every set: Codex itself
// always rejects it, so leaving it out correctly forces "copy the snippet"
// for a config that has it, which is the safe outcome.
const PRESERVED_KEYS = new Set([
  "environment_id",
  "auth",
  "startup_timeout_sec",
  "startup_timeout_ms",
  "tool_timeout_sec",
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

async function withConfigLock<T>(
  configPath: string,
  action: () => Promise<T>,
): Promise<T> {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
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
