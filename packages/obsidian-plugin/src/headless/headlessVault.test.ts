import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteVaultDirectoryHandler } from "$/features/mcp-tools/tools/deleteVaultDirectory";
import { ToolRegistryClass } from "$/features/mcp-transport/services/toolRegistry";
import {
  createHeadlessApp,
  HeadlessFileManager,
  type HeadlessAppHandle,
} from "./headlessApp";
import { HeadlessVault } from "./headlessVault";
import { nodeMoveOps } from "./moveEntry";
import { TFile, TFolder } from "./obsidianShim";
import { registerTools } from "./registerTools";
import { VaultPathError } from "./vaultFs";

/** The shim classes stand in for Obsidian's; the app type wants the real ones. */
const asObsidian = (f: TFile) => f as never;

let dir: string;
let root: string;
let handle: HeadlessAppHandle;
let vault: HeadlessVault;

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

async function open() {
  handle = await createHeadlessApp(root);
  vault = handle.vault;
}

beforeEach(() => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "headless-vault-")),
  );
  root = path.join(dir, "vault");
  fs.mkdirSync(root);
});
afterEach(() => {
  handle?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (rel: string): TFile => {
  const f = vault.getFileByPath(rel);
  if (!f) throw new Error(`missing ${rel}`);
  return f;
};

describe("indexing", () => {
  test("indexes files and folders, skips hidden ones", async () => {
    write("a.md", "# A");
    write("sub/b.md", "# B");
    write("sub/img.png", "x");
    write(".obsidian/app.json", "{}");
    write(".git/config", "x");
    write("sub/.hidden/c.md", "x");
    await open();

    expect(
      vault
        .getFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["a.md", "sub/b.md", "sub/img.png"]);
    expect(
      vault
        .getMarkdownFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["a.md", "sub/b.md"]);
    expect(vault.getAllFolders().map((f) => f.path)).toEqual(["sub"]);
    expect(vault.getAbstractFileByPath(".obsidian/app.json")).toBeNull();
    expect(vault.getAbstractFileByPath("sub")).toBeInstanceOf(TFolder);
    expect(file("sub/b.md")).toBeInstanceOf(TFile);
    expect(file("sub/b.md").basename).toBe("b");
    expect(file("sub/b.md").parent?.path).toBe("sub");
  });

  test("symlinks are skipped, wherever they point", async () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.md"), "s");
    write("a.md", "a");
    write("real/b.md", "b");
    fs.symlinkSync(outside, path.join(root, "link"));
    fs.symlinkSync("real", path.join(root, "alias"));
    fs.symlinkSync("a.md", path.join(root, "twin.md"));
    fs.symlinkSync("gone.md", path.join(root, "dangling.md"));
    await open();
    expect(
      vault
        .getFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["a.md", "real/b.md"]);
    expect(vault.getAllFolders().map((f) => f.path)).toEqual(["real"]);
  });
});

describe("writes are visible before the promise resolves", () => {
  test("create updates cache, tags and links at once", async () => {
    write("Target.md", "# Target");
    await open();
    await vault
      .create("notes/New.md", "---\nstatus: new\n---\nHi #fresh [[Target]]\n")
      .catch(() => {});
    // The parent folder is missing, as in Obsidian.
    expect(vault.getFileByPath("notes/New.md")).toBeNull();

    await vault.createFolder("notes");
    const created = await vault.create(
      "notes/New.md",
      "---\nstatus: new\n---\nHi #fresh [[Target]]\n",
    );
    const cache = vault.metadata.getFileCache(created);
    expect(cache?.frontmatter?.status).toBe("new");
    expect(cache?.tags?.map((t) => t.tag)).toEqual(["#fresh"]);
    expect(vault.metadata.getTags()["#fresh"]).toBe(1);
    expect(vault.metadata.resolvedLinks["notes/New.md"]).toEqual({
      "Target.md": 1,
    });
    expect(fs.readFileSync(path.join(root, "notes/New.md"), "utf8")).toContain(
      "status: new",
    );
  });

  test("creating a link target re-resolves an unchanged source", async () => {
    write("A.md", "see [[B]]");
    await open();
    expect(vault.metadata.unresolvedLinks["A.md"]).toEqual({ B: 1 });
    expect(vault.metadata.resolvedLinks["A.md"]).toEqual({});

    await vault.create("B.md", "b");
    expect(vault.metadata.resolvedLinks["A.md"]).toEqual({ "B.md": 1 });
    expect(vault.metadata.unresolvedLinks["A.md"]).toEqual({});

    await vault.delete(file("B.md"));
    expect(vault.metadata.unresolvedLinks["A.md"]).toEqual({ B: 1 });
  });

  test("create refuses to replace an existing file", async () => {
    write("A.md", "keep");
    await open();
    await expect(vault.create("A.md", "new")).rejects.toThrow("already exists");
    expect(fs.readFileSync(path.join(root, "A.md"), "utf8")).toBe("keep");
  });

  test("createFolder reports an existing folder like Obsidian", async () => {
    write("sub/a.md", "a");
    await open();
    await expect(vault.createFolder("sub")).rejects.toThrow("already exists");
    await vault.createFolder("x/y/z");
    expect(vault.getFolderByPath("x/y/z")).toBeInstanceOf(TFolder);
  });
});

describe("process and processFrontMatter", () => {
  test("concurrent edits to one file are serialised, none lost", async () => {
    write("c.md", "0");
    await open();
    const f = file("c.md");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        vault.process(f, (data) => String(Number(data) + 1)),
      ),
    );
    expect(fs.readFileSync(path.join(root, "c.md"), "utf8")).toBe("20");
  });

  test("concurrent frontmatter edits are serialised too", async () => {
    write("p.md", "---\nn: 0\n---\nbody\n");
    await open();
    const f = file("p.md");
    await Promise.all(
      Array.from({ length: 10 }, () =>
        handle.app.fileManager.processFrontMatter(asObsidian(f), (fm) => {
          fm.n = (fm.n as number) + 1;
        }),
      ),
    );
    expect(fs.readFileSync(path.join(root, "p.md"), "utf8")).toBe(
      "---\nn: 10\n---\nbody\n",
    );
    expect(vault.metadata.getFileCache(f)?.frontmatter?.n).toBe(10);
  });

  test("no temp files are left behind", async () => {
    write("t.md", "x");
    await open();
    await vault.modify(file("t.md"), "y");
    expect(fs.readdirSync(root)).toEqual(["t.md"]);
  });
});

