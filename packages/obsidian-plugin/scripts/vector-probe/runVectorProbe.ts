/**
 * Runs the vector probe (#680): every planned case embeds the same
 * sentences on WebGPU, on the main thread, and on WASM, in an embedding
 * worker, through the plugin's own pipeline factory. A failed WebGPU
 * attempt poisons later CPU sessions of the same context, which is why
 * the two never share one.
 */
import type {
  PipelineFn,
  ProgressEvent,
} from "../../src/features/semantic-search/services/embedder";
import type { VectorProbeHook } from "../../src/features/semantic-search/services/vectorProbeHook";
import type { ProbeNote, ProbeQuery } from "./corpus";
import { planProbeCases, type ProbeCase } from "./probeCases";
import { rankNotes, type RankingSummary } from "./ranking";
import {
  cosine,
  hasNonFinite,
  meanPairwiseCosine,
  splitRows,
} from "./vectorMath";

/** Same weights, two backends: the vectors must agree at least this much. */
export const COSINE_THRESHOLD = 0.99;
/** Production's batch size (transformersProvider.ts, embedder.ts). */
const BATCH_SIZE = 8;

export type BackendRun = {
  /** `main` or `worker`, read off the pipeline that came back. */
  thread: "main" | "worker";
  /** The `.onnx` files the library reported while loading. */
  files: string[];
  dimensions: number;
  nonFinite: boolean;
  /** Mean pairwise cosine over the sentences: the collapse index. */
  collapse: number;
  loadMs: number;
  embedMs: number;
  /** Absent when the run was given no notes and queries. */
  ranking?: RankingSummary;
};

export type CaseVerdict = "ok" | "mismatch" | "inconclusive" | "invalid";

export type CaseResult = {
  model: string;
  modelId: string;
  variant: string;
  control: boolean;
  equalDtype: boolean;
  dtype: { webgpu: string; wasm: string };
  verdict: CaseVerdict;
  /** Why the case is `invalid`, or what a `mismatch` rests on. */
  notes: string[];
  webgpu?: BackendRun;
  wasm?: BackendRun;
  /** Cosine WebGPU against WASM, one per sentence. */
  perSentence?: number[];
  minCosine?: number;
  meanCosine?: number;
};

export type ProbeReport = {
  machineBackend: string;
  sentences: number;
  threshold: number;
  cases: CaseResult[];
};

export type ProbeOptions = {
  sentences: readonly string[];
  /** The ranking test's inputs. Both absent skips it. */
  notes?: readonly ProbeNote[];
  queries?: readonly ProbeQuery[];
  /** Model labels to run. Absent runs every model in the table. */
  only?: readonly string[];
  log?: (line: string) => void;
};

type Loaded = { vectors: Float32Array[]; run: BackendRun };

type Inputs = Pick<ProbeOptions, "sentences" | "notes" | "queries">;

