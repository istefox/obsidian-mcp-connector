// See docs/architecture/ADR-0024-converge-anchor-matchers.md.
import { describe, expect, test } from "bun:test";
import {
  headingEntriesFromCache,
  headingEntriesFromContent,
  headingPathToSubpath,
  normalizeBlockId,
  resolveHeadingEntries,
  resolveHeadingForWrite,
  splitHeadingPath,
  type HeadingEntry,
} from "./anchorTargets";

const INVALID_BLOCK_TARGET =
  'Invalid block target: input is empty or contains only "^" characters.';

function heading(text: string, level: number, line: number): HeadingEntry {
  return { heading: text, level, line };
}

function cacheHeading(text: string, level: number, line: number) {
  return {
    heading: text,
    level,
    position: { start: { line } },
  };
}

describe("normalizeBlockId (R-10)", () => {
  test.each([
    ["abc", "abc"],
    ["^abc", "abc"],
    ["^^^abc", "abc"],
    ["  ^abc  ", "abc"],
  ])("normalizes %p to %p", (target, expected) => {
    expect(normalizeBlockId(target)).toEqual({ ok: true, id: expected });
  });

  test.each(["", "^", "^^^"])("rejects empty target %p", (target) => {
    expect(normalizeBlockId(target)).toEqual({
      ok: false,
      error: INVALID_BLOCK_TARGET,
    });
  });
});

describe("heading path conversion (R-04)", () => {
  test.each([
    ["A::B", "::", ["A", "B"]],
    [" A :: B ", "::", ["A", "B"]],
    ["A::::B", "::", ["A", "B"]],
    ["A > B", " > ", ["A", "B"]],
  ])("splits %p with delimiter %p", (target, delimiter, expected) => {
    expect(splitHeadingPath(target, delimiter)).toEqual(expected);
  });

  test.each([
    ["A::B", "#A#B"],
    ["A", "#A"],
  ])("converts %p to an Obsidian subpath", (target, expected) => {
    expect(headingPathToSubpath(target, "::")).toBe(expected);
  });
});

describe("heading entry extraction (R-08)", () => {
  test("extracts plain headings with zero-based lines and levels", () => {
    expect(
      headingEntriesFromContent([
        "# Title",
        "body",
        "## Section",
        "### Detail",
      ]),
    ).toEqual([
      heading("Title", 1, 0),
      heading("Section", 2, 2),
      heading("Detail", 3, 3),
    ]);
  });

  test("excludes apparent headings in backtick and tilde fences", () => {
    expect(
      headingEntriesFromContent([
        "# Before",
        "```",
        "# Backtick code",
        "```",
        "~~~",
        "## Tilde code",
        "~~~",
        "## After",
      ]),
    ).toEqual([heading("Before", 1, 0), heading("After", 2, 7)]);
  });

  test("does not treat a hashtag without a separating space as a heading", () => {
    expect(headingEntriesFromContent(["#hashtag", "# Heading"])).toEqual([
      heading("Heading", 1, 1),
    ]);
  });

  test("converts cache headings and tolerates absent cache data", () => {
    expect(
      headingEntriesFromCache({
        headings: [cacheHeading("Title", 1, 0), cacheHeading("Section", 2, 4)],
      }),
    ).toEqual([heading("Title", 1, 0), heading("Section", 2, 4)]);
    expect(headingEntriesFromCache({})).toEqual([]);
    expect(headingEntriesFromCache(null)).toEqual([]);
    expect(headingEntriesFromCache(undefined)).toEqual([]);
  });
});

