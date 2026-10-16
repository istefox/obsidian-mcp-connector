import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "$/shared/logger";
import { createHeadlessApp, type HeadlessAppHandle } from "./headlessApp";
import { HeadlessVault } from "./headlessVault";
import { VaultWatcher, WATCH_DEBOUNCE_MS, type WatchFolder } from "./watcher";

/** Hang guard for an event that should arrive; the wait itself is event-driven. */
const EVENT_GUARD_MS = 15000;

let dir: string;
let root: string;
let handle: HeadlessAppHandle;
let watcher: VaultWatcher | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-watch-"));
  root = path.join(dir, "vault");
  fs.mkdirSync(root);
});
afterEach(() => {
  handle?.close();
  watcher?.stop();
  watcher = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Resolve on the first `name` event whose file path is `rel`. */
function onceFile(
  name: string,
  rel: string,
  vault: HeadlessVault = handle.vault,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(
      () => reject(new Error(`no ${name} event for ${rel}`)),
      EVENT_GUARD_MS,
    );
    const ref = vault.on(name, ((f: { path: string }) => {
      if (f.path !== rel) return;
      clearTimeout(guard);
      vault.offref(ref);
      resolve();
    }) as never);
  });
}

/**
 * Open the vault the way `createHeadlessApp` does, with each folder watch
 * recorded. `live` holds the vault paths watched right now.
 */
async function openRecorded(watch?: WatchFolder) {
  const vault = await HeadlessVault.open(root);
  const live = new Set<string>();
  const rel = (abs: string) => path.relative(vault.root, abs);
  const recorded: WatchFolder = (abs, listener) => {
    const inner = watch
      ? watch(abs, listener)
      : fs.watch(abs, { persistent: false }, listener);
    live.add(rel(abs));
    return {
      on: (event, fn) => inner.on(event, fn),
      close: () => {
        live.delete(rel(abs));
        inner.close();
      },
    };
  };
  watcher = new VaultWatcher(vault, WATCH_DEBOUNCE_MS, recorded);
  watcher.start({ held: true });
  await vault.rescan();
  await watcher.release();
  return { vault, live };
}

/** Resolve once the next full rescan, which a folder change triggers, is done. */
function nextRescan(vault: HeadlessVault): Promise<void> {
  const rescan = vault.rescan.bind(vault);
  return new Promise((resolve) => {
    vault.rescan = async () => {
      await rescan();
      vault.rescan = rescan;
      resolve();
    };
  });
}

describe("external changes", () => {
  test("create, edit and delete reach the index and the metadata", async () => {
    handle = await createHeadlessApp(root);
    const { vault } = handle;

    const created = onceFile("create", "ext.md");
    fs.writeFileSync(path.join(root, "ext.md"), "one #first\n");
    await created;
    expect(vault.metadata.getTags()["#first"]).toBe(1);

    const modified = onceFile("modify", "ext.md");
    fs.writeFileSync(path.join(root, "ext.md"), "two #second\n");
    await modified;
    expect(vault.metadata.getTags()["#first"]).toBeUndefined();
    expect(vault.metadata.getTags()["#second"]).toBe(1);

    const deleted = onceFile("delete", "ext.md");
    fs.rmSync(path.join(root, "ext.md"));
    await deleted;
    expect(vault.getFileByPath("ext.md")).toBeNull();
    expect(vault.metadata.getTags()).toEqual({});
  });

  test("an external file resolves links from an unchanged note", async () => {
    fs.writeFileSync(path.join(root, "A.md"), "[[B]]");
    handle = await createHeadlessApp(root);
    const created = onceFile("create", "B.md");
    fs.writeFileSync(path.join(root, "B.md"), "b");
    await created;
    expect(handle.vault.metadata.resolvedLinks["A.md"]).toEqual({ "B.md": 1 });
  });

  test("a renamed folder is picked up under its new name", async () => {
    fs.mkdirSync(path.join(root, "old"));
    fs.writeFileSync(path.join(root, "old/n.md"), "n");
    handle = await createHeadlessApp(root);

    const gone = onceFile("delete", "old/n.md");
    const arrived = onceFile("create", "new/n.md");
    fs.renameSync(path.join(root, "old"), path.join(root, "new"));
    await Promise.all([gone, arrived]);
    expect(handle.vault.getFolderByPath("old")).toBeNull();
    expect(handle.vault.getFolderByPath("new")).not.toBeNull();
  });

  test("hidden folders are never indexed", async () => {
    handle = await createHeadlessApp(root);
    const marker = onceFile("create", "visible.md");
    fs.mkdirSync(path.join(root, ".obsidian"));
    fs.writeFileSync(path.join(root, ".obsidian/x.md"), "x");
    fs.writeFileSync(path.join(root, "visible.md"), "v");
    await marker;
    expect(handle.vault.getFiles().map((f) => f.path)).toEqual(["visible.md"]);
  });

  test("seeing the server's own write again changes nothing", async () => {
    handle = await createHeadlessApp(root);
    const { vault } = handle;
    const f = await vault.create("own.md", "v1 #own");
    await vault.modify(f, "v2 #own");

    // Both writes are complete, so the index already matches the disk and a
    // reconcile, which is what the watcher runs for them, has nothing to do.
    const seen: string[] = [];
    vault.on("modify", ((e: { path: string }) => seen.push(e.path)) as never);
    vault.on("create", ((e: { path: string }) => seen.push(e.path)) as never);
    await vault.reconcile("own.md");
    await vault.reconcile("own.md");
    expect(seen).toEqual([]);
    expect(vault.metadata.getTags()["#own"]).toBe(1);
  });
});

