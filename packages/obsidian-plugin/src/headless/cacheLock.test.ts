import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, lockFilePath, type LockConnection } from "./cacheLock";

let dir: string;
let file: string;
let children: ChildProcess[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelock-"));
  fs.chmodSync(dir, 0o700);
  file = path.join(dir, "lock.sqlite");
});
afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children = [];
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The lock's own statements, run by a process that is not the code under test. */
const TAKE_THE_LOCK = `
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { timeout: 0 });
  try {
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
    console.log("held");
    if (process.argv[2] === "hold") setInterval(() => {}, 1000);
    else db.close();
  } catch (err) {
    console.log("refused " + err.errcode);
  }
`;

/** Run TAKE_THE_LOCK in another process and resolve with its first line. */
function inAnotherProcess(mode: "hold" | "try"): {
  child: ChildProcess;
  answer: Promise<string>;
  exited: Promise<void>;
} {
  const child = spawn(process.execPath, ["-e", TAKE_THE_LOCK, file, mode], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  const answer = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", (chunk: Buffer) =>
      resolve(chunk.toString().trim()),
    );
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  return { child, answer, exited };
}

const held = (result: ReturnType<typeof acquireLock>) => {
  if (!result.ok) throw new Error("expected the lock to be taken");
  return result;
};

describe("lockFilePath", () => {
  test("is stable per vault folder, differs between vaults and sits in the root", () => {
    const a = lockFilePath("/c", "/c/a-1");
    expect(lockFilePath("/c", "/c/a-1")).toBe(a);
    expect(lockFilePath("/c", "/c/b-2")).not.toBe(a);
    expect(path.dirname(a)).toBe("/c");
    expect(path.basename(a)).toMatch(/^lock-[0-9a-f]{16}\.sqlite$/);
  });
});

describe("acquireLock in one process", () => {
  test("a second acquire is refused while the first is held, and succeeds after release", () => {
    const first = held(acquireLock(file));
    expect(acquireLock(file)).toEqual({ ok: false });
    expect(acquireLock(file)).toEqual({ ok: false });
    first.release();
    const second = held(acquireLock(file));
    expect(acquireLock(file)).toEqual({ ok: false });
    second.release();
  });

  test("asking again in a process that holds it neither gets it nor loses it", async () => {
    const lock = held(acquireLock(file));
    // Opening the file anywhere else in this process would drop its locks.
    expect(acquireLock(file)).toEqual({ ok: false });
    expect(acquireLock(file)).toEqual({ ok: false });
    const other = inAnotherProcess("try");
    expect(await other.answer).toBe("refused 5");
    await other.exited;
    lock.release();
  });

  test("release is idempotent and never drops a lock somebody else took since", () => {
    const first = held(acquireLock(file));
    first.release();
    first.release();
    const second = held(acquireLock(file));
    first.release();
    expect(acquireLock(file)).toEqual({ ok: false });
    second.release();
    second.release();
    held(acquireLock(file)).release();
  });

  test("the lock file stays on disk, empty, after release", () => {
    held(acquireLock(file)).release();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBe(0);
  });

  test("the lock file is private, a looser one is tightened", () => {
    held(acquireLock(file)).release();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.chmodSync(file, 0o644);
    held(acquireLock(file)).release();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("anything SQLite leaves beside the file is private too", () => {
    const lock = held(acquireLock(file));
    for (const name of fs.readdirSync(dir)) {
      expect(fs.statSync(path.join(dir, name)).mode & 0o077).toBe(0);
    }
    lock.release();
  });
});

describe("acquireLock errors", () => {
  /** A connection whose `exec` fails with `error`, recording that it was closed. */
  const failing = (error: unknown) => {
    const log = { closed: 0 };
    const open = (): LockConnection => ({
      exec: () => {
        throw error;
      },
      close: () => {
        log.closed++;
      },
    });
    return { open, log };
  };

  test.each([
    ["SQLITE_BUSY", Object.assign(new Error("x"), { errcode: 5 })],
    ["an extended busy code", Object.assign(new Error("x"), { errcode: 261 })],
    ["the message alone", new Error("database is locked")],
  ])("%s means the lock is held, with no error", (_name, error) => {
    const { open, log } = failing(error);
    expect(acquireLock(file, { open })).toEqual({ ok: false });
    expect(log.closed).toBe(1);
  });

  test("any other failure carries its message", () => {
    const { open, log } = failing(
      Object.assign(new Error("disk I/O error"), { errcode: 10 }),
    );
    expect(acquireLock(file, { open })).toEqual({
      ok: false,
      error: "disk I/O error",
    });
    expect(log.closed).toBe(1);
  });

  test("a failure that has a code carries it", () => {
    const { open } = failing(
      Object.assign(new Error("disk I/O error"), { code: "EIO" }),
    );
    expect(acquireLock(file, { open })).toEqual({
      ok: false,
      error: "disk I/O error",
      code: "EIO",
    });
  });

  test("a database that cannot be opened carries its message", () => {
    const result = acquireLock(file, {
      open: () => {
        throw Object.assign(new Error("unable to open database file"), {
          errcode: 14,
        });
      },
    });
    expect(result).toEqual({
      ok: false,
      error: "unable to open database file",
    });
  });

  test("a folder that is missing is an error, not a held lock", () => {
    const result = acquireLock(path.join(dir, "missing", "lock.sqlite"));
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("error");
  });

  test("a connection that cannot be closed does not hide the first failure", () => {
    const result = acquireLock(file, {
      open: () => ({
        exec: () => {
          throw new Error("boom");
        },
        close: () => {
          throw new Error("close failed");
        },
      }),
    });
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  test("a non-error throw is reported as text", () => {
    const result = acquireLock(file, {
      open: () => ({
        exec: () => {
          throw "plain string";
        },
        close: () => {},
      }),
    });
    expect(result).toEqual({ ok: false, error: "plain string" });
  });
});

describe("acquireLock across processes", () => {
  test("is refused while another process holds it, and succeeds once that process is killed", async () => {
    const holder = inAnotherProcess("hold");
    expect(await holder.answer).toBe("held");
    expect(acquireLock(file)).toEqual({ ok: false });

    holder.child.kill("SIGKILL");
    await holder.exited;
    // The kernel dropped it with the process: no stale lock to reclaim.
    held(acquireLock(file)).release();
  });

  test("another process is refused while this one holds it, and gets it after release", async () => {
    const lock = held(acquireLock(file));
    const refused = inAnotherProcess("try");
    expect(await refused.answer).toBe("refused 5");
    await refused.exited;

    lock.release();
    const granted = inAnotherProcess("try");
    expect(await granted.answer).toBe("held");
    await granted.exited;
  });

  test("a holder that exits normally frees it", async () => {
    const quick = inAnotherProcess("try");
    expect(await quick.answer).toBe("held");
    await quick.exited;
    held(acquireLock(file)).release();
  });
});
