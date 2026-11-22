/** Ranks the probe's notes against its queries (#680, after ADR-0034). */
import { cosine } from "./vectorMath";

export type RankedQuery = {
  query: string;
  expected: string | null;
  /** The note with the highest score. */
  top: string;
  topScore: number;
  /** 1-based position of the expected note, `null` for the nonsense query. */
  expectedRank: number | null;
  expectedScore: number | null;
};

export type RankingSummary = {
  queries: RankedQuery[];
  /** Queries with an expected note that ranked it first. */
  hits: number;
  /** Queries that have an expected note. */
  answerable: number;
  /** Mean score of the expected note over the answerable queries. */
  meanExpectedScore: number;
  /** Highest score any note got for a query that should match nothing. */
  nonsenseTopScore: number;
};

export function rankNotes(
  notes: ReadonlyArray<{ id: string; vector: ArrayLike<number> }>,
  queries: ReadonlyArray<{
    text: string;
    expected: string | null;
    vector: ArrayLike<number>;
  }>,
): RankingSummary {
  const ranked: RankedQuery[] = queries.map((query) => {
    const scored = notes
      .map((note) => ({
        id: note.id,
        score: cosine(query.vector, note.vector),
      }))
      // A NaN score sorts last: it must never look like a match.
      .sort(
        (a, b) =>
          (Number.isNaN(b.score) ? -Infinity : b.score) -
          (Number.isNaN(a.score) ? -Infinity : a.score),
      );
    const index =
      query.expected === null
        ? -1
        : scored.findIndex((s) => s.id === query.expected);
    return {
      query: query.text,
      expected: query.expected,
      top: scored[0]?.id ?? "",
      topScore: scored[0]?.score ?? Number.NaN,
      expectedRank: index === -1 ? null : index + 1,
      expectedScore: index === -1 ? null : scored[index]!.score,
    };
  });

  const answerable = ranked.filter((r) => r.expected !== null);
  const nonsense = ranked.filter((r) => r.expected === null);
  const expectedScores = answerable.map((r) => r.expectedScore ?? Number.NaN);
  return {
    queries: ranked,
    hits: answerable.filter((r) => r.expectedRank === 1).length,
    answerable: answerable.length,
    meanExpectedScore:
      expectedScores.length === 0
        ? Number.NaN
        : expectedScores.reduce((sum, s) => sum + s, 0) / expectedScores.length,
    nonsenseTopScore:
      nonsense.length === 0
        ? Number.NaN
        : Math.max(...nonsense.map((r) => r.topScore)),
  };
}
