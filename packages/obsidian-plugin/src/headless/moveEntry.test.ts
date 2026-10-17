import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moveNoReplace, STRANDED, type MoveOps } from "./moveEntry";

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * An in-memory directory of entries. `caseInsensitive` makes two spellings
 * of a name one entry, as macOS and Windows do. Without `hardLinks`, `link`
 * fails the way a filesystem without them does. `rename` replaces a file at
 * the destination, like POSIX.
 */
function fakeFs(options: { caseInsensitive?: boolean; hardLinks?: boolean }) {
  const entries = new Map<string, { name: string; id: number }>();
  const calls: string[] = [];
  let nextId = 1;
  const key = (p: string) => (options.caseInsensitive ? p.toLowerCase() : p);
  const get = (p: string) => {
    const e = entries.get(key(p));
    if (!e) throw errno("ENOENT");
    return e;
  };
  const ops: MoveOps = {
    lstat: async (p) => ({ dev: 1, ino: get(p).id }),
    link: async (src, dst) => {
      calls.push("link");
      if (options.hardLinks === false) throw errno("EPERM");
      const from = get(src);
      if (entries.has(key(dst))) throw errno("EEXIST");
      entries.set(key(dst), { name: dst, id: from.id });
    },
    unlink: async (p) => {
      get(p);
      entries.delete(key(p));
    },
    rename: async (src, dst) => {
      calls.push("rename");
      const from = get(src);
      entries.delete(key(src));
      entries.set(key(dst), { name: dst, id: from.id });
    },
    createExclusive: async (p) => {
      calls.push("createExclusive");
      if (entries.has(key(p))) throw errno("EEXIST");
      entries.set(key(p), { name: p, id: nextId++ });
    },
  };
  const add = (p: string) => {
    entries.set(key(p), { name: p, id: nextId++ });
  };
  const names = () => [...entries.values()].map((e) => e.name).sort();
  return { ops, add, names, calls, entries };
}

const tmpName = () => ".tmp-sibling";
const OWNED = "/v/.tmp-sibling";

