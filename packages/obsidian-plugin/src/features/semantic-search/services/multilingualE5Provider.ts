import type { EmbeddingProvider } from "../types";
import type { PipelineFactory } from "./embedder";
import { createTransformersProvider } from "./transformersProvider";

export function createMultilingualE5Provider(
  pipelineFactory: PipelineFactory,
): EmbeddingProvider {
  return createTransformersProvider({
    modelId: "Xenova/multilingual-e5-base",
    providerKey: "multilingual-e5-base",
    dimensions: 768,
    // Model intrinsic 512-token cap; no benefit from WebGPU's larger context.
    maxInputTokensByBackend: { wasm: 512, webgpu: 512 },
    modelSizeBytes: 60_000_000,
    taskPrompt: (text, role) =>
      (role === "query" ? "query: " : "passage: ") + text,
    pipelineFactory,
  });
}
