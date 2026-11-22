/**
 * Which loads the vector probe compares (#680), derived from the model
 * table the plugin hands over, so "each model and dtype production
 * loads" holds by construction.
 */
import type { VectorProbeModel } from "../../src/features/semantic-search/services/vectorProbeHook";

/** Tried on both backends for a model production loads with no dtype. */
const DEFAULT_DTYPE_CANDIDATES = ["q8", "fp32"] as const;

export type ProbeCase = {
  model: VectorProbeModel;
  /** `as shipped`, or the dtype forced on both backends. */
  variant: string;
  /** Passed to both loads. `undefined` leaves the library's default. */
  webgpuDtype: string | undefined;
  wasmDtype: string | undefined;
  /**
   * Whether the two loads are known to use the same weights. Only then
   * is a per-sentence cosine below the threshold a finding.
   */
  equalDtype: boolean;
  /**
   * Production never runs this model on WebGPU, so the WebGPU side is a
   * known-bad control: a probe that passes it cannot be trusted.
   */
  control: boolean;
};

function dtypeFor(
  model: VectorProbeModel,
  backend: "wasm" | "webgpu",
): string | undefined {
  return typeof model.dtype === "string" ? model.dtype : model.dtype?.[backend];
}

export function planProbeCases(
  models: readonly VectorProbeModel[],
): ProbeCase[] {
  const cases: ProbeCase[] = [];
  for (const model of models) {
    const control = model.backend === "wasm";
    const webgpuDtype = dtypeFor(model, "webgpu");
    const wasmDtype = dtypeFor(model, "wasm");
    const shippedEqual = webgpuDtype !== undefined && webgpuDtype === wasmDtype;
    cases.push({
      model,
      variant: "as shipped",
      webgpuDtype,
      wasmDtype,
      equalDtype: shippedEqual,
      control,
    });
    if (shippedEqual) continue;
    // Unequal or unstated precision: a low cosine there could be the
    // weights and not the backend, so each precision also runs alone.
    const forced =
      webgpuDtype === undefined && wasmDtype === undefined
        ? [...DEFAULT_DTYPE_CANDIDATES]
        : [
            ...new Set(
              [wasmDtype, webgpuDtype].filter(
                (d): d is string => d !== undefined,
              ),
            ),
          ];
    for (const dtype of forced) {
      cases.push({
        model,
        variant: `${dtype} on both`,
        webgpuDtype: dtype,
        wasmDtype: dtype,
        equalDtype: true,
        control,
      });
    }
  }
  return cases;
}
