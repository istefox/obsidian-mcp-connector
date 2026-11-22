import { describe, expect, test } from "bun:test";
import {
  cosine,
  hasNonFinite,
  meanPairwiseCosine,
  splitRows,
} from "./vectorMath";

describe("cosine", () => {
  test("is 1 for the same direction, whatever the length", () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
  });

  test("is 0 for orthogonal vectors and -1 for opposite ones", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [-3, 0])).toBeCloseTo(-1, 12);
  });

  test("matches a hand-computed value", () => {
    // (1*1 + 2*0) / (sqrt(5) * 1)
    expect(cosine([1, 2], [1, 0])).toBeCloseTo(1 / Math.sqrt(5), 12);
  });

  test("is NaN for a zero vector, a length mismatch or no components", () => {
    expect(cosine([0, 0], [1, 0])).toBeNaN();
    expect(cosine([1, 0], [1, 0, 0])).toBeNaN();
    expect(cosine([], [])).toBeNaN();
  });
});

describe("meanPairwiseCosine", () => {
  test("is 1 when every vector is the same: collapse", () => {
    expect(
      meanPairwiseCosine([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    ).toBeCloseTo(1, 12);
  });

  test("is 0 for mutually orthogonal vectors", () => {
    expect(
      meanPairwiseCosine([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]),
    ).toBe(0);
  });

  test("averages over the pairs, not over the vectors", () => {
    // Pairs: (a,b) = 1, (a,c) = 0, (b,c) = 0.
    expect(
      meanPairwiseCosine([
        [1, 0],
        [1, 0],
        [0, 1],
      ]),
    ).toBeCloseTo(1 / 3, 12);
  });

  test("is NaN with fewer than two vectors", () => {
    expect(meanPairwiseCosine([[1, 0]])).toBeNaN();
    expect(meanPairwiseCosine([])).toBeNaN();
  });
});

describe("hasNonFinite", () => {
  test("spots NaN and Infinity", () => {
    expect(hasNonFinite([1, Number.NaN])).toBe(true);
    expect(hasNonFinite([Number.POSITIVE_INFINITY])).toBe(true);
    expect(hasNonFinite([0, -1.5])).toBe(false);
  });
});

describe("splitRows", () => {
  const data = new Float32Array([1, 2, 3, 4, 5, 6]);

  test("uses the tensor's own row length when it has one", () => {
    expect(splitRows(data, 2, [2, 3]).map((r) => Array.from(r))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  test("derives the row length when dims are missing", () => {
    expect(splitRows(data, 3).map((r) => Array.from(r))).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  test("returns copies, not views of the tensor", () => {
    const rows = splitRows(data, 2, [2, 3]);
    rows[0]![0] = 99;
    expect(data[0]).toBe(1);
  });

  test("refuses a tensor that does not divide into the rows", () => {
    expect(() => splitRows(data, 4)).toThrow("cannot split 6 values");
  });
});
