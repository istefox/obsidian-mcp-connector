<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { onMount } from "svelte";
  import { applySettings } from "../index";
  import {
    DEFAULT_SEMANTIC_SETTINGS,
    type SemanticSearchSettings,
  } from "../types";
  import ModelDownloadProgress from "./ModelDownloadProgress.svelte";

  export let plugin: McpToolsPlugin;

  let settings: SemanticSearchSettings = { ...DEFAULT_SEMANTIC_SETTINGS };
  let saving = false;
  let rebuilding = false;
  let storeSize = 0;
  let lastError: string | null = null;
  let pendingProvider: string | null = null;
  let autoSuggestProvider: string | null = null;

  const PROVIDER_META: Record<
    string,
    { label: string; size: string; seconds: string }
  > = {
    "embedding-gemma-300m": {
      label: "EmbeddingGemma 300M",
      size: "~190 MB",
      seconds: "5–10 min",
    },
    "multilingual-e5-base": {
      label: "Multilingual E5 base",
      size: "~100 MB",
      seconds: "3–5 min",
    },
  };

  onMount(() => {
    const state = plugin.semanticSearchState;
    if (state) {
      settings = { ...state.settings };
      pendingProvider = state.pendingProvider ?? null;
      autoSuggestProvider = state.autoSuggestProvider ?? null;
    }
    refreshStatus();
  });

  function refreshStatus() {
    const state = plugin.semanticSearchState;
    const provider = state?.settings?.provider;
    const registry = state?.registry;
    // For DLC providers, read chunk count from their own store.
    // state.store always points to the native MiniLM store.
    if (provider === "embedding-gemma" && registry) {
      storeSize = registry.storeFor("embedding-gemma-300m", 768).size();
    } else if (provider === "multilingual-e5-base" && registry) {
      storeSize = registry.storeFor("multilingual-e5-base", 768).size();
    } else {
      storeSize = state?.store?.size?.() ?? 0;
    }
    pendingProvider = state?.pendingProvider ?? null;
    autoSuggestProvider = state?.autoSuggestProvider ?? null;
  }

  async function persist(next: SemanticSearchSettings) {
    const state = plugin.semanticSearchState;
    if (!state) {
      lastError = "Plugin not fully initialized — reload Obsidian.";
      return;
    }
    saving = true;
    lastError = null;
    try {
      await applySettings(plugin, state, next);
      settings = next;
      pendingProvider = state.pendingProvider ?? null;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function onProviderChange(value: SemanticSearchSettings["provider"]) {
    await persist({ ...settings, provider: value });
  }

  async function onModeChange(value: SemanticSearchSettings["indexingMode"]) {
    await persist({ ...settings, indexingMode: value });
  }

  async function onUnloadChange(value: boolean) {
    await persist({ ...settings, unloadModelWhenIdle: value });
  }

  async function onRebuildNow() {
    const state = plugin.semanticSearchState;
    if (!state || !pendingProvider) return;
    if (state.startRebuildFor) {
      state.startRebuildFor(pendingProvider);
    } else {
      new Notice("Rebuild not available yet — reload Obsidian.");
    }
  }

  async function onRebuild() {
    const state = plugin.semanticSearchState;
    if (!state) {
      new Notice("Semantic index not available yet — reload Obsidian.");
      return;
    }

    // DLC providers maintain their own stores; route through startRebuildFor.
    const dlcProviderKey =
      settings.provider === "embedding-gemma"
        ? "embedding-gemma-300m"
        : settings.provider === "multilingual-e5-base"
          ? "multilingual-e5-base"
          : null;

    if (dlcProviderKey) {
      if (!state.startRebuildFor) {
        new Notice("Rebuild not available yet — reload Obsidian.");
        return;
      }
      state.startRebuildFor(dlcProviderKey);
      new Notice("Rebuilding index in background…");
      return;
    }

    if (settings.provider === "smart-connections") {
      new Notice("Smart Connections manages its own index.");
      return;
    }

    // Native / auto: use the always-on MiniLM indexer.
    const indexer = state.indexer;
    if (!indexer) {
      new Notice("Semantic index not available yet — reload Obsidian.");
      return;
    }
    rebuilding = true;
    try {
      await indexer.rebuildAll();
      new Notice("Semantic index rebuilt.");
      refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Rebuild failed: ${msg}`);
    } finally {
      rebuilding = false;
    }
  }
</script>

<div class="semantic-search-settings">
  <h3>Semantic search</h3>
  <p class="description">
    Search notes by meaning, not just by keyword. Pick the embedding
    backend that matches your setup.
  </p>

  {#if autoSuggestProvider}
    {@const meta = PROVIDER_META[autoSuggestProvider]}
    <div class="banner info">
      Your vault appears to contain non-English content.
      {meta?.label ?? autoSuggestProvider} may improve search quality.
      <button
        type="button"
        class="banner-action"
        on:click={() =>
          onProviderChange(
            autoSuggestProvider === "embedding-gemma-300m"
              ? "embedding-gemma"
              : "multilingual-e5-base",
          )}
      >
        Switch
      </button>
    </div>
  {/if}

  {#if pendingProvider}
    {@const meta = PROVIDER_META[pendingProvider]}
    <div class="banner warn">
      {meta?.label ?? pendingProvider} index is being built ({meta?.size ?? ""}
      download, ~{meta?.seconds ?? ""}).
      <button type="button" class="banner-action" on:click={onRebuildNow}>
        Rebuild now
      </button>
    </div>
  {/if}

  <fieldset disabled={saving}>
    <legend>Provider</legend>
    <label>
      <input
        type="radio"
        name="ss-provider"
        value="auto"
        checked={settings.provider === "auto"}
        on:change={() => onProviderChange("auto")}
      />
      Auto
      <span class="hint"
        >use Smart Connections if installed, otherwise native</span
      >
    </label>
    <label>
      <input
        type="radio"
        name="ss-provider"
        value="native"
        checked={settings.provider === "native"}
        on:change={() => onProviderChange("native")}
      />
      Native
      <span class="hint"
        >Transformers.js + MiniLM-L6-v2, no external plugin required</span
      >
    </label>
    <label>
      <input
        type="radio"
        name="ss-provider"
        value="smart-connections"
        checked={settings.provider === "smart-connections"}
        on:change={() => onProviderChange("smart-connections")}
      />
      Smart Connections plugin
      <span class="hint">requires the Smart Connections community plugin</span>
    </label>
    <label>
      <input
        type="radio"
        name="ss-provider"
        value="embedding-gemma"
        checked={settings.provider === "embedding-gemma"}
        on:change={() => onProviderChange("embedding-gemma")}
      />
      EmbeddingGemma 300M
      <span class="hint">multilingual, 768d, 2K context (~190 MB download)</span
      >
    </label>
    <label>
      <input
        type="radio"
        name="ss-provider"
        value="multilingual-e5-base"
        checked={settings.provider === "multilingual-e5-base"}
        on:change={() => onProviderChange("multilingual-e5-base")}
      />
      Multilingual E5 base
      <span class="hint"
        >multilingual, 768d, 512 context (~100 MB download)</span
      >
    </label>
  </fieldset>

  {#if settings.provider !== "smart-connections"}
    <fieldset disabled={saving}>
      <legend>Indexing mode (native only)</legend>
      <label>
        <input
          type="radio"
          name="ss-mode"
          value="live"
          checked={settings.indexingMode === "live"}
          on:change={() => onModeChange("live")}
        />
        Live
        <span class="hint"
          >responsive, recommended — re-embed on file change</span
        >
      </label>
      <label>
        <input
          type="radio"
          name="ss-mode"
          value="low-power"
          checked={settings.indexingMode === "low-power"}
          on:change={() => onModeChange("low-power")}
        />
        Low-power
        <span class="hint">re-index every 5 min, saves battery</span>
      </label>
    </fieldset>

    <label class="checkbox">
      <input
        type="checkbox"
        checked={settings.unloadModelWhenIdle}
        on:change={(e) =>
          onUnloadChange((e.target as HTMLInputElement).checked)}
        disabled={saving}
      />
      Unload model when idle (60s)
      <span class="hint"
        >frees ~150 MB of RAM after inactivity, next search reloads the model
        (~1s); takes effect at the next plugin reload</span
      >
    </label>
  {/if}

  <ModelDownloadProgress {plugin} />

  <div class="status">
    <span>{storeSize.toLocaleString()} chunks indexed</span>
    <button
      type="button"
      on:click={onRebuild}
      disabled={rebuilding || saving}
    >
      {rebuilding ? "Rebuilding…" : "Rebuild index from scratch"}
    </button>
  </div>

  {#if lastError}
    <div class="error">{lastError}</div>
  {/if}
</div>

<style>
  .semantic-search-settings {
    margin-top: 2em;
  }

  .description {
    color: var(--text-muted);
    font-size: 0.9em;
    margin-bottom: 0.5em;
  }

  fieldset {
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    padding: 0.5em 1em;
    margin: 0 0 0.75em 0;
  }

  legend {
    font-weight: 600;
    font-size: 0.9em;
    padding: 0 0.4em;
  }

  fieldset label,
  label.checkbox {
    display: block;
    margin: 0.25em 0;
    cursor: pointer;
  }

  .hint {
    color: var(--text-muted);
    font-size: 0.85em;
    margin-left: 0.4em;
  }

  .banner {
    border-radius: 4px;
    font-size: 0.9em;
    margin-bottom: 0.75em;
    padding: 0.5em 0.75em;
  }

  .banner.info {
    background: var(--background-modifier-info);
    color: var(--text-normal);
  }

  .banner.warn {
    background: var(--background-modifier-error);
    color: var(--text-normal);
  }

  .banner-action {
    margin-left: 0.5em;
  }

  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 1em;
    padding-top: 0.75em;
    border-top: 1px solid var(--background-modifier-border);
    font-size: 0.9em;
  }

  .error {
    color: var(--text-error);
    font-size: 0.9em;
    margin-top: 0.5em;
  }
</style>
