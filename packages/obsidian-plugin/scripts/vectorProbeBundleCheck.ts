/**
 * Keeps the vector probe's access point (#680) out of every bundle that
 * was not built for it. `bun.config.ts` runs this on the main.js it just
 * wrote, `zip.ts` on the one it is about to pack.
 */
import { VECTOR_PROBE_KEY } from "../src/features/semantic-search/services/vectorProbeHook";

/**
 * `null` when the bundle matches the build that was asked for, otherwise
 * what is wrong. `withVectorProbe` is whether `--vector-probe` was passed.
 */
export function vectorProbeBundleProblem(
  mainJs: string,
  withVectorProbe: boolean,
): string | null {
  const hasHook = mainJs.includes(VECTOR_PROBE_KEY);
  if (hasHook === withVectorProbe) return null;
  return withVectorProbe
    ? "--vector-probe was passed but main.js has no vector probe hook"
    : "main.js holds the vector probe hook without --vector-probe";
}
