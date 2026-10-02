<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { onMount, tick } from "svelte";
  import { SettingsStore } from "$/shared/settingsStore";
  import {
    filterPresetAgainstRegistry,
    mergeIntoAllowlist,
    PRESETS,
    type PresetCategory,
  } from "../presets";
  import type { CommandAuditEntry } from "../types";
  import {
    AUDIT_LOG_MAX_ENTRIES,
    auditLogCsvFilename,
    auditLogToCsv,
    type CommandDescriptor,
    formatAllowlist,
    groupCommandsByNamespace,
    isDestructiveCommand,
    normalizeSoftRateLimit,
    parseAllowlistCsv,
    SOFT_RATE_LIMIT_MAX,
    SOFT_RATE_LIMIT_MIN,
    SOFT_RATE_LIMIT_PER_MINUTE,
    splitAllowlistByRegistry,
  } from "../utils";

  /**
   * Command permissions settings UI — "allowed-first" redesign (T12.d).
   *
   * Top-down structure:
   *  1. Master toggle + description
   *  2. "Currently allowed" chip-list (×-removable, persists immediately)
   *  3. "Add commands" section: search input (Enter adds first match)
   *     + preset buttons inline + "Browse all by category" disclosure
   *     where each namespace is its own nested disclosure with checkbox
   *     rows (no full-list rendering until the user opens a group).
   *  4. Recent invocations (audit log) — collapsed by default
   *  5. Advanced (soft rate-limit + Import/Export CSV) — collapsed
   *
   * Every interaction persists immediately — same paradigm as
   * ToolToggleSettings (T12.c). The legacy CSV textarea is removed
   * from the primary flow; users syncing settings between vaults use
   * the Import/Export affordance under Advanced.
   */

  export let plugin: McpToolsPlugin;

  let enabled = false;
  let allowlist: string[] = [];
  let recentInvocations: CommandAuditEntry[] = [];
  let softRateLimitRaw = "";
  let busy = false;
  let mounted = false;

  // Live command list scraped from the Obsidian runtime once on mount.
  let availableCommands: CommandDescriptor[] = [];
  let commandRegistry: Record<string, CommandDescriptor> | undefined =
    undefined;
  let searchQuery = "";

  // Imperative ref to the search <input> so Enter on a result that
  // clears the query can re-focus the input for the next search.
  let searchInputEl: HTMLInputElement | null = null;

  // The chip-list renders from `allowlist` directly; we expose it as a
  // Set for fast `has()` checks.
  $: allowedSet = new Set(allowlist);

  // Partition the allowlist into ids that exist in the live registry
  // ("live") and ids that do not ("stale"). Stale ids typically come
  // from a plugin that was uninstalled or an allowlist imported from
  // another vault. We surface them separately so the user can choose
  // to keep or remove them — never auto-remove (silent data loss).
  $: split = splitAllowlistByRegistry(allowlist, commandRegistry);

  // Case-insensitive filter over id + name.
  $: filteredCommands = (() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return availableCommands.filter(
      (c) =>
        c.id.toLowerCase().includes(query) ||
        c.name.toLowerCase().includes(query),
    );
  })();

  // Browse-all groups, computed once from the immutable
  // `availableCommands`. Iteration order = alphabetical namespace,
  // alphabetical id within.
  $: groupedCommands = groupCommandsByNamespace(availableCommands);

  // Per-namespace count of currently-allowed ids, for the "X / Y" header.
  $: namespaceAllowedCounts = (() => {
    const counts = new Map<string, number>();
    for (const [ns, cmds] of groupedCommands) {
      let n = 0;
      for (const c of cmds) if (allowedSet.has(c.id)) n++;
      counts.set(ns, n);
    }
    return counts;
  })();

  // Per-preset preview: how many of this preset's ids exist in the
  // live registry. Drives the "+ Editing (16)" button label.
  $: presetPreviews = PRESETS.map((preset) => ({
    preset,
    availableIds: filterPresetAgainstRegistry(preset, commandRegistry),
  }));

  onMount(async () => {
    const data = await plugin.loadData();
    const perms = data?.commandPermissions ?? {};
    enabled = perms.enabled ?? false;
    allowlist = [...(perms.allowlist ?? [])];
    recentInvocations = perms.recentInvocations ?? [];
    softRateLimitRaw =
      perms.softRateLimit !== undefined ? String(perms.softRateLimit) : "";

    const registry = (
      plugin.app as unknown as {
        commands?: { commands?: Record<string, CommandDescriptor> };
      }
    ).commands?.commands;
    if (registry) {
      commandRegistry = registry;
      availableCommands = Object.values(registry)
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    mounted = true;
  });

  /**
   * Persist `enabled` + `allowlist` + (optionally) `softRateLimit`
   * into data.json. The audit ring buffer is owned by the permission
   * handler; we read+merge so concurrent writes from the handler are
   * not clobbered. Same pattern as ToolToggleSettings.persist().
   */
  async function persist(): Promise<void> {
    // `busy` drives the UI-disabled state only; concurrency safety is
    // SettingsStore's read-modify-write under the shared process-wide
    // settings mutex (the permission handler writes the same slice from
    // the MCP path — one lock, so neither clobbers the other). Through the
    // store rather than a hand-rolled load/save so the write also primes
    // the read cache the request path serves from.
    busy = true;
    try {
      const softRateRaw = String(softRateLimitRaw ?? "").trim();
      const softRateLimit =
        softRateRaw === ""
          ? undefined
          : normalizeSoftRateLimit(Number(softRateRaw));
      await new SettingsStore(plugin).updateSlice(
        "commandPermissions",
        (current) => ({
          ...((current as Record<string, unknown> | undefined) ?? {}),
          enabled,
          allowlist: [...allowlist],
          softRateLimit,
        }),
      );
      softRateLimitRaw =
        softRateLimit !== undefined ? String(softRateLimit) : "";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save command permissions: ${message}`);
    } finally {
      busy = false;
    }
  }

  function onEnabledChange() {
    void persist();
  }

  function onSoftRateLimitChange() {
    void persist();
  }

  function removeCommand(commandId: string) {
    const next = allowlist.filter((id) => id !== commandId);
    if (next.length === allowlist.length) return;
    allowlist = next;
    void persist();
  }

  function addCommand(commandId: string) {
    if (allowlist.includes(commandId)) return;
    allowlist = [...allowlist, commandId];
    void persist();
  }

  function toggleCommand(commandId: string) {
    if (allowedSet.has(commandId)) removeCommand(commandId);
    else addCommand(commandId);
  }

  function applyPreset(preset: PresetCategory) {
    const eligible = filterPresetAgainstRegistry(preset, commandRegistry);
    if (eligible.length === 0) {
      new Notice(
        `No '${preset.label}' commands were found in this vault's registry.`,
      );
      return;
    }
    const merged = mergeIntoAllowlist(allowlist, eligible);
    const addedCount = merged.length - allowlist.length;
    if (addedCount === 0) {
      new Notice(
        `All '${preset.label}' commands are already in the allowlist.`,
      );
      return;
    }
    allowlist = merged;
    void persist();
    new Notice(
      `Added ${addedCount} '${preset.label}' command${addedCount === 1 ? "" : "s"} to the allowlist.`,
    );
  }

  /**
   * Keyboard fast-path: Enter in the search field adds the first match
   * to the allowlist and clears the query so the user can chain
   * searches without reaching for the mouse.
   */
  async function onSearchKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const first = filteredCommands.find((c) => !allowedSet.has(c.id));
    if (!first) return;
    addCommand(first.id);
    searchQuery = "";
    await tick();
    searchInputEl?.focus();
  }

  function formatTimestamp(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
  }

  /**
   * Trigger a browser download of the audit log as CSV. Runs inside
   * Electron's renderer; the BOM prefix is for Excel-on-Windows.
   */
  function exportAuditCsv(entries: readonly CommandAuditEntry[]): void {
    const csv = auditLogToCsv(entries);
    const blob = new Blob(["﻿" + csv], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = auditLogCsvFilename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Looks up the human-readable name for a command id. Falls back to
   * the id itself if the command is no longer registered.
   */
  function commandName(id: string): string {
    return commandRegistry?.[id]?.name ?? id;
  }

  /**
   * True if a command id (or its registered name) trips the
   * destructive heuristic (`isDestructiveCommand`). Used to render a
   * warning badge next to chips, search results, and browse rows.
   * The badge is a visual nudge — it does NOT disable the checkbox or
   * the chip, in line with invariant #3 of the security boundary
   * (destructive heuristic = nudge, not gate).
   */
  function isDestructive(id: string): boolean {
    return isDestructiveCommand(id, commandRegistry?.[id]?.name);
  }

  async function copyAllowlistAsCsv() {
    const csv = formatAllowlist(allowlist);
    try {
      await navigator.clipboard.writeText(csv);
      new Notice(
        `Copied ${allowlist.length} command id${allowlist.length === 1 ? "" : "s"} to clipboard.`,
      );
    } catch {
      new Notice(`Allowlist (copy manually):\n${csv}`);
    }
  }

  /**
   * Re-snapshot the live command registry. Useful after installing or
   * uninstalling a plugin while the settings tab is open: without this
   * the chip-list still flags the new ids as stale (or fails to flag
   * removed ones) until the user closes and reopens the tab.
   */
  function refreshRegistry(): void {
    const registry = (
      plugin.app as unknown as {
        commands?: { commands?: Record<string, CommandDescriptor> };
      }
    ).commands?.commands;
    if (!registry) {
      new Notice("Could not access the Obsidian command registry.");
      return;
    }
    commandRegistry = registry;
    availableCommands = Object.values(registry)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    new Notice(
      `Refreshed registry: ${availableCommands.length} commands found.`,
    );
  }

  /**
   * Drop every stale id from the allowlist in one go. Triggered by
   * the "Remove all N stale" button. We keep the live ids in their
   * original order to avoid reshuffling chips the user did not touch.
   */
  function removeAllStale(): void {
    if (split.stale.length === 0) return;
    const removed = split.stale.length;
    allowlist = split.live;
    void persist();
    new Notice(
      `Removed ${removed} stale command id${removed === 1 ? "" : "s"} from the allowlist.`,
    );
  }

  let importBuffer = "";

  function replaceAllowlistFromImport() {
    const next = parseAllowlistCsv(importBuffer);
    allowlist = next;
    void persist();
    importBuffer = "";
    new Notice(
      `Replaced allowlist with ${next.length} command id${next.length === 1 ? "" : "s"}.`,
    );
  }
</script>

<div class="command-permissions-settings">
  <h3>Command execution</h3>
  <p class="description">
    Let the MCP agent run Obsidian commands (the entries you see in the
    command palette). This feature is <strong>off by default</strong>
    — when enabled, only commands on the allowlist below are
    authorized. Everything else is denied and logged. Changes apply
    immediately; no client restart is required.
  </p>

  <label class="toggle-row">
    <input
      type="checkbox"
      bind:checked={enabled}
      on:change={onEnabledChange}
      disabled={busy}
    />
    Enable MCP command execution
  </label>

  {#if mounted}
    <section class="allowed-section" aria-labelledby="allowed-heading">
      <h4 id="allowed-heading">
        Currently allowed
        <span class="counter">
          ({split.live.length}{split.stale.length > 0
            ? `, ${split.stale.length} stale`
            : ""})
        </span>
      </h4>
      {#if allowlist.length === 0}
        <p class="empty">
          No commands are allowed yet. Search or pick a preset below to
          add some.
        </p>
      {:else}
        <ul class="chip-list" aria-label="Allowed commands">
          {#each split.live as commandId (commandId)}
            <li
              class="chip"
              class:chip-destructive={isDestructive(commandId)}
              title={commandName(commandId)}
            >
              {#if isDestructive(commandId)}
                <span
                  class="destructive-badge"
                  title="Destructive heuristic — this command can modify or remove data. Review carefully."
                  aria-label="Destructive command"
                >⚠</span>
              {/if}
              <code>{commandId}</code>
              <button
                type="button"
                class="chip-remove"
                aria-label="Remove {commandId}"
                title="Remove {commandId}"
                on:click={() => removeCommand(commandId)}
                disabled={busy}
              >
                ×
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if split.stale.length > 0}
        <div class="stale-block">
          <div class="stale-header">
            <span class="stale-label">
              Stale ({split.stale.length})
            </span>
            <span class="stale-hint">
              not currently registered in this vault — kept in case the
              plugin is reinstalled
            </span>
            <button
              type="button"
              class="stale-remove-all"
              on:click={removeAllStale}
              disabled={busy}
            >
              Remove all {split.stale.length} stale
            </button>
          </div>
          <ul class="chip-list stale-list" aria-label="Stale allowed commands">
            {#each split.stale as commandId (commandId)}
              <li class="chip stale-chip" title="Not registered in this vault">
                <code>{commandId}</code>
                <button
                  type="button"
                  class="chip-remove"
                  aria-label="Remove stale {commandId}"
                  title="Remove {commandId}"
                  on:click={() => removeCommand(commandId)}
                  disabled={busy}
                >
                  ×
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </section>

    <section class="add-section" aria-labelledby="add-heading">
      <h4 id="add-heading">Add commands</h4>

      <input
        bind:this={searchInputEl}
        bind:value={searchQuery}
        on:keydown={onSearchKeydown}
        type="search"
        class="search"
        placeholder="Search by id or name (Enter adds first match)..."
        aria-label="Search available commands"
        disabled={busy}
      />

      <div class="presets-row" aria-label="Quick-add presets">
        <span class="presets-label">Quick start:</span>
        {#each presetPreviews as entry (entry.preset.id)}
          <button
            type="button"
            on:click={() => applyPreset(entry.preset)}
            disabled={busy || entry.availableIds.length === 0}
            title={entry.availableIds.length === 0
              ? `None of these commands exist in this vault`
              : `${entry.preset.description} — adds ${entry.availableIds.length} command${entry.availableIds.length === 1 ? "" : "s"}`}
          >
            + {entry.preset.label} ({entry.availableIds.length})
          </button>
        {/each}
      </div>

      {#if searchQuery.trim().length > 0}
        <ul class="search-results" aria-label="Search results">
          {#if filteredCommands.length === 0}
            <li class="empty-row">No commands match your search.</li>
          {:else}
            {#each filteredCommands as cmd (cmd.id)}
              <li
                class="cmd-row"
                class:allowed-row={allowedSet.has(cmd.id)}
                class:destructive-row={isDestructive(cmd.id)}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={allowedSet.has(cmd.id)}
                    on:change={() => toggleCommand(cmd.id)}
                    disabled={busy}
                    aria-label="Toggle {cmd.id}"
                  />
                  {#if isDestructive(cmd.id)}
                    <span
                      class="destructive-badge"
                      title="Destructive heuristic — this command can modify or remove data. Review carefully."
                      aria-label="Destructive command"
                    >⚠</span>
                  {/if}
                  <span class="cmd-meta">
                    <code>{cmd.id}</code>
                    <span class="cmd-name">{cmd.name}</span>
                  </span>
                </label>
              </li>
            {/each}
          {/if}
        </ul>
      {:else}
        <details class="browse-all">
          <summary>
            Browse all {availableCommands.length} commands by category
          </summary>
          <div class="browse-actions">
            <button
              type="button"
              class="refresh-registry"
              on:click={refreshRegistry}
              disabled={busy}
              title="Re-snapshot the Obsidian command registry — useful after installing or uninstalling a plugin while this tab is open."
            >
              Refresh registry
            </button>
          </div>
          {#if availableCommands.length === 0}
            <p class="empty">
              No commands were found in the Obsidian command registry.
              Try closing and reopening the settings tab.
            </p>
          {:else}
            <div class="namespace-list">
              {#each [...groupedCommands] as [namespace, cmds] (namespace)}
                <details class="namespace-group">
                  <summary>
                    <span class="namespace-label">{namespace}</span>
                    <span class="namespace-counter">
                      ({namespaceAllowedCounts.get(namespace) ?? 0} / {cmds.length})
                    </span>
                  </summary>
                  <ul class="cmd-list">
                    {#each cmds as cmd (cmd.id)}
                      <li
                        class="cmd-row"
                        class:allowed-row={allowedSet.has(cmd.id)}
                        class:destructive-row={isDestructive(cmd.id)}
                      >
                        <label>
                          <input
                            type="checkbox"
                            checked={allowedSet.has(cmd.id)}
                            on:change={() => toggleCommand(cmd.id)}
                            disabled={busy}
                            aria-label="Toggle {cmd.id}"
                          />
                          {#if isDestructive(cmd.id)}
                            <span
                              class="destructive-badge"
                              title="Destructive heuristic — this command can modify or remove data. Review carefully."
                              aria-label="Destructive command"
                            >⚠</span>
                          {/if}
                          <span class="cmd-meta">
                            <code>{cmd.id}</code>
                            <span class="cmd-name">{cmd.name}</span>
                          </span>
                        </label>
                      </li>
                    {/each}
                  </ul>
                </details>
              {/each}
            </div>
          {/if}
        </details>
      {/if}
    </section>
  {/if}

  <details class="advanced">
    <summary>Advanced</summary>
    <div class="advanced-body">
      <label class="advanced-field">
        <span class="advanced-label">
          Soft rate-limit warning threshold
          <span class="hint">
            Commands per minute before the modal shows a "you're
            invoking a lot of commands" warning. Leave blank to use
            the default ({SOFT_RATE_LIMIT_PER_MINUTE}). Range: {SOFT_RATE_LIMIT_MIN}–{SOFT_RATE_LIMIT_MAX}.
            This is informational only — the MCP server's hard limit
            of 100/min is compiled into the binary and is not
            configurable from here.
          </span>
        </span>
        <input
          type="number"
          min={SOFT_RATE_LIMIT_MIN}
          max={SOFT_RATE_LIMIT_MAX}
          step="1"
          bind:value={softRateLimitRaw}
          on:change={onSoftRateLimitChange}
          placeholder={String(SOFT_RATE_LIMIT_PER_MINUTE)}
          disabled={busy}
          aria-label="Soft rate-limit warning threshold (commands per minute)"
        />
      </label>

      <div class="advanced-field">
        <span class="advanced-label">
          Import / Export allowlist
          <span class="hint">
            For syncing the allowlist between vaults. Copy returns a
            comma-separated list of command ids. Paste &amp; replace
            overwrites the current allowlist (use with care).
          </span>
        </span>
        <div class="import-export-actions">
          <button type="button" on:click={copyAllowlistAsCsv} disabled={busy}>
            Copy as CSV
          </button>
        </div>
        <textarea
          class="import-textarea"
          bind:value={importBuffer}
          placeholder="Paste a CSV of command ids here..."
          rows="3"
          disabled={busy}
          aria-label="Allowlist import buffer"
        ></textarea>
        <div class="import-export-actions">
          <button
            type="button"
            on:click={replaceAllowlistFromImport}
            disabled={busy || importBuffer.trim().length === 0}
          >
            Paste &amp; replace allowlist
          </button>
        </div>
      </div>
    </div>
  </details>

  <details class="audit-log">
    <summary>
      Recent invocations ({recentInvocations.length} / {AUDIT_LOG_MAX_ENTRIES})
    </summary>
    {#if recentInvocations.length === 0}
      <p class="empty">
        No commands have been requested yet. When the agent calls
        <code>execute_obsidian_command</code>, each decision will be
        logged here.
      </p>
    {:else}
      <div class="audit-actions">
        <button
          type="button"
          on:click={() => exportAuditCsv(recentInvocations)}
        >
          Export CSV
        </button>
      </div>
      <ul class="audit-list">
        {#each [...recentInvocations].reverse() as entry, i (entry.timestamp + ":" + i)}
          <li class="audit-entry audit-{entry.decision}">
            <div class="audit-header">
              <code>{entry.commandId}</code>
              <span class="audit-decision">{entry.decision}</span>
              <span class="audit-time">{formatTimestamp(entry.timestamp)}</span>
            </div>
            {#if entry.reason}
              <div class="audit-reason">{entry.reason}</div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </details>
</div>

<style>
  .command-permissions-settings {
    margin-top: 2em;
  }

  .description {
    color: var(--text-muted);
    font-size: 0.9em;
    margin-bottom: 0.75em;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    gap: 0.5em;
    margin-bottom: 1em;
    cursor: pointer;
  }

  .allowed-section {
    margin: 0.5em 0 1.2em;
  }

  .allowed-section h4,
  .add-section h4 {
    margin: 0 0 0.4em;
    font-size: 0.95em;
  }

  .counter {
    color: var(--text-muted);
    font-weight: normal;
    font-size: 0.9em;
  }

  .chip-list {
    list-style: none;
    margin: 0;
    padding: 0.5em 0.6em;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35em;
    background: var(--background-secondary);
    border-radius: 4px;
    max-height: 280px;
    overflow-y: auto;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2em;
    padding: 0.15em 0.15em 0.15em 0.5em;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 999px;
    font-size: 0.85em;
  }

  .chip code {
    font-family: var(--font-monospace);
    font-size: 0.95em;
  }

  .chip-remove {
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1.1em;
    line-height: 1;
    padding: 0 0.35em;
    border-radius: 999px;
  }

  .chip-remove:hover:not(:disabled) {
    color: var(--text-error, #c04848);
    background: var(--background-modifier-hover);
  }

  .destructive-badge {
    color: var(--text-warning, #c08a3e);
    font-size: 0.95em;
    cursor: help;
    line-height: 1;
  }

  .chip-destructive {
    border-color: var(--text-warning, #c08a3e);
  }

  .destructive-row code {
    color: var(--text-warning, #c08a3e);
  }

  .stale-block {
    margin-top: 0.6em;
  }

  .stale-header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5em;
    margin-bottom: 0.3em;
    font-size: 0.85em;
  }

  .stale-label {
    font-weight: 500;
    color: var(--text-muted);
  }

  .stale-hint {
    color: var(--text-muted);
    font-size: 0.85em;
    flex: 1 1 auto;
  }

  .stale-list {
    background: transparent;
    padding: 0;
  }

  .stale-chip {
    background: transparent;
    border-style: dashed;
    opacity: 0.7;
  }

  .stale-chip code {
    font-style: italic;
  }

  .stale-remove-all {
    flex-shrink: 0;
  }

  .add-section {
    margin: 0.5em 0 1em;
  }

  .search {
    width: 100%;
    margin-bottom: 0.5em;
    font-family: var(--font-monospace);
    font-size: 0.9em;
  }

  .presets-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4em;
    margin-bottom: 0.6em;
  }

  .presets-label {
    color: var(--text-muted);
    font-size: 0.85em;
    margin-right: 0.2em;
  }

  .search-results,
  .cmd-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    max-height: 320px;
    overflow-y: auto;
  }

  .search-results {
    margin-top: 0.3em;
  }

  .cmd-row {
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .cmd-row:last-child {
    border-bottom: none;
  }

  .cmd-row label {
    display: flex;
    align-items: center;
    gap: 0.5em;
    padding: 0.3em 0.5em;
    cursor: pointer;
  }

  .cmd-meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .cmd-meta code {
    font-family: var(--font-monospace);
    font-size: 0.85em;
    word-break: break-all;
  }

  .cmd-name {
    color: var(--text-muted);
    font-size: 0.8em;
  }

  .allowed-row code {
    color: var(--text-success, #2a7d2a);
  }

  .empty-row {
    color: var(--text-muted);
    font-size: 0.85em;
    padding: 0.5em;
    text-align: center;
  }

  .browse-all {
    margin-top: 0.4em;
  }

  .browse-actions {
    display: flex;
    justify-content: flex-end;
    margin: 0.3em 0;
  }

  .namespace-list {
    margin-top: 0.3em;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    max-height: 420px;
    overflow-y: auto;
  }

  .namespace-group {
    border-bottom: 1px solid var(--background-modifier-border);
    margin: 0;
  }

  .namespace-group:last-child {
    border-bottom: none;
  }

  .namespace-group summary {
    padding: 0.4em 0.6em;
    cursor: pointer;
    font-size: 0.9em;
    background: var(--background-secondary);
  }

  .namespace-label {
    font-family: var(--font-monospace);
    font-weight: 500;
  }

  .namespace-counter {
    color: var(--text-muted);
    font-size: 0.85em;
    margin-left: 0.4em;
  }

  .namespace-group .cmd-list {
    border: none;
    border-radius: 0;
    max-height: none;
  }

  details {
    margin-top: 0.75em;
  }

  details summary {
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.9em;
  }

  .empty {
    color: var(--text-muted);
    font-size: 0.85em;
    margin-top: 0.5em;
  }

  .advanced-body {
    padding: 0.5em 0.25em 0.25em;
    display: flex;
    flex-direction: column;
    gap: 1em;
  }

  .advanced-field {
    display: flex;
    flex-direction: column;
    gap: 0.3em;
  }

  .advanced-label {
    font-size: 0.9em;
    display: flex;
    flex-direction: column;
    gap: 0.2em;
  }

  .hint {
    color: var(--text-muted);
    font-size: 0.85em;
    font-weight: normal;
  }

  .advanced-field input[type="number"] {
    width: 8em;
    font-family: var(--font-monospace);
  }

  .import-textarea {
    width: 100%;
    font-family: var(--font-monospace);
    font-size: 0.85em;
    resize: vertical;
  }

  .import-export-actions {
    display: flex;
    gap: 0.4em;
  }

  .audit-actions {
    display: flex;
    justify-content: flex-end;
    margin: 0.5em 0 0.25em 0;
  }

  .audit-list {
    list-style: none;
    margin: 0.5em 0 0 0;
    padding: 0;
    max-height: 320px;
    overflow-y: auto;
  }

  .audit-entry {
    padding: 0.4em 0.6em;
    margin-bottom: 0.3em;
    border-left: 3px solid var(--background-modifier-border);
    background: var(--background-secondary);
    border-radius: 3px;
    font-size: 0.85em;
  }

  .audit-allow {
    border-left-color: var(--text-success, #2a7d2a);
  }

  .audit-deny {
    border-left-color: var(--text-error, #c04848);
  }

  .audit-header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5em;
  }

  .audit-header code {
    font-family: var(--font-monospace);
    font-size: 0.85em;
    word-break: break-all;
  }

  .audit-decision {
    text-transform: uppercase;
    font-size: 0.75em;
    font-weight: bold;
    color: var(--text-muted);
  }

  .audit-time {
    color: var(--text-muted);
    font-size: 0.75em;
    margin-left: auto;
  }

  .audit-reason {
    margin-top: 0.25em;
    color: var(--text-muted);
    font-size: 0.8em;
  }
</style>
