import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHeadlessApp, HeadlessFileManager } from "./headlessApp";
import { HeadlessVault } from "./headlessVault";
import { nodeMoveOps } from "./moveEntry";
import { collectRenameWarnings } from "./renameWarnings";
import { TFile, TFolder, type TAbstractFile } from "./obsidianShim";
import { VaultPathError } from "./vaultFs";
import { VaultWatcher } from "./watcher";

let dir: string;
let root: string;
let vault: HeadlessVault;
let files: HeadlessFileManager;
let cleanup: Array<() => void> = [];

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(root, rel));
const entry = (rel: string): TAbstractFile => {
  const e = vault.getAbstractFileByPath(rel);
  if (!e) throw new Error(`missing ${rel}`);
  return e;
};
const indexed = () =>
  vault
    .getFiles()
    .map((f) => f.path)
    .sort();
/** Every non-hidden file on disk, vault-relative and sorted. */
const onDisk = (rel = ""): string[] =>
  fs
    .readdirSync(path.join(root, rel), { withFileTypes: true })
    .filter((d) => !d.name.startsWith("."))
    .flatMap((d) => {
      const child = rel ? `${rel}/${d.name}` : d.name;
      return d.isDirectory() ? onDisk(child) : [child];
    })
    .sort();

/** The ELINKS error a rename ends with. */
const linksError = async (from: string, to: string) => {
  const err = (await files
    .renameFile(entry(from), to)
    .catch((e: Error) => e)) as Error & { reason?: string };
  expect(err).toBeInstanceOf(Error);
  expect(err.reason).toBe("ELINKS");
  expect(err.message).toContain("The move succeeded");
  return err.message;
};

/** Index a vault without a watcher, so nothing runs behind the test. */
async function openBare() {
  vault = await HeadlessVault.open(root);
  await vault.rescan();
  files = new HeadlessFileManager(vault);
}

function record(): Array<[string, string, string]> {
  const log: Array<[string, string, string]> = [];
  for (const name of ["create", "delete", "modify", "rename"]) {
    vault.on(name, ((e: TAbstractFile, oldPath?: string) => {
      log.push([name, e.path, oldPath ?? ""]);
    }) as never);
  }
  return log;
}

