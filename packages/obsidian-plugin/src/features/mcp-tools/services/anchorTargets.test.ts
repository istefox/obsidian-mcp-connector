// See docs/architecture/ADR-0024-converge-anchor-matchers.md.
import { describe, expect, test } from "bun:test";
import {
  headingEntriesFromCache,
  headingEntriesFromContent,
  headingPathToSubpath,
  normalizeBlockId,
  resolveHeadingEntries,
  resolveHeadingForUri,
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

  test("names the ancestors with the caller's own delimiter", () => {
    // The message echoes the path back to the caller, so it has to be joined
    // with the delimiter the caller wrote it in — `"A::B"` for a `" > "`
    // request describes a scope the caller never asked for.
    expect(
      resolveHeadingEntries(
        [heading("Parent", 1, 0), heading("Child", 2, 1)],
        ["Parent", "Child", "Missing"],
        4,
        " > ",
      ),
    ).toEqual({
      kind: "not-found",
      segment: "Missing",
      where: 'under "Parent > Child"',
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

  test("reports ambiguity when content gained a duplicate the cache predates", () => {
    // The cache was indexed before the second "## Section" was written, so it
    // still resolves to a single line 1 and the cached line itself is
    // untouched. Only a full re-resolution over the content sees the second
    // candidate; without it the write silently picks one of the two.
    expect(
      resolveHeadingForWrite(
        { headings: [cacheHeading("Section", 2, 1)] },
        ["# Parent", "## Section", "body", "## Section"],
        ["Section"],
      ),
    ).toMatchObject({ kind: "ambiguous", segment: "Section" });
  });

  test("resolves the surviving match when the cache is ambiguous but content is not", () => {
    // The mirror case: the cache still lists a "## Section" at line 3 that the
    // file no longer has. The ambiguity is an artefact of the stale index, and
    // erroring on it refuses a write that has exactly one valid target.
    expect(
      resolveHeadingForWrite(
        {
          headings: [
            cacheHeading("Section", 2, 1),
            cacheHeading("Section", 2, 3),
          ],
        },
        ["# Parent", "## Section", "body", "tail", "more"],
        ["Section"],
      ),
    ).toMatchObject({ kind: "found", line: 1, level: 2 });
  });

  test("passes the caller's delimiter through to the not-found message", () => {
    expect(
      resolveHeadingForWrite(
        null,
        ["# A", "## B", "body"],
        ["A", "B", "Missing"],
        " > ",
      ),
    ).toEqual({
      kind: "not-found",
      segment: "Missing",
      where: 'under "A > B"',
    });
  });
});

describe("resolveHeadingForUri (ADR-0026 D7, D8)", () => {
  test("exact match resolves from content", () => {
    expect(
      resolveHeadingForUri(null, ["# Title", "body", "## Section"], "Section"),
    ).toEqual({ ok: true, heading: "Section" });
  });

  test("caller's casing differs from the note's — resolves, returns the note's own casing", () => {
    expect(
      resolveHeadingForUri(null, ["# Title", "## Section"], "section"),
    ).toEqual({ ok: true, heading: "Section" });
  });

  test("heading only inside a fenced code block does not resolve (fence-awareness)", () => {
    expect(
      resolveHeadingForUri(
        null,
        ["```", "## Fenced Heading", "```", "body"],
        "Fenced Heading",
      ),
    ).toEqual({ ok: false });
  });

  test("absent from content but present in the cache (truncated-content case) — resolves from cache", () => {
    expect(
      resolveHeadingForUri(
        { headings: [cacheHeading("Past The Cut", 2, 500)] },
        ["# Title", "body — no headings here at all"],
        "Past The Cut",
      ),
    ).toEqual({ ok: true, heading: "Past The Cut" });
  });

  test("present in content but absent from the cache (just-created-note case) — resolves from content", () => {
    expect(
      resolveHeadingForUri(
        { headings: [] },
        ["# Title", "## Fresh Heading"],
        "Fresh Heading",
      ),
    ).toEqual({ ok: true, heading: "Fresh Heading" });
  });

  test("two identical headings resolve to the first in document order, not an error (ADR-0026 D8 — diverges from ADR-0024 D4's write-path ambiguity rule)", () => {
    expect(
      resolveHeadingForUri(
        null,
        ["# Duplicate", "body", "# Duplicate", "more"],
        "Duplicate",
      ),
    ).toEqual({ ok: true, heading: "Duplicate" });
  });

  test("whitespace-only heading does not resolve", () => {
    expect(resolveHeadingForUri(null, ["# Title"], "   ")).toEqual({
      ok: false,
    });
  });

  test("absent/empty cache and empty content do not resolve, and do not throw", () => {
    expect(() => resolveHeadingForUri(null, [], "Anything")).not.toThrow();
    expect(resolveHeadingForUri(null, [], "Anything")).toEqual({ ok: false });
    expect(resolveHeadingForUri({ headings: [] }, [], "Anything")).toEqual({
      ok: false,
    });
  });
});
