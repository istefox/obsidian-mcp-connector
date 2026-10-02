import { describe, expect, test } from "bun:test";
import {
  findSourceHeading,
  checkHeadingCollision,
  rewriteSourceHeadingLine,
  rewriteBacklinker,
  planRename,
  type HeadingCacheEntry,
  type ResolveLinkpath,
} from "./headingRename";

/** Build a `HeadingCacheEntry` succinctly for fixtures. */
function h(text: string, level: number, line: number): HeadingCacheEntry {
  return { heading: text, level, position: { start: { line } } };
}

/**
 * Simplest possible resolver: treat `linkpath` as a vault path with `.md`
 * appended (or used verbatim if already there). Backlinker tests use the
 * "real" vault paths so this is enough for unit coverage.
 */
const resolveBasic: ResolveLinkpath = (linkpath) =>
  linkpath.endsWith(".md") ? linkpath : `${linkpath}.md`;

describe("headingRename — findSourceHeading", () => {
  test("returns the unique match when only one heading matches", () => {
    const lines = ["# Intro", "body", "## Details"];
    const headings = [h("Intro", 1, 0), h("Details", 2, 2)];
    const r = findSourceHeading(headings, lines, { text: "Intro" });
    expect(r).toMatchObject({ line: 0, level: 1, text: "Intro" });
  });

  test("returns heading_not_found when no match", () => {
    const r = findSourceHeading([h("Foo", 1, 0)], ["# Foo"], { text: "Bar" });
    expect(r).toMatchObject({
      errorCode: "heading_not_found",
    });
  });

  test("disambiguates by level when level is provided", () => {
    const headings = [h("Title", 1, 0), h("Title", 3, 4)];
    const lines = ["# Title", "", "", "", "### Title"];
    const r = findSourceHeading(headings, lines, { text: "Title", level: 3 });
    expect(r).toMatchObject({ line: 4, level: 3, text: "Title" });
  });

  test("returns ambiguous_heading with candidates when multiple match", () => {
    const headings = [h("Section", 1, 0), h("Section", 2, 4)];
    const lines = ["# Section", "", "", "", "## Section"];
    const r = findSourceHeading(headings, lines, { text: "Section" });
    expect(r).toMatchObject({
      errorCode: "ambiguous_heading",
    });
    if ("errorCode" in r && r.errorCode === "ambiguous_heading") {
      expect(r.candidates).toHaveLength(2);
      expect(r.candidates.map((c) => c.line)).toEqual([0, 4]);
      expect(r.candidates.map((c) => c.level)).toEqual([1, 2]);
    }
  });

  test("RFC edge case #3 — match is case-sensitive", () => {
    const headings = [h("Section", 1, 0)];
    const lines = ["# Section"];
    const r = findSourceHeading(headings, lines, { text: "section" });
    expect(r).toMatchObject({ errorCode: "heading_not_found" });
  });

  test("RFC edge case #2 — skips headings inside fenced code blocks", () => {
    // Synthetic: a heading line that lives inside a fence. Obsidian's
    // cache normally excludes these but the defensive guard kicks in.
    const lines = ["```", "# Not a heading", "```", "# Real heading"];
    const headings = [h("Not a heading", 1, 1), h("Real heading", 1, 3)];
    const r = findSourceHeading(headings, lines, { text: "Not a heading" });
    expect(r).toMatchObject({ errorCode: "heading_not_found" });
    const ok = findSourceHeading(headings, lines, { text: "Real heading" });
    expect(ok).toMatchObject({ line: 3 });
  });
});

describe("headingRename — checkHeadingCollision (RFC edge case #1)", () => {
  test("flags collision when `to` already exists at same level", () => {
    const headings = [h("From", 2, 0), h("To", 2, 4)];
    const lines = ["## From", "", "", "", "## To"];
    const r = checkHeadingCollision(headings, lines, "To", 2, 0);
    expect(r).toMatchObject({ errorCode: "heading_collision" });
  });

  test("allows when same text exists at a different level", () => {
    const headings = [h("From", 2, 0), h("To", 3, 4)];
    const lines = ["## From", "", "", "", "### To"];
    const r = checkHeadingCollision(headings, lines, "To", 2, 0);
    expect(r).toBeNull();
  });

  test("ignores the matched heading itself in the collision search", () => {
    const headings = [h("From", 2, 0)];
    const lines = ["## From"];
    // Renaming from "From" to "Whatever" should NOT collide with itself.
    const r = checkHeadingCollision(headings, lines, "Whatever", 2, 0);
    expect(r).toBeNull();
  });
});