beforeEach(() => {
  dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "headless-rename-")),
  );
  root = path.join(dir, "vault");
  fs.mkdirSync(root);
});
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("renaming a file", () => {
  beforeEach(async () => {
    write("Notes/old.md", "# Old\nself [[old]] and [[#Old]]\n");
    write(
      "A.md",
      '---\nup: "[[old]]"\n---\nsee [[old]], [[old|alias]], [t](Notes/old.md)\n',
    );
    write("B.md", "no links\n");
    await openBare();
  });

  test("moves the file, rewrites links, keeps the rest", async () => {
    await files.renameFile(entry("Notes/old.md"), "Notes/new.md");

    expect(exists("Notes/old.md")).toBe(false);
    expect(read("Notes/new.md")).toBe("# Old\nself [[new]] and [[#Old]]\n");
    expect(read("A.md")).toBe(
      '---\nup: "[[new]]"\n---\nsee [[new]], [[new|alias]], [t](Notes/new.md)\n',
    );
    expect(read("B.md")).toBe("no links\n");
    expect(onDisk()).toEqual(["A.md", "B.md", "Notes/new.md"]);
    expect(indexed()).toEqual(onDisk());
  });

  test("keeps the same TFile object, with its new path and name", async () => {
    const before = entry("Notes/old.md") as TFile;
    await files.renameFile(before, "Notes/new.md");
    expect(vault.getFileByPath("Notes/new.md")).toBe(before);
    expect(vault.getFileByPath("Notes/old.md")).toBeNull();
    expect(before.path).toBe("Notes/new.md");
    expect(before.name).toBe("new.md");
    expect(before.basename).toBe("new");
    expect(before.extension).toBe("md");
    expect(before.parent?.path).toBe("Notes");
  });

  test("moving to another folder updates both parents", async () => {
    write("Archive/keep.md", "k");
    await vault.rescan();
    const file = entry("Notes/old.md") as TFile;
    await files.renameFile(file, "Archive/old.md");
    expect(file.parent?.path).toBe("Archive");
    expect((entry("Notes") as TFolder).children).toEqual([]);
    expect(
      (entry("Archive") as TFolder).children.map((c) => c.path).sort(),
    ).toEqual(["Archive/keep.md", "Archive/old.md"]);
    // The shortest-form links did not need to change.
    expect(read("A.md")).toContain(
      "see [[old]], [[old|alias]], [t](Archive/old.md)",
    );
  });

  test("the link index follows the rename", async () => {
    const cache = vault.metadata;
    expect(cache.resolvedLinks["A.md"]).toEqual({ "Notes/old.md": 4 });
    await files.renameFile(entry("Notes/old.md"), "Notes/new.md");
    expect(cache.resolvedLinks["A.md"]).toEqual({ "Notes/new.md": 4 });
    expect(cache.unresolvedLinks["A.md"]).toEqual({});
    expect(cache.resolvedLinks["Notes/old.md"]).toBeUndefined();
    expect(Object.keys(cache.resolvedLinks["Notes/new.md"])).toEqual([
      "Notes/new.md",
    ]);
    const moved = vault.getFileByPath("Notes/new.md") as TFile;
    expect(cache.getFileCache(moved)?.headings?.[0].heading).toBe("Old");
    expect(cache.getFirstLinkpathDest("new", "A.md")).toBe(moved);
    expect(cache.getFirstLinkpathDest("old", "A.md")).toBeNull();
  });

  test("emits rename with the old path, then modify for each rewritten note", async () => {
    const log = record();
    await files.renameFile(entry("Notes/old.md"), "Notes/new.md");
    expect(log[0]).toEqual(["rename", "Notes/new.md", "Notes/old.md"]);
    const rest = log.slice(1).map(([name, p]) => `${name} ${p}`);
    expect(rest.sort()).toEqual(["modify A.md", "modify Notes/new.md"].sort());
    expect(log.some(([name]) => name === "create" || name === "delete")).toBe(
      false,
    );
  });

  test("listeners see the link index already resolved", async () => {
    let seen: Record<string, number> | undefined;
    vault.on("rename", (() => {
      seen = { ...vault.metadata.resolvedLinks["Notes/new.md"] };
    }) as never);
    await files.renameFile(entry("Notes/old.md"), "Notes/new.md");
    expect(seen).toEqual({ "Notes/new.md": 1 });
  });

  test("a write in flight on the file finishes before it moves", async () => {
    const file = entry("Notes/old.md") as TFile;
    const pending = vault.modify(file, "changed [[old]]\n");
    await files.renameFile(file, "Notes/new.md");
    await pending;
    expect(read("Notes/new.md")).toBe("changed [[new]]\n");
  });

  test("no temp files are left behind", async () => {
    await files.renameFile(entry("Notes/old.md"), "Notes/new.md");
    expect(fs.readdirSync(root).sort()).toEqual(["A.md", "B.md", "Notes"]);
    expect(fs.readdirSync(path.join(root, "Notes"))).toEqual(["new.md"]);
  });

  test("a stale cache (disk edited behind the index) is not trusted", async () => {
    // Text that shifts every offset and adds a link the cache never saw.
    write("A.md", "prefix [[old]] longer line here\n[[old#H]] [[Notes/old]]\n");
    await files.renameFile(entry("Notes/old.md"), "Notes/new.md");
    expect(read("A.md")).toBe(
      "prefix [[new]] longer line here\n[[new#H]] [[Notes/new]]\n",
    );
  });
});

describe("a name with a colon", () => {
  test("markdown links stay links across successive renames", async () => {
    write("old.md", "old\n");
    write("A.md", "[See](old.md) [Angle](<old.md>)\n");
    await openBare();
    const cache = vault.metadata;

    await files.renameFile(entry("old.md"), "RFC: Auth.md");
    expect(read("A.md")).toBe(
      "[See](RFC%3A%20Auth.md) [Angle](<RFC%3A Auth.md>)\n",
    );
    expect(cache.resolvedLinks["A.md"]).toEqual({ "RFC: Auth.md": 2 });

    await files.renameFile(entry("RFC: Auth.md"), "Final.md");
    expect(read("A.md")).toBe("[See](Final.md) [Angle](<Final.md>)\n");
    expect(cache.resolvedLinks["A.md"]).toEqual({ "Final.md": 2 });
  });
});

describe("a name that links have to escape", () => {
  const LINKS =
    '---\nup: "[[old]]"\n---\n[[old]] [[old|alias]] ![[old]] [[old#H]]\n[See](old.md) [Angle](<old.md>) [Sub](old.md#H) `code`\n';

  test.each([
    "Using (fetch) <v2>.md",
    "My\u00a0Note.md",
    "50% & $5, 'a' \"b\".md",
    "a\u3000b\u2003c 🙂.md",
    "Déjà {vu} *x* ~y~ =z@!+;.md",
  ])("every link follows %p and then a plain name", async (weird) => {
    write("old.md", "old\n");
    write("A.md", LINKS);
    await openBare();
    const cache = vault.metadata;

    await files.renameFile(entry("old.md"), weird);
    expect(cache.resolvedLinks["A.md"]).toEqual({ [weird]: 8 });
    expect(cache.unresolvedLinks["A.md"]).toEqual({});

    await files.renameFile(entry(weird), "Final.md");
    expect(read("A.md")).toBe(LINKS.replace(/old/g, "Final"));
    expect(cache.resolvedLinks["A.md"]).toEqual({ "Final.md": 8 });
  });
});

