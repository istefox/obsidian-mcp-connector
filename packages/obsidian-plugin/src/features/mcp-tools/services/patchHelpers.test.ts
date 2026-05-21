import { describe, expect, test } from "bun:test";
import {
  hasParentH1,
  hasAnyH1,
  isInsideTableOrFencedCode,
  isBlockRangeStructurallyUnsafe,
  resolveHeadingPath,
  normalizeAppendBody,
  findBlockReferenceInContent,
  findBlockPositionFromCache,
  findHeadingSectionEnd,
  planFrontmatterReplace,
  planFrontmatterAppend,
} from "./patchHelpers";

describe("resolveHeadingPath", () => {
  test("matches single-level heading", () => {
    const content = "# Top\n\nbody\n\n## Section A\n";
    expect(resolveHeadingPath(content, "Section A", "::")).toBe(
      "Top::Section A",
    );
  });

  test("matches nested heading via stack", () => {
    const content = "# A\n\n## B\n\n### C\n\nbody\n\n## D\n";
    expect(resolveHeadingPath(content, "C", "::")).toBe("A::B::C");
  });

  test("returns null on miss", () => {
    const content = "# A\n\n## B\n";
    expect(resolveHeadingPath(content, "X", "::")).toBeNull();
  });

  test("respects custom delimiter", () => {
    const content = "# A\n\n## B\n";
    expect(resolveHeadingPath(content, "B", " > ")).toBe("A > B");
  });

  test("returns first match when multiple headings have same leaf name", () => {
    const content = "# A\n\n## X\n\n# B\n\n## X\n";
    expect(resolveHeadingPath(content, "X", "::")).toBe("A::X");
  });
});

describe("normalizeAppendBody", () => {
  test("appends double newline on append op when missing", () => {
    expect(normalizeAppendBody("text", "append")).toBe("text\n\n");
  });

  test("leaves content unchanged when already ends with newline", () => {
    expect(normalizeAppendBody("text\n", "append")).toBe("text\n");
  });

  test("leaves replace ops untouched", () => {
    expect(normalizeAppendBody("text", "replace")).toBe("text");
  });

  test("leaves prepend ops untouched", () => {
    expect(normalizeAppendBody("text", "prepend")).toBe("text");
  });
});

describe("findBlockReferenceInContent", () => {
  test("returns position for known block id", () => {
    const content = "Para 1\n\nPara 2\n^abc123\n\nPara 3\n";
    const pos = findBlockReferenceInContent(content, "abc123");
    expect(pos).not.toBeNull();
    expect(pos?.startLine).toBeGreaterThanOrEqual(0);
  });

  test("returns null for unknown block id", () => {
    const content = "Para 1\n\nPara 2\n";
    expect(findBlockReferenceInContent(content, "nonexistent")).toBeNull();
  });
});

describe("findBlockPositionFromCache", () => {
  test("returns position for cached block id", () => {
    const cache = {
      blocks: {
        myblock: { position: { start: { line: 5 }, end: { line: 7 } } },
      },
    };
    const pos = findBlockPositionFromCache(cache, "myblock");
    expect(pos).toEqual({ startLine: 5, endLine: 7 });
  });

  test("returns null when block not in cache", () => {
    const cache = { blocks: {} };
    expect(findBlockPositionFromCache(cache, "missing")).toBeNull();
  });

  test("returns null when cache has no blocks property", () => {
    const cache = {};
    expect(
      findBlockPositionFromCache(
        cache as { blocks?: Record<string, unknown> },
        "x",
      ),
    ).toBeNull();
  });
});

// ─── Frontmatter planners (issues #12, #13) ────────────────────────────────

