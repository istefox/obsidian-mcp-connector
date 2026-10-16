/**
 * Path confinement for the headless vault.
 *
 * Every vault path that reaches the disk goes through `VaultFs`. The
 * lexical rules (no `..`, no absolute paths, no NUL, no hidden segments)
 * reject a hostile path before any fs call. Symlinks below the root are
 * not part of the vault: a path through one, in any segment, is refused,
 * so every path served is the lexical path joined on the root. The root
 * itself may be a symlink; it is resolved once when the vault opens, and
 * only segments below it count, so a vault in `~/.vaults/x` is served.
 *
 * Known limit: the check and the later fs call are two steps, so a local
 * user who can already write into the vault and swaps a directory for a
 * symlink between them could win the race. The server binds loopback and
 * serves one user's vault, so that attacker is already inside the trust
 * boundary.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Thrown for a path the vault refuses. `reason` follows the Node errno
 * style, but is not a `code`: the message explains the refusal, and an error
 * with a `code` would lose it behind a generic phrase (see domainError.ts).
 */
export class VaultPathError extends Error {
  constructor(
    message: string,
    readonly reason: "EINVAL" | "EACCES",
  ) {
    super(message);
    this.name = "VaultPathError";
  }
}

/** True when `segment` names a hidden entry, which the vault neither indexes nor writes. */
export function isHiddenSegment(segment: string): boolean {
  return segment.startsWith(".");
}

/**
 * True when `name` holds a backslash on a system where that is a file name
 * character, not a separator. The vault cannot address such a file: its
 * paths use `/` only, and reading a backslash as a separator would open a
 * different file. (`separator` is `path.sep`, a parameter for tests.)
 */
export function hasBackslashName(
  name: string,
  separator: string = path.sep,
): boolean {
  return separator === "/" && name.includes("\\");
}

/**
 * True when the vault leaves `segment` out of its index: hidden entries,
 * and on POSIX the names with a backslash, which it cannot address.
 */
export function isSkippedSegment(
  segment: string,
  separator: string = path.sep,
): boolean {
  return isHiddenSegment(segment) || hasBackslashName(segment, separator);
}

/** True when any segment of the vault-relative path is skipped. */
export function isSkippedPath(
  rel: string,
  separator: string = path.sep,
): boolean {
  return rel.split("/").some((segment) => isSkippedSegment(segment, separator));
}

/**
 * Normalise a vault-relative path: `/` separators, no leading or trailing
 * slash, no empty or `.` segments. Throws VaultPathError for NUL bytes,
 * absolute paths, `..` segments and hidden segments. The empty string is
 * the vault root and is allowed.
 *
 * Where `\` separates paths (Windows) it is read as `/`. Where it does
 * not (POSIX), it is a file name character, so a path that holds one is
 * refused: reading it as `/` would address a different file than the one
 * named. (`separator` is `path.sep`, a parameter for tests.)
 */
export function normalizeVaultPath(
  input: string,
  separator: string = path.sep,
): string {
  if (input.includes("\0")) {
    throw new VaultPathError("Path contains a NUL byte", "EINVAL");
  }
  if (hasBackslashName(input, separator)) {
    throw new VaultPathError(
      "A backslash cannot appear in a vault path on this system: it is part of a file name here, and the vault addresses files with '/' only",
      "EINVAL",
    );
  }
  const slashed = input.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    throw new VaultPathError("Absolute paths are not allowed", "EINVAL");
  }
  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new VaultPathError("Path escapes the vault root", "EACCES");
    }
    if (isHiddenSegment(segment)) {
      throw new VaultPathError(
        "Hidden paths are not part of the vault",
        "EACCES",
      );
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export class VaultFs {
  private constructor(
    /** Realpath of the vault directory. */
    readonly root: string,
  ) {}

  static async open(dir: string): Promise<VaultFs> {
    const real = await fs.realpath(dir);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${dir}`);
    }
    return new VaultFs(real);
  }

  /**
   * Absolute disk path for a vault-relative path. Refuses a path that
   * passes through a symlink below the root. A path that does not exist
   * yet is checked up to its nearest existing ancestor.
   */
  async resolve(rel: string): Promise<string> {
    const segments = normalizeVaultPath(rel).split("/").filter(Boolean);
    let abs = this.root;
    for (const segment of segments) {
      abs = path.join(abs, segment);
      const stat = await fs.lstat(abs).catch(() => null);
      if (stat === null) break;
      if (stat.isSymbolicLink()) {
        throw new VaultPathError(
          "Symlinks are not part of the vault",
          "EACCES",
        );
      }
    }
    return path.join(this.root, ...segments);
  }

  /**
   * `resolve` for an operation that removes, moves or replaces the entry.
   * Refuses the vault root itself, however it is spelled: `""`, `.`, `./`.
   */
  async resolveEntry(rel: string): Promise<string> {
    const abs = await this.resolve(rel);
    if (abs === this.root) {
      throw new VaultPathError("The vault root cannot be changed", "EACCES");
    }
    return abs;
  }

  /**
   * Path of `<vault>/.trash`, created when missing. Refused unless it is a
   * real folder: a `.trash` symlink would move trashed files elsewhere.
   */
  async trashDir(): Promise<string> {
    const dir = path.join(this.root, ".trash");
    await fs.mkdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    if (!(await fs.lstat(dir)).isDirectory()) {
      throw new VaultPathError(
        "The .trash folder is not a folder inside the vault",
        "EACCES",
      );
    }
    return dir;
  }

  /** `resolve`, or null for a refused path. For lookups, which must not throw. */
  async tryResolve(rel: string): Promise<string | null> {
    try {
      return await this.resolve(rel);
    } catch (err) {
      if (err instanceof VaultPathError) return null;
      throw err;
    }
  }
}
