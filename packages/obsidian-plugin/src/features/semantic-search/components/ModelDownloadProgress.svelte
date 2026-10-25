<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { onDestroy, onMount } from "svelte";
  import type {
    ModelDownloader,
    ModelState,
  } from "../services/modelDownloader";

  export let plugin: McpToolsPlugin;

  // One row per model, so a Gemma or e5 download shows progress too,
  // not only MiniLM's.
  type Row = { label: string; downloader: ModelDownloader; state: ModelState };

  let rows: Row[] = [];
  let unsubscribes: Array<() => void> = [];

  onMount(() => {
    const downloaders = plugin.semanticSearchState?.downloaders ?? [];
    rows = downloaders.map((d) => ({ ...d, state: { kind: "idle" } }));
    unsubscribes = rows.map((row, i) =>
      row.downloader.subscribe((s) => {
        rows[i] = { ...rows[i], state: s };
      }),
    );
  });

  onDestroy(() => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  });
</script>

{#each rows as row (row.label)}
  {#if row.state.kind === "downloading"}
    <div class="model-download" role="status">
      <div class="header">
        <span>Downloading {row.label}…</span>
        <span class="pct">{Math.round(row.state.progress)}%</span>
      </div>
      <div class="bar">
        <div
          class="fill"
          style="width: {Math.max(2, Math.min(100, row.state.progress))}%"
        ></div>
      </div>
      {#if row.state.file}
        <div class="file" title={row.state.file}>{row.state.file}</div>
      {/if}
    </div>
  {:else if row.state.kind === "error"}
    <div class="model-download error" role="alert">
      <div class="header">
        <span>{row.label} download failed</span>
        <button type="button" on:click={() => row.downloader.retry()}>
          Retry
        </button>
      </div>
      <div class="message">{row.state.message}</div>
    </div>
  {/if}
{/each}

<!--
  state.kind === "idle" or "ready" → render nothing. Idle is the
  pre-download state (no UI needed); ready is the steady state
  during normal operation (also no UI needed). The progress card
  only appears while there's something to report.
-->

<style>
  .model-download {
    margin: 0.75em 0;
    padding: 0.6em 0.8em;
    border: 1px solid var(--background-modifier-border);
    border-radius: 4px;
    background: var(--background-secondary);
    font-size: 0.9em;
  }

  .model-download.error {
    border-color: var(--text-error);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.4em;
  }

  .pct {
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }

  .bar {
    width: 100%;
    height: 6px;
    background: var(--background-modifier-border);
    border-radius: 3px;
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--interactive-accent);
    transition: width 200ms linear;
  }

  .file {
    margin-top: 0.4em;
    color: var(--text-muted);
    font-family: var(--font-monospace);
    font-size: 0.85em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .message {
    color: var(--text-error);
    font-size: 0.85em;
  }

  button {
    font-size: 0.85em;
  }
</style>
