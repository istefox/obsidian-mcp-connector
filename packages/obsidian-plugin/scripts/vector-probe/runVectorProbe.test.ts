import { describe, expect, test } from "bun:test";
import type {
  PipelineFn,
  PipelineLoadOpts,
} from "../../src/features/semantic-search/services/embedder";
import type {
  VectorProbeHook,
  VectorProbeModel,
} from "../../src/features/semantic-search/services/vectorProbeHook";
import { formatReport } from "./formatReport";
import { runVectorProbe } from "./runVectorProbe";

const SENTENCES = ["alpha", "beta", "gamma"];

/** One distinct direction per sentence, in three dimensions. */
const HEALTHY: Record<string, number[]> = {
  alpha: [1, 0, 0],
  beta: [0, 1, 0],
  gamma: [0, 0, 1],
};

type Behaviour = {
  /** Vector for a text on a backend. Default: `HEALTHY` on both. */
  vector?: (text: string, backend: "webgpu" | "wasm") => number[];
  /** Whether the WASM load comes back as a worker pipeline. */
  wasmInWorker?: boolean;
  failWebgpu?: string;
};

type Load = { model: string; opts: PipelineLoadOpts | undefined };

function fakeHook(
  models: VectorProbeModel[],
  behaviour: Behaviour = {},
  machineBackend: "webgpu" | "wasm" = "webgpu",
): { hook: VectorProbeHook; loads: Load[]; disposed: () => number } {
  const loads: Load[] = [];
  let disposed = 0;
  const hook: VectorProbeHook = {
    machineBackend: async () => machineBackend,
    models,
    pipelineFactory: async (model, onProgress, opts) => {
      loads.push({ model, opts });
      const backend = opts?.backend === "wasm" ? "wasm" : "webgpu";
      if (backend === "webgpu" && behaviour.failWebgpu) {
        throw new Error(behaviour.failWebgpu);
      }
      onProgress?.({ status: "done", file: `onnx/model_${backend}.onnx` });
      onProgress?.({ status: "done", file: "tokenizer.json" });
      const pipe: PipelineFn = async (input) => {
        const texts = Array.isArray(input) ? input : [input];
        const rows = texts.map((text) =>
          (behaviour.vector ?? ((t: string) => HEALTHY[t]!))(text, backend),
        );
        return {
          data: new Float32Array(rows.flat()),
          dims: [rows.length, rows[0]!.length],
        };
      };
      if (backend === "wasm" && behaviour.wasmInWorker !== false) {
        pipe.acceptsPriority = true;
      }
      pipe.dispose = async () => {
        disposed++;
      };
      return pipe;
    },
  };
  return { hook, loads, disposed: () => disposed };
}

const base = { maxInputTokens: 256, queryPrefix: "q: ", passagePrefix: "" };
const E5: VectorProbeModel = {
  ...base,
  label: "E5",
  modelId: "e5-id",
  dtype: { wasm: "q8", webgpu: "q8" },
};

