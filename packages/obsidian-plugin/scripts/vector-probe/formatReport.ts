/** Plain-text rendering of a vector probe report (#680). */
import type { BackendRun, CaseResult, ProbeReport } from "./runVectorProbe";

function num(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? "n/a" : value.toFixed(4);
}

function rankingLine(name: string, run: BackendRun | undefined): string[] {
  const ranking = run?.ranking;
  if (!ranking) return [];
  const misses = ranking.queries
    .filter((q) => q.expected !== null && q.expectedRank !== 1)
    .map(
      (q) =>
        `"${q.query}" -> ${q.top} (expected ${q.expected} at ${q.expectedRank})`,
    );
  return [
    `  ranking ${name}: ${ranking.hits}/${ranking.answerable} expected notes first, ` +
      `mean expected score ${num(ranking.meanExpectedScore)}, nonsense top score ${num(ranking.nonsenseTopScore)}`,
    ...misses.map((m) => `    miss: ${m}`),
  ];
}

function runLine(name: string, run: BackendRun | undefined): string {
  if (!run) return `  ${name}: did not run`;
  return (
    `  ${name}: thread ${run.thread}, ${run.dimensions} dims, ` +
    `collapse ${num(run.collapse)}, load ${run.loadMs} ms, embed ${run.embedMs} ms, ` +
    `files ${run.files.length > 0 ? run.files.join(" ") : "not reported"}`
  );
}

function caseBlock(result: CaseResult): string[] {
  const lines = [
    `${result.model} [${result.variant}]${result.control ? " (control: production pins this model to WASM)" : ""}`,
    `  verdict: ${result.verdict.toUpperCase()}`,
    `  dtype: WebGPU ${result.dtype.webgpu}, WASM ${result.dtype.wasm}`,
    runLine("WebGPU", result.webgpu),
    runLine("WASM  ", result.wasm),
  ];
  if (result.perSentence) {
    lines.push(
      `  cosine WebGPU vs WASM: min ${num(result.minCosine)}, mean ${num(result.meanCosine)}`,
      `  per sentence: ${result.perSentence.map(num).join(" ")}`,
    );
  }
  if (result.webgpu && result.wasm) {
    lines.push(
      `  collapse delta (WebGPU - WASM): ${num(result.webgpu.collapse - result.wasm.collapse)}`,
    );
  }
  lines.push(
    ...rankingLine("WebGPU", result.webgpu),
    ...rankingLine("WASM  ", result.wasm),
  );
  for (const note of result.notes) lines.push(`  note: ${note}`);
  return lines;
}

/**
 * What the control cases say about the probe itself. Only a control case
 * at equal dtype can prove the probe sees the known defect: the control
 * model as shipped loads different weights per backend, so it never
 * comes back as a mismatch.
 */
function controlLines(cases: readonly CaseResult[]): string[] {
  const decisive = cases.filter((c) => c.control && c.equalDtype);
  if (decisive.length === 0) return [];
  if (decisive.some((c) => c.verdict === "mismatch")) return [];
  if (decisive.every((c) => c.verdict === "invalid")) {
    return [
      "WARNING: no control case ran to the end, so nothing shows this probe can see",
      "the defect the control model is known for. Read the other verdicts with that in mind.",
      "",
    ];
  }
  return [
    "WARNING: no control case came back as a mismatch. The control is a model known to be",
    "wrong on WebGPU, so either that defect is gone here or this probe cannot see it.",
    "",
  ];
}

export function formatReport(report: ProbeReport): string {
  const lines = [
    "Vector probe: WebGPU (main thread) vs WASM (embedding worker)",
    `machine backend: ${report.machineBackend}, sentences: ${report.sentences}, threshold: ${report.threshold}`,
    "",
  ];
  for (const result of report.cases) lines.push(...caseBlock(result), "");
  lines.push(...controlLines(report.cases));
  return lines.join("\n");
}
