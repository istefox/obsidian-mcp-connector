import { type } from "arktype";

/**
 * Active inference runtime. Resolved once per process by
 * `resolveBackend()` in `services/embedder.ts`.
 *
 * - `wasm`: onnxruntime-web CPU EP (non-JSEP WASM). Fallback path for
 *   hardware without `navigator.gpu` or after a failed adapter probe.
 * - `webgpu`: onnxruntime-web WebGPU EP via JSEP WASM. Faster, larger
 *   effective context windows for models that intrinsically support them.
 */
export type BackendKind = "wasm" | "webgpu";

/**
 * Embedding layer abstraction. One `EmbeddingProvider` per model;
 * the store registry and indexer are keyed on `providerKey`.
 *
 * `embed` accepts a batch and a role so providers that use asymmetric
 * task prompts (EmbeddingGemma, multilingual-e5) can apply them
 * internally without leaking the prompt format to callers.
 */
export interface EmbeddingProvider {
  readonly providerKey: string;
  readonly dimensions: number;
  /**
   * Conservative (WASM) cap. Synchronous getter for pre-resolution
   * callers (settings UI, status displays). Use `getMaxInputTokens()`
   * for the backend-resolved value.
   */
  readonly maxInputTokens: number;
  /**
   * Resolves the backend-dependent input-token cap. WebGPU providers
   * may expose a larger context here than `maxInputTokens` advertises.
   * Cached after the first call.
   */
  getMaxInputTokens(): Promise<number>;
  embed(texts: string[], role: "document" | "query"): Promise<Float32Array[]>;
  isAvailable(): Promise<boolean>;
  getModelSizeBytes(): number;
}

/**
 * Runtime schema for the semantic-search settings block.
 *
 * `provider` values:
 *   - "native"              → always Transformers.js MiniLM (NativeProvider)
 *   - "smart-connections"   → always Smart Connections; errors if not installed
 *   - "auto"                → Smart Connections if loaded and ready, else native
 *   - "embedding-gemma"     → EmbeddingGemma 300M (~190 MB, multilingual, 768d)
 *   - "multilingual-e5-base"→ Multilingual E5 base (~100 MB, multilingual, 768d)
 *
 * `indexingMode`: live re-embedding on file change vs.
 * 5-minute batched scan. Only meaningful when the active provider
 * is `NativeProvider` — Smart Connections owns its own indexing.
 *
 * `unloadModelWhenIdle` is the additional power saver. When true,
 * the embedder unloads the MiniLM pipeline 60s after the last call;
 * next call re-loads (cold ~1s).
 */
export const semanticSearchSettingsSchema = type({
  provider:
    '"native"|"smart-connections"|"auto"|"embedding-gemma"|"multilingual-e5-base"',
  indexingMode: '"live"|"low-power"',
  unloadModelWhenIdle: "boolean",
});

export type SemanticSearchSettings = typeof semanticSearchSettingsSchema.infer;

export const DEFAULT_SEMANTIC_SETTINGS: SemanticSearchSettings = {
  provider: "auto",
  indexingMode: "live",
  unloadModelWhenIdle: true,
};

/**
 * Settings augmentation. Lives here (not in the root plugin types.ts)
 * per the .clinerules feature architecture rule: each feature owns its
 * own settings shape.
 */
declare module "obsidian" {
  interface McpToolsPluginSettings {
    semanticSearch?: SemanticSearchSettings;
  }
}
