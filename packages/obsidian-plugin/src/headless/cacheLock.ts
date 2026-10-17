/**
 * One writer per vault index. Two servers for the same vault (say, two MCP
 * clients that each spawn one) would otherwise interleave writes to the
 * same cache folder and corrupt the index.
 *
 * The lock is an exclusive SQLite lock on a file in the cache root, taken
 * through Node's built-in `node:sqlite`: the connection runs
 * `PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;` and stays open for as
 * long as the lock is held. SQLite takes the lock from the operating system
 * (`fcntl` on POSIX, `LockFileEx` on Windows), so it belongs to the open
 * file and not to a name that can be raced for. A second connection, in
 * this process or another, is refused at once with "database is locked". A
 * holder that dies, however it dies, releases it with its process, so there
 * is no stale lock to detect or reclaim and no file to delete. The lock
 * file is never removed: removing a lock file is what makes path-based
 * locks racy.
 *
 * Nothing is written to the file. SQLite may leave an empty rollback
 * journal beside it, which holds nothing and takes the file's `0600` mode.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** What the lock needs of a database connection. */
export type LockConnection = { exec(sql: string): void; close(): void };

export type CacheLockDeps = {
  /** Opens the lock file. Tests replace it to make opening or locking fail. */
  open?: (file: string) => LockConnection;
};

export type AcquireResult =
  /** This process holds the lock until `release` is called. */
  | { ok: true; release: () => void }
  /**
   * Another connection holds it, or `error` says why it could not be taken,
   * with the error's own `code` when it has a string one.
   */
  | { ok: false; error?: string; code?: string };

/**
 * Where the lock for one vault lives: `lock-<16 hex of the vault cache
 * folder's hash>.sqlite` in the cache root, as unique per vault as the
 * folder is.
 */
export function lockFilePath(root: string, vaultDir: string): string {
  const id = createHash("sha256").update(vaultDir).digest("hex").slice(0, 16);
  return path.join(root, `lock-${id}.sqlite`);
}

const openSqlite = (file: string): LockConnection =>
  // No wait: a held lock is an answer, not something to queue for.
  new DatabaseSync(file, { timeout: 0 });

/** SQLITE_BUSY, in any of its extended forms, which is how a held lock reads. */
function isBusy(err: unknown): boolean {
  const { errcode, message } = err as { errcode?: unknown; message?: unknown };
  return (
    (typeof errcode === "number" && (errcode & 0xff) === 5) ||
    (typeof message === "string" && /database is locked/i.test(message))
  );
}

/**
 * Take the lock on `file`, whose folder must exist. Never throws: a held
 * lock is `{ ok: false }`, and any other failure is `{ ok: false, error }`.
 * The file is created `0600` if it is not there.
 */
export function acquireLock(
  file: string,
  deps: CacheLockDeps = {},
): AcquireResult {
  let db: LockConnection | undefined;
  try {
    // Created here and nowhere else opened outside SQLite: closing any
    // descriptor of a file drops the process's own POSIX locks on it, so an
    // existing file is never opened, only tightened.
    try {
      fs.closeSync(fs.openSync(file, "wx", 0o600));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    fs.chmodSync(file, 0o600);
    db = (deps.open ?? openSqlite)(file);
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch (err) {
    try {
      db?.close();
    } catch {
      // The failure above is the one to report.
    }
    if (isBusy(err)) return { ok: false };
    const code = (err as { code?: unknown } | null | undefined)?.code;
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(typeof code === "string" && { code }),
    };
  }
  const held = db;
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      try {
        held.close();
      } catch {
        // Closing drops the lock; a connection that is already gone has.
      }
    },
  };
}
