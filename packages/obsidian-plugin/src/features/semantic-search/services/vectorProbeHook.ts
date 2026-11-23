/**
 * Access point for the vector probe (#680), a diagnostic that embeds fixed
 * sentences with this bundle on WebGPU and on WASM and compares the
 * vectors. The probe itself is `scripts/vector-probe/`, outside `src`.
 *
 * Present only in a bundle built with `--vector-probe`. Every other
 * build defines `process.env.MCP_VECTOR_PROBE` as an empty string, the
 * one call site folds to dead code, and `bun.config.ts` and `zip.ts`
 * refuse a bundle that still holds `VECTOR_PROBE_KEY`
 * (`scripts/vectorProbeBundleCheck.ts`).
 */
import type {
  BackendKind,
  DtypeSpec,
  PipelineFactoryWithProgress,
  PipelineLoadOpts,
} from "./embedder";

/** The global the hook is installed under, and the mark the build looks for. */
export const VECTOR_PROBE_KEY = "__mcpConnectorVectorProbe";

/** One model as `productionWiring.ts` loads it. */
export type VectorProbeModel = {
  label: string;
  modelId: string;
  /** Absent for a model loaded with the library's default precision. */
  dtype?: DtypeSpec;
  /** Set for a model production pins to one backend (ADR-0034). */
  backend?: PipelineLoadOpts["backend"];
  maxInputTokens: number;
  queryPrefix: string;
  passagePrefix: string;
};

export type VectorProbeHook = {
  /**
   * The plugin's own factory: no `backend` runs a model where the machine
   * resolved it, WebGPU on the main thread when an adapter exists, and
   * `backend: "wasm"` runs it in an embedding worker (ADR-0036).
   */
  pipelineFactory: PipelineFactoryWithProgress;
  /** What the machine resolved, without loading the library. */
  machineBackend: () => Promise<BackendKind>;
  models: readonly VectorProbeModel[];
};

export function installVectorProbeHook(
  target: Record<string, unknown>,
  hook: VectorProbeHook,
): void {
  target[VECTOR_PROBE_KEY] = hook;
}
