import { describe, expect, test } from "bun:test";
import type { VectorProbeModel } from "../../src/features/semantic-search/services/vectorProbeHook";
import { planProbeCases } from "./probeCases";

const base = { maxInputTokens: 256, queryPrefix: "", passagePrefix: "" };

function summary(models: VectorProbeModel[]) {
  return planProbeCases(models).map((c) => ({
    variant: c.variant,
    webgpu: c.webgpuDtype,
    wasm: c.wasmDtype,
    equal: c.equalDtype,
    control: c.control,
  }));
}

describe("planProbeCases", () => {
  test("one case when both backends are given the same dtype", () => {
    expect(
      summary([
        {
          ...base,
          label: "E5",
          modelId: "e5",
          dtype: { wasm: "q8", webgpu: "q8" },
        },
      ]),
    ).toEqual([
      {
        variant: "as shipped",
        webgpu: "q8",
        wasm: "q8",
        equal: true,
        control: false,
      },
    ]);
  });

  test("a single-string dtype counts as the same on both", () => {
    expect(
      summary([{ ...base, label: "M", modelId: "m", dtype: "fp16" }]),
    ).toEqual([
      {
        variant: "as shipped",
        webgpu: "fp16",
        wasm: "fp16",
        equal: true,
        control: false,
      },
    ]);
  });

  test("no dtype: as shipped is not known equal, then q8 and fp32 alone", () => {
    expect(summary([{ ...base, label: "MiniLM", modelId: "m" }])).toEqual([
      {
        variant: "as shipped",
        webgpu: undefined,
        wasm: undefined,
        equal: false,
        control: false,
      },
      {
        variant: "q8 on both",
        webgpu: "q8",
        wasm: "q8",
        equal: true,
        control: false,
      },
      {
        variant: "fp32 on both",
        webgpu: "fp32",
        wasm: "fp32",
        equal: true,
        control: false,
      },
    ]);
  });

  test("different dtypes per backend: each one also runs on both", () => {
    expect(
      summary([
        {
          ...base,
          label: "Gemma",
          modelId: "g",
          dtype: { wasm: "q8", webgpu: "q4" },
          backend: "wasm",
        },
      ]),
    ).toEqual([
      {
        variant: "as shipped",
        webgpu: "q4",
        wasm: "q8",
        equal: false,
        control: true,
      },
      {
        variant: "q8 on both",
        webgpu: "q8",
        wasm: "q8",
        equal: true,
        control: true,
      },
      {
        variant: "q4 on both",
        webgpu: "q4",
        wasm: "q4",
        equal: true,
        control: true,
      },
    ]);
  });

  test("keeps the table's order across models", () => {
    const cases = planProbeCases([
      { ...base, label: "A", modelId: "a", dtype: "q8" },
      { ...base, label: "B", modelId: "b", dtype: "q8" },
    ]);
    expect(cases.map((c) => c.model.label)).toEqual(["A", "B"]);
  });
});