async function embedOn(
  hook: VectorProbeHook,
  testCase: ProbeCase,
  backend: "webgpu" | "wasm",
  inputs: Inputs,
): Promise<Loaded> {
  const files = new Set<string>();
  const onProgress = (event: ProgressEvent): void => {
    if (event.file?.endsWith(".onnx")) files.add(event.file);
  };
  const dtype =
    backend === "webgpu" ? testCase.webgpuDtype : testCase.wasmDtype;
  const loadStart = performance.now();
  const pipe: PipelineFn = await hook.pipelineFactory(
    testCase.model.modelId,
    onProgress,
    {
      ...(dtype !== undefined ? { dtype } : {}),
      ...(backend === "wasm" ? { backend: "wasm" as const } : {}),
    },
  );
  const loadMs = performance.now() - loadStart;
  try {
    const embed = async (texts: string[]): Promise<Float32Array[]> => {
      const out: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += BATCH_SIZE) {
        const batch = texts.slice(start, start + BATCH_SIZE);
        const result = await pipe(batch, {
          pooling: "mean",
          normalize: true,
          truncation: true,
          max_length: testCase.model.maxInputTokens,
        });
        out.push(...splitRows(result.data, batch.length, result.dims));
      }
      return out;
    };
    const { passagePrefix, queryPrefix } = testCase.model;
    const embedStart = performance.now();
    const vectors = await embed(inputs.sentences.map((s) => passagePrefix + s));
    const notes = inputs.notes ?? [];
    const queries = inputs.queries ?? [];
    let ranking: RankingSummary | undefined;
    if (notes.length > 0 && queries.length > 0) {
      const noteVectors = await embed(notes.map((n) => passagePrefix + n.text));
      const queryVectors = await embed(
        queries.map((q) => queryPrefix + q.text),
      );
      ranking = rankNotes(
        notes.map((n, i) => ({ id: n.id, vector: noteVectors[i]! })),
        queries.map((q, i) => ({ ...q, vector: queryVectors[i]! })),
      );
    }
    return {
      vectors,
      run: {
        // Only the worker pipeline queues its calls (ADR-0036).
        thread: pipe.acceptsPriority === true ? "worker" : "main",
        files: [...files].sort(),
        dimensions: vectors[0]?.length ?? 0,
        nonFinite: vectors.some(hasNonFinite),
        collapse: meanPairwiseCosine(vectors),
        loadMs: Math.round(loadMs),
        embedMs: Math.round(performance.now() - embedStart),
        ...(ranking ? { ranking } : {}),
      },
    };
  } finally {
    await pipe.dispose?.();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCase(
  hook: VectorProbeHook,
  testCase: ProbeCase,
  inputs: Inputs,
): Promise<CaseResult> {
  const result: CaseResult = {
    model: testCase.model.label,
    modelId: testCase.model.modelId,
    variant: testCase.variant,
    control: testCase.control,
    equalDtype: testCase.equalDtype,
    dtype: {
      webgpu: testCase.webgpuDtype ?? "library default",
      wasm: testCase.wasmDtype ?? "library default",
    },
    verdict: "invalid",
    notes: [],
  };

  let webgpu: Loaded;
  let wasm: Loaded;
  try {
    webgpu = await embedOn(hook, testCase, "webgpu", inputs);
    result.webgpu = webgpu.run;
  } catch (error) {
    result.notes.push(`WebGPU run failed: ${message(error)}`);
    return result;
  }
  try {
    wasm = await embedOn(hook, testCase, "wasm", inputs);
    result.wasm = wasm.run;
  } catch (error) {
    result.notes.push(`WASM run failed: ${message(error)}`);
    return result;
  }

  // A run on the wrong thread did not test what its row claims: WebGPU in
  // a worker cannot happen here, and WASM on the main thread means the
  // worker gave up and the session shares WebGPU's context.
  if (webgpu.run.thread !== "main") {
    result.notes.push("the WebGPU run came back from a worker");
  }
  if (wasm.run.thread !== "worker") {
    result.notes.push(
      "the WASM run was on the main thread, in the context WebGPU ran in",
    );
  }
  if (webgpu.run.dimensions !== wasm.run.dimensions) {
    result.notes.push(
      `dimensions differ: WebGPU ${webgpu.run.dimensions}, WASM ${wasm.run.dimensions}`,
    );
  }
  if (result.notes.length > 0) return result;

  const perSentence = webgpu.vectors.map((v, i) => cosine(v, wasm.vectors[i]!));
  result.perSentence = perSentence;
  result.minCosine = Math.min(...perSentence);
  result.meanCosine =
    perSentence.reduce((sum, c) => sum + c, 0) / perSentence.length;

  if (webgpu.run.nonFinite)
    result.notes.push("WebGPU returned NaN or Infinity");
  if (wasm.run.nonFinite) result.notes.push("WASM returned NaN or Infinity");
  // `!(x >= t)` and not `x < t`: a NaN cosine has to fail too.
  const agrees =
    !webgpu.run.nonFinite &&
    !wasm.run.nonFinite &&
    perSentence.every((c) => c >= COSINE_THRESHOLD);

  if (agrees) {
    result.verdict = "ok";
  } else if (testCase.equalDtype) {
    result.verdict = "mismatch";
  } else {
    result.verdict = "inconclusive";
    result.notes.push(
      "the two backends loaded different weights: see the rows that force one dtype",
    );
  }
  return result;
}

export async function runVectorProbe(
  hook: VectorProbeHook,
  options: ProbeOptions,
): Promise<ProbeReport> {
  const log = options.log ?? (() => {});
  const machineBackend = await hook.machineBackend();
  if (machineBackend !== "webgpu") {
    throw new Error(
      `this machine resolved "${machineBackend}", not webgpu: there is no WebGPU side to compare`,
    );
  }
  const models = options.only
    ? hook.models.filter((m) => options.only!.includes(m.label))
    : hook.models;
  if (models.length === 0) {
    throw new Error(
      `no model to run. Known labels: ${hook.models.map((m) => m.label).join(", ")}`,
    );
  }

  const cases: CaseResult[] = [];
  const planned = planProbeCases(models);
  for (const [index, testCase] of planned.entries()) {
    log(
      `case ${index + 1}/${planned.length}: ${testCase.model.label}, ${testCase.variant}`,
    );
    const result = await runCase(hook, testCase, options);
    log(`  ${result.verdict}`);
    cases.push(result);
  }
  return {
    machineBackend,
    sentences: options.sentences.length,
    threshold: COSINE_THRESHOLD,
    cases,
  };
}
