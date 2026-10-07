<script lang="ts">
  // Svelte 5 component, rendered inside an Obsidian Modal at runtime (see
  // services/codexInstallModal.ts). Presentational only: it shows the
  // preview and reports what the user clicked (ADR-0028 D1, D5, D8).
  import {
    CODEX_TOKEN_ENV_VAR,
    type CodexInstallPreview,
  } from "../services/codexConfig";
  import type {
    CodexInstallDecision,
    CodexProfileOffer,
  } from "../services/codexInstallFlow";

  interface Props {
    preview: CodexInstallPreview;
    profileOffer: CodexProfileOffer;
    tokenLabel: string;
    /** Where a user-config target came from; absent for a project. */
    homeSource?: "CODEX_HOME" | "default";
    onDecision: (decision: CodexInstallDecision) => void;
  }

  let { preview, profileOffer, tokenLabel, homeSource, onDecision }: Props =
    $props();

  // Unticked by default (ADR-0028 D8)
  let switchProfile = $state(false);

  // Focus on Cancel, so Enter on open does not write a file
  let safeButton = $state<HTMLButtonElement | undefined>(undefined);
  $effect(() => {
    safeButton?.focus();
  });

  const ACTIONS: Record<CodexInstallPreview["action"], string> = {
    add: "Add a new entry",
    replace: "Replace this vault's entry, keeping its tool settings",
    migrate: "Move an earlier entry of this vault to the current name",
    unchanged: "Nothing to change, the entry is up to date",
  };

  const folder = $derived(
    preview.configPath.replace(/[\\/]config\.toml$/, ""),
  );
</script>

<div class="codex-install">
  <h2>
    {preview.scope === "project"
      ? "Install into the project's Codex config?"
      : "Install into your Codex config?"}
  </h2>

  <dl>
    <dt>File</dt>
    <dd>
      <code>{preview.configPath}</code>
      {#if preview.scope === "user"}
        ({homeSource === "CODEX_HOME"
          ? "from CODEX_HOME"
          : "default Codex home, Obsidian did not see CODEX_HOME"})
      {/if}
    </dd>
    <dt>Action</dt>
    <dd>{ACTIONS[preview.action]}</dd>
    <dt>Entry</dt>
    <dd><code>{preview.serverId}</code></dd>
    <dt>URL</dt>
    <dd><code>{preview.url}</code></dd>
    {#if preview.action === "migrate" && preview.previousServerId}
      <dt>Earlier entry</dt>
      <dd>
        <code>{preview.previousServerId}</code>
        {#if preview.previousUrl}at <code>{preview.previousUrl}</code>{/if}.
        Codex tool names change with the entry name, so update any reference
        to the old name.
      </dd>
    {:else if preview.previousUrl && preview.previousUrl !== preview.url}
      <dt>Earlier URL</dt>
      <dd><code>{preview.previousUrl}</code></dd>
    {/if}
    <dt>Token</dt>
    <dd>
      {#if preview.tokenForm === "env"}
        Read from <code>{CODEX_TOKEN_ENV_VAR}</code>, which must hold the
        {tokenLabel} token when Codex starts
      {:else}
        The {tokenLabel} token, written into the file
      {/if}
    </dd>
  </dl>

  {#if preview.action !== "unchanged"}
    <p class="note">
      {#if preview.createsDirectory}
        Creates the folder <code>{folder}</code> and the file.
      {:else if preview.createsFile}
        Creates the file.
      {:else}
        Copies the current file to a backup next to it first.
      {/if}
      {#if preview.scope === "project"}
        Codex loads a project config only for a project you have marked
        trusted. Keep backups out of version control.
      {/if}
    </p>
  {/if}

  {#if profileOffer}
    <label class="offer">
      <input type="checkbox" bind:checked={switchProfile} />
      Switch {tokenLabel} to All tools. Codex does not reload the tool list
      during a session, so tools that the Adaptive profile activates later
      stay hidden from it until it reconnects.
    </label>
  {/if}

  <div class="actions">
    <button
      type="button"
      bind:this={safeButton}
      onclick={() => onDecision({ confirmed: false, switchProfile: false })}
    >
      Cancel
    </button>
    <button
      type="button"
      class="mod-cta"
      onclick={() => onDecision({ confirmed: true, switchProfile })}
    >
      {preview.action === "unchanged" ? "Apply" : "Install"}
    </button>
  </div>
</div>

<style>
  .codex-install {
    max-width: 560px;
  }

  .codex-install h2 {
    margin-top: 0;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.3em 0.8em;
  }

  dt {
    color: var(--text-muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .note {
    color: var(--text-muted);
  }

  .offer {
    display: block;
    margin-bottom: 0.75em;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5em;
  }
</style>