describe("an edit never replaces a change it did not read", () => {
  /** A vault whose edits run `during(rel)` between the read and the commit. */
  async function openWith(during: (rel: string) => void): Promise<void> {
    handle = await createHeadlessApp(root, {
      beforeCommit: async (rel) => during(rel),
    });
    vault = handle.vault;
  }

  test("an outside edit made after the read fails the write and survives", async () => {
    write("n.md", "original");
    let edited = false;
    await openWith((rel) => {
      if (edited) return;
      edited = true;
      fs.writeFileSync(path.join(root, rel), "typed in an editor");
    });
    await expect(
      vault.process(file("n.md"), (data) => `${data} + tool`),
    ).rejects.toMatchObject({ reason: "ECONFLICT" });
    expect(fs.readFileSync(path.join(root, "n.md"), "utf8")).toBe(
      "typed in an editor",
    );
    expect(fs.readdirSync(root)).toEqual(["n.md"]);
  });

  test("the message says nothing was written and to retry", async () => {
    write("n.md", "original");
    await openWith((rel) => {
      fs.writeFileSync(path.join(root, rel), "other");
    });
    await expect(vault.process(file("n.md"), () => "mine")).rejects.toThrow(
      /nothing was written.*retry/s,
    );
  });

  test("a retry reads the new content and succeeds", async () => {
    write("n.md", "original");
    let edited = false;
    await openWith((rel) => {
      if (edited) return;
      edited = true;
      fs.writeFileSync(path.join(root, rel), "typed in an editor");
    });
    await expect(
      vault.process(file("n.md"), (data) => `${data} + tool`),
    ).rejects.toThrow("retry");
    await vault.rescan();
    await vault.process(file("n.md"), (data) => `${data} + tool`);
    expect(fs.readFileSync(path.join(root, "n.md"), "utf8")).toBe(
      "typed in an editor + tool",
    );
  });

  test("a file removed after the read is not recreated", async () => {
    write("n.md", "original");
    await openWith((rel) => {
      fs.unlinkSync(path.join(root, rel));
    });
    await expect(
      vault.process(file("n.md"), () => "mine"),
    ).rejects.toMatchObject({ reason: "ECONFLICT" });
    expect(fs.existsSync(path.join(root, "n.md"))).toBe(false);
  });

  test("frontmatter edits are covered the same way", async () => {
    write("p.md", "---\nn: 0\n---\nbody\n");
    await openWith((rel) => {
      fs.writeFileSync(path.join(root, rel), "---\nn: 9\n---\nedited\n");
    });
    const manager = new HeadlessFileManager(vault);
    await expect(
      manager.processFrontMatter(asObsidian(file("p.md")), (fm) => {
        fm.n = 1;
      }),
    ).rejects.toMatchObject({ reason: "ECONFLICT" });
    expect(fs.readFileSync(path.join(root, "p.md"), "utf8")).toBe(
      "---\nn: 9\n---\nedited\n",
    );
  });

  test("an edit that changes nothing is not a conflict, and a rewrite to equal bytes is", async () => {
    write("n.md", "same");
    let calls = 0;
    await openWith(() => {
      calls += 1;
    });
    await vault.process(file("n.md"), (data) => data);
    expect(calls).toBe(0);
    await vault.process(file("n.md"), () => "changed");
    expect(calls).toBe(1);
    expect(fs.readFileSync(path.join(root, "n.md"), "utf8")).toBe("changed");
  });

  test("create and plain modify are not read-modify-write and are not checked", async () => {
    write("n.md", "original");
    let calls = 0;
    await openWith(() => {
      calls += 1;
    });
    await vault.modify(file("n.md"), "overwritten");
    await vault.create("new.md", "fresh");
    expect(calls).toBe(0);
  });
});

