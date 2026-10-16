import { describe, expect, test } from "bun:test";
import {
  parseFrontMatterAliases,
  prepareFuzzySearch,
  sortSearchResults,
} from "./fuzzySearch";

const score = (query: string, text: string) =>
  prepareFuzzySearch(query)(text)?.score ?? null;

describe("prepareFuzzySearch", () => {
  test("an exact match scores 0, the best", () => {
    expect(score("note", "note")).toBe(0);
    expect(score("NOTE", "note")).toBe(0);
  });

  test("scores are never above 0", () => {
    for (const [q, t] of [
      ["abc", "a big cat"],
      ["x", "Projects/x.md"],
      ["pm", "Project Management"],
    ]) {
      expect(score(q, t) as number).toBeLessThanOrEqual(0);
    }
  });

  test("returns null unless the characters occur in order", () => {
    expect(score("abc", "acb")).toBeNull();
    expect(score("z", "note")).toBeNull();
    expect(score("noteb", "note")).toBeNull();
  });

  test("a name whose lowercase is longer still matches, with ranges in the original text", () => {
    // `İ` lowercases to two UTF-16 units.
    const match = prepareFuzzySearch("ist")("İstanbul.md");
    expect(match).not.toBeNull();
    expect(match?.matches).toEqual([[0, 3]]);
    expect(prepareFuzzySearch("stan")("İstanbul.md")?.matches).toEqual([
      [1, 5],
    ]);
  });

  test("offsets after a length-changing character map back to the original text", () => {
    expect(prepareFuzzySearch("y")("xİy.md")?.matches).toEqual([[2, 3]]);
    expect(prepareFuzzySearch("ab")("İİ ab")?.matches).toEqual([[3, 5]]);
    // An astral character is one range, not two halves.
    expect(prepareFuzzySearch("z")("\u{1F600}z")?.matches).toEqual([[2, 3]]);
  });

  test("an empty query matches anything with score 0", () => {
    expect(prepareFuzzySearch("")("anything")).toEqual({
      score: 0,
      matches: [],
    });
    expect(prepareFuzzySearch("  ")("x")).toEqual({ score: 0, matches: [] });
  });

  test("a contiguous run beats scattered characters", () => {
    expect(score("mee", "meeting")).toBeGreaterThan(score("mee", "m-e-x-e")!);
    expect(score("abc", "abcdef")).toBeGreaterThan(score("abc", "a-b-c-def")!);
  });

  test("a match at a word start beats one in the middle of a word", () => {
    expect(score("not", "my notes")).toBeGreaterThan(score("not", "annotate")!);
    expect(score("pm", "Project Management")).toBeGreaterThan(
      score("pm", "spam")!,
    );
  });

  test("camelCase humps and separators count as word starts", () => {
    expect(score("pm", "ProjectManager")).toBeGreaterThan(
      score("pm", "rapidmap")!,
    );
    expect(score("pm", "project-manager")).toBeGreaterThan(
      score("pm", "rapidmap")!,
    );
  });

  test("an earlier and a tighter text scores higher", () => {
    expect(score("note", "note")).toBeGreaterThan(score("note", "note extra")!);
    expect(score("note", "note extra")).toBeGreaterThan(
      score("note", "zzz note")!,
    );
  });

  test("the best alignment is chosen, not the first", () => {
    // The first `a` and `b` are apart, a later pair is adjacent.
    const result = prepareFuzzySearch("ab")("a x ab")!;
    expect(result.matches).toEqual([[4, 6]]);
  });

  test("matches are ranges of consecutive matched characters", () => {
    expect(prepareFuzzySearch("nb")("note book")!.matches).toEqual([
      [0, 1],
      [5, 6],
    ]);
    expect(prepareFuzzySearch("noo")("note book")!.matches).toEqual([
      [0, 2],
      [6, 7],
    ]);
  });

  test("whitespace separates words that must each match", () => {
    const hit = prepareFuzzySearch("proj plan")("Project Plan 2025");
    expect(hit).not.toBeNull();
    expect(hit!.matches).toEqual([
      [0, 4],
      [8, 12],
    ]);
    expect(prepareFuzzySearch("proj zzz")("Project Plan")).toBeNull();
  });

  test("is case-insensitive and keeps ranges on the original text", () => {
    expect(prepareFuzzySearch("ÄB")("xäb")!.matches).toEqual([[1, 3]]);
  });

  test("a query folds like the names it searches, even for a final sigma", () => {
    // A whole-string lowercase turns the final `Σ` into `ς`, a name folds
    // one code point at a time into `σ`.
    expect(prepareFuzzySearch("ΟΣ")("ΟΣ.md")?.matches).toEqual([[0, 2]]);
    expect(prepareFuzzySearch("οσ")("ΟΣ.md")?.matches).toEqual([[0, 2]]);
  });
});

describe("sortSearchResults", () => {
  test("puts the highest score first", () => {
    const rows = [
      { id: "low", match: { score: -3, matches: [] } },
      { id: "best", match: { score: 0, matches: [] } },
      { id: "mid", match: { score: -1, matches: [] } },
    ];
    sortSearchResults(rows);
    expect(rows.map((r) => r.id)).toEqual(["best", "mid", "low"]);
  });
});

describe("parseFrontMatterAliases", () => {
  test("reads a list, a comma-separated string, and either key", () => {
    expect(parseFrontMatterAliases({ aliases: ["A", " B "] })).toEqual([
      "A",
      "B",
    ]);
    expect(parseFrontMatterAliases({ alias: "A, B" })).toEqual(["A", "B"]);
    expect(parseFrontMatterAliases({ Aliases: [1, "x"] })).toEqual(["1", "x"]);
  });

  test("returns null when there are none", () => {
    expect(parseFrontMatterAliases(null)).toBeNull();
    expect(parseFrontMatterAliases({ title: "x" })).toBeNull();
    expect(parseFrontMatterAliases({ aliases: 5 })).toBeNull();
  });

  test("drops empty entries", () => {
    expect(parseFrontMatterAliases({ aliases: ["", "A", null] })).toEqual([
      "A",
    ]);
  });
});
