import type McpToolsPlugin from "$/main";
import {
  globalSettingsMutex,
  type Mutex,
} from "$/features/command-permissions";
import { SettingsStore } from "$/shared/settingsStore";
import {
  DEFAULT_SEMANTIC_SETTINGS,
  semanticSearchSettingsSchema,
  type SemanticSearchSettings,
} from "./types";
import {
  createProviderFactory,
  type ProviderChooser,
  type ProviderFactoryDeps,
} from "./services/providerFactory";
import type { ModelDownloader } from "./services/modelDownloader";
import type { SemanticIndexer } from "./services/indexer";
import type { EmbeddingStore } from "./services/store";
import type { EmbeddingStoreRegistry } from "./services/storeRegistry";

export { default as FeatureSettings } from "./components/SemanticSettingsSection.svelte";
export {
  createModelDownloader,
  type ModelDownloader,
  type ModelState,
} from "./services/modelDownloader";

/**
 * Semantic search feature — public API + setup.
 *
 * `setup()` constructs the real provider via `factoryDeps` (or leaves
 * the NoopProvider in place when omitted — early lifecycle / tests),
 * wires the indexer + embedding store + model downloader, and persists
 * the feature settings under the shared `globalSettingsMutex`:
 * `plugin.loadData` / `plugin.saveData` are not atomic, so the
 * read-modify-write of this slice is serialized against every other
 * feature's data.json writes (see CLAUDE.md § Gotchas).
 */

export type SearchOpts = {
  folders?: readonly string[];
  excludeFolders?: readonly string[];
  limit?: number;
};

export type SearchResult = {
  filePath: string;
  heading: string | null;
  excerpt: string;
  /** 0-indexed line the chunk starts at, or null when unresolvable (no
   * resolver, resolver failure, or a provider — e.g. Smart Connections —
   * that doesn't track a character offset into the source file). */
  line: number | null;
  score: number;
};

export interface SemanticSearchProvider {
  search(query: string, opts: SearchOpts): Promise<SearchResult[]>;
  isReady(): boolean;
}