// A backslash is a file name character on POSIX. These tests need a file
// system that allows one in a name.
describe.skipIf(path.sep === "\\")("a backslash in a file name (POSIX)", () => {
  test("the entry is left out of the index and of listings", async () => {
    write("dir/a\\b.md", "backslash file");
    write("dir/a/b.md", "slash file");
    write("dir/plain.md", "plain");
    write("folder\\x/inside.md", "inside a backslash folder");
    await open();
    expect(
      vault
        .getFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["dir/a/b.md", "dir/plain.md"]);
    expect(
      vault
        .getAllFolders()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["dir", "dir/a"]);
    expect(await handle.app.vault.adapter.list("dir")).toEqual({
      files: ["dir/plain.md"],
      folders: ["dir/a"],
    });
  });

  test("a watcher event for such a name is ignored", async () => {
    await open();
    write("late\\name.md", "x");
    await vault.reconcile("late\\name.md");
    expect(vault.getFiles()).toEqual([]);
  });

  test("a path with a backslash is refused as input, and the slash file is untouched", async () => {
    write("dir/a/b.md", "slash file");
    write("dir/a\\b.md", "backslash file");
    await open();
    const target = "dir/a\\b.md";
    await expect(vault.create(target, "new")).rejects.toThrow("backslash");
    await expect(
      vault.createBinary(target, new ArrayBuffer(1)),
    ).rejects.toThrow("backslash");
    await expect(vault.createFolder("dir\\sub")).rejects.toThrow("backslash");
    expect(() => vault.getAbstractFileByPath(target)).toThrow("backslash");
    expect(() => vault.getFileByPath(target)).toThrow("backslash");
    expect(() => vault.getFolderByPath("dir\\sub")).toThrow("backslash");
    await expect(handle.app.vault.adapter.exists(target)).rejects.toThrow(
      "backslash",
    );
    await expect(handle.app.vault.adapter.rmdir(target, true)).rejects.toThrow(
      "backslash",
    );
    expect(fs.readFileSync(path.join(root, "dir/a/b.md"), "utf8")).toBe(
      "slash file",
    );
    expect(fs.readFileSync(path.join(root, "dir/a\\b.md"), "utf8")).toBe(
      "backslash file",
    );
  });

  test("a tool call with such a path fails with that message", async () => {
    write("dir/a/b.md", "slash file");
    await open();
    const registry = new ToolRegistryClass();
    await registerTools(registry, {
      app: handle.app,
      plugin: {} as never,
      pluginVersion: "0.0.0-test",
    });
    const result = (await registry.dispatch(
      {
        name: "delete_vault_directory",
        arguments: { path: "dir\\a", recursive: true },
      },
      {} as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("backslash");
    expect(fs.existsSync(path.join(root, "dir/a/b.md"))).toBe(true);
  });
});

describe("a case-insensitive filesystem", () => {
  /** A stat that finds a path under any spelling, as macOS and Windows do. */
  const insensitiveLstat = async (abs: string) => {
    const hit = await fs.promises.lstat(abs).catch(() => null);
    if (hit) return hit;
    const found = fs
      .readdirSync(path.dirname(abs))
      .find((n) => n.toLowerCase() === path.basename(abs).toLowerCase());
    if (found === undefined) throw new Error("ENOENT");
    return fs.promises.lstat(path.join(path.dirname(abs), found));
  };

  test("a late event for the old spelling of a renamed path adds nothing", async () => {
    write("Note.md", "# N\n");
    write("Dir/x.md", "x");
    vault = await HeadlessVault.open(root, { lstat: insensitiveLstat });
    await vault.rescan();

    await vault.rename(file("Note.md"), "note.md");
    await vault.rename(vault.getFolderByPath("Dir") as TFolder, "dir");
    await vault.reconcile("Note.md");
    await vault.reconcile("Dir");

    expect(
      vault
        .getFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["dir/x.md", "note.md"]);
    expect(vault.getAllFolders().map((f) => f.path)).toEqual(["dir"]);
  });

  test("a new file is still indexed under its real spelling", async () => {
    vault = await HeadlessVault.open(root, { lstat: insensitiveLstat });
    await vault.rescan();
    write("New.md", "n");
    await vault.reconcile("New.md");
    expect(vault.getFiles().map((f) => f.path)).toEqual(["New.md"]);
  });
});

describe("confinement", () => {
  test("hostile paths are refused before touching the disk", async () => {
    await open();
    for (const bad of [
      "../x.md",
      "/etc/x.md",
      "a/../../x.md",
      ".git/x",
      "a\0.md",
      "a\nb.md",
    ]) {
      await expect(vault.create(bad, "x")).rejects.toThrow(VaultPathError);
    }
    expect(fs.existsSync(path.join(dir, "x.md"))).toBe(false);
  });

  test("a symlinked folder out of the vault cannot be written through", async () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "link"));
    await open();
    await expect(vault.create("link/pwn.md", "x")).rejects.toThrow(
      VaultPathError,
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("fs errors do not reveal the host path", async () => {
    write("a.md", "a");
    await open();
    const f = file("a.md");
    fs.rmSync(path.join(root, "a.md"));
    const err = await vault.read(f).catch((e: Error) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect((err as Error).message).not.toContain(dir);
  });
});

describe("delete and trash", () => {
  test("trashFile moves into .trash without indexing it", async () => {
    write("gone.md", "bye");
    await open();
    await handle.app.fileManager.trashFile(asObsidian(file("gone.md")));
    expect(vault.getFileByPath("gone.md")).toBeNull();
    expect(fs.readFileSync(path.join(root, ".trash/gone.md"), "utf8")).toBe(
      "bye",
    );
    expect(vault.getFiles()).toEqual([]);
  });

  test("a second trashed file of the same name does not overwrite", async () => {
    write("n.md", "1");
    await open();
    await handle.app.fileManager.trashFile(asObsidian(file("n.md")));
    await vault.create("n.md", "2");
    await handle.app.fileManager.trashFile(asObsidian(file("n.md")));
    expect(fs.readdirSync(path.join(root, ".trash")).length).toBe(2);
  });

  test("adapter.rmdir removes a folder tree from disk and index", async () => {
    write("d/a.md", "a");
    write("d/e/b.md", "b");
    await open();
    const adapter = vault.adapter;
    await expect(adapter.rmdir("d", false)).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
    await adapter.rmdir("d", true);
    expect(vault.getFiles()).toEqual([]);
    expect(vault.getAllFolders()).toEqual([]);
    expect(await adapter.exists("d")).toBe(false);
  });
});

describe("the vault root is never removed or replaced", () => {
  const spellings = ["", ".", "./", "a/..", "self"];

  beforeEach(() => {
    write("a.md", "a");
    fs.symlinkSync(".", path.join(root, "self"));
  });

  test.each(spellings.map((p) => [p]))("rmdir(%p) is refused", async (p) => {
    await open();
    await expect(vault.adapter.rmdir(p, true)).rejects.toThrow(VaultPathError);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("a");
  });

  test("delete_vault_directory with path '.' leaves the vault alone", async () => {
    await open();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: ".", recursive: true },
      app: handle.app,
    });
    expect(result.isError).toBe(true);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("a");
  });

  test("delete and trash refuse a folder that resolves to the root", async () => {
    await open();
    const alias = new TFolder(vault, "self");
    await expect(vault.delete(alias)).rejects.toThrow(VaultPathError);
    await expect(vault.trash(alias)).rejects.toThrow(VaultPathError);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("a");
  });

  test("a write never targets the root", async () => {
    await open();
    await expect(vault.create("self", "x")).rejects.toThrow(VaultPathError);
    expect(fs.readdirSync(dir)).toEqual(["vault"]);
  });
});