describe("runVectorProbe", () => {
  test("identical vectors on both backends: ok, with the collapse index", async () => {
    const { hook, loads, disposed } = fakeHook([E5]);

    const report = await runVectorProbe(hook, { sentences: SENTENCES });

    expect(report.cases).toHaveLength(1);
    const result = report.cases[0]!;
    expect(result.verdict).toBe("ok");
    expect(result.perSentence).toEqual([1, 1, 1]);
    expect(result.minCosine).toBe(1);
    expect(result.webgpu).toMatchObject({
      thread: "main",
      dimensions: 3,
      collapse: 0,
      files: ["onnx/model_webgpu.onnx"],
    });
    expect(result.wasm).toMatchObject({ thread: "worker", collapse: 0 });
    // WebGPU with no backend override, WASM with one, same dtype on both.
    expect(loads).toEqual([
      { model: "e5-id", opts: { dtype: "q8" } },
      { model: "e5-id", opts: { dtype: "q8", backend: "wasm" } },
    ]);
    expect(disposed()).toBe(2);
  });

  test("collapsed WebGPU vectors at equal dtype: mismatch", async () => {
    const { hook } = fakeHook([E5], {
      vector: (text, backend) =>
        backend === "webgpu" ? [1, 1, 1] : HEALTHY[text]!,
    });

    const result = (await runVectorProbe(hook, { sentences: SENTENCES }))
      .cases[0]!;

    expect(result.verdict).toBe("mismatch");
    expect(result.webgpu!.collapse).toBeCloseTo(1, 6);
    expect(result.wasm!.collapse).toBe(0);
    expect(result.minCosine).toBeCloseTo(1 / Math.sqrt(3), 6);
  });

  test("NaN from WebGPU is a mismatch, not a pass", async () => {
    const { hook } = fakeHook([E5], {
      vector: (text, backend) =>
        backend === "webgpu" ? [Number.NaN, 0, 0] : HEALTHY[text]!,
    });

    const result = (await runVectorProbe(hook, { sentences: SENTENCES }))
      .cases[0]!;

    expect(result.verdict).toBe("mismatch");
    expect(result.notes).toContain("WebGPU returned NaN or Infinity");
  });

  test("a low cosine with different weights per backend is inconclusive", async () => {
    const miniLm: VectorProbeModel = { ...base, label: "MiniLM", modelId: "m" };
    const { hook, loads } = fakeHook([miniLm], {
      vector: (text, backend) =>
        backend === "webgpu" ? [1, 1, 1] : HEALTHY[text]!,
    });

    const report = await runVectorProbe(hook, { sentences: SENTENCES });

    expect(report.cases.map((c) => [c.variant, c.verdict])).toEqual([
      ["as shipped", "inconclusive"],
      ["q8 on both", "mismatch"],
      ["fp32 on both", "mismatch"],
    ]);
    // As shipped passes no dtype at all, as production does.
    expect(loads[0]!.opts).toEqual({});
    expect(loads[1]!.opts).toEqual({ backend: "wasm" });
  });

  test("a WASM run that landed on the main thread makes the case invalid", async () => {
    const { hook } = fakeHook([E5], { wasmInWorker: false });

    const result = (await runVectorProbe(hook, { sentences: SENTENCES }))
      .cases[0]!;

    expect(result.verdict).toBe("invalid");
    expect(result.perSentence).toBeUndefined();
    expect(result.notes).toEqual([
      "the WASM run was on the main thread, in the context WebGPU ran in",
    ]);
  });

  test("a WebGPU load that throws makes the case invalid and skips WASM", async () => {
    const { hook, loads } = fakeHook([E5], { failWebgpu: "no adapter" });

    const result = (await runVectorProbe(hook, { sentences: SENTENCES }))
      .cases[0]!;

    expect(result.verdict).toBe("invalid");
    expect(result.notes).toEqual(["WebGPU run failed: no adapter"]);
    expect(loads).toHaveLength(1);
  });

  test("embeds each sentence with the model's passage prefix", async () => {
    const seen: string[] = [];
    const { hook } = fakeHook([{ ...E5, passagePrefix: "passage: " }], {
      vector: (text) => {
        seen.push(text);
        return [1, 0, 0];
      },
    });

    await runVectorProbe(hook, { sentences: ["alpha"] });

    expect(seen).toEqual(["passage: alpha", "passage: alpha"]);
  });

  test("ranks the notes on each backend, queries with the query prefix", async () => {
    const seen: string[] = [];
    const { hook } = fakeHook([{ ...E5, passagePrefix: "p: " }], {
      vector: (text, backend) => {
        seen.push(text);
        const plain = text.replace(/^[pq]: /, "");
        // WebGPU collapses, WASM keeps the three directions apart.
        return backend === "webgpu" ? [1, 1, 1] : HEALTHY[plain]!;
      },
    });

    const result = (
      await runVectorProbe(hook, {
        sentences: ["alpha"],
        notes: [
          { id: "n-alpha", text: "alpha" },
          { id: "n-beta", text: "beta" },
        ],
        queries: [
          { text: "beta", expected: "n-beta" },
          { text: "gamma", expected: null },
        ],
      })
    ).cases[0]!;

    expect(result.wasm!.ranking).toMatchObject({
      hits: 1,
      answerable: 1,
      meanExpectedScore: 1,
      nonsenseTopScore: 0,
    });
    expect(result.webgpu!.ranking).toMatchObject({ nonsenseTopScore: 1 });
    expect(seen.slice(0, 5)).toEqual([
      "p: alpha",
      "p: alpha",
      "p: beta",
      "q: beta",
      "q: gamma",
    ]);
    const text = formatReport({
      machineBackend: "webgpu",
      sentences: 1,
      threshold: 0.99,
      cases: [result],
    });
    expect(text).toContain(
      "ranking WASM  : 1/1 expected notes first, mean expected score 1.0000, nonsense top score 0.0000",
    );
  });

  test("refuses to run where the machine did not resolve WebGPU", async () => {
    const { hook, loads } = fakeHook([E5], {}, "wasm");

    await expect(
      runVectorProbe(hook, { sentences: SENTENCES }),
    ).rejects.toThrow('this machine resolved "wasm", not webgpu');
    expect(loads).toHaveLength(0);
  });

  test("`only` selects models by label and rejects an unknown one", async () => {
    const other: VectorProbeModel = { ...E5, label: "Other", modelId: "o" };
    const { hook, loads } = fakeHook([E5, other]);

    await runVectorProbe(hook, { sentences: SENTENCES, only: ["Other"] });
    expect(loads.map((l) => l.model)).toEqual(["o", "o"]);

    await expect(
      runVectorProbe(hook, { sentences: SENTENCES, only: ["Nope"] }),
    ).rejects.toThrow("Known labels: E5, Other");
  });
});