export type SemanticSearchState = {
  provider: SemanticSearchProvider;
  settings: SemanticSearchSettings;
  settingsMutex: Mutex;
  /**
   * Closure mapping `SemanticSearchSettings` to the matching
   * provider. Present iff `setup()` was called with `factoryDeps`.
   * The settings UI calls this on a tri-state change to swap
   * `state.provider` without rebuilding the embedder/store.
   * Optional in the type so test fixtures can construct partial
   * state shapes; populated to either ProviderChooser or null at
   * runtime by `setup()`.
   */
  chooser?: ProviderChooser | null;
  /**
   * Reference to the model downloader so the settings UI can
   * subscribe to the first-run download progress without importing
   * internal feature plumbing. Wired by production setup;
   * absent in tests and in the early lifecycle.
   */
  downloader?: ModelDownloader | null;
  /**
   * The constructed indexer (live or low-power per setting), when
   * present. Not auto-started — the search tool calls
   * `startIndexerIfNeeded()` on first use (lazy).
   */
  indexer?: SemanticIndexer | null;
  /**
   * The embedding store, wired by production setup. Used by the
   * settings UI to surface the indexed-chunks count.
   */
  store?: EmbeddingStore | null;
  /**
   * Store registry for the DLC provider-swap pattern. When present,
   * `applySettings` checks whether the new provider's store is ready
   * before swapping the live provider.
   */
  registry?: EmbeddingStoreRegistry | null;
  /**
   * Per-providerKey record counts from the plugin-load probe pass.
   * With lazy store init, `store.size()` reports 0 until something
   * initializes the store; the settings UI falls back to these counts
   * so "chunks indexed" stays truthful in settings-only sessions.
   */
  probedCounts?: Partial<Record<string, number>> | null;
  /**
   * providerKey of the provider currently being built (download +
   * index). Set when the user switches to a provider whose store is
   * not yet ready. Cleared once `onProviderReady` fires.
   */
  pendingProvider?: string | null;
  /**
   * `Date.now()` when `pendingProvider` was last set. Cleared (`null`)
   * alongside every `pendingProvider = null` write. Used by
   * `search_vault_smart` (#344) to estimate `retryAfterSeconds` from the
   * elapsed build time and the files-indexed percent.
   */
  pendingProviderStartedAt?: number | null;
  /**
   * True while the native provider's lazy first-time index build (or a
   * post-reopen catch-up rebuild) is in flight — set by
   * `startIndexerIfNeeded`'s production wiring right before
   * `indexer.start()`, cleared once that promise settles. Unlike
   * `pendingProvider` (DLC-only), this covers the native MiniLM
   * provider's own lazy-build window, which is the scenario #344
   * actually describes ("the first search_vault_smart on a vault kicks
   * off lazy indexing"). Deliberately NOT derived from
   * `filesIndexed/filesTotal` reaching 100% — a vault with any
   * zero-chunk (e.g. empty) note would never hit 100% by that metric.
   */
  nativeIndexBuildInProgress?: boolean;
  /** `Date.now()` when `nativeIndexBuildInProgress` was last set true. */
  nativeIndexBuildStartedAt?: number | null;
  /**
   * providerKey suggested by the auto language-detect heuristic.
   * Non-null when the vault non-ASCII ratio exceeds the threshold and
   * the user has not yet chosen a multilingual provider. The settings
   * UI uses this to surface the suggestion banner.
   */
  autoSuggestProvider?: string | null;
  /**
   * Lazy indexer-start hook. First call starts the indexer in
   * background (fire-and-forget); subsequent calls are no-ops. The
   * search tool handler invokes this so vault events are subscribed
   * and a missing index begins building — without blocking the
   * request on a multi-minute first build.
   */
  startIndexerIfNeeded?: () => void;
  /**
   * Trigger a download + full index build for a specific providerKey.
   * Wired by production setup (Task 8); absent in tests and early lifecycle.
   * The settings UI calls this from the rebuild banner's "Rebuild now" button.
   *
   * Implementation detail: the first call for a providerKey creates a
   * persistent `LiveIndexer` (stored in `dlcIndexers`) and calls `start()`
   * so vault create/modify/delete events flow into the matching store from
   * that point on. Subsequent calls reuse the already-subscribed indexer
   * and run a fresh `rebuildAll()` against it.
   */
  startRebuildFor?: ((providerKey: string) => void) | null;
  /**
   * Persistent DLC indexers keyed by providerKey. Populated lazily by
   * `startRebuildFor` and by the plugin-load auto-subscribe for the
   * active DLC provider. Used by `teardown` to stop and flush every
   * subscribed indexer on plugin unload.
   */
  dlcIndexers?: Map<string, SemanticIndexer> | null;
  teardown: () => Promise<void>;
};

export type SemanticSearchSetupOpts = {
  /**
   * Provider factory dependencies. When supplied, `setup` constructs
   * a real provider via the factory and exposes the chooser closure.
   * When omitted, the state stays on the NoopProvider — useful for
   * the early plugin lifecycle and for tests that want to exercise
   * settings persistence in isolation.
   */
  factoryDeps?: ProviderFactoryDeps;
};

/**
 * Load settings, merge any missing keys with DEFAULT_SEMANTIC_SETTINGS,
 * persist the merged result if it differs from what was on disk, and
 * return the canonical settings object.
 *
 * Held under the shared `globalSettingsMutex`: `plugin.loadData` and
 * `plugin.saveData` are not atomic at the plugin level, and every
 * feature that reads-modifies-writes its own settings slice must
 * serialize through the one shared mutex to avoid lost-update races.
 */
