// Model: onnx-community/embeddinggemma-300m-ONNX (ONNX IR v10; requires onnxruntime-web ≥ 1.20 / the dev build pinned in onnxEnv.ts).
import type { EmbeddingProvider } from "../types";
import type { PipelineFactory } from "./embedder";
import { withSentenceEmbedding } from "./sentenceEmbeddingPipeline";
import { createTransformersProvider } from "./transformersProvider";

/**
 * EmbeddingGemma runs on WASM only. On the WebGPU execution provider
 * (onnxruntime-web 1.26.0, in Electron) it returned vectors that ranked
 * notes at random with both q4 and q8 weights, while the same files on
 * WASM ranked them correctly (ADR-0034). The model downloader in
 * productionWiring.ts passes the same value to the factory.
 */
export const EMBEDDING_GEMMA_BACKEND = "wasm" as const;

export function createEmbeddingGemmaProvider(
  pipelineFactory: PipelineFactory,
): EmbeddingProvider {
  return createTransformersProvider({
    modelId: "onnx-community/embeddinggemma-300m-ONNX",
    providerKey: "embedding-gemma-300m",
    dimensions: 768,
    // WASM capped at 512 — onnxruntime-web@1.26.0 SafeInt overflow at 2048
    // (#202, upstream microsoft/onnxruntime#28726). The webgpu entry is
    // unused while the model is pinned to WASM.
    maxInputTokensByBackend: { wasm: 512, webgpu: 2048 },
    backend: EMBEDDING_GEMMA_BACKEND,
    modelSizeBytes: 190_000_000,
    taskPrompt: (text, role) =>
      role === "query"
        ? "task: search result | query: " + text
        : "title: none | text: " + text,
    // The model's own sentence vector, Dense layers included. Mean
    // pooling the token states skips them (sentenceEmbeddingPipeline.ts).
    pipelineFactory: withSentenceEmbedding(pipelineFactory),
    // 2K-context model: padding to the longest text in the batch makes
    // attention memory batch × seq², which can OOM integrated GPUs at
    // the default batch of 8.
    batchSize: 4,
  });
}
