import { type } from "arktype";
import type McpToolsPlugin from "$/main";
import {
  globalSettingsMutex,
  type Mutex,
} from "$/features/command-permissions";
import { logger } from "$/shared/logger";
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
   * Lazy indexer-start hook. First call starts the indexer in
   * background (fire-and-forget); subsequent calls are no-ops. The
   * search tool handler invokes this so vault events are subscribed
   * and a missing index begins building — without blocking the
   * request on a multi-minute first build.
   */
  startIndexerIfNeeded?: () => void;
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
  return mutex.run(async () => {
    const data = ((await plugin.loadData()) as Record<string, unknown>) ?? {};
    const stored = data.semanticSearch as
      | Partial<SemanticSearchSettings>
      | undefined;

    const merged: SemanticSearchSettings = {
      ...DEFAULT_SEMANTIC_SETTINGS,
      ...(stored ?? {}),
    };

    const validated = semanticSearchSettingsSchema(merged);
    if (validated instanceof type.errors) {
      // Settings on disk are malformed — fall back to defaults but log
      // so the user can find out via plugin logs why their tweaks were
      // ignored. Never throw: a corrupt settings field must not crash
      // the plugin onload.
      logger.warn("semantic-search settings invalid, using defaults", {
        summary: validated.summary,
        stored,
      });
      const defaults = { ...DEFAULT_SEMANTIC_SETTINGS };
      data.semanticSearch = defaults;
      await plugin.saveData(data);
      return defaults;
    }

    // Persist iff the merge added defaults that weren't on disk.
    const needsPersist =
      stored === undefined ||
      JSON.stringify(stored) !== JSON.stringify(validated);
    if (needsPersist) {
      data.semanticSearch = validated;
      await plugin.saveData(data);
    }

    return validated;
  });
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
 * Persist a new SemanticSearchSettings value and swap the live
 * provider via the chooser closure when one is available.
 *
 * Used by the settings UI (T12) on tri-state / mode / unload-toggle
 * change. Held under the feature mutex so a rapid double-toggle
 * cannot land out-of-order writes against `data.json`.
 */
export async function applySettings(
  plugin: McpToolsPlugin,
  state: SemanticSearchState,
  next: SemanticSearchSettings,
): Promise<void> {
  await state.settingsMutex.run(async () => {
    const data = ((await plugin.loadData()) as Record<string, unknown>) ?? {};
    data.semanticSearch = next;
    await plugin.saveData(data);
  });
  state.settings = next;
  if (state.chooser) {
    state.provider = state.chooser(next);
  }
}
