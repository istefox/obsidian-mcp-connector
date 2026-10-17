/**
 * The vault's Obsidian settings the headless server honours, read once at
 * startup from `.obsidian/`. The vault tools never touch dot-folders, so
 * this is the server's own read: it follows no symlink on the way to a
 * file, caps the size it reads, and treats a missing file, and any file it
 * will not use, as "Obsidian defaults". A file that is there and will not
 * be used is reported through `warn`, naming the file and why, because
 * silently ignoring a setting such as "Excluded files" would serve notes
 * the user meant to hide. Nothing watches the folder, so a changed setting
 * needs a restart.
 */

import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_DIR = ".obsidian";
const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Read `.obsidian/<rel>` as JSON. Undefined when the file is absent
 * (silently), and when it will not be used: it or a folder above it is a
 * symlink, it is not a regular file, it is larger than 1 MB, it cannot be
 * read, or it is not valid JSON. Those say why once through `warn`.
 */
export async function readConfigJson(
  root: string,
  rel: string,
  warn: (message: string) => void,
): Promise<unknown> {
  const parts = [CONFIG_DIR, ...rel.split("/")];
  const file = path.join(root, ...parts);
  const ignore = (reason: string): undefined => {
    warn(`Ignoring ${CONFIG_DIR}/${rel}: ${reason}`);
    return undefined;
  };
  try {
    // Every component below the vault root, so a symlinked folder in the
    // middle (`.obsidian/plugins` pointing outside) is refused too.
    for (let i = 1; i <= parts.length; i++) {
      const stat = await fs.lstat(path.join(root, ...parts.slice(0, i)));
      if (stat.isSymbolicLink()) {
        const where =
          i === parts.length
            ? "it is a symlink"
            : `${parts.slice(0, i).join("/")} is a symlink`;
        return ignore(`${where}, which is not followed`);
      }
    }
    const stat = await fs.stat(file);
    if (!stat.isFile()) return ignore("it is not a regular file");
    if (stat.size > MAX_CONFIG_BYTES) return ignore("it is larger than 1 MB");
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (err) {
    if (err instanceof SyntaxError) return ignore("it is not valid JSON");
    const code = (err as NodeJS.ErrnoException).code;
    // Absent, or below a path that is not a folder: the vault has no such setting.
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return ignore(
      `it cannot be read (${code ?? (err instanceof Error ? err.message : String(err))})`,
    );
  }
}

export type VaultSettings = {
  /** `Files & Links` -> `Excluded files`: path prefixes and `/regex/` entries. */
  userIgnoreFilters: string[];
};

/** Obsidian's defaults, used for every setting the file does not give. */
export const DEFAULT_VAULT_SETTINGS: VaultSettings = { userIgnoreFilters: [] };

/** Pick the known settings out of a parsed `app.json`, ignoring bad values. */
export function parseAppSettings(json: unknown): VaultSettings {
  const raw =
    typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>).userIgnoreFilters
      : undefined;
  return {
    userIgnoreFilters: Array.isArray(raw)
      ? raw.filter((f): f is string => typeof f === "string")
      : [],
  };
}

export async function loadVaultSettings(
  root: string,
  warn: (message: string) => void,
): Promise<VaultSettings> {
  return parseAppSettings(
    await readConfigJson(root, "app.json", (message) =>
      warn(
        `${message}. "Excluded files" is not applied, so those notes are served.`,
      ),
    ),
  );
}

/**
 * The "Excluded files" test. An entry wrapped in slashes (`/\.png$/`) is a
 * regular expression tested against the vault-relative path, any other
 * entry is a path prefix. An invalid expression, an empty entry and an
 * empty expression (`//`) match nothing.
 */
export function createIgnoreMatcher(
  filters: readonly string[],
): (path: string) => boolean {
  const prefixes: string[] = [];
  const patterns: RegExp[] = [];
  for (const filter of filters) {
    if (filter === "") continue;
    if (filter.length > 2 && filter.startsWith("/") && filter.endsWith("/")) {
      try {
        patterns.push(new RegExp(filter.slice(1, -1)));
      } catch {
        // An invalid expression excludes nothing.
      }
    } else if (filter !== "//") {
      prefixes.push(filter);
    }
  }
  if (prefixes.length === 0 && patterns.length === 0) return () => false;
  return (p) =>
    prefixes.some((prefix) => p.startsWith(prefix)) ||
    patterns.some((re) => re.test(p));
}