describe("trash destinations", () => {
  test("same-named files trashed within one clock tick all survive", async () => {
    write("n.md", "1");
    const fixed = await HeadlessVault.open(root, { now: () => 1000 });
    await fixed.rescan();
    for (const next of ["2", "3", null]) {
      await fixed.trash(fixed.getFileByPath("n.md") as TFile);
      if (next !== null) await fixed.create("n.md", next);
    }
    const trash = path.join(root, ".trash");
    const contents = fs
      .readdirSync(trash)
      .map((name) => fs.readFileSync(path.join(trash, name), "utf8"))
      .sort();
    expect(contents).toEqual(["1", "2", "3"]);
  });

  test("a file that cannot be put back is reported, not trashed under another name", async () => {
    write("a.md", "original");
    write(".trash/a.md", "older");
    const vault = await HeadlessVault.open(root, {
      moveOps: {
        ...nodeMoveOps,
        rename: async (src, dst) => {
          await fs.promises.rename(src, dst);
          // An external save recreates the name right after it is captured.
          if (path.basename(dst).endsWith(".tmp")) {
            fs.writeFileSync(path.join(root, "a.md"), "external");
          }
        },
      },
    });
    await vault.rescan();
    const err = await vault
      .trash(vault.getFileByPath("a.md") as TFile)
      .catch((e: Error) => e);
    expect((err as { reason?: string }).reason).toBe("ESTRANDED");
    expect((err as Error).message).toContain(".a.md.");
    expect((err as Error).message).not.toContain(dir);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("external");
    expect(fs.readdirSync(path.join(root, ".trash"))).toEqual(["a.md"]);
    expect(fs.readFileSync(path.join(root, ".trash/a.md"), "utf8")).toBe(
      "older",
    );
    const kept = fs.readdirSync(root).filter((n) => n.endsWith(".tmp"));
    expect(kept.length).toBe(1);
    expect(fs.readFileSync(path.join(root, kept[0]), "utf8")).toBe("original");
    expect(vault.getFiles().map((f) => f.path)).toEqual(["a.md"]);
  });

  test("a temporary name that cannot be removed is reported after the file is trashed", async () => {
    write("a.md", "original");
    const vault = await HeadlessVault.open(root, {
      moveOps: {
        ...nodeMoveOps,
        unlink: async (p) => {
          if (p.endsWith(".tmp")) {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          await fs.promises.unlink(p);
        },
      },
    });
    await vault.rescan();
    const err = await vault
      .trash(vault.getFileByPath("a.md") as TFile)
      .catch((e: Error) => e);
    expect((err as { reason?: string }).reason).toBe("ELEFTOVER");
    expect((err as Error).message).not.toContain(dir);
    expect(fs.readFileSync(path.join(root, ".trash/a.md"), "utf8")).toBe(
      "original",
    );
    expect(vault.getFiles()).toEqual([]);
  });

  test("a .trash symlink out of the vault is refused", async () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, ".trash"));
    write("keep.md", "k");
    await open();
    const err = await vault.trash(file("keep.md")).catch((e: Error) => e);
    expect(err).toBeInstanceOf(VaultPathError);
    expect((err as Error).message).toContain(".trash");
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(root, "keep.md"), "utf8")).toBe("k");
    expect(vault.getFileByPath("keep.md")).not.toBeNull();
  });
});