describe("startup", () => {
  test("an edit that lands while the initial scan runs is not lost", async () => {
    const note = path.join(root, "early.md");
    fs.writeFileSync(note, "old #before\n");
    let edited = false;
    handle = await createHeadlessApp(root, {
      // Runs after the scan read the note and before the scan finishes, so
      // the index holds the old text while the disk holds the new one.
      afterScanRead: async (rel) => {
        if (rel !== "early.md" || edited) return;
        edited = true;
        fs.writeFileSync(note, "new #after\n");
      },
    });
    expect(edited).toBe(true);
    const tags = () => handle.vault.metadata.getTags();
    if (tags()["#after"] === undefined) await onceFile("modify", "early.md");
    expect(tags()["#after"]).toBe(1);
    expect(tags()["#before"]).toBeUndefined();
  });
});

describe("one watch per visible folder", () => {
  test("only visible folders are watched, never dot-folders or symlinks", async () => {
    for (const d of [".git/objects/ab", ".obsidian/plugins", "sub/deeper"]) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
    }
    fs.mkdirSync(path.join(root, "sub/.hidden"));
    fs.symlinkSync("sub", path.join(root, "link"));
    const fake: WatchFolder = () =>
      Object.assign(new EventEmitter(), { close: () => {} });
    const { live } = await openRecorded(fake);
    expect([...live].sort()).toEqual(["", "sub", path.join("sub", "deeper")]);
    watcher?.stop();
    expect(live.size).toBe(0);
  });

  test("an edit in a nested folder is picked up", async () => {
    fs.mkdirSync(path.join(root, "a/b"), { recursive: true });
    fs.writeFileSync(path.join(root, "a/b/n.md"), "one");
    const { vault } = await openRecorded();
    const modified = onceFile("modify", "a/b/n.md", vault);
    fs.writeFileSync(path.join(root, "a/b/n.md"), "two #nested");
    await modified;
    expect(vault.metadata.getTags()["#nested"]).toBe(1);
  });

  test("a new folder is indexed and watched, so later edits in it arrive", async () => {
    const { vault, live } = await openRecorded();
    const rescanned = nextRescan(vault);
    const created = onceFile("create", "new/deep/n.md", vault);
    fs.mkdirSync(path.join(root, "new/deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "new/deep/n.md"), "one");
    await Promise.all([created, rescanned]);
    expect(live.has(path.join("new", "deep"))).toBe(true);

    const modified = onceFile("modify", "new/deep/n.md", vault);
    fs.writeFileSync(path.join(root, "new/deep/n.md"), "two #fresh");
    await modified;
    expect(vault.metadata.getTags()["#fresh"]).toBe(1);
  });

  test("a deleted folder leaves the index and loses its watch", async () => {
    fs.mkdirSync(path.join(root, "d/e"), { recursive: true });
    fs.writeFileSync(path.join(root, "d/e/n.md"), "n");
    const { vault, live } = await openRecorded();
    expect(live.has(path.join("d", "e"))).toBe(true);
    const rescanned = nextRescan(vault);
    const gone = onceFile("delete", "d", vault);
    fs.rmSync(path.join(root, "d"), { recursive: true });
    await Promise.all([gone, rescanned]);
    expect(vault.getFileByPath("d/e/n.md")).toBeNull();
    expect([...live]).toEqual([""]);
  });

  test("a folder that cannot be watched warns once and is still indexed", async () => {
    for (const d of ["a", "b"]) {
      fs.mkdirSync(path.join(root, d));
      fs.writeFileSync(path.join(root, d, "n.md"), d);
    }
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const full: WatchFolder = (abs, listener) => {
        if (abs !== fs.realpathSync(root)) {
          throw Object.assign(new Error("ENOSPC: watch limit"), {
            code: "ENOSPC",
          });
        }
        return fs.watch(abs, { persistent: false }, listener);
      };
      const { vault, live } = await openRecorded(full);
      expect([...live]).toEqual([""]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(
        "fs.inotify.max_user_watches",
      );
      expect(
        vault
          .getFiles()
          .map((f) => f.path)
          .sort(),
      ).toEqual(["a/n.md", "b/n.md"]);
    } finally {
      warn.mockRestore();
    }
  });
});
