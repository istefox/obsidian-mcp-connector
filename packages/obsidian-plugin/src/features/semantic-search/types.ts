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
  /**
   * How many document `embed` calls the provider can run at the same
   * time, as of now: more than one only once its model is loaded in a
   * pool of workers (ADR-0036). The indexer reads it while a rebuild
   * runs and never loads a model to learn it. Absent means one.
   */
  documentConcurrency?(): number;
  /**
   * Releases the model the provider loaded (its ONNX sessions). Called
   * at teardown. Providers that own no model, such as the Smart
   * Connections bridge or the native provider over the shared embedder,
   * leave it out.
   */
  unload?(): Promise<void>;
}

/**
 * Runtime schema for the semantic-search settings block.
 *
 * `provider` values:
 *   - "native"              → always Transformers.js MiniLM (NativeProvider)
 *   - "smart-connections"   → always Smart Connections; errors if not installed
 *   - "auto"                → Smart Connections if loaded and ready, else native
 *   - "embedding-gemma"     → EmbeddingGemma 300M (~200 MB on WebGPU, ~310 MB on WASM, multilingual, 768d)
 *   - "multilingual-e5-base"→ Multilingual E5 base (~280 MB, multilingual, 768d)
 *   - "remote"              → any OpenAI-compatible /v1/embeddings server
 *                             (LM Studio, llama.cpp, Ollama, TEI) per the
 *                             `remote` block below
 *
 * `indexingMode`: live re-embedding on file change vs.
 * 5-minute batched scan. Only meaningful when the active provider
 * is `NativeProvider` — Smart Connections owns its own indexing.
 *
 * `unloadModelWhenIdle` is the additional power saver. When true,
 * the embedder unloads the MiniLM pipeline 60s after the last call;
 * next call re-loads (cold ~1s).
 */

/**
 * Configuration for the "remote" provider. Every field is optional so a
 * partially-filled block written by an older build (or hand-edited into
 * `data.json`) still validates — `resolveRemoteConfig` is the one place
 * that decides whether the block is complete enough to use, and fills
 * the rest from `DEFAULT_REMOTE_SETTINGS`.
 */
export const remoteEmbeddingSettingsSchema = type({
  /** Server root ("http://localhost:1234"), a `/v1` root, or the full
   * `/v1/embeddings` URL — all three are normalized at call time. */
  "baseUrl?": "string",
  /** Model id as the server reports it in `/v1/models`. */
  "model?": "string",
  /** Sent as `Authorization: Bearer …`. LM Studio ignores it. */
  "apiKey?": "string",
  /** Vector width. Detected by the settings UI's probe (or at load) and
   * cached here; it is part of the store directory name, so changing
   * models never mixes widths in one index. */
  "dimensions?": "number",
  /** Asymmetric-retrieval instruction prepended to QUERIES only, as
   * `Instruct: <instruction>\nQuery: <text>`. Empty string = symmetric
   * (no prefix on either side). Documents are always sent bare. */
  "queryInstruction?": "string",
  /** Chunker budget. Not enforced server-side — it only sizes chunks. */
  "maxInputTokens?": "number",
  /** Texts per HTTP request during indexing. */
  "batchSize?": "number",
  /** Per-request timeout. A 1.7B embedder on a busy GPU is not fast. */
  "timeoutMs?": "number",
  /**
   * Hard ceiling on the characters sent for one text. The chunker keeps
   * an oversized code fence atomic rather than splitting mid-fence, so a
   * note that is one long ```dataviewjs``` block arrives as a single
   * chunk many times the chunk budget. The bundled ONNX providers
   * truncate such input at the tokenizer; a remote server does not, and
   * a long enough sequence exhausts VRAM and drops the model.
   */
  "maxInputChars?": "number",
  /**
   * Hard ceiling on the characters in one HTTP request. Bounds the case
   * where several individually-legal chunks land in the same batch.
   */
  "maxRequestChars?": "number",
});

export type RemoteEmbeddingSettings =
  typeof remoteEmbeddingSettingsSchema.infer;

export const semanticSearchSettingsSchema = type({
  provider:
    '"native"|"smart-connections"|"auto"|"embedding-gemma"|"multilingual-e5-base"|"remote"',
  indexingMode: '"live"|"low-power"',
  unloadModelWhenIdle: "boolean",
  "remote?": remoteEmbeddingSettingsSchema,
});

