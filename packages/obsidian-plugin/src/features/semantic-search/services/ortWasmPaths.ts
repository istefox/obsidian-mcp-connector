/**
 * Where onnxruntime-web fetches its WASM binaries from (see onnxEnv.ts for
 * why a CDN). Its own module, importing nothing, because the embedding
 * worker runtime needs the same value and is bundled apart from the rest
 * of the plugin (ADR-0036).
 *
 * Stable build; required for ONNX IR v10 support (onnxruntime-web ≥ 1.20).
 */
export const ORT_WASM_PATHS =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/";
