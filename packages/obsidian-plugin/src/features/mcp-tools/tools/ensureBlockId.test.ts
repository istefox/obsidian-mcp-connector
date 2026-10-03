import { beforeEach, describe, expect, test } from "bun:test";
import { TFile } from "obsidian";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockMetadata,
  setMockModifyFail,
} from "$/test-setup";
import {
  ensureBlockIdHandler,
  ensureBlockIdSchema,
  type EnsureBlockIdContext,
} from "./ensureBlockId";

beforeEach(() => resetMockVault());

async function run(args: EnsureBlockIdContext["arguments"]) {
  const app = mockApp();
  const r = await ensureBlockIdHandler({ arguments: args, app });
  const data = JSON.parse(r.content[0].text);
  const file = app.vault.getAbstractFileByPath(args.path);
  const content = file instanceof TFile ? await app.vault.read(file) : null;
  return { r, data, content };
}

const NOTE = [
  "---",
  "title: n",
  "---",
  "# Top",
  "",
  "Intro line one",
  "intro line two",
  "",
  "## Items",
  "",
  "- first",
  "- second ^have",
  "",
  "## Table",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "## Empty",
  "",
  "## Code",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "after",
].join("\n");

function headings(): void {
  setMockMetadata("n.md", {
    headings: [
      { heading: "Top", level: 1, line: 3 },
      { heading: "Items", level: 2, line: 8 },
      { heading: "Table", level: 2, line: 13 },
      { heading: "Empty", level: 2, line: 19 },
      { heading: "Code", level: 2, line: 21 },
    ],
    blocks: { have: { startLine: 11, endLine: 11 } },
  });
}

