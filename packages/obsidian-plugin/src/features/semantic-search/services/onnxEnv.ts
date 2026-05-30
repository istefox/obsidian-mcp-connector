/**
 * One-shot ONNX / Transformers.js environment configuration.
 *
 * Two exported functions cover the two execution paths:
 *   - `configureEnv()` — CPU WASM path; sets numThreads:1 (no SharedArrayBuffer
 *     in Electron renderer without COOP+COEP).
 *   - `configureEnvForWebGpu()` — WebGPU path; wasmPaths only, no numThreads,
 *     so onnxruntime-web selects the JSEP WASM build which registers WebGPU EP.
 *
 * Both functions are no-ops after first call (independent flags per path).
 * `realPipelineFactory` in embedder.ts calls the appropriate one after probing
 * `navigator.gpu.requestAdapter()`; `transformersProvider.ts` does NOT call
 * either directly — env configuration is centralised in the factory.
 *
 * Why each setting:
 *
 * * `env.backends.onnx.wasm.wasmPaths`: onnxruntime-web's default
 *   wasm-blob loader resolves siblings via `fetch(new URL(...,
 *   import.meta.url))`. Bun's CJS bundle does not preserve
 *   `import.meta.url` meaningfully, so the loader 404s. Pointing at
 *   the matching CDN sidesteps the `import.meta.url` dance. Pinned to
 *   the version bundled with @huggingface/transformers@4.2.0; updating
 *   the lib requires updating this URL or the WASM ABI may not match
 *   the JS glue.
 * * `env.backends.onnx.wasm.numThreads = 1` (CPU only): Electron's renderer
 *   does not have COOP/COEP cross-origin isolation, so SharedArrayBuffer is
 *   restricted. Single-threaded non-JSEP WASM avoids the worker spin-up path.
 *   Omitted on the WebGPU path so onnxruntime-web selects JSEP WASM instead.
 * * `env.useBrowserCache = true`: persist the downloaded model to the
 *   Cache API so subsequent loads are fast.
 *
 * Bundle prerequisite: `bun.config.ts` redirects `onnxruntime-web` →
 * `onnxruntime-web/all` (ort.all.min.js). The default `ort.min.js` includes
 * only WASM/CPU EP; WebGPU EP lives in the `all` bundle. Without this redirect,
 * `device: "webgpu"` always fails with "backend not found".
 */

// Static import required: Obsidian's eval-based plugin loader cannot
// resolve node_modules at runtime; a bundled require() works, a
// dynamic `import(...)` would 404.
import { env as _hfEnv } from "@huggingface/transformers";
import { logger } from "$/shared/logger";

// Stable build; required for ONNX IR v10 support (onnxruntime-web ≥ 1.20).
const ORT_WASM_PATHS =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";

type HfEnv = {
  backends?: {
    onnx?: {
      wasm?: { numThreads?: number; simd?: boolean; wasmPaths?: string };
    };
  };
  useBrowserCache?: boolean;
};

// Two independent configured-flags: one per execution path.
// CPU path sets numThreads:1 (non-JSEP WASM, required for Electron renderer
// which lacks SharedArrayBuffer/COOP+COEP). WebGPU path omits numThreads so
// onnxruntime-web selects ort-wasm-simd.jsep.wasm (JSEP WASM), which
// registers the WebGPU execution provider — numThreads:1 would force the
// non-JSEP build and silently drop WebGPU EP support.
let _cpuEnvConfigured = false;
let _webgpuEnvConfigured = false;

function applyCommon(e: HfEnv): void {
  if (e.backends?.onnx?.wasm) {
    e.backends.onnx.wasm.wasmPaths = ORT_WASM_PATHS;
  } else {
    logger.warn(
      "onnxEnv: expected WASM backend shape not found — CDN paths not configured",
    );
  }
  if (typeof navigator !== "undefined") {
    e.useBrowserCache = true;
  }
}

export function configureEnv(): void {
  if (_cpuEnvConfigured) return;
  _cpuEnvConfigured = true;
  const e = _hfEnv as unknown as HfEnv;
  applyCommon(e);
  if (e.backends?.onnx?.wasm) {
    e.backends.onnx.wasm.numThreads = 1;
  }
}

/**
 * WebGPU variant: same CDN paths, but NO numThreads override.
 * numThreads:1 forces ort-wasm-simd.wasm (non-JSEP); omitting it lets
 * onnxruntime-web pick ort-wasm-simd.jsep.wasm, which registers the
 * WebGPU execution provider. Call this only after confirming a WebGPU
 * adapter is available (navigator.gpu.requestAdapter() returned non-null).
 */
export function configureEnvForWebGpu(): void {
  if (_webgpuEnvConfigured) return;
  _webgpuEnvConfigured = true;
  const e = _hfEnv as unknown as HfEnv;
  applyCommon(e);
  // numThreads intentionally not set — JSEP WASM handles its own threading.
}