describe("planFrontmatterReplace", () => {
  test("scalar existing → ok-string (legacy assign-as-string)", () => {
    expect(planFrontmatterReplace("draft", "published", "status")).toEqual({
      kind: "ok-string",
    });
  });

  test("missing existing → ok-string", () => {
    expect(planFrontmatterReplace(undefined, "x", "any")).toEqual({
      kind: "ok-string",
    });
    expect(planFrontmatterReplace(null, "x", "any")).toEqual({
      kind: "ok-string",
    });
  });

  test("array existing + JSON array content → ok with parsed array", () => {
    expect(planFrontmatterReplace(["a", "b"], '["c","d"]', "tags")).toEqual({
      kind: "ok",
      value: ["c", "d"],
    });
  });

  test("array existing + JSON null → ok with value=null (clears the field)", () => {
    expect(planFrontmatterReplace(["a"], "null", "tags")).toEqual({
      kind: "ok",
      value: null,
    });
  });

  test("issue #12: array existing + plain string content → reject", () => {
    const result = planFrontmatterReplace(["alpha", "beta"], "gamma", "tags");
    expect(result.kind).toBe("reject");
    if (result.kind === "reject") {
      expect(result.message).toContain("tags");
      expect(result.message).toMatch(/array/i);
      expect(result.message).toMatch(/JSON/i);
    }
  });

  test("array existing + JSON scalar content → reject (would still flatten)", () => {
    const result = planFrontmatterReplace(["a"], '"single"', "tags");
    expect(result.kind).toBe("reject");
  });

  test("array existing + JSON object content → reject", () => {
    const result = planFrontmatterReplace(["a"], '{"k":"v"}', "tags");
    expect(result.kind).toBe("reject");
  });

  test("array existing + empty content → reject (empty is not valid JSON)", () => {
    const result = planFrontmatterReplace(["a"], "", "tags");
    expect(result.kind).toBe("reject");
  });

  test("nested array assignment is preserved", () => {
    expect(
      planFrontmatterReplace(["a"], '[["nested"],["array"]]', "matrix"),
    ).toEqual({
      kind: "ok",
      value: [["nested"], ["array"]],
    });
  });
});

describe("planFrontmatterAppend", () => {
  test("scalar existing → string-concat (legacy)", () => {
    expect(planFrontmatterAppend("draft", " v2")).toEqual({
      kind: "string-concat",
    });
  });

  test("missing existing → string-concat", () => {
    expect(planFrontmatterAppend(undefined, "x")).toEqual({
      kind: "string-concat",
    });
    expect(planFrontmatterAppend(null, "x")).toEqual({
      kind: "string-concat",
    });
  });

  test("array existing + plain string content → push as single string element", () => {
    // The DWIM branch: an LLM caller that doesn't know about JSON encoding
    // sends the bare tag, and it lands as an array element.
    expect(planFrontmatterAppend(["existing"], "new-tag")).toEqual({
      kind: "array-push",
      values: ["new-tag"],
    });
  });

  test("issue #13: array existing + JSON scalar content → push parsed scalar", () => {
    // Was the original failure: 0.3.x returned 500, 0.4.0 corrupted via
    // String(["existing"]) + content. The plan splits the scalar onto its
    // own array element.
    expect(planFrontmatterAppend(["existing"], '"new-tag"')).toEqual({
      kind: "array-push",
      values: ["new-tag"],
    });
  });

  test("array existing + JSON array content → spread parsed array elements", () => {
    expect(planFrontmatterAppend(["a"], '["b","c"]')).toEqual({
      kind: "array-push",
      values: ["b", "c"],
    });
  });

  test("array existing + JSON number → push parsed number", () => {
    expect(planFrontmatterAppend([1, 2], "3")).toEqual({
      kind: "array-push",
      values: [3],
    });
  });

  test("array existing + JSON null → push null as element", () => {
    expect(planFrontmatterAppend(["a"], "null")).toEqual({
      kind: "array-push",
      values: [null],
    });
  });

  test("array existing + malformed JSON → push raw content as string element", () => {
    expect(planFrontmatterAppend(["a"], "[unclosed")).toEqual({
      kind: "array-push",
      values: ["[unclosed"],
    });
  });
});

describe("hasParentH1", () => {
  test("returns true when an H1 line precedes the heading line", () => {
    const lines = ["# Top", "", "## Section", ""];
    expect(hasParentH1(lines, 2)).toBe(true);
  });

  test("returns false when no H1 precedes (root-orphan H2)", () => {
    const lines = ["## RootHeading", "", "Body."];
    expect(hasParentH1(lines, 0)).toBe(false);
  });

  test("returns false when only deeper headings precede", () => {
    const lines = ["## Sub1", "", "### Deeper", "", "## Sub2"];
    expect(hasParentH1(lines, 4)).toBe(false);
  });

  test("returns true for H3 with H1 grandparent (no H2 parent required)", () => {
    const lines = ["# Top", "", "### DeepRoot"];
    expect(hasParentH1(lines, 2)).toBe(true);
  });

  test("returns false at headingLine=0 (first line is the target)", () => {
    const lines = ["## RootHeading", "Body."];
    expect(hasParentH1(lines, 0)).toBe(false);
  });

  test("ignores `#` characters that are not at column 0 of a heading line", () => {
    const lines = ["Some prose with # not-a-heading", "## Real"];
    expect(hasParentH1(lines, 1)).toBe(false);
  });
});

