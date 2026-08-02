<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import {
    claudeCodeConfig,
    claudeDesktopConfig,
    streamableHttpConfig,
    wrapInMcpServers,
  } from "../services/generators";
  import { downloadMcpb } from "../services/mcpbDownload";

  /**
   * The client families this vault can be configured for, for ONE
   * token. Mounted by ClientConfigSection for the vault's first token
   * and by every token row in Access Control for its own, so adding a
   * client family here adds it everywhere.
   *
   * The generators are pure and untouched: their output lands in
   * user-managed files outside the vault, so a change of shape would
   * silently break configs already in the wild.
   */

  export let plugin: McpToolsPlugin;
  export let url: string;
  export let token: string;
  /**
   * Baked into the .mcpb, and required whenever `showMcpb` is on — the
   * button is gated on it below, so "there is a .mcpb button" and
   * "there is an id to bake" are one condition. Optional only because
   * the sections that pass `showMcpb={false}` have no token id to give.
   */
  export let tokenId: string | undefined = undefined;
  /** Off where the surrounding section already carries its own .mcpb row. */
  export let showMcpb = true;
  export let mcpbDisabled = false;

  let mcpbBusy = false;

  $: offline = !url || !token;

  async function copyJson(payload: unknown, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      new Notice(`${label} config copied to clipboard.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Copy failed: ${msg}`);
    }
  }

  function copyClaudeDesktop(): Promise<void> {
    return copyJson(
      wrapInMcpServers(claudeDesktopConfig({ url, token })),
      "Claude Desktop",
    );
  }

  function copyClaudeCode(): Promise<void> {
    return copyJson(
      wrapInMcpServers(claudeCodeConfig({ url, token })),
      "Claude Code",
    );
  }

  function copyStreamableHttp(): Promise<void> {
    return copyJson(
      wrapInMcpServers(streamableHttpConfig({ url, token })),
      "Streamable HTTP",
    );
  }

  async function handleDownloadMcpb(): Promise<void> {
    if (mcpbBusy) return;
    mcpbBusy = true;
    try {
      // `?? ""` cannot be reached through the gated button; it makes an
      // unexpected caller get the service's refusal rather than a
      // TypeError on `.trim()`.
      new Notice(await downloadMcpb(plugin, tokenId ?? ""));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to generate .mcpb: ${msg}`);
      console.error("[mcpb] generation failed", err);
    } finally {
      mcpbBusy = false;
    }
  }
</script>

<div class="copy-config-menu">
  <button
    type="button"
    on:click={copyClaudeDesktop}
    disabled={offline}
    aria-label="Copy Claude Desktop config"
  >
    Claude Desktop
  </button>
  <button
    type="button"
    on:click={copyClaudeCode}
    disabled={offline}
    aria-label="Copy Claude Code config"
  >
    Claude Code
  </button>
  <button
    type="button"
    on:click={copyStreamableHttp}
    disabled={offline}
    aria-label="Copy streamable-http config (Cursor, Cline, Continue, VS Code)"
  >
    Cursor / Cline / Continue
  </button>
  {#if showMcpb && tokenId}
    <button
      type="button"
      on:click={handleDownloadMcpb}
      disabled={offline || mcpbDisabled || mcpbBusy}
      aria-label="Download Claude Desktop extension (.mcpb)"
    >
      {mcpbBusy ? "Generating…" : ".mcpb"}
    </button>
  {/if}
</div>

<style>
  .copy-config-menu {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4em;
  }
</style>