async function loadAndPersistSettings(
  plugin: McpToolsPlugin,
  mutex: Mutex,
): Promise<SemanticSearchSettings> {
  // SettingsStore.loadSlice owns the merge-defaults + arktype-validate
  // + persist-iff-changed cycle under the mutex. Invalid on-disk data
  // falls back to defaults (persisted, warned) without throwing.
  return new SettingsStore(plugin, mutex).loadSlice<SemanticSearchSettings>(
    "semanticSearch",
    {
      schema: semanticSearchSettingsSchema,
      defaults: DEFAULT_SEMANTIC_SETTINGS,
    },
  );
}

class NoopProvider implements SemanticSearchProvider {
  async search(): Promise<SearchResult[]> {
    throw new Error(
      "Semantic search provider not configured. Open Settings → MCP Connector → Semantic Search to choose a provider.",
    );
  }
  isReady(): boolean {
    return false;
  }
}

export type SetupResult =
  | { success: true; state: SemanticSearchState }
  | { success: false; error: string };

export async function setup(
  plugin: McpToolsPlugin,
  opts: SemanticSearchSetupOpts = {},
): Promise<SetupResult> {
  try {
    // Shared process-wide mutex: data.json is one file, so this
    // feature's settings cycle must serialize against every other
    // feature's, not just against itself (cross-feature lost update).
    const settingsMutex = globalSettingsMutex;
    const settings = await loadAndPersistSettings(plugin, settingsMutex);

    // If factoryDeps is supplied, construct the chooser and pick the
    // provider matching the user's tri-state setting. Without deps,
    // the state holds a NoopProvider until the real deps are supplied
    // from main.ts after the embedder + store are wired to the vault.
    let provider: SemanticSearchProvider;
    let chooser: ProviderChooser | null = null;
    if (opts.factoryDeps) {
      chooser = createProviderFactory(opts.factoryDeps);
      provider = chooser(settings);
    } else {
      provider = new NoopProvider();
    }

    const state: SemanticSearchState = {
      provider,
      settings,
      settingsMutex,
      chooser,
      downloader: null,
      indexer: null,
      store: opts.factoryDeps?.store ?? null,
      registry: null,
      pendingProvider: null,
      autoSuggestProvider: null,
      startIndexerIfNeeded: undefined, // production wiring overrides this
      teardown: async () => {
        // production wiring overrides this to flush+close the
        // store, stop the indexer, and unload the embedder model.
      },
    };
    return { success: true, state };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export async function teardown(state: SemanticSearchState): Promise<void> {
  await state.teardown();
}

/**
 * Maps provider setting values that require a store build to their
 * providerKey. Values absent from this map (native, smart-connections,
 * auto) are always immediately swappable.
 */
const DOWNLOADABLE_PROVIDER_KEYS: Partial<Record<string, string>> = {
  "embedding-gemma": "embedding-gemma-300m",
  "multilingual-e5-base": "multilingual-e5-base",
};

/**
 * Persist a new SemanticSearchSettings value and swap the live
 * provider via the chooser closure when one is available.
 *
 * For providers that require a store build (embedding-gemma,
 * multilingual-e5-base), if the store is not yet marked ready in the
 * registry, the live provider is NOT swapped — the old results stay
 * available while the index builds — and `state.pendingProvider` is
 * set so the UI can show the rebuild banner.
 *
 * Held under the feature mutex so a rapid double-toggle cannot land
 * out-of-order writes against `data.json`.
 */
export async function applySettings(
  plugin: McpToolsPlugin,
  state: SemanticSearchState,
  next: SemanticSearchSettings,
): Promise<void> {
  await new SettingsStore(plugin, state.settingsMutex).updateSlice(
    "semanticSearch",
    () => next,
  );
  state.settings = next;

  const pendingKey = DOWNLOADABLE_PROVIDER_KEYS[next.provider];
  if (pendingKey && state.registry && !state.registry.isReady(pendingKey)) {
    // Store not yet built — surface the rebuild banner, keep old provider.
    state.pendingProvider = pendingKey;
    state.pendingProviderStartedAt = Date.now();
    return;
  }

  state.pendingProvider = null;
  state.pendingProviderStartedAt = null;
  if (state.chooser) {
    state.provider = state.chooser(next);
  }
}
