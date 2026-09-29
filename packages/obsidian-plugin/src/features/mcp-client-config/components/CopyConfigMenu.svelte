<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import {
    claudeCodeAddCommand,
    claudeDesktopConfig,
    clineConfig,
    streamableHttpConfig,
    vaultServerId,
    wrapInMcpServers,
  } from "../services/generators";
  import { downloadMcpb } from "../services/mcpbDownload";

  /**
   * The client families this vault can be configured for, for ONE
   * token. Mounted by every token row in Access Control and nowhere
   * else, so adding a client family here adds it to every row at once
   * and no surface can emit a snippet without naming its token.
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
  $: serverId = vaultServerId(plugin.app.vault.getName());

  async function copyText(text: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(`${label} copied to clipboard.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Copy failed: ${msg}`);
    }
  }

  function copyJson(payload: unknown, label: string): Promise<void> {
    return copyText(JSON.stringify(payload, null, 2), `${label} config`);
  }

  function copyClaudeDesktop(): Promise<void> {
    return copyJson(
      wrapInMcpServers(claudeDesktopConfig({ url, token }), serverId),
      "Claude Desktop",
    );
  }

  // Claude Code owns `~/.claude.json`; its docs register servers through
  // the CLI, so the button copies the command rather than a JSON block
  // for a file the user is told not to hand-edit.
  function copyClaudeCode(): Promise<void> {
    return copyText(
      claudeCodeAddCommand({ url, token, pluginId: serverId }),
      "Claude Code `claude mcp add` command",
    );
  }

  function copyStreamableHttp(): Promise<void> {
    return copyJson(
      wrapInMcpServers(streamableHttpConfig({ url, token }), serverId),
      "Streamable HTTP",
    );
  }

  function copyCline(): Promise<void> {
    return copyJson(wrapInMcpServers(clineConfig({ url, token })), "Cline");
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
    aria-label="Copy the claude mcp add command for Claude Code"
  >
    Claude Code
  </button>
  <button
    type="button"
    on:click={copyStreamableHttp}
    disabled={offline}
    aria-label="Copy streamable-http config (Cursor, Continue, Windsurf, VS Code)"
  >
    Cursor / Continue / VS Code
  </button>
  <button
    type="button"
    on:click={copyCline}
    disabled={offline}
    aria-label="Copy Cline config (streamableHttp)"
  >
    Cline
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
