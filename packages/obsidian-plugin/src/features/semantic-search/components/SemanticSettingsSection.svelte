<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { onDestroy, onMount } from "svelte";
  import { applySettings } from "../index";
  import {
    DEFAULT_REMOTE_SETTINGS,
    DEFAULT_SEMANTIC_SETTINGS,
    remoteProviderKey,
    type RemoteEmbeddingSettings,
    type SemanticSearchSettings,
  } from "../types";
  import {
    listRemoteModels,
    probeRemoteDimensions,
  } from "../services/remoteEmbeddingProvider";
  import ModelDownloadProgress from "./ModelDownloadProgress.svelte";

  export let plugin: McpToolsPlugin;

  let settings: SemanticSearchSettings = { ...DEFAULT_SEMANTIC_SETTINGS };
  let saving = false;
  let rebuilding = false;
  let storeSize = 0;
  let lastError: string | null = null;
  let pendingProvider: string | null = null;
  let autoSuggestProvider: string | null = null;
  // #655: build status of the pending DLC provider, refreshed by a poll
  // while the settings tab is open, so the banner shows what is really
  // happening (building, failed, or waiting for the user).
  let pendingBuilding = false;
  let pendingError: string | null = null;
  let pollTimer: number | null = null;
  const POLL_MS = 1000;

  // Working copy of the remote block. Edited freely and written back on
  // blur or on an explicit action, so typing a URL does not re-persist
  // and re-instantiate the provider on every keystroke.
  let remote: Required<RemoteEmbeddingSettings> = {
    ...DEFAULT_REMOTE_SETTINGS,
  };
  let testing = false;
  let testMessage: string | null = null;
  let testOk = false;
  let knownModels: string[] = [];

  const PROVIDER_META: Record<
    string,
    { label: string; size: string; seconds: string }
  > = {
    "embedding-gemma-300m": {
      label: "EmbeddingGemma 300M",
      size: "~200 to 310 MB",
      seconds: "5–10 min",
    },
    "multilingual-e5-base": {
      label: "Multilingual E5 base",
      size: "~280 MB",
      seconds: "3–5 min",
    },
  };

  onMount(() => {
    const state = plugin.semanticSearchState;
    if (state) {
      settings = { ...state.settings };
      remote = { ...DEFAULT_REMOTE_SETTINGS, ...(state.settings.remote ?? {}) };
      pendingProvider = state.pendingProvider ?? null;
      autoSuggestProvider = state.autoSuggestProvider ?? null;
    }
    refreshStatus();
    pollTimer = window.setInterval(refreshStatus, POLL_MS);
  });

  onDestroy(() => {
    if (pollTimer !== null) window.clearInterval(pollTimer);
  });

  function refreshStatus() {
    const state = plugin.semanticSearchState;
    const provider = state?.settings?.provider;
    const registry = state?.registry;
    // Stores load lazily: size() is 0 until the first indexer/search
    // use. Fall back to the plugin-load probe counts so a settings-only
    // session still shows the persisted chunk count.
    const probed = state?.probedCounts ?? {};
    // For DLC providers, read chunk count from their own store.
    // state.store always points to the native MiniLM store.
    if (provider === "embedding-gemma" && registry) {
      storeSize =
        registry.storeFor("embedding-gemma-300m", 768).size() ||
        probed["embedding-gemma-300m"] ||
        0;
    } else if (provider === "multilingual-e5-base" && registry) {
      storeSize =
        registry.storeFor("multilingual-e5-base", 768).size() ||
        probed["multilingual-e5-base"] ||
        0;
    } else if (provider === "remote" && registry && remote.dimensions > 0) {
      const key = remoteProviderKey(remote.model, remote.dimensions);
      storeSize = registry.storeFor(key, remote.dimensions).size() ||
        probed[key] ||
        0;
    } else {
      storeSize =
        (state?.store?.size?.() ?? 0) || probed["native-minilm-l6-v2"] || 0;
    }
    const previousPending = pendingProvider;
    const wasBuilding = pendingBuilding;
    pendingProvider = state?.pendingProvider ?? null;
    autoSuggestProvider = state?.autoSuggestProvider ?? null;
    pendingBuilding = pendingProvider
      ? (state?.isRebuildingFor?.(pendingProvider) ?? false)
      : false;
    pendingError = pendingProvider
      ? (state?.dlcRebuildErrors?.get(pendingProvider) ?? null)
      : null;
    // The build finished while the tab was open: say so, since the
    // banner just disappears otherwise.
    // Switching to another provider also clears pendingProvider, so
    // check the store really is ready.
    if (
      previousPending &&
      wasBuilding &&
      !pendingProvider &&
      registry?.isReady(previousPending)
    ) {
      const label = PROVIDER_META[previousPending]?.label ?? previousPending;
      new Notice(`${label} index is ready.`);
    }
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
      // Rebuild the remote provider FIRST: applySettings runs the
      // chooser, which reads the live remote key. Reversing these two
      // would leave the chooser resolving against the previous server.
      state.configureRemote?.(next);
      await applySettings(plugin, state, next);
      settings = next;
      refreshStatus();
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  async function onProviderChange(value: SemanticSearchSettings["provider"]) {
    await persist({ ...settings, provider: value });
  }

  /** Write the working copy of the remote block back to settings. */
  async function persistRemote(patch: Partial<RemoteEmbeddingSettings> = {}) {
    remote = { ...remote, ...patch };
    await persist({ ...settings, remote: { ...remote } });
  }

  /**
   * Changing the server or the model invalidates the detected width:
   * it is part of the store directory name, so keeping a stale value
   * would point at another model's vectors. Clearing it forces a probe
   * before the provider can be used, which is the safe default.
   */
  async function onRemoteTargetChange(
    patch: Partial<RemoteEmbeddingSettings>,
  ) {
    testMessage = null;
    await persistRemote({ ...patch, dimensions: 0 });
  }

  /**
   * Probe the server: list its models (best effort) and embed one short
   * string to learn the vector width, which is then cached in settings.
   * This is the only place the width is discovered from the UI.
   */
  async function onTestConnection() {
    testing = true;
    testMessage = null;
    testOk = false;
    try {
      knownModels = await listRemoteModels(remote).catch(() => []);
      if (!remote.model) {
        testMessage =
          knownModels.length > 0
            ? `Server reachable. Pick a model: ${knownModels.slice(0, 8).join(", ")}`
            : "Server reachable, but no model id is set.";
        return;
      }
      const dimensions = await probeRemoteDimensions(remote);
      await persistRemote({ dimensions });
      testOk = true;
      testMessage = `OK — ${remote.model} returns ${dimensions}-dimensional vectors. Index directory: ${remoteProviderKey(remote.model, dimensions)}`;
      refreshStatus();
    } catch (e) {
      testMessage = e instanceof Error ? e.message : String(e);
    } finally {
      testing = false;
    }
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
    if (!state.startRebuildFor) {
      new Notice("Rebuild not available yet — reload Obsidian.");
      return;
    }
    const label = PROVIDER_META[pendingProvider]?.label ?? pendingProvider;
    state.startRebuildFor(pendingProvider);
    refreshStatus();
    new Notice(
      pendingBuilding
        ? `Building ${label} index in background…`
        : `Could not start the ${label} build. Reload Obsidian and try again.`,
    );
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
          : settings.provider === "remote" && remote.dimensions > 0
            ? remoteProviderKey(remote.model, remote.dimensions)
            : null;

    if (settings.provider === "remote" && !dlcProviderKey) {
      new Notice(
        "Run “Test connection” first — the vector width has to be known before an index can be built.",
      );
      return;
    }

    if (dlcProviderKey) {
      if (!state.startRebuildFor) {
        new Notice("Rebuild not available yet — reload Obsidian.");
        return;
      }
      state.startRebuildFor(dlcProviderKey);
      refreshStatus();
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
    <div class="banner warn" role="status">
      {#if pendingBuilding}
        {#if meta}
          Building the {meta.label} index: model download ({meta.size}) then
          indexing, ~{meta.seconds}.
        {:else}
          Building the <code>{pendingProvider}</code> index on the embedding
          server.
        {/if}
        {storeSize.toLocaleString()} chunks indexed so far. Search keeps using
        the previous provider until it is done.
      {:else if pendingError}
        {meta?.label ?? pendingProvider} index build failed: {pendingError}
        <button type="button" class="banner-action" on:click={onRebuildNow}>
          Retry
        </button>
      {:else}
        {#if meta}
          {meta.label} index is not built yet ({meta.size} download, ~{meta.seconds}).
        {:else}
          The index for <code>{pendingProvider}</code> is not built yet. Search
          keeps using the previous provider until it is.
        {/if}
        <button type="button" class="banner-action" on:click={onRebuildNow}>
          Rebuild now
        </button>
      {/if}
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
      <span class="hint">multilingual, 768d, 2K context (~200 to 310 MB download)</span
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
        >multilingual, 768d, 512 context (~280 MB download)</span
      >
    </label>
    <label>
      <input
        type="radio"
        name="ss-provider"
        value="remote"
        checked={settings.provider === "remote"}
        on:change={() => onProviderChange("remote")}
      />
      Remote server
      <span class="hint"
        >any OpenAI-compatible /v1/embeddings endpoint — LM Studio,
        llama.cpp, Ollama, TEI. Nothing is downloaded into the vault.</span
      >
    </label>
  </fieldset>

  {#if settings.provider === "remote"}
    <fieldset disabled={saving || testing}>
      <legend>Remote embedding server</legend>

      <label class="field">
        <span class="field-label">Base URL</span>
        <input
          type="text"
          spellcheck="false"
          value={remote.baseUrl}
          placeholder="http://localhost:1234"
          on:change={(e) =>
            onRemoteTargetChange({
              baseUrl: (e.target as HTMLInputElement).value,
            })}
        />
      </label>
      <p class="hint block">
        The server root, a <code>/v1</code> root, or the full
        <code>/v1/embeddings</code> URL — all three work.
      </p>

      <label class="field">
        <span class="field-label">Model</span>
        <input
          type="text"
          spellcheck="false"
          list="ss-remote-models"
          value={remote.model}
          placeholder="text-embedding-…"
          on:change={(e) =>
            onRemoteTargetChange({
              model: (e.target as HTMLInputElement).value,
            })}
        />
      </label>
      <datalist id="ss-remote-models">
        {#each knownModels as id}
          <option value={id}></option>
        {/each}
      </datalist>

      <label class="field">
        <span class="field-label">API key</span>
        <input
          type="password"
          autocomplete="off"
          value={remote.apiKey}
          placeholder="(not needed for LM Studio)"
          on:change={(e) =>
            persistRemote({ apiKey: (e.target as HTMLInputElement).value })}
        />
      </label>

      <label class="field">
        <span class="field-label">Query instruction</span>
        <input
          type="text"
          value={remote.queryInstruction}
          on:change={(e) =>
            persistRemote({
              queryInstruction: (e.target as HTMLInputElement).value,
            })}
        />
      </label>
      <p class="hint block">
        Sent as <code>Instruct: …\nQuery: …</code> in front of search queries
        only; indexed passages are always embedded bare. This is what
        instruction-tuned retrieval models (F2LLM, E5, BGE, Qwen3-Embedding)
        expect. Leave empty for symmetric models. Changing it does not
        require a re-index — only queries are affected.
      </p>

      <div class="field-row">
        <label class="field narrow">
          <span class="field-label">Chunk budget (tokens)</span>
          <input
            type="number"
            min="64"
            max="8192"
            value={remote.maxInputTokens}
            on:change={(e) =>
              persistRemote({
                maxInputTokens: Number((e.target as HTMLInputElement).value),
              })}
          />
        </label>
        <label class="field narrow">
          <span class="field-label">Batch size</span>
          <input
            type="number"
            min="1"
            max="128"
            value={remote.batchSize}
            on:change={(e) =>
              persistRemote({
                batchSize: Number((e.target as HTMLInputElement).value),
              })}
          />
        </label>
        <label class="field narrow">
          <span class="field-label">Timeout (ms)</span>
          <input
            type="number"
            min="1000"
            max="600000"
            step="1000"
            value={remote.timeoutMs}
            on:change={(e) =>
              persistRemote({
                timeoutMs: Number((e.target as HTMLInputElement).value),
              })}
          />
        </label>
      </div>
      <p class="hint block">
        The chunk budget only sizes chunks — the server enforces its own
        context. Changing it re-cuts every chunk boundary, so rebuild the
        index afterwards.
      </p>

      <div class="field-row">
        <label class="field narrow">
          <span class="field-label">Max chars per text</span>
          <input
            type="number"
            min="500"
            max="200000"
            step="500"
            value={remote.maxInputChars}
            on:change={(e) =>
              persistRemote({
                maxInputChars: Number((e.target as HTMLInputElement).value),
              })}
          />
        </label>
        <label class="field narrow">
          <span class="field-label">Max chars per request</span>
          <input
            type="number"
            min="500"
            max="1000000"
            step="1000"
            value={remote.maxRequestChars}
            on:change={(e) =>
              persistRemote({
                maxRequestChars: Number((e.target as HTMLInputElement).value),
              })}
          />
        </label>
      </div>
      <p class="hint block">
        Safety ceilings for the server, not quality settings. A note that is
        one long code block reaches the chunker as a single oversized chunk;
        sending it whole can exhaust GPU memory and drop the model. Lower
        these if a large model crashes mid-rebuild.
      </p>

      <div class="status">
        <span>
          {#if remote.dimensions > 0}
            {remote.dimensions}-dimensional vectors
          {:else}
            Vector width not detected yet
          {/if}
        </span>
        <button type="button" on:click={onTestConnection} disabled={testing}>
          {testing ? "Testing…" : "Test connection"}
        </button>
      </div>

      {#if testMessage}
        <div class={testOk ? "banner info" : "error"}>{testMessage}</div>
      {/if}
    </fieldset>
  {/if}

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

  .field {
    display: flex;
    align-items: center;
    gap: 0.75em;
    margin: 0.4em 0;
  }

  .field-label {
    flex: 0 0 11em;
    font-size: 0.9em;
  }

  .field input {
    flex: 1 1 auto;
    min-width: 0;
  }

  .field-row {
    display: flex;
    flex-wrap: wrap;
    gap: 1em;
  }

  .field-row .field.narrow {
    flex: 1 1 10em;
  }

  .field-row .field.narrow .field-label {
    flex: 0 0 auto;
  }

  .field-row .field.narrow input {
    width: 6em;
    flex: 0 0 auto;
  }

  .hint.block {
    display: block;
    color: var(--text-muted);
    font-size: 0.85em;
    margin: 0 0 0.75em 0;
  }
</style>
