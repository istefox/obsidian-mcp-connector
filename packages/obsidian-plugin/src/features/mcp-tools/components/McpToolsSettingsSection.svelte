<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { onMount } from "svelte";
  import { globalSettingsMutex } from "$/features/command-permissions";
  import { SettingsStore } from "$/shared/settingsStore";
  import {
    DEFAULT_MAX_TEXT_OUTPUT_KB,
    MIN_MAX_TEXT_OUTPUT_KB,
    MAX_MAX_TEXT_OUTPUT_KB,
    normalizeMaxTextOutputKB,
  } from "../types";

  export let plugin: McpToolsPlugin;

  // `null` means "blank input" (Svelte coerces an empty number input to
  // null, not NaN) — treated as "use the default" on save, same
  // blank-means-default convention as AccessControlSection's fixed-port
  // field.
  let maxTextOutputKB: number | null = null;
  let busy = false;

  onMount(async () => {
    const raw = (await new SettingsStore(plugin).readSlice("mcpTools")) as
      | { maxTextOutputKB?: number }
      | undefined;
    maxTextOutputKB = raw?.maxTextOutputKB ?? null;
  });

  async function handleSave(): Promise<void> {
    busy = true;
    try {
      const normalized =
        maxTextOutputKB === null
          ? undefined
          : normalizeMaxTextOutputKB(maxTextOutputKB);

      await globalSettingsMutex.run(async () => {
        const data = ((await plugin.loadData()) ?? {}) as Record<
          string,
          unknown
        >;
        const existing = (data.mcpTools ?? {}) as Record<string, unknown>;
        await plugin.saveData({
          ...data,
          mcpTools: { ...existing, maxTextOutputKB: normalized },
        });
      });

      maxTextOutputKB = normalized ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save MCP Tools settings: ${message}`);
    } finally {
      busy = false;
    }
  }
</script>

<div class="mcp-tools-settings">
  <h3>MCP Tools</h3>

  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">Max text output size (KB)</div>
      <div class="setting-item-description">
        Ceiling on inline text returned by get_vault_file before it is
        truncated with a hint to read a specific range instead. Leave
        blank for the default ({DEFAULT_MAX_TEXT_OUTPUT_KB} KB). Range:
        {MIN_MAX_TEXT_OUTPUT_KB}–{MAX_MAX_TEXT_OUTPUT_KB} KB.
      </div>
    </div>
    <div class="setting-item-control">
      <input
        type="number"
        bind:value={maxTextOutputKB}
        placeholder={String(DEFAULT_MAX_TEXT_OUTPUT_KB)}
        min={MIN_MAX_TEXT_OUTPUT_KB}
        max={MAX_MAX_TEXT_OUTPUT_KB}
        step="1"
        aria-label="Max text output size in KB"
      />
      <button type="button" on:click={handleSave} disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  </div>
</div>