describe("symlinks inside the vault", () => {
  let outside: string;

  beforeEach(() => {
    outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "o.md"), "outside");
    write("real/r.md", "real");
    write(".obsidian/settings.json", "hidden-setting");
    fs.symlinkSync("real/r.md", path.join(root, "file-link.md"));
    fs.symlinkSync("real", path.join(root, "dir-link"));
    fs.symlinkSync(outside, path.join(root, "out-link"));
    fs.symlinkSync(".obsidian", path.join(root, "Alias"));
  });

  const ghost = (rel: string) =>
    new TFile(vault, rel, { ctime: 0, mtime: 0, size: 0 });

  test("cannot be read, even by a path the index never offered", async () => {
    await open();
    for (const rel of [
      "file-link.md",
      "dir-link/r.md",
      "out-link/o.md",
      "Alias/settings.json",
    ]) {
      expect(vault.getAbstractFileByPath(rel)).toBeNull();
      await expect(vault.read(ghost(rel))).rejects.toThrow(VaultPathError);
    }
  });

  test("delete, trash and rmdir refuse them and leave the targets alone", async () => {
    await open();
    await expect(vault.delete(ghost("file-link.md"))).rejects.toThrow(
      VaultPathError,
    );
    await expect(vault.trash(ghost("file-link.md"))).rejects.toThrow(
      VaultPathError,
    );
    await expect(vault.delete(new TFolder(vault, "dir-link"))).rejects.toThrow(
      VaultPathError,
    );
    await expect(vault.adapter.rmdir("dir-link", true)).rejects.toThrow(
      VaultPathError,
    );
    await expect(vault.adapter.rmdir("out-link", true)).rejects.toThrow(
      VaultPathError,
    );
    expect(fs.readFileSync(path.join(root, "real/r.md"), "utf8")).toBe("real");
    expect(fs.readFileSync(path.join(outside, "o.md"), "utf8")).toBe("outside");
    expect(fs.lstatSync(path.join(root, "file-link.md")).isSymbolicLink()).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, ".trash"))).toBe(false);
  });

  test("nothing is written through them", async () => {
    await open();
    for (const rel of ["dir-link/new.md", "out-link/new.md", "Alias/new.md"]) {
      await expect(vault.create(rel, "x")).rejects.toThrow(VaultPathError);
    }
    await expect(vault.createFolder("dir-link/sub")).rejects.toThrow(
      VaultPathError,
    );
    expect(fs.readdirSync(path.join(root, "real"))).toEqual(["r.md"]);
    expect(fs.readdirSync(outside)).toEqual(["o.md"]);
    expect(fs.readdirSync(path.join(root, ".obsidian"))).toEqual([
      "settings.json",
    ]);
  });

  test("a symlinked vault root, or one below a dot-folder, still works", async () => {
    const nested = path.join(dir, ".vaults", "x");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "a.md"), "a");
    const link = path.join(dir, "vault-link");
    fs.symlinkSync(nested, link);
    handle = await createHeadlessApp(link);
    vault = handle.vault;
    expect(vault.getFiles().map((f) => f.path)).toEqual(["a.md"]);
    await vault.create("b.md", "b");
    expect(fs.readFileSync(path.join(nested, "b.md"), "utf8")).toBe("b");
  });
});

