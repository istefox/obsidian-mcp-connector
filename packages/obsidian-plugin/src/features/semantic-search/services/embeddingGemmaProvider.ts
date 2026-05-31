// Model: onnx-community/embeddinggemma-300m-ONNX (ONNX IR v10; requires onnxruntime-web ≥ 1.20 / the dev build pinned in onnxEnv.ts).
import type { EmbeddingProvider } from "../types";
import type { PipelineFactory } from "./embedder";
import { createTransformersProvider } from "./transformersProvider";

export function createEmbeddingGemmaProvider(
  pipelineFactory: PipelineFactory,
): EmbeddingProvider {
  return createTransformersProvider({
    modelId: "onnx-community/embeddinggemma-300m-ONNX",
    providerKey: "embedding-gemma-300m",
    dimensions: 768,
    // WASM capped at 512 — onnxruntime-web@1.26.0 SafeInt overflow at 2048
    // (#202, upstream microsoft/onnxruntime#28726). WebGPU EP bypasses the
    // WASM int math path and unlocks the model's full 2K context.
    maxInputTokensByBackend: { wasm: 512, webgpu: 2048 },
    modelSizeBytes: 190_000_000,
    taskPrompt: (text, role) =>
      role === "query"
        ? "task: search result | query: " + text
        : "title: none | text: " + text,
    pipelineFactory,
  });
}
