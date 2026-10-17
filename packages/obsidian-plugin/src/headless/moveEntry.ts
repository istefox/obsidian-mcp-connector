/**
 * Move a file or folder on disk without ever replacing an entry at the
 * destination.
 *
 * A file is first renamed to a unique hidden sibling name that this move
 * owns, which captures exactly the entry being moved: an external atomic
 * save that lands at the old name afterwards is a new file and is never
 * touched. The owned file is then hard-linked to its new name (`link` fails
 * atomically with EEXIST when the name is taken) and the owned name is
 * removed, so a file that appears at the destination between a check and
 * the move is never overwritten. When the link fails the file is put back
 * the same way, never over an entry that was created at the old name
 * meanwhile. If it cannot be put back, the owned file stays where it is and
 * the error (reason `ESTRANDED`, never a name collision) names it, so nothing is
 * lost.
 *
 * Once the destination name exists the move has succeeded. If the owned name
 * then cannot be removed it is left in place and reported as `leftover`: the
 * destination is never unlinked again, because by then it may be a different
 * file that an external save put there.
 *
 * On a filesystem without hard links the file is moved onto an exclusively
 * created empty placeholder instead: that is the one way left to claim a
 * name. On such a filesystem a save landing at the destination in the
 * instant before the move can be replaced.
 *
 * A folder cannot be linked. It is renamed once the destination is seen to be
 * absent. On POSIX a rename onto an existing directory only succeeds when
 * that directory is empty, so the race that remains can replace nothing but
 * an empty directory. The destination is not created first, because Windows
 * refuses to rename onto an existing directory.
 *
 * On a case-insensitive filesystem a case-only rename (`Note.md` to
 * `note.md`) finds the destination "taken" by the source itself. A file
 * needs no special case, because it has left its old name before it is
 * linked. A folder is detected by comparing device and inode, and moved in
 * two steps through a temporary hidden sibling name.
 */

import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { errorWithReason } from "./domainError";

/** The filesystem calls the move uses. A seam for tests. */
export type MoveOps = {
  lstat(p: string): Promise<Pick<Stats, "dev" | "ino">>;
  link(src: string, dst: string): Promise<void>;
  unlink(p: string): Promise<void>;
  rename(src: string, dst: string): Promise<void>;
  /** Exclusive create of an empty file. */
  createExclusive(p: string): Promise<void>;
};

export const nodeMoveOps: MoveOps = {
  lstat: (p) => fs.lstat(p),
  link: (src, dst) => fs.link(src, dst),
  unlink: (p) => fs.unlink(p),
  rename: (src, dst) => fs.rename(src, dst),
  createExclusive: (p) => fs.writeFile(p, "", { flag: "wx" }),
};

/**
 * The reason of the error for a file that could not be put back: it sits at
 * its hidden temporary name. Not a name collision, so a caller that retries
 * under another name on EEXIST must not retry on this. It is a `reason`, not
 * a `code`: the tools replace the message of an error that has a `code` with
 * a generic phrase, and this message names where the file is.
 */
export const STRANDED = "ESTRANDED";

/** What a finished move leaves behind. */
export type MoveResult = {
  /**
   * Absolute path of a hidden temporary name that could not be removed after
   * the move succeeded. It is another name of the moved file.
   */
  leftover?: string;
};

/** Errors that mean the filesystem cannot make a hard link. */
const LINK_UNSUPPORTED = new Set([
  "EPERM",
  "EXDEV",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EMLINK",
]);

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function exists(): Error {
  return Object.assign(new Error("EEXIST: destination already exists"), {
    code: "EEXIST",
  });
}

/**
 * Give `from` the name `to` and remove `from`, without replacing anything
 * at `to`. Resolves to the error from removing `from` when `to` was made
 * and `from` could not be removed, else null. Failing there never undoes
 * `to`.
 */
async function linkOnto(
  ops: MoveOps,
  from: string,
  to: string,
): Promise<Error | null> {
  try {
    await ops.link(from, to);
  } catch (err) {
    if (!LINK_UNSUPPORTED.has(codeOf(err) ?? "")) throw err;
    // No hard links here: move onto an exclusively created placeholder.
    await ops.createExclusive(to);
    try {
      await ops.rename(from, to);
    } catch (renameErr) {
      await ops.unlink(to).catch(() => {});
      throw renameErr;
    }
    return null;
  }
  try {
    await ops.unlink(from);
  } catch (err) {
    return err as Error;
  }
  return null;
}

function stranded(message: string, owned: string): Error {
  return Object.assign(
    errorWithReason(`${message} (the file is kept at ${owned})`, STRANDED),
    { leftover: owned },
  );
}

async function moveFile(
  ops: MoveOps,
  src: string,
  dst: string,
  tmpName: (base: string) => string,
): Promise<MoveResult> {
  const owned = path.join(path.dirname(src), tmpName(path.basename(src)));
  await ops.rename(src, owned);
  try {
    const stuck = await linkOnto(ops, owned, dst);
    return stuck === null ? {} : { leftover: owned };
  } catch (err) {
    let back: Error | null;
    try {
      back = await linkOnto(ops, owned, src);
    } catch {
      throw stranded((err as Error).message, owned);
    }
    // Put back, but the owned name stayed: report it, never retry past it.
    if (back !== null) throw stranded((err as Error).message, owned);
    throw err;
  }
}

async function moveFolder(
  ops: MoveOps,
  src: string,
  dst: string,
): Promise<void> {
  const taken = await ops.lstat(dst).then(
    () => true,
    () => false,
  );
  if (taken) throw exists();
  await ops.rename(src, dst);
}

async function sameEntry(ops: MoveOps, a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([ops.lstat(a), ops.lstat(b)]);
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/**
 * Move `src` to `dst`, which must not exist (EEXIST otherwise).
 * `tmpName` makes the unique hidden sibling name a file is owned under while
 * it moves, and a folder's temporary name in a case-only rename.
 */
export async function moveNoReplace(
  src: string,
  dst: string,
  isFolder: boolean,
  ops: MoveOps = nodeMoveOps,
  tmpName: (base: string) => string = (base) =>
    `.${base}.${randomBytes(6).toString("hex")}.tmp`,
): Promise<MoveResult> {
  if (!isFolder) return moveFile(ops, src, dst, tmpName);
  try {
    await moveFolder(ops, src, dst);
  } catch (err) {
    if (codeOf(err) !== "EEXIST" || !(await sameEntry(ops, src, dst))) {
      throw err;
    }
    // The destination is the source under another spelling.
    const tmp = path.join(path.dirname(src), tmpName(path.basename(src)));
    await ops.rename(src, tmp);
    try {
      await moveFolder(ops, tmp, dst);
    } catch (second) {
      await ops.rename(tmp, src).catch(() => {});
      throw second;
    }
  }
  return {};
}
