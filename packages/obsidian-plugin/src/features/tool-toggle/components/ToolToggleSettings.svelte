<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { onMount } from "svelte";
  import { SettingsStore } from "$/shared/settingsStore";
  import { DESTRUCTIVE_TOOL_NAMES, KNOWN_MCP_TOOL_NAMES } from "../utils";

  /**
   * Disabled MCP tools settings UI.
   *
   * Replaces the legacy CSV textarea (0.3.x carry-over) with a
   * checkbox grid bound to the live `toolToggle.disabled` array. Each
   * checkbox toggles the persisted state immediately — no save button,
   * no typing, no typos.
   *
   * The runtime filter lives in
   * `tool-toggle/services/applyFilter.ts`. It reads the same
   * `toolToggle.disabled` slice once at registration time and flips
   * each matching tool to user-disabled in the registry. Disabling a tool here
   * therefore takes effect on the NEXT plugin reload (or transport
   * restart, which fires automatically on token regenerate).
   *
   * Two presets are exposed:
   *  - "Disable write operations" — adds every entry in
   *    `DESTRUCTIVE_TOOL_NAMES` (every tool without `readOnlyHint`) to
   *    the disabled set, leaving a read-only MCP surface.
   *  - "Enable all" — clears the disabled set entirely.
   */

  export let plugin: McpToolsPlugin;

  let disabled: Set<string> = new Set();
  let busy = false;
  let mounted = false;

  onMount(async () => {
    const data = (await plugin.loadData()) as
      | { toolToggle?: { disabled?: string[] } }
      | null;
    const existing = data?.toolToggle?.disabled ?? [];
    disabled = new Set(existing);
    mounted = true;
  });

  /**
   * Persist the current `disabled` set into `data.json`. When empty,
   * remove the whole `toolToggle` slice rather than leaving an
   * `{ disabled: [] }` behind — keeps the data file tidy and
   * round-trips to "no key" on the next load.
   */
  async function persist(): Promise<void> {
    // `busy` drives the UI-disabled state only; concurrency safety is
    // SettingsStore's read-modify-write under the shared process-wide
    // settings mutex (data.json is not atomic and is shared across
    // features). An empty set returns `undefined`, which the JSON
    // serialization drops — the same on-disk result as deleting the key.
    busy = true;
    try {
      await new SettingsStore(plugin).updateSlice("toolToggle", () =>
        disabled.size === 0 ? undefined : { disabled: [...disabled].sort() },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save disabled tools: ${message}`);
    } finally {
      busy = false;
    }
  }

  function toggle(name: string): void {
    if (disabled.has(name)) {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }
    // Trigger Svelte reactivity (Set mutations are not tracked).
    disabled = disabled;
    void persist();
  }

  function disableDestructive(): void {
    for (const name of DESTRUCTIVE_TOOL_NAMES) disabled.add(name);
    disabled = disabled;
    void persist();
    new Notice(
      `${DESTRUCTIVE_TOOL_NAMES.length} destructive operations disabled. Restart your MCP client.`,
    );
  }

  function enableAll(): void {
    if (disabled.size === 0) return;
    disabled = new Set();
    void persist();
    new Notice("All MCP tools enabled.");
  }
</script>

<div class="tool-toggle-settings">
  <h3>Disabled MCP tools</h3>
  <p class="description">
    Tick a tool to hide it from your MCP client. Disabled tools are not
    even registered with the MCP server, so the client never sees them.
    Changes apply on the next plugin reload (or after the next API key
    rotation, which restarts the transport automatically).
  </p>

  <div class="presets">
    <button
      type="button"
      on:click={disableDestructive}
      disabled={busy}
      aria-label="Disable write operations"
    >
      Disable write operations ({DESTRUCTIVE_TOOL_NAMES.length})
    </button>
    <button
      type="button"
      on:click={enableAll}
      disabled={busy || disabled.size === 0}
      aria-label="Enable all MCP tools"
    >
      Enable all
    </button>
  </div>

  {#if mounted}
    <div class="grid">
      {#each KNOWN_MCP_TOOL_NAMES as name (name)}
        <label class="row" class:disabled-row={disabled.has(name)}>
          <input
            type="checkbox"
            checked={disabled.has(name)}
            on:change={() => toggle(name)}
            disabled={busy}
            aria-label="Disable {name}"
          />
          <code>{name}</code>
        </label>
      {/each}
    </div>
  {/if}

  <p class="counter">
    {disabled.size} of {KNOWN_MCP_TOOL_NAMES.length} disabled
  </p>
</div>

<style>
  .tool-toggle-settings {
    margin-top: 2em;
  }

  .description {
    color: var(--text-muted);
    font-size: 0.9em;
    margin: 0.5em 0 0.8em;
  }

  .presets {
    display: flex;
    gap: 0.4em;
    flex-wrap: wrap;
    margin-bottom: 0.8em;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.25em 1.2em;
    margin: 0.4em 0 0.8em;
    padding: 0.6em 0.8em;
    background: var(--background-secondary);
    border-radius: 4px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.5em;
    cursor: pointer;
    padding: 0.15em 0;
  }

  .row code {
    font-family: var(--font-monospace);
    font-size: 0.9em;
  }

  .disabled-row code {
    text-decoration: line-through;
    color: var(--text-muted);
  }

  .counter {
    color: var(--text-muted);
    font-size: 0.85em;
    margin: 0;
  }
</style>
