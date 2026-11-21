/**
 * Adapter that exposes the existing `Embedder` abstraction (MiniLM-L6-v2)
 * as an `EmbeddingProvider`. This allows the indexer and store registry
 * to treat the native backend identically to the new multilingual providers
 * while reusing the existing pipeline + LRU-cache + idle-unload logic.
 *
 * MiniLM does not use asymmetric task prompts, so `role` changes no vector.
 */

import type { Embedder } from "./embedder";
import type { EmbeddingProvider } from "../types";

const PROVIDER_KEY = "native-minilm-l6-v2";
const DIMENSIONS = 384;
export const MAX_INPUT_TOKENS = 256;
const MODEL_SIZE_BYTES = 25_000_000;

class NativeEmbeddingProviderImpl implements EmbeddingProvider {
  readonly providerKey = PROVIDER_KEY;
  readonly dimensions = DIMENSIONS;
  readonly maxInputTokens = MAX_INPUT_TOKENS;

  constructor(private embedder: Embedder) {}

  // MiniLM's 256-token cap is a model-intrinsic limit; identical on
  // both WASM and WebGPU paths. No backend probe required.
  getMaxInputTokens(): Promise<number> {
    return Promise.resolve(MAX_INPUT_TOKENS);
  }

  getModelSizeBytes(): number {
    return MODEL_SIZE_BYTES;
  }

  async isAvailable(): Promise<boolean> {
    // Native MiniLM lazy-loads on the first embed() call; it is
    // always available to callers (no download gate required).
    return true;
  }

  documentConcurrency(): number {
    return this.embedder.documentConcurrency?.() ?? 1;
  }

  async embed(
    texts: string[],
    role: "document" | "query",
  ): Promise<Float32Array[]> {
    // The role changes no vector, only the order: a query goes ahead of
    // indexing batches when the model runs in a worker (ADR-0036).
    return this.embedder.embedBatch(
      texts,
      role === "query" ? { priority: "query" } : undefined,
    );
  }
}

export function createNativeEmbeddingProvider(
  embedder: Embedder,
): EmbeddingProvider {
  return new NativeEmbeddingProviderImpl(embedder);
}
