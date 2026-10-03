import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFileStat,
  setMockFolder,
  setMockIgnored,
  setMockResolvedLinks,
} from "$/test-setup";
import {
  listAttachmentsHandler,
  listAttachmentsSchema,
  type ListAttachmentsContext,
} from "./listAttachments";

beforeEach(() => resetMockVault());

async function run(args: ListAttachmentsContext["arguments"] = {}) {
  const r = await listAttachmentsHandler({ arguments: args, app: mockApp() });
  return { r, data: JSON.parse(r.content[0].text) };
}

function seedVault(): void {
  setMockFile("a.md", "");
  setMockFile("b.canvas", "{}");
  setMockFile("c.base", "");
  setMockFile("img/one.png", "1234");
  setMockFile("img/two.PNG", "12");
  setMockFile("docs/paper.pdf", "123456");
  setMockFile("music/song.mp3", "1");
  setMockFile("misc/blob.xyz", "123");
  setMockFileStat("img/one.png", { mtime: 10 });
  setMockFileStat("docs/paper.pdf", { mtime: 30 });
  setMockFileStat("music/song.mp3", { mtime: 20 });
  setMockResolvedLinks("a.md", { "img/one.png": 2, "docs/paper.pdf": 1 });
  setMockResolvedLinks("b.canvas", { "img/one.png": 1 });
}

describe("list_attachments", () => {
  test("schema declares the tool name", () => {
    expect(listAttachmentsSchema.get("name").toString()).toContain(
      "list_attachments",
    );
  });

  test("lists every non-note file with reference counts, sorted by path", async () => {
    seedVault();
    const { r, data } = await run();
    expect(r.isError).toBeUndefined();
    expect(data.total).toBe(5);
    expect(data.totalBytes).toBe(4 + 2 + 6 + 1 + 3);
    expect(data.offset).toBe(0);
    expect(data.truncated).toBeUndefined();
    expect(data.attachments.map((a: { path: string }) => a.path)).toEqual([
      "docs/paper.pdf",
      "img/one.png",
      "img/two.PNG",
      "misc/blob.xyz",
      "music/song.mp3",
    ]);
    expect(data.attachments[1]).toEqual({
      path: "img/one.png",
      extension: "png",
      kind: "image",
      mime: "image/png",
      size: 4,
      mtime: 10,
      referencedBy: 2,
      references: 3,
    });
    expect(data.attachments[2]).toMatchObject({
      extension: "PNG",
      kind: "image",
      referencedBy: 0,
      references: 0,
    });
  });

  test("unreferencedOnly keeps the orphans", async () => {
    seedVault();
    const { data } = await run({ unreferencedOnly: true });
    expect(data.attachments.map((a: { path: string }) => a.path)).toEqual([
      "img/two.PNG",
      "misc/blob.xyz",
      "music/song.mp3",
    ]);
  });

  test("extensions filter is case-insensitive and tolerates a leading dot", async () => {
    seedVault();
    const { data } = await run({ extensions: [".png", "PDF"] });
    expect(data.attachments.map((a: { path: string }) => a.path)).toEqual([
      "docs/paper.pdf",
      "img/one.png",
      "img/two.PNG",
    ]);
  });

  test("folder scope is recursive and tolerates slashes", async () => {
    seedVault();
    setMockFolder("img");
    const { data } = await run({ folder: "/img/" });
    expect(data.folder).toBe("/img/");
    expect(data.attachments.map((a: { path: string }) => a.path)).toEqual([
      "img/one.png",
      "img/two.PNG",
    ]);
  });

  test("a missing or file-typed folder is a typed error", async () => {
    seedVault();
    const missing = await run({ folder: "nope" });
    expect(missing.r.isError).toBe(true);
    expect(missing.data).toMatchObject({
      errorCode: "folder_not_found",
      path: "nope",
    });
    const file = await run({ folder: "a.md" });
    expect(file.r.isError).toBe(true);
    expect(file.data).toMatchObject({
      errorCode: "not_a_directory",
      path: "a.md",
    });
  });

  test("path scope lists what one note links to, with that note's counts", async () => {
    seedVault();
    const { data } = await run({ path: "a.md", folder: "img" });
    expect(data.path).toBe("a.md");
    expect(data.folder).toBeUndefined();
    expect(data.attachments).toEqual([
      expect.objectContaining({
        path: "docs/paper.pdf",
        referencedBy: 1,
        references: 1,
      }),
      expect.objectContaining({
        path: "img/one.png",
        referencedBy: 1,
        references: 2,
      }),
    ]);
  });

  test("path scope rejects a missing note and a folder", async () => {
    seedVault();
    setMockFolder("img");
    const missing = await run({ path: "zzz.md" });
    expect(missing.data).toMatchObject({ errorCode: "file_not_found" });
    const folder = await run({ path: "img" });
    expect(folder.data).toMatchObject({ errorCode: "not_a_file" });
  });

  test("sortBy size and mtime are descending with a path tiebreaker", async () => {
    seedVault();
    const bySize = await run({ sortBy: "size" });
    expect(
      bySize.data.attachments.map((a: { path: string }) => a.path),
    ).toEqual([
      "docs/paper.pdf",
      "img/one.png",
      "misc/blob.xyz",
      "img/two.PNG",
      "music/song.mp3",
    ]);
    const byMtime = await run({ sortBy: "mtime" });
    expect(
      byMtime.data.attachments.map((a: { path: string }) => a.path),
    ).toEqual([
      "docs/paper.pdf",
      "music/song.mp3",
      "img/one.png",
      "img/two.PNG",
      "misc/blob.xyz",
    ]);
  });

  test("offset and limit page through the sorted set", async () => {
    seedVault();
    const first = await run({ limit: 2 });
    expect(first.data.attachments.map((a: { path: string }) => a.path)).toEqual(
      ["docs/paper.pdf", "img/one.png"],
    );
    expect(first.data.truncated).toBe(true);
    expect(first.data.total).toBe(5);
    const last = await run({ limit: 2, offset: 4 });
    expect(last.data.attachments.map((a: { path: string }) => a.path)).toEqual([
      "music/song.mp3",
    ]);
    expect(last.data.offset).toBe(4);
    expect(last.data.truncated).toBeUndefined();
  });

  test("honours Obsidian's excluded files and skips excluded link targets", async () => {
    seedVault();
    setMockIgnored("misc/blob.xyz");
    setMockIgnored("docs/paper.pdf");
    const all = await run();
    expect(all.data.attachments.map((a: { path: string }) => a.path)).toEqual([
      "img/one.png",
      "img/two.PNG",
      "music/song.mp3",
    ]);
    const note = await run({ path: "a.md" });
    expect(note.data.attachments.map((a: { path: string }) => a.path)).toEqual([
      "img/one.png",
    ]);
  });

  test("an empty vault answers an empty page", async () => {
    setMockFile("a.md", "");
    const { data } = await run();
    expect(data).toEqual({
      total: 0,
      totalBytes: 0,
      offset: 0,
      attachments: [],
    });
  });
});