describe("formatReport", () => {
  const GEMMA: VectorProbeModel = {
    ...E5,
    label: "Gemma",
    dtype: { wasm: "q8", webgpu: "q4" },
    backend: "wasm",
  };

  test("warns when no equal-dtype control case is a mismatch", async () => {
    const { hook } = fakeHook([GEMMA]);

    const report = await runVectorProbe(hook, { sentences: SENTENCES });
    const text = formatReport(report);

    expect(report.cases.map((c) => c.variant)).toEqual([
      "as shipped",
      "q8 on both",
      "q4 on both",
    ]);
    expect(text).toContain("Gemma [as shipped] (control:");
    expect(text).toContain("WARNING: no control case came back as a mismatch.");
  });

  test("an inconclusive as-shipped control does not silence the warning", async () => {
    // Different weights disagree as shipped; at equal dtype they agree.
    const { hook, loads } = fakeHook([GEMMA], {
      vector: (text, backend) =>
        backend === "webgpu" && loads.length === 1 ? [1, 1, 1] : HEALTHY[text]!,
    });

    const report = await runVectorProbe(hook, { sentences: SENTENCES });

    expect(report.cases.map((c) => c.verdict)).toEqual([
      "inconclusive",
      "ok",
      "ok",
    ]);
    expect(formatReport(report)).toContain(
      "WARNING: no control case came back as a mismatch.",
    );
  });

  test("no warning once a control case at equal dtype is a mismatch", async () => {
    const { hook } = fakeHook([GEMMA], {
      vector: (text, backend) =>
        backend === "webgpu" ? [1, 1, 1] : HEALTHY[text]!,
    });

    const text = formatReport(
      await runVectorProbe(hook, { sentences: SENTENCES }),
    );

    expect(text).toContain("verdict: MISMATCH");
    expect(text).not.toContain("WARNING");
  });

  test("says so when no control case ran to the end", async () => {
    const { hook } = fakeHook([GEMMA], { failWebgpu: "no adapter" });

    const text = formatReport(
      await runVectorProbe(hook, { sentences: SENTENCES }),
    );

    expect(text).toContain("WARNING: no control case ran to the end");
  });

  test("prints the numbers of a mismatch and no control warning", async () => {
    const { hook } = fakeHook([E5], {
      vector: (text, backend) =>
        backend === "webgpu" ? [1, 1, 1] : HEALTHY[text]!,
    });

    const text = formatReport(
      await runVectorProbe(hook, { sentences: SENTENCES }),
    );

    expect(text).toContain("verdict: MISMATCH");
    expect(text).toContain("cosine WebGPU vs WASM: min 0.5774, mean 0.5774");
    expect(text).toContain("collapse delta (WebGPU - WASM): 1.0000");
    expect(text).not.toContain("WARNING");
  });
});