describe("a rename that changes what a file is", () => {
  test("a text file renamed to .md is parsed as a note at once", async () => {
    write("old.txt", "# Title\nsee [[B]]\n");
    write("B.md", "b\n");
    await openBare();
    expect(vault.metadata.getCache("old.txt")).toBeNull();

    await files.renameFile(entry("old.txt"), "new.md");

    expect(vault.metadata.getCache("new.md")?.headings?.[0].heading).toBe(
      "Title",
    );
    expect(vault.metadata.resolvedLinks["new.md"]).toEqual({ "B.md": 1 });
    // A rescan finds nothing left to do for it.
    const log = record();
    await vault.rescan();
    expect(log.filter(([name]) => name === "modify")).toEqual([]);
  });

  test("a note renamed to .txt keeps no metadata", async () => {
    write("old.md", "# Title\nsee [[B]]\n");
    write("B.md", "b\n");
    await openBare();
    expect(vault.metadata.getCache("old.md")).not.toBeNull();

    await files.renameFile(entry("old.md"), "new.txt");

    expect(vault.metadata.getCache("new.txt")).toBeNull();
    expect(vault.metadata.getCache("old.md")).toBeNull();
    expect(vault.metadata.resolvedLinks["new.txt"]).toBeUndefined();
    expect(vault.metadata.resolvedLinks["old.md"]).toBeUndefined();
  });

  test("an edit made behind the index before the move is seen by the next reconcile", async () => {
    write("a.md", "# One\n");
    await openBare();
    // The save lands after the index last looked and before the move.
    vault.flushPending = async () => write("a.md", "# Twenty\n");

    await files.renameFile(entry("a.md"), "b.md");
    await vault.reconcile("b.md");

    expect(vault.metadata.getCache("b.md")?.headings?.[0].heading).toBe(
      "Twenty",
    );
  });
});

describe("renaming a folder", () => {
  beforeEach(async () => {
    write("Proj/a.md", "a [[Proj/sub/b]] [x](./sub/b.md) [[b]] [[a]]\n");
    write("Proj/sub/b.md", "b [[../a]] [[Proj/a]]\n");
    write("Proj/img.png", "png");
    write(
      "X.md",
      "[[Proj/a]] [[b]] [t](Proj/sub/b.md) ![[img.png]] ![](Proj/img.png)\n",
    );
    write("Other/o.md", "o [[Proj/a#H]]\n");
    await openBare();
  });

  test("moves every file and rewrites all links in one pass", async () => {
    await files.renameFile(entry("Proj"), "Work");

    expect(onDisk()).toEqual([
      "Other/o.md",
      "Work/a.md",
      "Work/img.png",
      "Work/sub/b.md",
      "X.md",
    ]);
    expect(indexed()).toEqual(onDisk());
    expect(read("X.md")).toBe(
      "[[Work/a]] [[b]] [t](Work/sub/b.md) ![[img.png]] ![](Work/img.png)\n",
    );
    expect(read("Other/o.md")).toBe("o [[Work/a#H]]\n");
    expect(read("Work/a.md")).toBe(
      "a [[Work/sub/b]] [x](./sub/b.md) [[b]] [[a]]\n",
    );
    expect(read("Work/sub/b.md")).toBe("b [[../a]] [[Work/a]]\n");
    expect(vault.metadata.unresolvedLinks["X.md"]).toEqual({});
    expect(vault.metadata.unresolvedLinks["Work/a.md"]).toEqual({});
  });

  test("the folder tree in the index follows", async () => {
    const proj = entry("Proj") as TFolder;
    await files.renameFile(proj, "Work");
    expect(vault.getAbstractFileByPath("Proj")).toBeNull();
    expect(vault.getAbstractFileByPath("Proj/sub")).toBeNull();
    expect(vault.getFolderByPath("Work")).toBe(proj);
    expect(proj.name).toBe("Work");
    expect(proj.parent?.isRoot()).toBe(true);
    const sub = vault.getFolderByPath("Work/sub") as TFolder;
    expect(sub.name).toBe("sub");
    expect(sub.parent).toBe(proj);
    expect(sub.children.map((c) => c.path)).toEqual(["Work/sub/b.md"]);
    expect(
      vault
        .getAllFolders()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["Other", "Work", "Work/sub"]);
  });

  test("emits rename for the folder, its subfolders and every file", async () => {
    const log = record();
    await files.renameFile(entry("Proj"), "Work");
    const renames = log.filter(([name]) => name === "rename");
    expect(renames.map(([, p, old]) => `${old} -> ${p}`).sort()).toEqual(
      [
        "Proj -> Work",
        "Proj/sub -> Work/sub",
        "Proj/a.md -> Work/a.md",
        "Proj/img.png -> Work/img.png",
        "Proj/sub/b.md -> Work/sub/b.md",
      ].sort(),
    );
    // Folders come before the files in them.
    expect(renames[0][2]).toBe("Proj");
  });

  test("a folder can move under another folder", async () => {
    await files.renameFile(entry("Proj"), "Other/Proj");
    expect(indexed()).toEqual(onDisk());
    // `Proj/a` still names the file as a path suffix, so those links stay.
    expect(read("X.md")).toBe(
      "[[Proj/a]] [[b]] [t](Proj/sub/b.md) ![[img.png]] ![](Proj/img.png)\n",
    );
    expect(vault.metadata.unresolvedLinks["X.md"]).toEqual({});
    expect(vault.metadata.resolvedLinks["X.md"]).toEqual({
      "Other/Proj/a.md": 1,
      "Other/Proj/sub/b.md": 2,
      "Other/Proj/img.png": 2,
    });
  });
});