describe("moving a file", () => {
  test("owns the entry, links the new name, then removes the owned name", async () => {
    const vol = fakeFs({});
    vol.add("/v/a.md");
    const moved = vol.entries.get("/v/a.md");
    await moveNoReplace("/v/a.md", "/v/b.md", false, vol.ops, tmpName);
    expect(vol.names()).toEqual(["/v/b.md"]);
    expect(vol.entries.get("/v/b.md")?.id).toBe(moved?.id);
    expect(vol.calls).toEqual(["rename", "link"]);
  });

  test("a save landing at the old name between the steps is kept", async () => {
    const vol = fakeFs({});
    vol.add("/v/a.md");
    const link = vol.ops.link;
    vol.ops.link = async (src, dst) => {
      await link(src, dst);
      // An external atomic save replaces the old name before it is removed.
      vol.add("/v/a.md");
    };
    await moveNoReplace("/v/a.md", "/v/b.md", false, vol.ops, tmpName);
    expect(vol.names()).toEqual(["/v/a.md", "/v/b.md"]);
    expect(vol.entries.get("/v/a.md")?.id).not.toBe(
      vol.entries.get("/v/b.md")?.id,
    );
  });

  test("a taken destination is never replaced", async () => {
    const vol = fakeFs({});
    vol.add("/v/a.md");
    vol.add("/v/b.md");
    const taken = vol.entries.get("/v/b.md");
    await expect(
      moveNoReplace("/v/a.md", "/v/b.md", false, vol.ops, tmpName),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(vol.names()).toEqual(["/v/a.md", "/v/b.md"]);
    expect(vol.entries.get("/v/b.md")).toBe(taken);
  });

  test("a refused link puts the same entry back at the old name", async () => {
    const vol = fakeFs({});
    vol.add("/v/a.md");
    vol.add("/v/b.md");
    const moved = vol.entries.get("/v/a.md");
    await expect(
      moveNoReplace("/v/a.md", "/v/b.md", false, vol.ops, tmpName),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(vol.names()).toEqual(["/v/a.md", "/v/b.md"]);
    expect(vol.entries.get("/v/a.md")?.id).toBe(moved?.id);
    expect(vol.entries.has(OWNED)).toBe(false);
  });

  test("a restore that finds the old name taken keeps the owned file and names it", async () => {
    const vol = fakeFs({});
    vol.add("/v/a.md");
    vol.add("/v/b.md");
    const kept = vol.entries.get("/v/a.md");
    const rename = vol.ops.rename;
    vol.ops.rename = async (src, dst) => {
      await rename(src, dst);
      // A save lands at the old name right after it is captured.
      vol.add("/v/a.md");
    };
    await expect(
      moveNoReplace("/v/a.md", "/v/b.md", false, vol.ops, tmpName),
    ).rejects.toMatchObject({
      reason: STRANDED,
      leftover: OWNED,
      message: expect.stringContaining(OWNED),
    });
    expect(vol.names()).toEqual(["/v/.tmp-sibling", "/v/a.md", "/v/b.md"]);
    expect(vol.entries.get(OWNED)?.id).toBe(kept?.id);
    expect(vol.entries.get("/v/a.md")?.id).not.toBe(kept?.id);
  });

  test("without hard links it moves onto an exclusive placeholder", async () => {
    const vol = fakeFs({ hardLinks: false });
    vol.add("/v/a.md");
    await moveNoReplace("/v/a.md", "/v/b.md", false, vol.ops, tmpName);
    expect(vol.names()).toEqual(["/v/b.md"]);
    expect(vol.calls).toEqual(["rename", "link", "createExclusive", "rename"]);
  });

  test("without hard links a taken destination is still refused", async () => {
    const vol = fakeFs({ hardLinks: false });
    vol.add("/v/a.md");
    vol.add("/v/b.md");
    await expect(
      moveNoReplace("/v/a.md", "/v/b.md", false, vol.ops, tmpName),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(vol.names()).toEqual(["/v/a.md", "/v/b.md"]);
  });

  test("a failed move leaves the source and removes the placeholder", async () => {
    const vol = fakeFs({ hardLinks: false });
    vol.add("/v/a.md");
    const rename = vol.ops.rename;
    vol.ops.rename = async (src, dst) => {
      if (dst === "/v/b.md") throw errno("EIO");
      await rename(src, dst);
    };
    await expect(
      moveNoReplace("/v/a.md", "/v/b.md", false, vol.ops, tmpName),
    ).rejects.toMatchObject({ code: "EIO" });
    expect(vol.names()).toEqual(["/v/a.md"]);
  });

  test("a failed removal of the owned name keeps the move and reports the temp", async () => {
    const vol = fakeFs({});
    vol.add("/v/a.md");
    const moved = vol.entries.get("/v/a.md");
    const unlink = vol.ops.unlink;
    vol.ops.unlink = async (p) => {
      if (p === OWNED) throw errno("EACCES");
      await unlink(p);
    };
    const result = await moveNoReplace(
      "/v/a.md",
      "/v/b.md",
      false,
      vol.ops,
      tmpName,
    );
    expect(result).toEqual({ leftover: OWNED });
    expect(vol.names()).toEqual(["/v/.tmp-sibling", "/v/b.md"]);
    expect(vol.entries.get("/v/b.md")?.id).toBe(moved?.id);
  });

  test("a failed removal never unlinks a destination an external save replaced", async () => {
    const vol = fakeFs({});
    vol.add("/v/a.md");
    const unlink = vol.ops.unlink;
    let savedId: number | undefined;
    vol.ops.unlink = async (p) => {
      if (p === OWNED) {
        // An atomic save replaces the new name, then the removal fails.
        vol.add("/v/b.md");
        savedId = vol.entries.get("/v/b.md")?.id;
        throw errno("EACCES");
      }
      await unlink(p);
    };
    const result = await moveNoReplace(
      "/v/a.md",
      "/v/b.md",
      false,
      vol.ops,
      tmpName,
    );
    expect(result.leftover).toBe(OWNED);
    expect(vol.names()).toEqual(["/v/.tmp-sibling", "/v/b.md"]);
    expect(vol.entries.get("/v/b.md")?.id).toBe(savedId);
  });

  test("a restore whose owned name cannot be removed is reported as stranded", async () => {
    const vol = fakeFs({});
    vol.add("/v/a.md");
    vol.add("/v/b.md");
    const unlink = vol.ops.unlink;
    vol.ops.unlink = async (p) => {
      if (p === OWNED) throw errno("EACCES");
      await unlink(p);
    };
    await expect(
      moveNoReplace("/v/a.md", "/v/b.md", false, vol.ops, tmpName),
    ).rejects.toMatchObject({ reason: STRANDED, leftover: OWNED });
    expect(vol.names()).toEqual(["/v/.tmp-sibling", "/v/a.md", "/v/b.md"]);
  });
});

describe("moving a folder", () => {
  test("renames once the destination is absent, without creating it first", async () => {
    const vol = fakeFs({});
    vol.add("/v/A");
    await moveNoReplace("/v/A", "/v/B", true, vol.ops, tmpName);
    expect(vol.names()).toEqual(["/v/B"]);
    expect(vol.calls).toEqual(["rename"]);
  });

  test("a taken destination is refused untouched", async () => {
    const vol = fakeFs({});
    vol.add("/v/A");
    vol.add("/v/B");
    await expect(
      moveNoReplace("/v/A", "/v/B", true, vol.ops, tmpName),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(vol.names()).toEqual(["/v/A", "/v/B"]);
    expect(vol.calls).toEqual([]);
  });
});

describe("a case-only rename", () => {
  test("a file moves through a temporary sibling name", async () => {
    const vol = fakeFs({ caseInsensitive: true });
    vol.add("/v/Note.md");
    await moveNoReplace("/v/Note.md", "/v/note.md", false, vol.ops, tmpName);
    expect(vol.names()).toEqual(["/v/note.md"]);
  });

  test("a folder moves through a temporary sibling name", async () => {
    const vol = fakeFs({ caseInsensitive: true });
    vol.add("/v/Dir");
    await moveNoReplace("/v/Dir", "/v/dir", true, vol.ops, tmpName);
    expect(vol.names()).toEqual(["/v/dir"]);
  });

  test("a filesystem without hard links does the same", async () => {
    const vol = fakeFs({ caseInsensitive: true, hardLinks: false });
    vol.add("/v/Note.md");
    await moveNoReplace("/v/Note.md", "/v/note.md", false, vol.ops, tmpName);
    expect(vol.names()).toEqual(["/v/note.md"]);
  });

  test("a different entry under the other spelling is still refused", async () => {
    const vol = fakeFs({});
    vol.add("/v/Note.md");
    vol.add("/v/note.md");
    await expect(
      moveNoReplace("/v/Note.md", "/v/note.md", false, vol.ops, tmpName),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(vol.names()).toEqual(["/v/Note.md", "/v/note.md"]);
  });

  test("another name for the same inode is refused and restored", async () => {
    // Two hard links of one file are two entries, not one spelling.
    const vol = fakeFs({});
    vol.add("/v/a.md");
    vol.entries.set("/v/b.md", {
      name: "/v/b.md",
      id: vol.entries.get("/v/a.md")!.id,
    });
    await expect(
      moveNoReplace("/v/a.md", "/v/b.md", false, vol.ops, tmpName),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(vol.names()).toEqual(["/v/a.md", "/v/b.md"]);
  });
});

describe("on the real filesystem", () => {
  test("moves a file and a folder, and refuses a taken name", async () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "headless-move-")),
    );
    try {
      const at = (name: string) => path.join(dir, name);
      fs.writeFileSync(at("a.md"), "a");
      fs.writeFileSync(at("taken.md"), "mine");
      fs.mkdirSync(at("d"));
      fs.writeFileSync(path.join(at("d"), "x.md"), "x");

      await moveNoReplace(at("a.md"), at("b.md"), false);
      await moveNoReplace(at("d"), at("e"), true);
      await expect(
        moveNoReplace(at("b.md"), at("taken.md"), false),
      ).rejects.toMatchObject({ code: "EEXIST" });

      expect(fs.readdirSync(dir).sort()).toEqual(["b.md", "e", "taken.md"]);
      expect(fs.readFileSync(at("taken.md"), "utf8")).toBe("mine");
      expect(fs.readFileSync(path.join(at("e"), "x.md"), "utf8")).toBe("x");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
