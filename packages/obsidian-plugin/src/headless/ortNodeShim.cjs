// Stands in for `onnxruntime-node` (a native addon that cannot live in a
// single-file bundle) and for `onnxruntime-web` in the headless bundle:
// the CPU build of onnxruntime-web, reading model files from disk. See
// ortSessionPatch.ts. "ort-wasm-cpu" is mapped to the package's
// ort.wasm.min.js by bun.headless.config.ts.
const { readFile } = require("node:fs/promises");
const { patchInferenceSession } = require("./ortSessionPatch");

module.exports = patchInferenceSession(require("ort-wasm-cpu"), readFile);
