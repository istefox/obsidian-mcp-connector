<script lang="ts">
  // Svelte 5 component, rendered inside an Obsidian Modal at runtime
  // (see services/excludedFoldersConsentModal.ts). Presentational only:
  // it reports what the user clicked and knows nothing about settings.
  //
  // ONE component serves both the gate and the later review, on purpose
  // (ADR-0020 D12). If the terms the user agreed to and the terms shown
  // afterwards lived in two places, they would drift, and a consent
  // dialog whose text no longer describes what you have is worse than
  // none.
  //
  // The copy names what is given up and what is NOT protected. That
  // second list is the honest half and must survive review: the person
  // reading this is deciding whether to trust the feature with material
  // they consider sensitive.

  export type ConsentDecision = "accept" | "cancel";

  interface Props {
    /** The folder being added. Absent in review mode. */
    folder?: string;
    /** "gate" asks for a decision; "review" only explains. */
    mode: "gate" | "review";
    /** Version this build ships, named in the downgrade warning. */
    pluginVersion: string;
    onDecision: (decision: ConsentDecision) => void;
  }

  let { folder, mode, pluginVersion, onDecision }: Props = $props();

  // Focus placement here is a safety decision, not styling: Enter on
  // open must not grant consent. Done programmatically rather than with
  // the `autofocus` attribute, which svelte-check rightly flags.
  let safeButton = $state<HTMLButtonElement | undefined>(undefined);
  $effect(() => {
    safeButton?.focus();
  });
</script>

<div class="folder-consent">
  {#if mode === "gate"}
    <h2>Hide folders from MCP?</h2>
    <p class="intro">
      You are about to make
      {#if folder}<code>{folder}</code>{:else}this folder{/if}
      invisible to every MCP client connected to this vault. Some of what
      follows is a trade, and some of it is a limit.
    </p>
  {:else}
    <h2>What hiding folders means</h2>
    <p class="intro">
      Folders in this vault are hidden from every MCP client. Here is what
      that does and does not do.
    </p>
  {/if}

  <h3>What you get</h3>
  <p>
    No MCP tool will read, list, search or write anything inside a hidden
    folder. To a connected client the contents behave as if they do not
    exist: a read answers <em>not found</em> rather than
    <em>forbidden</em>, and a listing simply omits them. This applies to
    every client and every token.
  </p>

  <h3>What you give up: three tools stop working</h3>
  <p>While at least one folder is hidden, these are disabled for all clients.</p>
  <ul class="tool-list">
    <li>
      <code>execute_obsidian_command</code> runs an arbitrary Obsidian
      command, which can touch any file in the vault. It takes a command
      id, not a path, so there is nothing for a path filter to inspect.
    </li>
    <li>
      <code>execute_dataview_query</code> hands the query to Dataview,
      which reads across the whole vault. Filtering the query text would
      not be a filter.
    </li>
    <li>
      <code>execute_template</code> runs a Templater template, whose
      JavaScript reaches the vault through Templater rather than through
      this plugin.
    </li>
  </ul>
  <p class="muted">
    They come back on their own if you remove every hidden folder.
  </p>

  <h3>What this does not protect you from</h3>
  <ul class="limits">
    <li>
      <strong>Your notes are not encrypted.</strong> The files stay on disk
      in plain text, and anything with access to the vault folder still
      reads them: another Obsidian plugin, a sync client, a backup, another
      program on this computer.
    </li>
    <li>
      <strong>Installing an older version of this plugin removes the
      protection.</strong>
      Versions before {pluginVersion} do not know about this setting. They keep
      the list in your settings file and do not enforce it, so hidden folders
      become readable again with no warning. If you roll back, check this setting
      afterwards.
    </li>
    <li>
      <strong>Only exact folder paths are hidden.</strong> Matching is
      literal and case-sensitive, so <code>Journal/therapy</code> does not
      hide <code>Journal/Therapy</code>. Add folders from the suggestion
      list rather than typing them, and check the settings page for any
      entry marked as not found in this vault.
    </li>
    <li>
      <strong>Content already sent stays sent.</strong> A client that read
      a note before you hid its folder still has it, in its own history and
      its own logs.
    </li>
    <li>
      <strong>Notes outside a hidden folder can still name what is inside
      it.</strong>
      A visible note containing <code>[[Therapy/2026-01-02]]</code> still contains
      that text, and a client reading that note sees the link. The file behind
      the link stays unreachable.
    </li>
  </ul>

  <p class="closing">
    This is a guardrail against an assistant wandering into the wrong
    folder. It is not a security boundary against someone who wants your
    files.
  </p>

  <div class="actions">
    {#if mode === "gate"}
      <!-- Cancel is focused: Enter on open must not grant consent. -->
      <button
        type="button"
        bind:this={safeButton}
        aria-label="Cancel, do not hide any folder"
        onclick={() => onDecision("cancel")}
      >
        Cancel
      </button>
      <button
        type="button"
        class="mod-cta"
        aria-label="Accept and hide the folder"
        onclick={() => onDecision("accept")}
      >
        I understand, hide these folders
      </button>
    {:else}
      <button
        type="button"
        class="mod-cta"
        bind:this={safeButton}
        aria-label="Close"
        onclick={() => onDecision("cancel")}
      >
        Close
      </button>
    {/if}
  </div>
</div>

<style>
  .folder-consent {
    max-width: 560px;
  }

  .folder-consent h2 {
    margin-top: 0;
    margin-bottom: 0.5em;
  }

  .folder-consent h3 {
    margin-bottom: 0.3em;
    font-size: 1em;
  }

  .intro {
    color: var(--text-muted);
    margin-bottom: 0.75em;
  }

  .tool-list,
  .limits {
    margin: 0.3em 0 0.75em 1.1em;
    padding: 0;
  }

  .tool-list li,
  .limits li {
    margin-bottom: 0.45em;
  }

  .muted {
    color: var(--text-muted);
    font-size: 0.9em;
  }

  .closing {
    padding: 0.6em 0.8em;
    border-left: 3px solid var(--text-warning, #e1a800);
    background: var(--background-secondary);
    font-style: italic;
    margin-bottom: 1em;
  }

  code {
    font-family: var(--font-monospace);
    font-size: 0.9em;
    word-break: break-all;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5em;
  }
</style>
