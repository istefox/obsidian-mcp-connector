import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeFsAdapter } from "./nodeFsAdapter";

let root: string;
beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nodefs-")), "cache");
});
afterEach(() =>
  fs.rmSync(path.dirname(root), { recursive: true, force: true }),
);

const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe("nodeFsAdapter", () => {
  test("text and binary round-trip under a leading-slash path", async () => {
    const a = nodeFsAdapter(root);
    await a.write("/embeddings/k/mtimes.json", '{"a":1}');
    await a.writeBinary(
      "/embeddings/k/v.bin",
      new Uint8Array([1, 2, 3]).buffer,
    );
    expect(await a.read("/embeddings/k/mtimes.json")).toBe('{"a":1}');
    expect(new Uint8Array(await a.readBinary("/embeddings/k/v.bin"))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(fs.existsSync(path.join(root, "embeddings/k/v.bin"))).toBe(true);
  });

  test("directories are 0700 and files 0600", async () => {
    const a = nodeFsAdapter(root);
    await a.write("/embeddings/k/x.json", "{}");
    await a.writeBinary("/embeddings/k/x.bin", new ArrayBuffer(4));
    await a.mkdir("/embeddings/other");
    for (const dir of ["embeddings", "embeddings/k", "embeddings/other"]) {
      expect(mode(path.join(root, dir))).toBe(0o700);
    }
    for (const file of ["x.json", "x.bin"]) {
      expect(mode(path.join(root, "embeddings/k", file))).toBe(0o600);
    }
  });

  test("an overwrite replaces the file whole and leaves no temporary file", async () => {
    const a = nodeFsAdapter(root);
    await a.write("/s/f.json", "long first contents");
    await a.write("/s/f.json", "second");
    expect(await a.read("/s/f.json")).toBe("second");
    expect(fs.readdirSync(path.join(root, "s"))).toEqual(["f.json"]);
  });

  test("exists, and remove of a missing file is not an error", async () => {
    const a = nodeFsAdapter(root);
    expect(await a.exists("/s/f.json")).toBe(false);
    await a.write("/s/f.json", "x");
    expect(await a.exists("/s/f.json")).toBe(true);
    await a.remove("/s/f.json");
    expect(await a.exists("/s/f.json")).toBe(false);
    await a.remove("/s/f.json");
  });

  test("reading a missing file rejects", async () => {
    await expect(nodeFsAdapter(root).read("/nope.json")).rejects.toThrow();
  });

  test("a path that leaves the directory is refused", async () => {
    const a = nodeFsAdapter(root);
    await expect(a.write("/../escape.json", "x")).rejects.toThrow("escapes");
    await expect(a.read("../../etc/passwd")).rejects.toThrow("escapes");
    expect(fs.existsSync(path.join(path.dirname(root), "escape.json"))).toBe(
      false,
    );
  });
});