export type SemanticSearchSettings = typeof semanticSearchSettingsSchema.infer;

export const DEFAULT_REMOTE_SETTINGS: Required<RemoteEmbeddingSettings> = {
  baseUrl: "http://localhost:1234",
  model: "",
  apiKey: "",
  // 0 = not yet detected. `resolveRemoteConfig` refuses to build a
  // store until a probe has filled this in, because the width is baked
  // into the on-disk vector layout.
  dimensions: 0,
  queryInstruction:
    "Given a search query, retrieve relevant passages from the user's notes",
  // Matches the EmbeddingGemma WASM budget, so switching between the
  // two does not silently re-cut every chunk boundary.
  maxInputTokens: 512,
  batchSize: 8,
  timeoutMs: 120_000,
  // Comfortably above any chunk the 512-token budget produces (~3.5k
  // chars of prose), so ordinary content is never touched; low enough
  // that a whole-file code fence cannot reach a length that costs more
  // VRAM than the card has.
  maxInputChars: 6_000,
  maxRequestChars: 24_000,
};

export const DEFAULT_SEMANTIC_SETTINGS: SemanticSearchSettings = {
  provider: "auto",
  indexingMode: "live",
  // Warm by default: typical usage is sporadic agent queries, where a
  // cold pipeline rebuild on every search costs more than the RAM.
  unloadModelWhenIdle: false,
  // `remote` is deliberately absent rather than defaulted: settings are
  // persisted whenever the merged slice differs from what is on disk,
  // so shipping a default block would rewrite every existing user's
  // data.json on first load to store a configuration they never used.
  // Readers go through `mergeRemoteSettings`, which supplies the same
  // defaults on demand.
};

/**
 * Fully-resolved remote config. Distinct from the settings shape: every
 * field is present, and `dimensions` is known to be usable.
 */
export type RemoteEmbeddingConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions: number;
  queryInstruction: string;
  maxInputTokens: number;
  batchSize: number;
  timeoutMs: number;
  maxInputChars: number;
  maxRequestChars: number;
};

/**
 * Merge a (possibly partial) settings block over the defaults.
 * `dimensions` is left as-is — callers that need a store demand a
 * positive width via `resolveRemoteConfig`; the settings UI and the
 * dimension probe need the merged block *before* one is known.
 */
export function mergeRemoteSettings(
  remote: RemoteEmbeddingSettings | undefined,
): RemoteEmbeddingConfig {
  const m = { ...DEFAULT_REMOTE_SETTINGS, ...(remote ?? {}) };
  return {
    baseUrl: m.baseUrl.trim(),
    model: m.model.trim(),
    apiKey: m.apiKey.trim(),
    dimensions: Math.floor(m.dimensions),
    queryInstruction: m.queryInstruction,
    maxInputTokens: clampInt(m.maxInputTokens, 64, 8192, 512),
    batchSize: clampInt(m.batchSize, 1, 128, 8),
    timeoutMs: clampInt(m.timeoutMs, 1_000, 600_000, 120_000),
    maxInputChars: clampInt(m.maxInputChars, 500, 200_000, 6_000),
    maxRequestChars: clampInt(m.maxRequestChars, 500, 1_000_000, 24_000),
  };
}

/**
 * The remote block is usable only once it names a server AND a model
 * AND a detected vector width. Anything less and the provider factory
 * falls back to native rather than writing a store it cannot read back.
 */
export function resolveRemoteConfig(
  remote: RemoteEmbeddingSettings | undefined,
): RemoteEmbeddingConfig | null {
  const cfg = mergeRemoteSettings(remote);
  if (!cfg.baseUrl || !cfg.model || cfg.dimensions <= 0) return null;
  return cfg;
}

/**
 * Store directory name for a remote model. The width is part of the key
 * so a model swap (or a server that changes its output width) lands in a
 * fresh directory instead of appending mismatched vectors to the old
 * one — the store throws on a width mismatch, and a rebuild the user did
 * not ask for is worse than a few stale megabytes on disk.
 */
export function remoteProviderKey(model: string, dimensions: number): string {
  const slug =
    model
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60) || "model";
  return `remote-${slug}-${dimensions}`;
}

function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

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