describe("hasAnyH1 (#139 — narrowed-A: whole-file H1 detection)", () => {
  test("true when an H1 exists anywhere, including after the target", () => {
    const lines = ["## Early", "", "# Later H1", "", "## Under"];
    expect(hasAnyH1(lines)).toBe(true);
  });

  test("true when H1 is the only heading", () => {
    expect(hasAnyH1(["# Only"])).toBe(true);
  });

  test("false for an entirely H1-free document (frontmatter + H2s)", () => {
    const lines = ["---", "title: My Note", "---", "", "## A", "", "## B"];
    expect(hasAnyH1(lines)).toBe(false);
  });

  test("false on empty input", () => {
    expect(hasAnyH1([])).toBe(false);
  });

  test("ignores `#` not at column 0 of a heading line", () => {
    expect(hasAnyH1(["prose with # not-a-heading", "## H2"])).toBe(false);
  });
});

describe("isInsideTableOrFencedCode", () => {
  test("detects line inside a 3-row markdown table (data-row position)", () => {
    const lines = [
      "## Section",
      "",
      "| Col | Data |",
      "| --- | --- |",
      "| a   | b ^cell-id |",
      "",
      "End.",
    ];
    expect(isInsideTableOrFencedCode(lines, 4)).toBe(true);
  });

  test("detects line at header-row position above separator", () => {
    const lines = ["| Col | Data |", "| --- | --- |", "| row | val  |"];
    expect(isInsideTableOrFencedCode(lines, 0)).toBe(true);
  });

  test("detects separator row itself", () => {
    const lines = ["| Col | Data |", "| --- | --- |", "| row | val  |"];
    expect(isInsideTableOrFencedCode(lines, 1)).toBe(true);
  });

  test("rejects when line is in a normal paragraph (no separator nearby)", () => {
    const lines = [
      "## Section",
      "",
      "Just prose with ^block-id at the end.",
      "",
      "## Other",
    ];
    expect(isInsideTableOrFencedCode(lines, 2)).toBe(false);
  });

  test("rejects when line starts with `|` but no separator above/below (false-positive guard)", () => {
    const lines = [
      "## Section",
      "",
      "| stray pipe content but not a real table",
      "",
      "## Other",
    ];
    expect(isInsideTableOrFencedCode(lines, 2)).toBe(false);
  });

  test("detects line inside a fenced code block", () => {
    const lines = [
      "## Section",
      "",
      "```",
      "code line ^block-id",
      "```",
      "",
      "End.",
    ];
    expect(isInsideTableOrFencedCode(lines, 3)).toBe(true);
  });

  test("rejects when fenced code block is closed before the target line", () => {
    const lines = [
      "## Section",
      "",
      "```",
      "code line",
      "```",
      "",
      "Plain prose with ^block-id.",
    ];
    expect(isInsideTableOrFencedCode(lines, 6)).toBe(false);
  });

  test("detects table with alignment colons in separator", () => {
    const lines = ["| Col | Data |", "|:----|----:|", "| a   | b   |"];
    expect(isInsideTableOrFencedCode(lines, 2)).toBe(true);
  });

  test("returns false for out-of-range indices", () => {
    const lines = ["a", "b"];
    expect(isInsideTableOrFencedCode(lines, -1)).toBe(false);
    expect(isInsideTableOrFencedCode(lines, 99)).toBe(false);
  });

  test("detects opening fence delimiter line itself (#84 boundary case)", () => {
    // The regex fallback findBlockReferenceInContent can return startLine
    // pointing AT the opening fence when ^block-id lives inside a fenced
    // code block. Helper must recognize the fence-delimiter line itself as
    // structural to avoid the splice-orphans-closer corruption.
    const lines = [
      "## Section",
      "",
      "```",
      "code",
      "^block-id",
      "```",
      "",
      "End.",
    ];
    expect(isInsideTableOrFencedCode(lines, 2)).toBe(true);
  });

  test("detects closing fence delimiter line itself", () => {
    const lines = ["```", "code", "```", "", "End."];
    expect(isInsideTableOrFencedCode(lines, 2)).toBe(true);
  });

  test("detects indented fence delimiter (still starts with ``` after trim)", () => {
    const lines = ["  ```", "code", "  ```"];
    expect(isInsideTableOrFencedCode(lines, 0)).toBe(true);
  });
});

