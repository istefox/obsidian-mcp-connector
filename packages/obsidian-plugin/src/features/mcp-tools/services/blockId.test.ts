import { describe, expect, test } from "bun:test";
import {
  allBlockIds,
  attachBlockId,
  existingBlockId,
  generateBlockId,
  locateBlock,
} from "./blockId";

describe("locateBlock", () => {
  test("a multi-line paragraph is one inline block", () => {
    const lines = ["# H", "", "first", "second", "", "- item"];
    expect(locateBlock(lines, 2)).toEqual({
      kind: "inline",
      startLine: 2,
      endLine: 3,
    });
    expect(locateBlock(lines, 3)).toEqual({
      kind: "inline",
      startLine: 2,
      endLine: 3,
    });
  });

  test("a list item is its own inline block", () => {
    const lines = ["- a", "- b", "  1. c"];
    expect(locateBlock(lines, 1)).toEqual({
      kind: "inline",
      startLine: 1,
      endLine: 1,
    });
    expect(locateBlock(lines, 2)).toEqual({
      kind: "inline",
      startLine: 2,
      endLine: 2,
    });
  });

  test("tables, quotes and fences are own-line blocks spanning their extent", () => {
    const lines = [
      "| a |",
      "|---|",
      "| 1 |",
      "",
      "> q1",
      "> q2",
      "",
      "```js",
      "x",
      "```",
      "tail",
    ];
    expect(locateBlock(lines, 1)).toEqual({
      kind: "own-line",
      startLine: 0,
      endLine: 2,
    });
    expect(locateBlock(lines, 5)).toEqual({
      kind: "own-line",
      startLine: 4,
      endLine: 5,
    });
    expect(locateBlock(lines, 8)).toEqual({
      kind: "own-line",
      startLine: 7,
      endLine: 9,
    });
    expect(locateBlock(lines, 10)).toEqual({
      kind: "inline",
      startLine: 10,
      endLine: 10,
    });
  });

  test("a heading inside a fence is code, not a heading", () => {
    const lines = ["```", "# not a heading", "```"];
    expect(locateBlock(lines, 1)).toEqual({
      kind: "own-line",
      startLine: 0,
      endLine: 2,
    });
  });

  test("blank and heading lines are reported as such", () => {
    expect(locateBlock(["", "## H"], 0)).toEqual({ kind: "blank" });
    expect(locateBlock(["", "## H"], 1)).toEqual({ kind: "heading" });
  });
});

describe("existingBlockId / attachBlockId", () => {
  test("reads a trailing id and does not invent one", () => {
    const lines = ["para ^abc-1", "plain"];
    expect(
      existingBlockId(lines, { kind: "inline", startLine: 0, endLine: 0 }),
    ).toEqual({
      id: "abc-1",
      line: 0,
    });
    expect(
      existingBlockId(lines, { kind: "inline", startLine: 1, endLine: 1 }),
    ).toBeNull();
  });

  test("reads an own-line id directly after or one blank after the block", () => {
    const direct = ["| a |", "^t1"];
    const spaced = ["| a |", "", "^t2", "", "x"];
    const none = ["| a |", "", "", "^far"];
    const p = { kind: "own-line" as const, startLine: 0, endLine: 0 };
    expect(existingBlockId(direct, p)).toEqual({ id: "t1", line: 1 });
    expect(existingBlockId(spaced, p)).toEqual({ id: "t2", line: 2 });
    expect(existingBlockId(none, p)).toBeNull();
  });

  test("attaches inline at the end of the last line, trimming trailing spaces", () => {
    const r = attachBlockId(
      ["a", "b  ", "", "c"],
      { kind: "inline", startLine: 0, endLine: 1 },
      "id1",
    );
    expect(r.lines).toEqual(["a", "b ^id1", "", "c"]);
    expect(r.line).toBe(1);
  });

  test("attaches own-line with a blank before and after when content follows", () => {
    const r = attachBlockId(
      ["| a |", "| 1 |", "tail"],
      { kind: "own-line", startLine: 0, endLine: 1 },
      "t",
    );
    expect(r.lines).toEqual(["| a |", "| 1 |", "", "^t", "", "tail"]);
    expect(r.line).toBe(3);
    const end = attachBlockId(
      ["> q"],
      { kind: "own-line", startLine: 0, endLine: 0 },
      "t",
    );
    expect(end.lines).toEqual(["> q", "", "^t"]);
    const blankNext = attachBlockId(
      ["> q", "", "x"],
      { kind: "own-line", startLine: 0, endLine: 0 },
      "t",
    );
    expect(blankNext.lines).toEqual(["> q", "", "^t", "", "x"]);
  });

  test("allBlockIds collects trailing and own-line ids", () => {
    expect(allBlockIds(["a ^x1", "^y2", "no", "code^z"])).toEqual(
      new Set(["x1", "y2"]),
    );
  });

  test("generateBlockId skips taken ids and uses 6 lowercase alphanumerics", () => {
    const seq = ["aaaaaa", "bbbbbb"];
    expect(
      generateBlockId(new Set(["aaaaaa"]), () => seq.shift() ?? "cccccc"),
    ).toBe("bbbbbb");
    expect(generateBlockId(new Set())).toMatch(/^[a-z0-9]{6}$/);
  });
});
