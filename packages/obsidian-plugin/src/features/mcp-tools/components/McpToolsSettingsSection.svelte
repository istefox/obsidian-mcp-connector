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
    DEFAULT_REQUIRE_WRITE_PRECONDITIONS,
  } from "../types";

  export let plugin: McpToolsPlugin;

  // `null` means "blank input" (Svelte coerces an empty number input to
  // null, not NaN) — treated as "use the default" on save, same
  // blank-means-default convention as AccessControlSection's fixed-port
  // field.
  let maxTextOutputKB: number | null = null;
  let requireWritePreconditions = DEFAULT_REQUIRE_WRITE_PRECONDITIONS;
  let busy = false;

  onMount(async () => {
    const raw = (await new SettingsStore(plugin).readSlice("mcpTools")) as
      | { maxTextOutputKB?: number; requireWritePreconditions?: boolean }
      | undefined;
    maxTextOutputKB = raw?.maxTextOutputKB ?? null;
    requireWritePreconditions =
      raw?.requireWritePreconditions ?? DEFAULT_REQUIRE_WRITE_PRECONDITIONS;
  });

  async function handleSave(): Promise<void> {
    busy = true;
    try {
      const normalized =
        maxTextOutputKB === null
          ? undefined
          : normalizeMaxTextOutputKB(maxTextOutputKB);

      // updateSlice rather than the hand-rolled load/spread/save this used to
      // do: it is the same atomic read-modify-write under the same mutex, and
      // it is the discipline SettingsStore exists to enforce. Worth switching
      // now that two fields share the slice, since a hand-rolled spread is
      // exactly where one field quietly clobbers the other.
      await new SettingsStore(plugin).updateSlice("mcpTools", (current) => ({
        ...((current ?? {}) as Record<string, unknown>),
        maxTextOutputKB: normalized,
        requireWritePreconditions,
      }));

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

  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">Require a write precondition</div>
      <div class="setting-item-description">
        When on, patch_vault_file and patch_active_file refuse a
        <code>replace</code> unless the caller states the text it expects to
        overwrite, so an edit you made after the assistant last read the note
        cannot be silently replaced. Off by default, because a client that
        does not send it will start getting refusals for that one operation.
        Appending and prepending are never affected.
      </div>
    </div>
    <div class="setting-item-control">
      <input
        type="checkbox"
        bind:checked={requireWritePreconditions}
        aria-label="Require a write precondition for replace operations"
      />
      <button type="button" on:click={handleSave} disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  </div>
</div>