describe("isBlockRangeStructurallyUnsafe", () => {
  test("rejects range whose start is opening fence (#84 regex-fallback shape)", () => {
    // Mirrors folotp's #84 fixture after findBlockReferenceInContent walks
    // back from `^block-id` and captures the opening fence as startLine.
    const lines = [
      "para",
      "",
      "```", // 2: opening fence (regex-fallback startLine)
      "echo",
      "^id", // 4: endLine
      "```",
    ];
    expect(isBlockRangeStructurallyUnsafe(lines, 2, 4)).toBe(true);
  });

  test("accepts safe range in normal paragraph", () => {
    const lines = ["para 1", "^id", "", "para 2"];
    expect(isBlockRangeStructurallyUnsafe(lines, 0, 1)).toBe(false);
  });

  test("rejects single-line range when line is in table", () => {
    const lines = ["| h |", "| --- |", "| ^id |"];
    expect(isBlockRangeStructurallyUnsafe(lines, 2, 2)).toBe(true);
  });

  test("rejects multi-line range crossing a fence boundary", () => {
    // Defense-in-depth: a hypothetical cache shape where startLine is safe
    // but endLine is inside a fence.
    const lines = ["safe", "```", "in-fence", "```"];
    expect(isBlockRangeStructurallyUnsafe(lines, 0, 2)).toBe(true);
  });

  test("rejects when the resolved range covers a fence-delimiter line only", () => {
    const lines = ["before", "```", "after"];
    expect(isBlockRangeStructurallyUnsafe(lines, 1, 1)).toBe(true);
  });
});

describe("findHeadingSectionEnd (#137 — heading-branch fenced-code guard)", () => {
  // R1: ```-fenced block with internal `## …` lines must not be treated as
  // section boundaries; the real boundary is the next sibling heading.
  test("R1: backtick fence with internal ## → boundary is the real next H2", () => {
    const lines = [
      "## Section A", // 0  target
      "",
      "Préambule.",
      "",
      "```text", // 4  fence open
      "## Identity", // 5  NOT a boundary (in fence)
      "paste",
      "## Language", // 7  NOT a boundary (in fence)
      "more",
      "```", // 9  fence close
      "",
      "Postambule.",
      "",
      "## Section B", // 13 the real boundary
      "",
      "Autre.",
    ];
    expect(findHeadingSectionEnd(lines, 0, 2)).toBe(13);
  });

  // R2: same, with ~~~ fences (CommonMark §4.5 allows ~~~ as a fence char).
  test("R2: tilde fence with internal ## → boundary is the real next H2", () => {
    const lines = [
      "## Section A", // 0
      "",
      "~~~text", // 2  fence open
      "## Identity", // 3  NOT a boundary (in fence)
      "## Language", // 4  NOT a boundary (in fence)
      "~~~", // 5  fence close
      "",
      "## Section B", // 7  the real boundary
    ];
    expect(findHeadingSectionEnd(lines, 0, 2)).toBe(7);
  });

  // R3: no fenced block (control) — existing behaviour preserved.
  test("R3: no fence → boundary is the next sibling heading", () => {
    const lines = ["## A", "", "body", "", "## B", "tail"];
    expect(findHeadingSectionEnd(lines, 0, 2)).toBe(4);
  });

  // R4: fence with no internal ## (control) — existing behaviour preserved.
  test("R4: fence without internal headings → next sibling heading", () => {
    const lines = ["## A", "", "```js", "const x = 1;", "```", "", "## B"];
    expect(findHeadingSectionEnd(lines, 0, 2)).toBe(6);
  });

  // R5: nested fences (four-backtick wrapping three-backtick) — the inner
  // ## sample line stays opaque; boundary is the post-outer-close heading.
  test("R5: nested fences → inner ## opaque, outer boundary honoured", () => {
    const lines = [
      "## A", // 0
      "````md", // 1  outer open (4 backticks)
      "## not a heading", // 2  NOT a boundary (in outer fence)
      "```js", // 3  inner sample fence
      "code();",
      "```", // 5  inner close
      "more sample",
      "````", // 7  outer close
      "## B", // 8  the real boundary
      "body B",
    ];
    expect(findHeadingSectionEnd(lines, 0, 2)).toBe(8);
  });

  // R6: indented fence inside a list item — recognised as a fence (trim),
  // a column-0 ## inside the paste is not a premature boundary.
  test("R6: indented fence in a list → column-0 ## inside stays opaque", () => {
    const lines = [
      "## A", // 0
      "- list intro", // 1
      "  ```text", // 2  indented fence open
      "## paste line", // 3  NOT a boundary (in fence)
      "  ```", // 4  indented fence close
      "## B", // 5  the real boundary
      "end",
    ];
    expect(findHeadingSectionEnd(lines, 0, 2)).toBe(5);
  });

  // Control: a deeper heading inside the section is not a boundary; only a
  // heading of the same level or shallower closes it. Runs to EOF here.
  test("deeper heading is not a boundary; section runs to EOF", () => {
    const lines = ["## A", "", "### sub", "x", "#### deeper", "y"];
    expect(findHeadingSectionEnd(lines, 0, 2)).toBe(6);
  });
});
