<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { onMount } from "svelte";
  import { globalSettingsMutex } from "$/features/command-permissions";
  import { ToolLoadingManager } from "../toolLoadingManager";
  import type { ToolLoadingState } from "../toolLoadingManager";

  export let plugin: McpToolsPlugin;

  let profile: "all" | "core" | "adaptive" = "all";
  let promoted: string[] = [];
  let busy = false;
  let mounted = false;

  const mgr = new ToolLoadingManager();

  onMount(async () => {
    const state = await mgr.loadState(plugin);
    profile = state.profile;
    promoted = state.promoted;
    mounted = true;
  });

  async function persist(patch: Partial<ToolLoadingState>): Promise<void> {
    busy = true;
    try {
      await globalSettingsMutex.run(async () => {
        const data =
          ((await plugin.loadData()) as Record<string, unknown>) ?? {};
        const existing = (data.toolLoading ?? {}) as Partial<ToolLoadingState>;
        data.toolLoading = { ...existing, ...patch };
        await plugin.saveData(data);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save tool loading settings: ${message}`);
    } finally {
      busy = false;
    }
  }

  function onProfileChange(value: "all" | "core" | "adaptive"): void {
    profile = value;
    void persist({ profile });
  }

  async function removePromoted(name: string): Promise<void> {
    await mgr.deactivateTool(name, plugin);
    promoted = promoted.filter((n) => n !== name);
  }

  async function resetAdaptiveData(): Promise<void> {
    await mgr.resetAll(plugin);
    promoted = [];
    new Notice("Adaptive tool data reset.");
  }
</script>

<div class="adaptive-tool-loading-settings">
  <h3>Tool Loading</h3>
  <p class="description">
    Control which MCP tools are loaded at connect time. "All tools" (default)
    preserves current behavior. "Core set" loads ~13 frequently-used tools.
    "Adaptive" starts from the core set and adds tools you use often or
    activate explicitly via <code>activate_tool</code>.
  </p>

  {#if mounted}
    <div class="profile-group">
      <label class="radio-row">
        <input
          type="radio"
          name="tool-loading-profile"
          value="all"
          checked={profile === "all"}
          on:change={() => onProfileChange("all")}
          disabled={busy}
        />
        <span>All tools <span class="muted">(default — loads every tool)</span></span>
      </label>
      <label class="radio-row">
        <input
          type="radio"
          name="tool-loading-profile"
          value="core"
          checked={profile === "core"}
          on:change={() => onProfileChange("core")}
          disabled={busy}
        />
        <span>Core set <span class="muted">(~13 essential tools)</span></span>
      </label>
      <label class="radio-row">
        <input
          type="radio"
          name="tool-loading-profile"
          value="adaptive"
          checked={profile === "adaptive"}
          on:change={() => onProfileChange("adaptive")}
          disabled={busy}
        />
        <span>Adaptive <span class="muted">(core + promoted tools)</span></span>
      </label>
    </div>

    {#if profile === "adaptive"}
      <div class="promoted-section">
        <p class="section-label">
          Promoted tools
          <span class="muted"
            >— auto-promoted after {3} calls, or activated via
            <code>activate_tool</code></span
          >
        </p>
        {#if promoted.length === 0}
          <p class="muted empty-hint">
            No promoted tools yet. Use a non-core tool 3 times in Adaptive mode
            to auto-promote it, or call <code>activate_tool</code> from chat.
          </p>
        {:else}
          <ul class="promoted-list">
            {#each promoted as name (name)}
              <li>
                <code>{name}</code>
                <button
                  type="button"
                  on:click={() => void removePromoted(name)}
                  disabled={busy}
                  aria-label="Remove {name} from promoted tools"
                >
                  Remove
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        <button
          type="button"
          class="reset-btn"
          on:click={() => void resetAdaptiveData()}
          disabled={busy}
          aria-label="Reset adaptive tool data"
        >
          Reset adaptive data
        </button>
      </div>
    {/if}
  {/if}

  <p class="footer-hint muted">
    Profile changes take effect on the next MCP client connection.
  </p>
</div>

<style>
  .adaptive-tool-loading-settings {
    margin-top: 2em;
  }

  .description {
    color: var(--text-muted);
    font-size: 0.9em;
    margin: 0.5em 0 0.8em;
  }

  .profile-group {
    display: flex;
    flex-direction: column;
    gap: 0.4em;
    margin-bottom: 1em;
  }

  .radio-row {
    display: flex;
    align-items: center;
    gap: 0.5em;
    cursor: pointer;
  }

  .muted {
    color: var(--text-muted);
    font-size: 0.9em;
  }

  .section-label {
    font-weight: 500;
    margin: 0 0 0.5em;
  }

  .promoted-section {
    padding: 0.6em 0.8em;
    background: var(--background-secondary);
    border-radius: 4px;
    margin-bottom: 0.8em;
  }

  .promoted-list {
    list-style: none;
    padding: 0;
    margin: 0 0 0.6em;
    display: flex;
    flex-direction: column;
    gap: 0.3em;
  }

  .promoted-list li {
    display: flex;
    align-items: center;
    gap: 0.6em;
  }

  .promoted-list code {
    font-family: var(--font-monospace);
    font-size: 0.9em;
    flex: 1;
  }

  .empty-hint {
    font-size: 0.85em;
    margin: 0 0 0.5em;
  }

  .reset-btn {
    margin-top: 0.4em;
  }

  .footer-hint {
    font-size: 0.82em;
    margin: 0.4em 0 0;
  }
</style>