describe("ensure_block_id", () => {
  test("schema declares the tool name", () => {
    expect(ensureBlockIdSchema.get("name").toString()).toContain(
      "ensure_block_id",
    );
  });

  test("creates an id at the end of a multi-line paragraph and returns link, embed and uri", async () => {
    setMockFile("n.md", NOTE);
    headings();
    const { r, data, content } = await run({
      path: "n.md",
      line: 5,
      id: "intro",
    });
    expect(r.isError).toBeUndefined();
    expect(data).toEqual({
      path: "n.md",
      id: "intro",
      created: true,
      dryRun: false,
      line: 6,
      blockStartLine: 5,
      blockEndLine: 6,
      link: "[[n#^intro]]",
      embed: "![[n#^intro]]",
      uri: "obsidian://open?vault=Test%20Vault&file=n.md",
    });
    expect(content!.split("\n")[6]).toBe("intro line two ^intro");
    expect(content!.split("\n")[5]).toBe("Intro line one");
  });

  test("returns the existing id without writing, and reports an ignored request", async () => {
    setMockFile("n.md", NOTE);
    headings();
    const { data, content } = await run({
      path: "n.md",
      line: 11,
      id: "other",
    });
    expect(data).toMatchObject({
      id: "have",
      created: false,
      line: 11,
      requestedIdIgnored: "other",
    });
    expect(content).toBe(NOTE);
  });

  test("generates a 6-character id on a list item when none is requested", async () => {
    setMockFile("n.md", NOTE);
    headings();
    const { data, content } = await run({ path: "n.md", line: 10 });
    expect(data.created).toBe(true);
    expect(data.id).toMatch(/^[a-z0-9]{6}$/);
    expect(content!.split("\n")[10]).toBe(`- first ^${data.id}`);
    const again = await run({ path: "n.md", line: 10 });
    expect(again.data).toMatchObject({ id: data.id, created: false });
  });

  test("a table gets the id on its own line with blank lines around it", async () => {
    setMockFile("n.md", NOTE);
    headings();
    const { data, content } = await run({ path: "n.md", line: 16, id: "tbl" });
    expect(data).toMatchObject({
      created: true,
      line: 19,
      blockStartLine: 15,
      blockEndLine: 17,
    });
    const lines = content!.split("\n");
    expect(lines.slice(17, 21)).toEqual(["| 1 | 2 |", "", "^tbl", ""]);
    const second = await run({ path: "n.md", line: 15 });
    expect(second.data).toMatchObject({ id: "tbl", created: false, line: 19 });
  });

  test("a fenced code block is addressed by any of its lines, including the fence", async () => {
    setMockFile("n.md", NOTE);
    headings();
    const { data, content } = await run({ path: "n.md", line: 24, id: "code" });
    expect(data).toMatchObject({
      created: true,
      blockStartLine: 23,
      blockEndLine: 25,
      line: 27,
    });
    expect(content!.split("\n").slice(25, 29)).toEqual([
      "```",
      "",
      "^code",
      "",
    ]);
    expect(content!.split("\n")[29]).toBe("after");
  });

  test("heading mode targets the first block under the heading", async () => {
    setMockFile("n.md", NOTE);
    headings();
    const items = await run({ path: "n.md", heading: "Items" });
    expect(items.data).toMatchObject({
      created: true,
      blockStartLine: 10,
      blockEndLine: 10,
    });
    const top = await run({ path: "n.md", heading: "Top", id: "top-intro" });
    expect(top.data).toMatchObject({
      id: "top-intro",
      blockStartLine: 5,
      blockEndLine: 6,
    });
  });

  test("heading mode errors: missing heading, empty section", async () => {
    setMockFile("n.md", NOTE);
    headings();
    const missing = await run({ path: "n.md", heading: "Nope" });
    expect(missing.r.isError).toBe(true);
    expect(missing.data).toMatchObject({
      errorCode: "heading_not_found",
      heading: "Nope",
    });
    const empty = await run({ path: "n.md", heading: "Empty" });
    expect(empty.data).toMatchObject({
      errorCode: "empty_section",
      heading: "Empty",
    });
  });

  test("dry_run reports the plan and leaves the file alone", async () => {
    setMockFile("n.md", NOTE);
    headings();
    const { data, content } = await run({
      path: "n.md",
      line: 5,
      id: "x",
      dry_run: true,
    });
    expect(data).toMatchObject({
      id: "x",
      created: true,
      dryRun: true,
      line: 6,
    });
    expect(content).toBe(NOTE);
  });

  test("refuses a taken id, a bad id, a heading line, a blank line, out-of-range and no target", async () => {
    setMockFile("n.md", NOTE);
    headings();
    expect(
      (await run({ path: "n.md", line: 5, id: "have" })).data,
    ).toMatchObject({
      errorCode: "block_id_taken",
      id: "have",
    });
    expect(
      (await run({ path: "n.md", line: 5, id: "bad id" })).data,
    ).toMatchObject({
      errorCode: "invalid_params",
    });
    expect((await run({ path: "n.md", line: 8 })).data).toMatchObject({
      errorCode: "unsupported_block",
    });
    expect((await run({ path: "n.md", line: 4 })).data).toMatchObject({
      errorCode: "invalid_params",
      line: 4,
    });
    expect((await run({ path: "n.md", line: 999 })).data).toMatchObject({
      errorCode: "line_out_of_range",
      lineCount: NOTE.split("\n").length,
    });
    expect((await run({ path: "n.md" })).data).toMatchObject({
      errorCode: "invalid_params",
    });
  });

  test("ids known only to the metadata cache are treated as taken", async () => {
    setMockFile("n.md", "a\n\nb\n");
    setMockMetadata("n.md", {
      blocks: { ghost: { startLine: 2, endLine: 2 } },
    });
    const { data } = await run({ path: "n.md", line: 0, id: "ghost" });
    expect(data).toMatchObject({ errorCode: "block_id_taken" });
  });

  test("file errors: missing, folder, non-markdown, write failure", async () => {
    setMockFolder("dir");
    setMockFile("a.txt", "x");
    setMockFile("w.md", "x");
    setMockModifyFail("w.md");
    expect((await run({ path: "zz.md", line: 0 })).data).toMatchObject({
      errorCode: "file_not_found",
    });
    expect((await run({ path: "dir", line: 0 })).data).toMatchObject({
      errorCode: "not_a_file",
    });
    expect((await run({ path: "a.txt", line: 0 })).data).toMatchObject({
      errorCode: "not_markdown",
    });
    expect((await run({ path: "w.md", line: 0 })).data).toMatchObject({
      errorCode: "write_failed",
    });
  });
});
