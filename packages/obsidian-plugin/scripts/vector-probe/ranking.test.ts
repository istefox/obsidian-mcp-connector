import { describe, expect, test } from "bun:test";
import { PROBE_NOTES, PROBE_QUERIES } from "./corpus";
import { rankNotes } from "./ranking";

const notes = [
  { id: "a", vector: [1, 0, 0] },
  { id: "b", vector: [0, 1, 0] },
  { id: "c", vector: [0, 0, 1] },
];

describe("rankNotes", () => {
  test("counts a query whose expected note ranks first as a hit", () => {
    const summary = rankNotes(notes, [
      { text: "q1", expected: "a", vector: [0.9, 0.1, 0] },
      { text: "q2", expected: "b", vector: [0.9, 0.3, 0] },
    ]);

    expect(summary.hits).toBe(1);
    expect(summary.answerable).toBe(2);
    expect(summary.queries.map((q) => [q.top, q.expectedRank])).toEqual([
      ["a", 1],
      ["a", 2],
    ]);
  });

  test("reports the nonsense query's best score and leaves it out of the hits", () => {
    const summary = rankNotes(notes, [
      { text: "q1", expected: "a", vector: [1, 0, 0] },
      { text: "noise", expected: null, vector: [1, 1, 1] },
    ]);

    expect(summary.answerable).toBe(1);
    expect(summary.hits).toBe(1);
    expect(summary.nonsenseTopScore).toBeCloseTo(1 / Math.sqrt(3), 12);
    expect(summary.queries[1]).toMatchObject({
      expectedRank: null,
      expectedScore: null,
    });
    expect(summary.meanExpectedScore).toBe(1);
  });

  test("collapsed vectors: every note scores the same and the nonsense query scores as high", () => {
    const collapsed = notes.map((n) => ({ id: n.id, vector: [1, 1, 1] }));
    const summary = rankNotes(collapsed, [
      { text: "q", expected: "c", vector: [1, 1, 1] },
      { text: "noise", expected: null, vector: [1, 1, 1] },
    ]);

    expect(summary.meanExpectedScore).toBeCloseTo(1, 12);
    expect(summary.nonsenseTopScore).toBeCloseTo(1, 12);
  });

  test("a NaN score never ranks first", () => {
    const summary = rankNotes(
      [
        { id: "broken", vector: [0, 0, 0] },
        { id: "a", vector: [1, 0, 0] },
      ],
      [{ text: "q", expected: "a", vector: [1, 0, 0] }],
    );

    expect(summary.queries[0]!.top).toBe("a");
    expect(summary.hits).toBe(1);
  });
});

describe("probe corpus", () => {
  test("has ADR-0034's shape: twelve notes, eight answerable queries, one nonsense", () => {
    expect(PROBE_NOTES).toHaveLength(12);
    expect(PROBE_QUERIES.filter((q) => q.expected !== null)).toHaveLength(8);
    expect(PROBE_QUERIES.filter((q) => q.expected === null)).toHaveLength(1);
  });

  test("every expected note exists, and no note is expected twice", () => {
    const ids = new Set(PROBE_NOTES.map((n) => n.id));
    expect(ids.size).toBe(PROBE_NOTES.length);
    const expected = PROBE_QUERIES.flatMap((q) => q.expected ?? []);
    for (const id of expected) expect(ids.has(id)).toBe(true);
    expect(new Set(expected).size).toBe(expected.length);
  });
});
