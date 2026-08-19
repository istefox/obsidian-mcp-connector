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
    EXCLUDED_FOLDERS_CONSENT_VERSION,
    UNFILTERABLE_TOOL_NAMES,
    normalizeExcludedFolders,
  } from "../types";
  import { isUnderFolder, normalizeFolderEntry } from "$/shared/pathPolicy";
  import { ExcludedFoldersConsentModal } from "../services/excludedFoldersConsentModal";

  type ConsentRecord = { version: number; acceptedAt: string };
  type McpToolsSlice = {
    maxTextOutputKB?: number;
    requireWritePreconditions?: boolean;
    excludedFolders?: string[];
    excludedFoldersConsent?: ConsentRecord;
  };

  export let plugin: McpToolsPlugin;

  // `null` means "blank input" (Svelte coerces an empty number input to
  // null, not NaN) — treated as "use the default" on save, same
  // blank-means-default convention as AccessControlSection's fixed-port
  // field.
  let maxTextOutputKB: number | null = null;
  let requireWritePreconditions = DEFAULT_REQUIRE_WRITE_PRECONDITIONS;
  let busy = false;

  // --- folders hidden from MCP (ADR-0020) --------------------------------
  let excludedFolders: string[] = [];
  let consent: ConsentRecord | undefined;
  let allFolders: string[] = [];
  let draft = "";
  let draftError = "";
  let foldersBusy = false;

  // A typed entry that names no existing folder is the one failure mode
  // case-sensitive matching leaves open: it looks configured and
  // protects nothing. Marking it is part of the design, not polish, so
  // it is never removed automatically (ADR-0020 D13).
  $: folderSet = new Set(allFolders);
  $: staleFolders = excludedFolders.filter((f) => !folderSet.has(f));
  $: liveFolders = excludedFolders.filter((f) => folderSet.has(f));
  $: redundantFolders = new Set(
    excludedFolders.filter((f) =>
      excludedFolders.some((other) => other !== f && isUnderFolder(f, other)),
    ),
  );
  $: suggestions = allFolders
    .filter((f) => f.toLowerCase().includes(draft.trim().toLowerCase()))
    .filter((f) => !excludedFolders.includes(f))
    .slice(0, 500);
  $: policyActive = excludedFolders.length > 0;
  $: consentStale =
    policyActive &&
    (consent?.version ?? 0) < EXCLUDED_FOLDERS_CONSENT_VERSION;

  function applySlice(slice: McpToolsSlice | undefined): void {
    excludedFolders = normalizeExcludedFolders(slice?.excludedFolders) ?? [];
    consent = slice?.excludedFoldersConsent;
  }

  /**
   * Why the normalizer refused an entry. Checked against the raw draft
   * rather than by re-deriving the normalizer's steps, so the two cannot
   * drift into disagreeing about the same string.
   */
  function draftRejectionReason(raw: string): string {
    const segments = raw.split(/[\\/]+/).filter((s) => s !== "");
    if (segments.some((s) => s === "." || s === "..")) {
      return "A folder path cannot contain . or .. — use a path relative to the vault root, such as Journal/Therapy.";
    }
    return "The vault root cannot be hidden: that would hide everything from every client while the server keeps running. Hide specific folders instead, or turn the plugin off.";
  }

  function openConsent(mode: "gate" | "review", folder?: string) {
    const modal = new ExcludedFoldersConsentModal(plugin.app, {
      folder,
      mode,
      pluginVersion: plugin.manifest.version,
    });
    modal.open();
    return modal.waitForDecision();
  }

  async function addFolder(): Promise<void> {
    draftError = "";
    const entry = normalizeFolderEntry(draft);
    if (entry === undefined) {
      draftError = draftRejectionReason(draft);
      return;
    }
    if (excludedFolders.includes(entry)) {
      draft = "";
      return;
    }

    foldersBusy = true;
    try {
      const store = new SettingsStore(plugin);
      // Lock-free read, and the await on the human happens OUT HERE.
      // globalSettingsMutex is non-re-entrant, so awaiting a dialog
      // inside the recipe below would freeze every settings write in the
      // plugin for as long as the modal is open.
      const before = (await store.readSlice("mcpTools")) as
        | McpToolsSlice
        | undefined;
      const inert =
        normalizeExcludedFolders(before?.excludedFolders) === undefined;
      const alreadyAccepted =
        (before?.excludedFoldersConsent?.version ?? 0) >=
        EXCLUDED_FOLDERS_CONSENT_VERSION;

      let grantConsent = false;
      if (inert && !alreadyAccepted) {
        if ((await openConsent("gate", entry)) !== "accept") return;
        grantConsent = true;
      }

      const next = (await store.updateSlice("mcpTools", (current) => {
        const slice = (current ?? {}) as McpToolsSlice;
        return {
          ...slice,
          excludedFolders: normalizeExcludedFolders([
            ...(normalizeExcludedFolders(slice.excludedFolders) ?? []),
            entry,
          ]),
          // Consent and the first folder ride ONE write. Two writes let
          // a crash between them leave policy-without-consent, which is
          // the state the gate exists to prevent.
          ...(grantConsent
            ? {
                excludedFoldersConsent: {
                  version: EXCLUDED_FOLDERS_CONSENT_VERSION,
                  acceptedAt: new Date().toISOString(),
                },
              }
            : {}),
        };
      })) as McpToolsSlice;

      // Read back from the write rather than assuming: the returned
      // value is the normalized one, so the user sees the dedupe and the
      // canonical form. Optimistic assignment would show a folder as
      // hidden that a failed write never hid.
      applySlice(next);
      draft = "";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save hidden folders: ${message}`);
    } finally {
      foldersBusy = false;
    }
  }

  async function removeFolder(folder: string): Promise<void> {
    foldersBusy = true;
    try {
      const next = (await new SettingsStore(plugin).updateSlice(
        "mcpTools",
        (current) => {
          const slice = (current ?? {}) as McpToolsSlice;
          return {
            ...slice,
            excludedFolders: normalizeExcludedFolders(
              (normalizeExcludedFolders(slice.excludedFolders) ?? []).filter(
                (f) => f !== folder,
              ),
            ),
          };
        },
      )) as McpToolsSlice;
      applySlice(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save hidden folders: ${message}`);
    } finally {
      foldersBusy = false;
    }
  }

  function onDraftKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      void addFolder();
    }
  }

  onMount(async () => {
    const raw = (await new SettingsStore(plugin).readSlice("mcpTools")) as
      | McpToolsSlice
      | undefined;
    maxTextOutputKB = raw?.maxTextOutputKB ?? null;
    requireWritePreconditions =
      raw?.requireWritePreconditions ?? DEFAULT_REQUIRE_WRITE_PRECONDITIONS;
    applySlice(raw as McpToolsSlice | undefined);

    // Read once: on a large vault this is thousands of entries, and it
    // only changes when the user creates a folder.
    allFolders = (plugin.app.vault.getAllFolders?.(false) ?? [])
      .map((f) => f.path)
      .sort();
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
      // Do NOT add excludedFolders here. This recipe writes from locals
      // captured at mount, so folding the folder list in would make a
      // Save on the KB field silently revert folders added since — and
      // the spread below is what keeps them intact today.
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
      <div class="setting-item-name">Folders hidden from MCP</div>
      <div class="setting-item-description">
        No MCP tool can read, list, search or write inside these folders.
        To a connected client their contents behave as if they do not
        exist. Applies to every client and every token. Paths are matched
        exactly and are case-sensitive, and plugin versions older than
        {plugin.manifest.version} keep this list without enforcing it.
      </div>
    </div>
    <div class="setting-item-control">
      {#if consent}
        <button
          type="button"
          aria-label="Review what hiding folders means"
          on:click={() => void openConsent("review")}
        >
          Review what this means
        </button>
      {/if}
    </div>
  </div>

  <div class="excluded-folders">
    {#if excludedFolders.length === 0}
      <p class="empty">
        No folders are hidden. Every folder in this vault is reachable by
        MCP clients.
      </p>
    {:else}
      <ul class="chip-list" aria-label="Folders hidden from MCP">
        {#each liveFolders as folder (folder)}
          <li class="chip">
            <code>{folder}</code>
            {#if redundantFolders.has(folder)}
              <span class="muted">covered by a parent</span>
            {/if}
            <button
              type="button"
              class="chip-remove"
              aria-label="Stop hiding {folder}"
              disabled={foldersBusy}
              on:click={() => void removeFolder(folder)}>×</button
            >
          </li>
        {/each}
      </ul>
    {/if}

    {#if staleFolders.length > 0}
      <div class="stale-block">
        <span class="stale-label"
          >Not found in this vault ({staleFolders.length})</span
        >
        <span class="stale-hint">
          no folder with this exact path exists. Check the spelling and the
          capitalisation, or it may have been renamed. Kept as written;
          nothing is removed automatically.
        </span>
        <ul
          class="chip-list stale-list"
          aria-label="Hidden folders not found in this vault"
        >
          {#each staleFolders as folder (folder)}
            <li class="chip stale">
              <code>{folder}</code>
              <button
                type="button"
                class="chip-remove"
                aria-label="Stop hiding {folder}"
                disabled={foldersBusy}
                on:click={() => void removeFolder(folder)}>×</button
              >
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="add-row">
      <input
        type="search"
        list="mcp-excluded-folder-suggestions"
        bind:value={draft}
        on:keydown={onDraftKeydown}
        placeholder="Folder path, e.g. Journal/Therapy"
        aria-label="Add a folder to hide from MCP"
        disabled={foldersBusy}
      />
      <datalist id="mcp-excluded-folder-suggestions">
        {#each suggestions as folder (folder)}
          <option value={folder}></option>
        {/each}
      </datalist>
      <button
        type="button"
        class="mod-cta"
        disabled={foldersBusy || draft.trim() === ""}
        on:click={() => void addFolder()}
      >
        {foldersBusy ? "Saving…" : "Add"}
      </button>
    </div>

    {#if draftError}
      <div class="warning">{draftError}</div>
    {/if}

    {#if policyActive}
      <div class="warning">
        While at least one folder is hidden, these tools are disabled for
        all clients:
        {#each UNFILTERABLE_TOOL_NAMES as name, i (name)}<code>{name}</code
          >{#if i < UNFILTERABLE_TOOL_NAMES.length - 1}{", "}{/if}{/each}. They
        reach vault content by a route a path filter cannot follow. Remove
        every hidden folder to bring them back.
      </div>
    {/if}

    {#if consentStale}
      <div class="warning">
        What hiding folders means has changed since you accepted it. Your
        folders are still hidden.
        <button
          type="button"
          on:click={() => void openConsent("review")}
          aria-label="Review the current terms">Review</button
        >
      </div>
    {/if}
  </div>

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

<style>
  .excluded-folders {
    margin: 0 0 1.2em 0;
  }

  .empty {
    color: var(--text-muted);
    font-size: 0.9em;
    margin: 0.2em 0 0.6em 0;
  }

  .chip-list {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4em;
    margin: 0.2em 0 0.6em 0;
    padding: 0;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    padding: 0.2em 0.5em;
    border-radius: 4px;
    background: var(--background-secondary);
  }

  .chip.stale {
    border: 1px dashed var(--text-warning, #e1a800);
    background: transparent;
  }

  .chip code {
    font-family: var(--font-monospace);
    font-size: 0.9em;
  }

  .chip-remove {
    padding: 0 0.35em;
    line-height: 1;
  }

  .muted {
    color: var(--text-muted);
    font-size: 0.8em;
  }

  .stale-block {
    margin-bottom: 0.6em;
  }

  .stale-label {
    display: block;
    font-size: 0.85em;
    color: var(--text-warning, #e1a800);
  }

  .stale-hint {
    display: block;
    font-size: 0.8em;
    color: var(--text-muted);
    margin-bottom: 0.3em;
  }

  .add-row {
    display: flex;
    gap: 0.4em;
    align-items: center;
  }

  .add-row input {
    flex: 1;
    min-width: 12em;
  }

  .warning {
    margin-top: 0.5em;
    padding: 0.5em 0.7em;
    border-left: 3px solid var(--text-warning, #e1a800);
    background: var(--background-secondary);
    font-size: 0.9em;
  }
</style>