describe("edits keep the file's permission bits", () => {
  test.each([
    ["0600", 0o600],
    ["0640", 0o640],
  ])("mode %s", async (_, mode) => {
    write("p.md", "---\nn: 0\n---\nbody\n");
    fs.chmodSync(path.join(root, "p.md"), mode);
    await open();
    await vault.modify(file("p.md"), "---\nn: 1\n---\nbody\n");
    expect(fs.statSync(path.join(root, "p.md")).mode & 0o777).toBe(mode);
    await handle.app.fileManager.processFrontMatter(
      asObsidian(file("p.md")),
      (fm) => {
        fm.n = 2;
      },
    );
    expect(fs.statSync(path.join(root, "p.md")).mode & 0o777).toBe(mode);
    expect(fs.readFileSync(path.join(root, "p.md"), "utf8")).toContain("n: 2");
  });
});

describe("a note that cannot be parsed", () => {
  test("a self-referencing YAML anchor does not stop the scan", async () => {
    write("loop.md", "---\na: &self\n  link: '[[B]]'\n  next: *self\n---\n");
    write("B.md", "b");
    await open();
    expect(vault.getFileByPath("loop.md")).not.toBeNull();
    expect(vault.metadata.resolvedLinks["loop.md"]).toEqual({ "B.md": 1 });
  });
});

