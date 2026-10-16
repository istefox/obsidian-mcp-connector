import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hasBackslashName,
  isSkippedPath,
  isSkippedSegment,
  normalizeVaultPath,
  VaultFs,
  VaultPathError,
} from "./vaultFs";

let dir: string;
let vault: string;
let outside: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vaultfs-"));
  vault = path.join(dir, "vault");
  outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(vault, "notes"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.md"), "secret");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("normalizeVaultPath", () => {
  test("tidies separators and dots", () => {
    expect(normalizeVaultPath("a//b/./c.md")).toBe("a/b/c.md");
    expect(normalizeVaultPath("")).toBe("");
  });

  test.each([
    ["a/../b.md"],
    ["../x.md"],
    ["/etc/passwd"],
    ["C:/x.md"],
    ["a\0b.md"],
    [".obsidian/app.json"],
    ["notes/.git/config"],
  ])("rejects %p", (input) => {
    expect(() => normalizeVaultPath(input)).toThrow(VaultPathError);
  });

  describe("a backslash", () => {
    test("is a separator where the system says so", () => {
      expect(normalizeVaultPath("a\\b\\c.md", "\\")).toBe("a/b/c.md");
      expect(() => normalizeVaultPath("a\\..\\b.md", "\\")).toThrow(
        VaultPathError,
      );
    });

    test.each([["a\\b.md"], ["dir/a\\b.md"], ["a\\..\\b.md"], ["\\x.md"]])(
      "is refused with a clear error on POSIX in %p, never read as '/'",
      (input) => {
        let error: unknown;
        try {
          normalizeVaultPath(input, "/");
        } catch (err) {
          error = err;
        }
        expect(error).toBeInstanceOf(VaultPathError);
        expect((error as VaultPathError).reason).toBe("EINVAL");
        expect((error as VaultPathError).message).toContain("backslash");
      },
    );

    test("is a name character the index leaves out on POSIX only", () => {
      expect(hasBackslashName("a\\b.md", "/")).toBe(true);
      expect(hasBackslashName("a\\b.md", "\\")).toBe(false);
      expect(isSkippedSegment("a\\b.md", "/")).toBe(true);
      expect(isSkippedSegment("a\\b.md", "\\")).toBe(false);
      expect(isSkippedSegment(".hidden", "\\")).toBe(true);
      expect(isSkippedPath("dir/a\\b.md", "/")).toBe(true);
      expect(isSkippedPath("dir/ab.md", "/")).toBe(false);
    });
  });
});

describe("VaultFs.resolve", () => {
  test("resolves existing and new paths inside the root", async () => {
    const vfs = await VaultFs.open(vault);
    expect(await vfs.resolve("notes")).toBe(path.join(vfs.root, "notes"));
    expect(await vfs.resolve("notes/new.md")).toBe(
      path.join(vfs.root, "notes", "new.md"),
    );
  });

  test("refuses a symlinked folder that leaves the root", async () => {
    fs.symlinkSync(outside, path.join(vault, "notes", "link"));
    const vfs = await VaultFs.open(vault);
    await expect(vfs.resolve("notes/link/secret.md")).rejects.toThrow(
      VaultPathError,
    );
    // A new file below the escaping link is judged by where the link points.
    await expect(vfs.resolve("notes/link/new.md")).rejects.toThrow(
      VaultPathError,
    );
  });

  test("refuses a symlinked file that leaves the root", async () => {
    fs.symlinkSync(
      path.join(outside, "secret.md"),
      path.join(vault, "leak.md"),
    );
    const vfs = await VaultFs.open(vault);
    await expect(vfs.resolve("leak.md")).rejects.toThrow(VaultPathError);
  });

  test("refuses a dangling symlink, which a create would write through", async () => {
    fs.symlinkSync(
      path.join(outside, "not-yet.md"),
      path.join(vault, "dangling.md"),
    );
    const vfs = await VaultFs.open(vault);
    await expect(vfs.resolve("dangling.md")).rejects.toThrow(VaultPathError);
  });

  test("refuses a symlink that stays inside the root, in any segment", async () => {
    fs.writeFileSync(path.join(vault, "notes", "a.md"), "a");
    fs.symlinkSync(path.join(vault, "notes"), path.join(vault, "alias"));
    fs.symlinkSync(
      path.join(vault, "notes", "a.md"),
      path.join(vault, "notes", "b.md"),
    );
    const vfs = await VaultFs.open(vault);
    for (const rel of ["alias", "alias/a.md", "alias/new.md", "notes/b.md"]) {
      await expect(vfs.resolve(rel)).rejects.toThrow(VaultPathError);
    }
    expect(await vfs.resolve("notes/a.md")).toBe(
      path.join(vfs.root, "notes", "a.md"),
    );
  });

  test("the vault root itself may be a symlink", async () => {
    const link = path.join(dir, "root-link");
    fs.symlinkSync(vault, link);
    const vfs = await VaultFs.open(link);
    expect(vfs.root).toBe(fs.realpathSync(vault));
    expect(await vfs.resolve("notes/new.md")).toBe(
      path.join(vfs.root, "notes", "new.md"),
    );
  });
});