describe("refusals", () => {
  beforeEach(async () => {
    write("a.md", "a [[b]]\n");
    write("b.md", "b\n");
    write("dir/c.md", "c\n");
    write("dir/sub/d.md", "d\n");
    write(".obsidian/app.json", "{}");
    await openBare();
  });

  const unchanged = () => {
    expect(onDisk()).toEqual(["a.md", "b.md", "dir/c.md", "dir/sub/d.md"]);
    expect(indexed()).toEqual(onDisk());
    expect(read("a.md")).toBe("a [[b]]\n");
  };

  test.each([
    ["an existing file", "a.md", "b.md", "EEXIST"],
    ["an existing folder", "a.md", "dir", "EEXIST"],
    ["a file over a folder name", "b.md", "dir/sub", "EEXIST"],
    ["a folder onto a file", "dir", "b.md", "EEXIST"],
    ["a missing parent folder", "a.md", "nope/a.md", "ENOENT"],
    ["a file as the parent", "a.md", "b.md/a.md", "ENOENT"],
    ["the same path", "a.md", "a.md", "EINVAL"],
    ["a folder into itself", "dir", "dir/sub/dir", "EINVAL"],
    ["a folder into its own child", "dir", "dir/x", "EINVAL"],
  ])("%s", async (_name, from, to, reason) => {
    await expect(files.renameFile(entry(from), to)).rejects.toMatchObject({
      reason,
    });
    unchanged();
  });

  test.each([
    ["a hidden destination", "a.md", ".hidden.md"],
    ["a hidden destination folder", "a.md", ".obsidian/a.md"],
    ["a destination that escapes the vault", "a.md", "../a.md"],
    ["a nested escape", "a.md", "dir/../../a.md"],
    ["an absolute destination", "a.md", "/tmp/a.md"],
    ["a NUL byte", "a.md", "x\0.md"],
    ["a newline", "a.md", "x\n- injected.md"],
    ["a control character in a folder", "a.md", "d\x1b/x.md"],
    ["the vault root as destination", "a.md", ""],
    ["a [ in the name", "a.md", "a[b.md"],
    ["a ] in the name", "a.md", "a]b.md"],
    ["a | in the name", "a.md", "a|b.md"],
    ["a # in the name", "a.md", "a#b.md"],
    ["a ^ in the name", "a.md", "a^b.md"],
    ["a backtick in the name", "a.md", "Using `fetch`.md"],
    ["whitespace that starts the name", "a.md", "dir/\u00a0a.md"],
    ["whitespace that ends the name", "a.md", "a.md "],
    ["a link-breaking character in a folder name", "dir", "d]ir"],
    [
      "a link-breaking character in the final name of a move",
      "a.md",
      "dir/a#.md",
    ],
  ])("%s is refused", async (_name, from, to) => {
    await expect(files.renameFile(entry(from), to)).rejects.toThrow(
      VaultPathError,
    );
    unchanged();
  });

  test("a file that already has such a name stays usable and can be renamed away", async () => {
    write("w]x#y.md", "w\n");
    await vault.rescan();
    expect(read("w]x#y.md")).toBe("w\n");
    await files.renameFile(entry("w]x#y.md"), "plain.md");
    expect(exists("plain.md")).toBe(true);
    expect(exists("w]x#y.md")).toBe(false);
  });

  test("only the name the rename gives is checked, not the folders above it", async () => {
    write("Archive#2026/kept.md", "k\n");
    write("Notes/old.md", "old\n");
    write("x.md", "[[old]] [[Notes/old]] [t](Notes/old.md)\n");
    await vault.rescan();

    // A new name that a link cannot spell is still refused, wherever it goes.
    await expect(
      files.renameFile(entry("Notes/old.md"), "Archive#2026/new#1.md"),
    ).rejects.toThrow(VaultPathError);
    expect(read("Notes/old.md")).toBe("old\n");

    // A clean name inside a folder with such a name is fine. A wikilink no
    // spelling can reach stays as written and is reported, and a markdown
    // link is rewritten with the `#` escaped.
    const err = (await files
      .renameFile(entry("Notes/old.md"), "Archive#2026/new.md")
      .catch((e: Error) => e)) as Error & { reason?: string };
    expect(err.reason).toBe("ELINKS");
    expect(err.message).toContain("The move succeeded");
    expect(err.message).toContain("x.md");
    expect(err.message).toContain("[[Notes/old]]");
    expect(err.message).not.toContain("[t](");
    expect(read("Archive#2026/new.md")).toBe("old\n");
    expect(exists("Notes/old.md")).toBe(false);
    expect(read("x.md")).toBe(
      "[[new]] [[Notes/old]] [t](Archive%232026/new.md)\n",
    );

    // A whole folder moves in, keeping its own name.
    write("Stuff/s.md", "s\n");
    await vault.rescan();
    await files.renameFile(entry("Stuff"), "Archive#2026/Stuff");
    expect(read("Archive#2026/Stuff/s.md")).toBe("s\n");

    // And a file can leave the folder.
    await files.renameFile(entry("Archive#2026/kept.md"), "Notes/kept.md");
    expect(read("Notes/kept.md")).toBe("k\n");
    expect(exists("Archive#2026/kept.md")).toBe(false);
  });

  test("a file keeps its odd name when it moves to another folder", async () => {
    write("w]x#y.md", "w\n");
    write("Sub/keep.md", "k\n");
    await vault.rescan();
    await files.renameFile(entry("w]x#y.md"), "Sub/w]x#y.md");
    expect(read("Sub/w]x#y.md")).toBe("w\n");
    expect(exists("w]x#y.md")).toBe(false);
  });

  test("the vault root cannot be renamed", async () => {
    await expect(files.renameFile(vault.getRoot(), "all")).rejects.toThrow(
      VaultPathError,
    );
    unchanged();
  });

  test("a destination through a symlinked folder is refused", async () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "link"));
    await vault.rescan();
    await expect(files.renameFile(entry("a.md"), "link/a.md")).rejects.toThrow(
      VaultPathError,
    );
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(read("a.md")).toBe("a [[b]]\n");
  });

  test("a symlink in the way of the destination is refused, not replaced", async () => {
    const outside = path.join(dir, "outside.md");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(root, "trap.md"));
    await vault.rescan();
    await expect(files.renameFile(entry("a.md"), "trap.md")).rejects.toThrow(
      VaultPathError,
    );
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    expect(read("a.md")).toBe("a [[b]]\n");
  });

  test("a destination created on disk behind the index is never replaced", async () => {
    // Not in the index yet, so only the exclusive claim can refuse it.
    write("late.md", "mine");
    await expect(
      files.renameFile(entry("a.md"), "late.md"),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(read("late.md")).toBe("mine");
    expect(read("a.md")).toBe("a [[b]]\n");
    // No placeholder or temp file was left in the vault.
    expect(fs.readdirSync(root).sort()).toEqual([
      ".obsidian",
      "a.md",
      "b.md",
      "dir",
      "late.md",
    ]);
  });

  test("errors do not reveal the host path", async () => {
    const err = await files
      .renameFile(entry("a.md"), "b.md")
      .catch((e: Error) => e);
    expect((err as Error).message).not.toContain(dir);
  });

  test("a source that left the index is refused", async () => {
    const stale = entry("a.md");
    await vault.delete(stale);
    await expect(files.renameFile(stale, "z.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("a temporary name that cannot be removed", () => {
  test("the move stands, links are rewritten, and the error names the temp", async () => {
    write("old.md", "# Old\n");
    write("n.md", "see [[old]]\n");
    vault = await HeadlessVault.open(root, {
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
    files = new HeadlessFileManager(vault);
    const err = await files
      .renameFile(entry("old.md"), "new.md")
      .catch((e: Error) => e);
    const hidden = fs.readdirSync(root).filter((n) => n.endsWith(".tmp"));
    expect(hidden.length).toBe(1);
    expect((err as { reason?: string }).reason).toBe("ELEFTOVER");
    expect((err as Error).message).toContain(hidden[0]);
    expect((err as Error).message).not.toContain(dir);
    expect(read("new.md")).toBe("# Old\n");
    expect(exists("old.md")).toBe(false);
    expect(read("n.md")).toBe("see [[new]]\n");
    // The index lists the moved file and never the hidden temp.
    expect(indexed()).toEqual(["n.md", "new.md"]);
  });
});

describe("concurrent writers", () => {
  beforeEach(async () => {
    write("F/target.md", "t\n");
    write("F/n.md", '---\nrelated: "[[F/target]]"\n---\nbody\n');
    await openBare();
  });

  /** Pause the next read of `rel` after it returned, until `release` runs. */
  function pauseAfterRead(rel: string) {
    let reached!: () => void;
    let release!: () => void;
    const hit = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const read = vault.read.bind(vault);
    let paused = false;
    vault.read = async (file: TFile) => {
      const text = await read(file);
      if (!paused && file.path === rel) {
        paused = true;
        reached();
        await gate;
      }
      return text;
    };
    return { hit, release };
  }

  test("a property write paused after its read does not undo the link rewrite", async () => {
    const pause = pauseAfterRead("F/n.md");
    const note = vault.getFileByPath("F/n.md") as TFile;
    const log: string[] = [];
    vault.on("modify", ((f: TFile) => log.push(`modify ${f.path}`)) as never);
    vault.flushPending = async () => {
      log.push("rename began");
    };

    const write = files.processFrontMatter(note, (fm) => {
      fm.status = "done";
    });
    await pause.hit;
    const renamed = files.renameFile(entry("F"), "G");
    pause.release();
    await Promise.all([write, renamed]);

    expect(log.slice(0, 2)).toEqual(["modify F/n.md", "rename began"]);
    expect(exists("F")).toBe(false);
    expect(read("G/n.md")).toBe(
      '---\nrelated: "[[G/target]]"\nstatus: done\n---\nbody\n',
    );
  });

  test("a writer that waits for the rename writes to the new path with fresh text", async () => {
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((r) => (began = r));
    vault.flushPending = async () => {
      began();
      await new Promise<void>((r) => (release = r));
    };
    const note = vault.getFileByPath("F/n.md") as TFile;

    const renamed = files.renameFile(entry("F"), "G");
    await started;
    // The rename holds the vault: this write starts after it ends.
    const appended = vault.process(note, (text) => `${text}more\n`);
    release();
    await Promise.all([renamed, appended]);

    expect(exists("F")).toBe(false);
    expect(read("G/n.md")).toBe(
      '---\nrelated: "[[G/target]]"\n---\nbody\nmore\n',
    );
    expect(note.path).toBe("G/n.md");
  });
});

describe("an external edit the watcher has not applied", () => {
  test("is applied before the rename picks the notes that link to the file", async () => {
    write("old.md", "o\n");
    write("C.md", "none\n");
    await openBare();
    const listeners = new Map<string, (type: string, name: string) => void>();
    // A debounce that never ends: only the flush can apply the event.
    const watcher = new VaultWatcher(vault, 3_600_000, (abs, listener) => {
      listeners.set(abs, listener);
      return { close() {}, on() {} };
    });
    watcher.start();
    cleanup.push(() => watcher.stop());
    vault.flushPending = () => watcher.flush();

    write("C.md", "now links [[old]]\n");
    // The watcher is keyed on the vault's resolved root, which is not the
    // temp path itself where the temp dir is a symlink (macOS: /var).
    listeners.get(vault.root)!("change", "C.md");
    expect(vault.metadata.resolvedLinks["C.md"]).toEqual({});

    await files.renameFile(entry("old.md"), "new.md");

    expect(read("C.md")).toBe("now links [[new]]\n");
  });
});

describe("link failures", () => {
  test("the move stands and the error names the notes that were not updated", async () => {
    write("old.md", "o\n");
    write("good.md", "[[old]]\n");
    write("bad.md", "[[old]]\n");
    await openBare();
    // Unreadable behind the index: a folder where the note was.
    fs.rmSync(path.join(root, "bad.md"));
    fs.mkdirSync(path.join(root, "bad.md"));

    const err = (await files
      .renameFile(entry("old.md"), "new.md")
      .catch((e: Error) => e)) as Error & { reason?: string };

    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe("ELINKS");
    expect(err.message).toContain("The move succeeded");
    expect(err.message).toContain("1 note(s)");
    expect(err.message).toContain("bad.md");
    expect(err.message).not.toContain("good.md");
    expect(err.message).not.toContain(dir);
    expect(exists("old.md")).toBe(false);
    expect(read("new.md")).toBe("o\n");
    expect(read("good.md")).toBe("[[new]]\n");
  });

  test("a wikilink to a file left in a folder a link cannot spell stays and is reported", async () => {
    write("Archive#2026/source.md", "[[./kept]] [[source#H]] [k](./kept.md)\n");
    write("Archive#2026/kept.md", "k\n");
    write("Index.md", "[[source]]\n");
    write("Notes/other.md", "o\n");
    await openBare();

    const message = await linksError(
      "Archive#2026/source.md",
      "Notes/moved.md",
    );

    // The markdown link can name the folder with %23, the wikilink cannot.
    expect(read("Notes/moved.md")).toBe(
      "[[./kept]] [[moved#H]] [k](../Archive%232026/kept.md)\n",
    );
    expect(read("Index.md")).toBe("[[moved]]\n");
    expect(message).toContain("1 note(s)");
    expect(message).toContain("Notes/moved.md");
    expect(message).toContain("[[./kept]]");
    expect(message).not.toContain("[k](");
    expect(message).not.toContain("Index.md");
  });

  test("a subfolder leaving such a folder keeps the link it cannot spell", async () => {
    write("Archive#2026/kept.md", "k\n");
    write("Archive#2026/Sub/a.md", "[[../kept]] [[./b]] [t](../../top.md)\n");
    write("Archive#2026/Sub/b.md", "b\n");
    write("top.md", "t\n");
    await openBare();

    const message = await linksError("Archive#2026/Sub", "Sub");

    expect(read("Sub/a.md")).toBe("[[../kept]] [[./b]] [t](../top.md)\n");
    expect(message).toContain("Sub/a.md ");
    expect(message).toContain("[[../kept]]");
    expect(message).not.toContain("[[./b]]");
  });

  test("a folder rename keeps a link its descendants' names cannot spell", async () => {
    // From the root `[[n]]` leads to P/a#b/n.md, the alphabetically first
    // of two equal candidates. After the rename the other one wins, and the
    // full path the link would need cannot be written.
    write("P/a#b/n.md", "n\n");
    write("P/other.md", "o\n");
    write("Zed/x/n.md", "z\n");
    write("X.md", "[[n]] [[P/other]]\n");
    await openBare();

    const message = await linksError("P", "Work");

    expect(read("X.md")).toBe("[[n]] [[Work/other]]\n");
    expect(message).toContain("X.md ");
    expect(message).toContain("[[n]]");
  });
});

describe("names with # and % in markdown links", () => {
  test("a link to a file in a # folder is resolved, then rewritten on rename", async () => {
    write("a#b/old.md", "o\n");
    write("100%/p.md", "p\n");
    write("N.md", "[See old](a%23b/old.md) [p](100%25/p.md) [[a#b/old]]\n");
    await openBare();
    expect(vault.metadata.resolvedLinks["N.md"]).toEqual({
      "a#b/old.md": 1,
      "100%/p.md": 1,
    });

    await files.renameFile(entry("a#b/old.md"), "a#b/new.md");
    await files.renameFile(entry("100%"), "Pct");

    expect(read("N.md")).toBe(
      "[See old](a%23b/new.md) [p](Pct/p.md) [[a#b/old]]\n",
    );
    expect(vault.metadata.resolvedLinks["N.md"]).toEqual({
      "a#b/new.md": 1,
      "Pct/p.md": 1,
    });
  });
});

describe("canvases and bases", () => {
  const canvas = (nodes: unknown[]) =>
    `${JSON.stringify({ nodes, edges: [] }, null, "\t")}\n`;
  const box = { x: 0, y: 0, width: 100, height: 100 };

  test("a canvas follows a renamed file, in its file nodes and its text", async () => {
    write("Notes/old.md", "# Old\n");
    write(
      "Board.canvas",
      canvas([
        { id: "a", type: "file", file: "Notes/old.md", ...box },
        { id: "b", type: "text", text: "see [[old]]", ...box },
        { id: "c", type: "file", file: "Notes/other.md", ...box },
      ]),
    );
    write("Notes/other.md", "o\n");
    await openBare();

    await files.renameFile(entry("Notes/old.md"), "Notes/new.md");

    expect(read("Board.canvas")).toBe(
      canvas([
        { id: "a", type: "file", file: "Notes/new.md", ...box },
        { id: "b", type: "text", text: "see [[new]]", ...box },
        { id: "c", type: "file", file: "Notes/other.md", ...box },
      ]),
    );
  });

  test("a canvas follows a renamed folder, including a file that is not a note", async () => {
    write("Proj/a.md", "a\n");
    write("Proj/img.png", "png");
    write(
      "Board.canvas",
      canvas([
        { id: "a", type: "file", file: "Proj/a.md", ...box },
        { id: "b", type: "file", file: "Proj/img.png", ...box },
        {
          id: "c",
          type: "text",
          text: "[[Proj/a]] and [x](Proj/a.md)",
          ...box,
        },
      ]),
    );
    await openBare();

    await files.renameFile(entry("Proj"), "Work");

    expect(read("Board.canvas")).toBe(
      canvas([
        { id: "a", type: "file", file: "Work/a.md", ...box },
        { id: "b", type: "file", file: "Work/img.png", ...box },
        {
          id: "c",
          type: "text",
          text: "[[Work/a]] and [x](Work/a.md)",
          ...box,
        },
      ]),
    );
  });

  test("a canvas inside a renamed folder is rewritten at its new place", async () => {
    write("Proj/a.md", "a\n");
    write(
      "Proj/Board.canvas",
      canvas([{ id: "a", type: "file", file: "Proj/a.md", ...box }]),
    );
    await openBare();

    await files.renameFile(entry("Proj"), "Work");

    expect(read("Work/Board.canvas")).toBe(
      canvas([{ id: "a", type: "file", file: "Work/a.md", ...box }]),
    );
  });

  test("a base is never changed, and one that links to the file is named", async () => {
    write("Notes/old.md", "# Old\n");
    const text =
      'views:\n  - type: table\n    name: "[[old]]"\n    desc: "[t](Notes/old.md)"\n';
    write("Tasks.base", text);
    await openBare();

    const { warnings } = await collectRenameWarnings(() =>
      files.renameFile(entry("Notes/old.md"), "Notes/new.md"),
    );

    expect(read("Tasks.base")).toBe(text);
    expect(warnings).toEqual([expect.stringContaining("Tasks.base")]);
  });

  test("a filter value that looks like a link is not rewritten and is named", async () => {
    write("Notes/old.md", "o\n");
    const text = 'filters:\n  and:\n    - note.text == "[[old]]"\n';
    write("Tasks.base", text);
    await openBare();

    const { warnings } = await collectRenameWarnings(() =>
      files.renameFile(entry("Notes/old.md"), "Notes/new.md"),
    );

    expect(read("Tasks.base")).toBe(text);
    expect(warnings).toEqual([expect.stringContaining("Tasks.base")]);
  });

  test("a base that links into a renamed folder is named", async () => {
    write("Proj/a.md", "a\n");
    const text = 'x: "[[Proj/a]]"\n';
    write("Tasks.base", text);
    write("Clean.base", 'x: "[[Elsewhere]]"\n');
    write("Elsewhere.md", "e\n");
    await openBare();

    const { warnings } = await collectRenameWarnings(() =>
      files.renameFile(entry("Proj"), "Work"),
    );

    expect(read("Tasks.base")).toBe(text);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Tasks.base");
  });

  test("a filter that names the old path is left alone and reported", async () => {
    write("Projects/a.md", "a\n");
    write("Other.md", "o\n");
    const filters =
      'filters:\n  and:\n    - file.inFolder("Projects")\n    - file.path != "Other.md"\n';
    write("Tasks.base", filters);
    write("Clean.base", 'filters:\n  and:\n    - file.ext == "md"\n');
    await openBare();

    const warnings: string[] = [];
    await collectRenameWarnings(() =>
      files.renameFile(entry("Projects"), "Work"),
    ).then((r) => warnings.push(...r.warnings));

    expect(read("Tasks.base")).toBe(filters);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Tasks.base");
    expect(warnings[0]).toContain('"Projects"');
    expect(read("Work/a.md")).toBe("a\n");
  });

  test("a filter that names a renamed note is reported with the note's path", async () => {
    write("Notes/old.md", "o\n");
    write(
      "Tasks.base",
      'filters:\n  and:\n    - file.path == "Notes/old.md"\n',
    );
    await openBare();

    const { warnings } = await collectRenameWarnings(() =>
      files.renameFile(entry("Notes/old.md"), "Notes/new.md"),
    );

    expect(warnings).toEqual([expect.stringContaining('"Notes/old.md"')]);
  });

  test("a rename outside a collector reports to no one and still works", async () => {
    write("Projects/a.md", "a\n");
    write("Tasks.base", 'filters:\n  and:\n    - file.folder == "Projects"\n');
    await openBare();
    await files.renameFile(entry("Projects"), "Work");
    expect(exists("Work/a.md")).toBe(true);
  });

  test("a canvas link no spelling reaches is reported like a note's, and the move stands", async () => {
    write("Notes/old.md", "o\n");
    write("Odd#Dir/keep.md", "k\n");
    write(
      "Board.canvas",
      canvas([{ id: "a", type: "text", text: "[[Notes/old]]", ...box }]),
    );
    await openBare();

    const message = await linksError("Notes/old.md", "Odd#Dir/new.md");

    expect(message).toContain("Board.canvas");
    expect(message).toContain("[[Notes/old]]");
    expect(read("Odd#Dir/new.md")).toBe("o\n");
  });

  test("an unreadable canvas does not stop the others", async () => {
    write("Notes/old.md", "o\n");
    write("Broken.canvas", "{ not json");
    write(
      "Board.canvas",
      canvas([{ id: "a", type: "file", file: "Notes/old.md", ...box }]),
    );
    await openBare();

    await files.renameFile(entry("Notes/old.md"), "Notes/new.md");

    expect(read("Broken.canvas")).toBe("{ not json");
    expect(read("Board.canvas")).toContain("Notes/new.md");
  });
});

describe("with the watcher running", () => {
  test("the index matches the disk once the queue drains", async () => {
    write("Proj/a.md", "a [[b]]\n");
    write("Proj/b.md", "b [[Proj/a]]\n");
    write("X.md", "[[Proj/a]] [[b]]\n");
    const handle = await createHeadlessApp(root);
    cleanup.push(() => handle.close());
    vault = handle.vault;

    await handle.app.fileManager.renameFile(entry("Proj") as never, "Work");
    await vault.rescan();

    expect(indexed()).toEqual(onDisk());
    expect(vault.getAllFolders().map((f) => f.path)).toEqual(["Work"]);
    expect(read("X.md")).toBe("[[Work/a]] [[b]]\n");
    expect(vault.metadata.unresolvedLinks["X.md"]).toEqual({});
  });
});