describe("resolveHeadingEntries (R-01, R-02, R-05)", () => {
  test("matches a single heading case-insensitively", () => {
    expect(
      resolveHeadingEntries([heading("Heading", 2, 3)], ["heading"], 8),
    ).toMatchObject({ kind: "found", line: 3, level: 2 });
  });

  test("selects the matching leaf beneath Parent", () => {
    const entries = [
      heading("Parent", 1, 0),
      heading("Section", 2, 2),
      heading("Other", 1, 5),
      heading("Section", 2, 7),
    ];

    expect(
      resolveHeadingEntries(entries, ["Parent", "Section"], 10),
    ).toMatchObject({ kind: "found", line: 2, level: 2 });
  });

  test("retains Other as the ancestor when resolving its Section", () => {
    const entries = [
      heading("Parent", 1, 0),
      heading("Section", 2, 2),
      heading("Other", 1, 5),
      heading("Section", 2, 7),
    ];

    expect(
      resolveHeadingEntries(entries, ["Other", "Section"], 10),
    ).toMatchObject({ kind: "found", line: 7, level: 2 });
  });

  test("reports duplicate leaves in the same scope as ambiguous", () => {
    const result = resolveHeadingEntries(
      [
        heading("Parent", 1, 0),
        heading("Section", 2, 2),
        heading("Section", 2, 4),
      ],
      ["Parent", "Section"],
      8,
    );

    expect(result).toMatchObject({
      kind: "ambiguous",
      segment: "Section",
      candidates: [heading("Section", 2, 2), heading("Section", 2, 4)],
    });
    if (result.kind === "ambiguous") {
      expect(result.message).toMatch(
        /^Ambiguous heading target: "Section" matches multiple headings \(level \d+ at line \d+, level \d+ at line \d+\)\. Use a nested path with `targetDelimiter` to disambiguate\.$/,
      );
    }
  });

  test("names the resolved ancestor when a nested leaf is missing", () => {
    expect(
      resolveHeadingEntries(
        [heading("Parent", 1, 0)],
        ["Parent", "Missing"],
        4,
      ),
    ).toEqual({
      kind: "not-found",
      segment: "Missing",
      where: 'under "Parent"',
    });
  });

  test("names the file when the first segment is missing", () => {
    expect(resolveHeadingEntries([], ["Missing"], 0)).toEqual({
      kind: "not-found",
      segment: "Missing",
      where: "in the file",
    });
  });

  test("reports an empty path as not found", () => {
    expect(resolveHeadingEntries([], [], 0)).toMatchObject({
      kind: "not-found",
    });
  });
});

describe("resolveHeadingForWrite (R-07 setup, R-08)", () => {
  test("resolves a cache hit that agrees with the current content", () => {
    expect(
      resolveHeadingForWrite(
        { headings: [cacheHeading("Target", 2, 1)] },
        ["body", "## Target", "tail"],
        ["Target"],
      ),
    ).toMatchObject({ kind: "found", line: 1, level: 2 });
  });

  test("discards a stale cache hit and resolves against current content", () => {
    expect(
      resolveHeadingForWrite(
        { headings: [cacheHeading("Target", 1, 0)] },
        ["# Renamed", "body", "## Target"],
        ["Target"],
      ),
    ).toMatchObject({ kind: "found", line: 2, level: 2 });
  });

  test("resolves from content when cache is null", () => {
    expect(
      resolveHeadingForWrite(null, ["# Target", "body"], ["Target"]),
    ).toMatchObject({ kind: "found", line: 0, level: 1 });
  });

  test("does not match a heading that exists only inside a fence", () => {
    expect(
      resolveHeadingForWrite(
        { headings: [cacheHeading("Hidden", 1, 1)] },
        ["```", "# Hidden", "```"],
        ["Hidden"],
      ),
    ).toMatchObject({
      kind: "not-found",
      segment: "Hidden",
      where: "in the file",
    });
  });

  test("reports ambiguity from the cache resolution leg", () => {
    expect(
      resolveHeadingForWrite(
        {
          headings: [
            cacheHeading("Section", 2, 1),
            cacheHeading("Section", 2, 3),
          ],
        },
        ["# Parent", "## Section", "body", "## Section"],
        ["Section"],
      ),
    ).toMatchObject({ kind: "ambiguous", segment: "Section" });
  });

  test("reports ambiguity from the content resolution leg", () => {
    expect(
      resolveHeadingForWrite(
        null,
        ["# Parent", "## Section", "body", "## Section"],
        ["Section"],
      ),
    ).toMatchObject({ kind: "ambiguous", segment: "Section" });
  });

  test("discards a cache hit whose leaf now sits under a different parent", () => {
    // The cache was indexed before "## Z" (under "A") became "# B", so it
    // still resolves "A::X" to line 3. Line 3 itself is untouched, so a
    // leaf-text-only agreement check accepts the stale hit and the write
    // lands under "B" instead of "A" — the wrong-section write ADR-0024
    // exists to close. The full path has to be re-checked against content.
    expect(
      resolveHeadingForWrite(
        {
          headings: [
            cacheHeading("A", 1, 0),
            cacheHeading("Y", 2, 1),
            cacheHeading("Z", 2, 2),
            cacheHeading("X", 2, 3),
          ],
        },
        ["# A", "## Y", "# B", "## X"],
        ["A", "X"],
      ),
    ).toEqual({
      kind: "not-found",
      segment: "X",
      where: 'under "A"',
    });
  });

  test("keeps a nested hit whose path skips an intermediate ancestor", () => {
    expect(
      resolveHeadingForWrite(
        {
          headings: [
            cacheHeading("A", 1, 0),
            cacheHeading("B", 2, 1),
            cacheHeading("X", 3, 2),
          ],
        },
        ["# A", "## B", "### X"],
        ["A", "X"],
      ),
    ).toMatchObject({ kind: "found", line: 2, level: 3 });
  });
});