describe("headingRename — rewriteSourceHeadingLine", () => {
  test("replaces the heading text while preserving the `#` prefix", () => {
    const lines = ["## Old", "body"];
    const out = rewriteSourceHeadingLine(lines, 0, "New", 2);
    expect(out).toEqual(["## New", "body"]);
  });

  test("preserves trailing block-id suffix (^abc)", () => {
    const lines = ["### Old ^abc-123", "body"];
    const out = rewriteSourceHeadingLine(lines, 0, "Renamed", 3);
    expect(out).toEqual(["### Renamed ^abc-123", "body"]);
  });

  test("preserves leading whitespace on the heading line", () => {
    const lines = ["  ## Old"];
    const out = rewriteSourceHeadingLine(lines, 0, "New", 2);
    expect(out).toEqual(["  ## New"]);
  });

  test("preserves trailing whitespace", () => {
    const lines = ["## Old   "];
    const out = rewriteSourceHeadingLine(lines, 0, "New", 2);
    expect(out).toEqual(["## New   "]);
  });
});

describe("headingRename — rewriteBacklinker", () => {
  test("rewrites a simple wikilink `[[note#heading]]`", () => {
    const r = rewriteBacklinker(
      "See [[source#Old]] for details.",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("See [[source#New]] for details.");
    expect(r.rewriteCount).toBe(1);
  });

  test("rewrites a wikilink with alias `[[note#heading|alias]]`", () => {
    const r = rewriteBacklinker(
      "Check [[source#Old|the old name]] please.",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("Check [[source#New|the old name]] please.");
    expect(r.rewriteCount).toBe(1);
  });

  test("rewrites a markdown link `[text](note.md#heading)`", () => {
    const r = rewriteBacklinker(
      "Read [the section](source.md#Old) carefully.",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("Read [the section](source.md#New) carefully.");
    expect(r.rewriteCount).toBe(1);
  });

  test("rewrites a markdown link with URL-encoded heading", () => {
    const r = rewriteBacklinker(
      "See [doc](source.md#My%20Old%20Heading).",
      "My Old Heading",
      "Renamed Heading",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("See [doc](source.md#Renamed%20Heading).");
    expect(r.rewriteCount).toBe(1);
  });

  test("RFC edge case #4 — rewrites subheading-path link (leaf segment)", () => {
    const r = rewriteBacklinker(
      "See [[source#Parent > Old]] there.",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("See [[source#Parent > New]] there.");
    expect(r.rewriteCount).toBe(1);
  });

  test("RFC edge case #4 — rewrites subheading-path link (non-leaf segment)", () => {
    const r = rewriteBacklinker(
      "See [[source#Old > Child]] there.",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("See [[source#New > Child]] there.");
    expect(r.rewriteCount).toBe(1);
  });

  test("does NOT rewrite a link pointing at a different note", () => {
    const r = rewriteBacklinker(
      "See [[other#Old]] there.",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("See [[other#Old]] there.");
    expect(r.rewriteCount).toBe(0);
  });

  test("does NOT rewrite a link with the wrong heading text (case-sensitive)", () => {
    const r = rewriteBacklinker(
      "See [[source#old]] (lowercase).",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("See [[source#old]] (lowercase).");
    expect(r.rewriteCount).toBe(0);
  });

  test("rewrites multiple occurrences in the same file", () => {
    const r = rewriteBacklinker(
      "First [[source#Old]] then [[source#Old|alias]] and again [[source#Old]].",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe(
      "First [[source#New]] then [[source#New|alias]] and again [[source#New]].",
    );
    expect(r.rewriteCount).toBe(3);
  });

  test("handles same-file references with `[[#heading]]` shape", () => {
    const r = rewriteBacklinker(
      "Self-ref: [[#Old]] inside source itself.",
      "Old",
      "New",
      "source.md",
      "source.md", // backlinker IS the source — same-file refs use empty notePart
      resolveBasic,
    );
    expect(r.newText).toBe("Self-ref: [[#New]] inside source itself.");
    expect(r.rewriteCount).toBe(1);
  });

  // RFC edge case #7 (#158): Obsidian's wikilink grammar splits the alias
  // on the FIRST `|`. A heading whose text contains `|` is unaddressable by
  // wikilink; the `|` is always the alias separator. Verified via
  // get_outgoing_links in a scratch vault (see #68/#158).
  test("#158 — wikilink alias splits on the FIRST `|` (heading=`A`, alias=`B|C`)", () => {
    // `[[source#A|B|C]]` targets heading `A` with alias `B|C`. Renaming
    // heading `A` rewrites only the heading segment; the alias is preserved
    // verbatim.
    const r = rewriteBacklinker(
      "Look at [[source#A|B|C]] here.",
      "A",
      "Z",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("Look at [[source#Z|B|C]] here.");
    expect(r.rewriteCount).toBe(1);
  });

  test("#158 — a heading literally named `A|B` is NOT rewritten via a wikilink", () => {
    // `[[source#A|B]]` is heading `A` + alias `B` per Obsidian's grammar, so
    // it does NOT reference a heading named `A|B`. Renaming `A|B` must leave
    // this wikilink untouched (the link points at heading `A`, not `A|B`).
    const r = rewriteBacklinker(
      "Look at [[source#A|B]] here.",
      "A|B",
      "C|D",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("Look at [[source#A|B]] here.");
    expect(r.rewriteCount).toBe(0);
  });

  test("#158 — a heading literally named `A|B` IS rewritten via a markdown link", () => {
    // Markdown-link fragments keep `|` literal, so `[txt](source.md#A|B)`
    // genuinely addresses the heading `A|B`. Renaming it rewrites the
    // fragment.
    const r = rewriteBacklinker(
      "Look at [txt](source.md#A|B) here.",
      "A|B",
      "C|D",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("Look at [txt](source.md#C|D) here.");
    expect(r.rewriteCount).toBe(1);
  });
});

describe("headingRename — rewriteBacklinker fenced-code guard (#143 C2)", () => {
  test("C2: a wikilink inside a ``` fenced block is NOT rewritten", () => {
    const text = [
      "Real: [[source#Old]] here.",
      "```",
      "Code sample: [[source#Old]] is literal text.",
      "```",
      "After: [[source#Old]] again.",
    ].join("\n");
    const r = rewriteBacklinker(
      text,
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe(
      [
        "Real: [[source#New]] here.",
        "```",
        "Code sample: [[source#Old]] is literal text.",
        "```",
        "After: [[source#New]] again.",
      ].join("\n"),
    );
    expect(r.rewriteCount).toBe(2);
  });

  test("C2: a markdown link inside a ~~~ fenced block is NOT rewritten", () => {
    const text = [
      "~~~",
      "[doc](source.md#Old)",
      "~~~",
      "[doc](source.md#Old)",
    ].join("\n");
    const r = rewriteBacklinker(
      text,
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe(
      ["~~~", "[doc](source.md#Old)", "~~~", "[doc](source.md#New)"].join("\n"),
    );
    expect(r.rewriteCount).toBe(1);
  });

  test("H4: a renamed heading containing [ ] is URL-encoded in markdown links", () => {
    const r = rewriteBacklinker(
      "See [doc](source.md#Old).",
      "Old",
      "New [1]",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("See [doc](source.md#New%20%5B1%5D).");
    expect(r.rewriteCount).toBe(1);
  });
});

describe("headingRename — rewriteBacklinker embeds & degenerate links", () => {
  // Embeds `![[…]]` are wikilinks with a leading `!`. The wikilink regex
  // matches the `[[…]]` span and leaves the `!` untouched, so an embed of a
  // renamed heading must follow the rename exactly like a plain wikilink.
  test("rewrites an embed `![[note#heading]]`, preserving the leading `!`", () => {
    const r = rewriteBacklinker(
      "Transclude: ![[source#Old]] below.",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("Transclude: ![[source#New]] below.");
    expect(r.rewriteCount).toBe(1);
  });

  test("rewrites a same-file section embed `![[#heading]]`", () => {
    const r = rewriteBacklinker(
      "Inline: ![[#Old]] here.",
      "Old",
      "New",
      "source.md",
      "source.md", // empty notePart resolves to the backlinker (self) itself
      resolveBasic,
    );
    expect(r.newText).toBe("Inline: ![[#New]] here.");
    expect(r.rewriteCount).toBe(1);
  });

  test("rewrites an embed targeting a subheading-path leaf", () => {
    const r = rewriteBacklinker(
      "Transclude: ![[source#Parent > Old]] below.",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("Transclude: ![[source#Parent > New]] below.");
    expect(r.rewriteCount).toBe(1);
  });

  test("does NOT rewrite an embed pointing at a different note", () => {
    const r = rewriteBacklinker(
      "Transclude: ![[other#Old]] below.",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("Transclude: ![[other#Old]] below.");
    expect(r.rewriteCount).toBe(0);
  });

  // Degenerate alias shapes: per the first-`|` tokenizer (#158), everything
  // after the first `|` is the alias and is preserved verbatim — including a
  // leading `|` (double-pipe) or an empty alias (trailing `|`).
  test("degenerate double-pipe `[[note#A||C]]` — heading=`A`, alias `|C` preserved", () => {
    const r = rewriteBacklinker(
      "Look at [[source#A||C]] here.",
      "A",
      "Z",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("Look at [[source#Z||C]] here.");
    expect(r.rewriteCount).toBe(1);
  });

  test("degenerate empty alias `[[note#Old|]]` — trailing pipe preserved", () => {
    const r = rewriteBacklinker(
      "Look at [[source#Old|]] here.",
      "Old",
      "New",
      "source.md",
      "back.md",
      resolveBasic,
    );
    expect(r.newText).toBe("Look at [[source#New|]] here.");
    expect(r.rewriteCount).toBe(1);
  });
});

describe("headingRename — rewriteSourceHeadingLine level fallback (#143 H2)", () => {
  test("H2: regex-miss fallback uses the known level, not hardcoded H1", () => {
    // `##Old` (no space after the hashes) does not match the heading-line
    // regex, so the fallback path is taken. It must emit the real level.
    const out = rewriteSourceHeadingLine(["##Old", "body"], 0, "New", 2);
    expect(out).toEqual(["## New", "body"]);
  });
});

describe("headingRename — planRename (integration)", () => {
  test("happy path with one source rename + two backlinkers", () => {
    const sourceText = "# Title\n## Old\nbody\n## Other";
    const sourceHeadings = [h("Title", 1, 0), h("Old", 2, 1), h("Other", 2, 3)];
    const backlinkers = {
      "a.md": "See [[source#Old]].",
      "b.md": "Also [[source#Old|alias]].",
      "c.md": "Unrelated [[other#Old]].",
    };
    const r = planRename({
      sourcePath: "source.md",
      sourceText,
      sourceHeadings,
      from: { text: "Old" },
      to: "Renamed",
      backlinkers,
      resolve: resolveBasic,
    });
    if ("errorCode" in r) throw new Error(`unexpected error: ${r.message}`);
    expect(r.source.newText).toBe("# Title\n## Renamed\nbody\n## Other");
    expect(r.source.matchedHeading.line).toBe(1);
    // c.md links to a different note → not in the backlinker patches list
    expect(r.backlinkers.map((b) => b.path).sort()).toEqual(["a.md", "b.md"]);
    expect(r.linkRewriteCount).toBe(2);
  });

  test("returns heading_not_found error before doing anything else", () => {
    const r = planRename({
      sourcePath: "source.md",
      sourceText: "# Other",
      sourceHeadings: [h("Other", 1, 0)],
      from: { text: "Missing" },
      to: "Whatever",
      backlinkers: { "a.md": "[[source#Missing]]" },
      resolve: resolveBasic,
    });
    expect(r).toMatchObject({ errorCode: "heading_not_found" });
  });

  test("returns ambiguous_heading error with candidates", () => {
    const r = planRename({
      sourcePath: "source.md",
      sourceText: "## Foo\n\n\n\n## Foo",
      sourceHeadings: [h("Foo", 2, 0), h("Foo", 2, 4)],
      from: { text: "Foo" },
      to: "Bar",
      backlinkers: {},
      resolve: resolveBasic,
    });
    expect(r).toMatchObject({ errorCode: "ambiguous_heading" });
    if ("errorCode" in r && r.errorCode === "ambiguous_heading") {
      expect(r.candidates).toHaveLength(2);
    }
  });

  test("returns heading_collision error when `to` already exists at same level", () => {
    const r = planRename({
      sourcePath: "source.md",
      sourceText: "## Old\n\n\n\n## Existing",
      sourceHeadings: [h("Old", 2, 0), h("Existing", 2, 4)],
      from: { text: "Old" },
      to: "Existing",
      backlinkers: {},
      resolve: resolveBasic,
    });
    expect(r).toMatchObject({ errorCode: "heading_collision" });
  });

  test("returns heading_collision error on no-op rename (from === to)", () => {
    const r = planRename({
      sourcePath: "source.md",
      sourceText: "## Same",
      sourceHeadings: [h("Same", 2, 0)],
      from: { text: "Same" },
      to: "Same",
      backlinkers: {},
      resolve: resolveBasic,
    });
    expect(r).toMatchObject({ errorCode: "heading_collision" });
  });

  test("emits an empty backlinkers list (and linkRewriteCount=0) when no file references the heading", () => {
    const r = planRename({
      sourcePath: "source.md",
      sourceText: "## Old",
      sourceHeadings: [h("Old", 2, 0)],
      from: { text: "Old" },
      to: "New",
      backlinkers: { "a.md": "no links here" },
      resolve: resolveBasic,
    });
    if ("errorCode" in r) throw new Error(`unexpected error: ${r.message}`);
    expect(r.backlinkers).toEqual([]);
    expect(r.linkRewriteCount).toBe(0);
    expect(r.source.newText).toBe("## New");
  });
});
