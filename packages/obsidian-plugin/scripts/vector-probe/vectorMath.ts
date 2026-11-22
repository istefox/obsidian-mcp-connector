/**
 * The arithmetic of the vector probe (#680). No model, no Obsidian: plain
 * numbers in, plain numbers out, so it is tested on its own.
 */

/** Cosine of two vectors. `NaN` when either has no length or no norm. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return Number.NaN;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return Number.NaN;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Mean cosine over every pair of different vectors: the collapse index.
 * A model that tells sentences apart keeps it well below 1, and one that
 * returns nearly the same vector for every input pushes it to 1. It is
 * only meaningful next to the same model's value on the other backend:
 * some models sit high by nature.
 */
export function meanPairwiseCosine(
  vectors: ReadonlyArray<ArrayLike<number>>,
): number {
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sum += cosine(vectors[i]!, vectors[j]!);
      pairs++;
    }
  }
  return pairs === 0 ? Number.NaN : sum / pairs;
}

/** True when any component is not a finite number. */
export function hasNonFinite(vector: ArrayLike<number>): boolean {
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i]!)) return true;
  }
  return false;
}

/** Splits a `[rows, dim]` row-major tensor into one vector per row. */
export function splitRows(
  data: Float32Array,
  rows: number,
  dims?: number[],
): Float32Array[] {
  const stride =
    dims?.length === 2 && typeof dims[1] === "number"
      ? dims[1]
      : data.length / rows;
  if (!Number.isInteger(stride) || stride <= 0) {
    throw new Error(
      `cannot split ${data.length} values into ${rows} rows of equal length`,
    );
  }
  return Array.from(
    { length: rows },
    (_, row) =>
      new Float32Array(data.subarray(row * stride, (row + 1) * stride)),
  );
}