describe("index updates never interleave with a rescan", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  /**
   * A vault whose rescans count their listings and can be held between
   * listing the disk and applying the listing. `queued(n)` resolves once
   * n index updates have joined the queue.
   */
  async function openHeld() {
    let hold: { reached: () => void; release: Promise<void> } | null = null;
    let count = 0;
    const waiting = new Map<number, () => void>();
    const held = {
      listings: 0,
      vault: await HeadlessVault.open(root, {
        afterScanList: async () => {
          held.listings += 1;
          const h = hold;
          hold = null;
          if (h === null) return;
          h.reached();
          await h.release;
        },
        onQueued: () => {
          count += 1;
          waiting.get(count)?.();
        },
      }),
      /** Hold the next rescan; resolves with its release once it is held. */
      async hold(): Promise<() => void> {
        const reached = deferred();
        const release = deferred();
        hold = { reached: reached.resolve, release: release.promise };
        await reached.promise;
        return release.resolve;
      },
      queued(n: number): Promise<void> {
        const target = count + n;
        return new Promise((resolve) => waiting.set(target, resolve));
      },
    };
    await held.vault.rescan();
    return held;
  }

  const indexed = (v: HeadlessVault) =>
    v
      .getFiles()
      .map((f) => f.path)
      .sort();
  /** The files at the vault root, where these tests keep all of theirs. */
  const onDisk = () =>
    fs
      .readdirSync(root)
      .filter((p) => fs.statSync(path.join(root, p)).isFile())
      .sort();

  test("watcher updates that arrive during a rescan are applied after it", async () => {
    write("keep.md", "k");
    write("pic.png", "x");
    const held = await openHeld();
    const { vault: v } = held;
    const holding = held.hold();
    const scanned = v.rescan();
    const release = await holding;

    write("new.md", "n");
    fs.rmSync(path.join(root, "pic.png"));
    // What the watcher runs for the two events. An unordered update
    // finishes at once; an ordered one waits behind the held scan.
    const queued = held.queued(2);
    const settled = Promise.all([
      v.reconcile("new.md"),
      v.reconcile("pic.png"),
    ]);
    await Promise.race([settled, queued]);
    release();
    await Promise.all([scanned, settled]);

    expect(onDisk()).toEqual(["keep.md", "new.md"]);
    expect(indexed(v)).toEqual(onDisk());
  });

  test("a tool write during a rescan is not undone by the older listing", async () => {
    write("keep.md", "k");
    write("pic.png", "x");
    const held = await openHeld();
    const { vault: v } = held;
    const holding = held.hold();
    const scanned = v.rescan();
    const release = await holding;

    const queued = held.queued(2);
    const written = Promise.all([
      v.create("new.md", "n #fresh"),
      v.delete(v.getFileByPath("pic.png") as TFile),
    ]);
    await Promise.race([written, queued]);
    release();
    await Promise.all([scanned, written]);

    expect(onDisk()).toEqual(["keep.md", "new.md"]);
    expect(indexed(v)).toEqual(onDisk());
    expect(v.metadata.getTags()["#fresh"]).toBe(1);
  });

  test("rescans requested during a rescan coalesce into one more", async () => {
    write("a.md", "a");
    const held = await openHeld();
    const { vault: v } = held;
    const holding = held.hold();
    const first = v.rescan();
    const release = await holding;
    expect(held.listings).toBe(2);

    const more = [v.rescan(), v.rescan(), v.rescan()];
    release();
    await Promise.all([first, ...more]);
    expect(held.listings).toBe(3);
  });
});
