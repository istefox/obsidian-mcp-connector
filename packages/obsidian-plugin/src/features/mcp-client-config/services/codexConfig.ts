import { createHash, randomUUID } from "crypto";
import fsp from "fs/promises";
import os from "os";
import path from "path";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 30_000;

export type CodexConnection = {
  vaultName: string;
  routeId: string;
  accessToken: string;
  brokerPort: number;
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

export function codexServerId(vaultName: string): string {
  const suffix = vaultName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (suffix.length === 0) {
    throw new Error(
      "The vault name must contain at least one letter or number.",
    );
  }
  return `obsidian_${suffix}`;
}

export function codexConfigSnippet(input: CodexConnection): string {
  const serverId = codexServerId(input.vaultName);
  const url = `http://127.0.0.1:${input.brokerPort}/v1/${input.routeId}/mcp`;
  return [
    `[mcp_servers.${serverId}]`,
    `url = ${tomlString(url)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${input.accessToken}`)} }`,
    "enabled = true",
    "required = false",
  ].join("\n");
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
  const edit = planEntryEdit(raw, codexServerId(input.vaultName), snippet);
  return {
    configPath,
    serverId: codexServerId(input.vaultName),
    action: edit.action,
    snippet,
    revision: configRevision(previous),
  };
}

/** Perform the explicit, one-time install after the UI has shown a preview. */
export async function installCodexConfig(
  input: CodexConnection,
  opts?: { configPath?: string; expectedRevision?: string },
): Promise<CodexInstallResult> {
  const configPath = await resolveConfigPath(opts?.configPath);
  const serverId = codexServerId(input.vaultName);
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
    try {
      await writeAtomic(configPath, edit.content, previous);
      const written = await fsp.readFile(configPath, "utf8");
      const verified = planEntryEdit(written, serverId, snippet);
      if (verified.action !== "unchanged") {
        throw new Error("the installed MCP entry did not verify");
      }
    } catch (error) {
      if (previous === null) await fsp.rm(configPath, { force: true });
      else await writeAtomic(configPath, previous, previous);
      throw error;
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
  delimiter: "'''" | '\"\"\"',
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
): { delimiter: "'''" | '\"\"\"'; start: number; end: number } | null {
  let quote: "'" | '\"' | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '\"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '\"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "#") return null;
    const delimiter = text.slice(index, index + 3);
    if (delimiter === "'''" || delimiter === '\"\"\"') {
      return {
        delimiter,
        start: index,
        end: findClosingDelimiter(text, delimiter, index + 3),
      };
    }
    if (character === "'" || character === '\"') quote = character;
  }
  return null;
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
  let multiline: { delimiter: "'''" | '\"\"\"'; start: number } | null = null;
  for (const line of lines) {
    const rawLine = line[0].replace(/\r?\n$/, "");
    if (multiline) {
      const end = findClosingDelimiter(rawLine, multiline.delimiter, 0);
      if (end !== -1) {
        multilineStrings.push({
          start: multiline.start,
          end: line.index! + end + multiline.delimiter.length,
        });
        multiline = null;
      }
      continue;
    }
    const textOffset = line.index === 0 && rawLine.startsWith("\uFEFF") ? 1 : 0;
    const text = rawLine.slice(textOffset);
    if (/^\s*\[/.test(text)) {
      const match = /^\s*(\[\[|\[)([^\]\r\n]+)(\]\]|\])\s*(?:#.*)?$/.exec(text);
      if (match && (match[1] === "[[") === (match[3] === "]]")) {
        const parts = parseDottedKey(match[2]);
        if (parts) {
          headers.push({
            start: line.index!,
            parts,
            array: match[1] === "[[",
          });
          continue;
        }
      }
    }
    const opening = findMultilineStart(text);
    if (!opening) continue;
    const start = line.index! + textOffset + opening.start;
    if (opening.end === -1) {
      multiline = { delimiter: opening.delimiter, start };
    } else {
      multilineStrings.push({
        start,
        end: line.index! + textOffset + opening.end + opening.delimiter.length,
      });
    }
  }
  if (multiline) {
    throw new Error(
      "Codex config contains an unterminated multiline string. Copy the snippet instead.",
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
  let content = "";
  let cursor = 0;
  let inserted = false;
  for (const range of ranges) {
    content += raw.slice(cursor, range.start);
    if (!inserted) {
      if (range.start === 0 && raw.startsWith("\uFEFF")) content += "\uFEFF";
      content += `${normalizedSnippet}${newline}${newline}`;
      inserted = true;
    }
    content += standaloneComments(raw.slice(range.start, range.end));
    cursor = range.end;
  }
  content += raw.slice(cursor);
  return {
    action: content === raw ? "unchanged" : "replace",
    content,
  };
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
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
