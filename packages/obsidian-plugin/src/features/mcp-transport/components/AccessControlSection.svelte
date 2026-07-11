<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { onMount } from "svelte";
  import {
    setup as mcpTransportSetup,
    teardown as mcpTransportTeardown,
  } from "$/features/mcp-transport/services/setup";
  import { generateToken } from "$/features/mcp-transport/services/token";
  import { BIND_HOST, MCP_PATH_PREFIX } from "$/features/mcp-transport/constants";
  import { applyAutoWrite } from "$/features/mcp-client-config";
  import { globalSettingsMutex } from "$/features/command-permissions";
  import { SettingsStore } from "$/shared/settingsStore";

  export let plugin: McpToolsPlugin;

  // Local reactive copy of the bearer token so the UI updates immediately
  // after regenerate without requiring a settings-tab close/reopen.
  let bearerToken: string = plugin.mcpTransportState?.bearerToken ?? "";
  let port: number = plugin.mcpTransportState?.server.port ?? 27200;

  let showToken = false;
  let busy = false;

  // The configured (possibly blank) server-name override, read from
  // data.json on mount. Blank means "use the computed default" — see
  // resolveServerName in services/setup.ts.
  let serverNameInput = "";
  let serverNameBusy = false;

  onMount(async () => {
    const raw = (await new SettingsStore(plugin).readSlice("mcpTransport")) as
      | { serverName?: string }
      | undefined;
    serverNameInput = raw?.serverName ?? "";
  });

  /**
   * Persist the server-name override and restart the transport so the
   * next MCP `initialize` handshake reports it (see issue #329).
   *
   * Mirrors handleRegenerate(): persist → teardown → setup → update
   * local/plugin state.
   */
  async function handleSaveServerName(): Promise<void> {
    serverNameBusy = true;
    try {
      const trimmed = serverNameInput.trim();
      await globalSettingsMutex.run(async () => {
        const data = ((await plugin.loadData()) ?? {}) as Record<
          string,
          unknown
        >;
        const existing = (data.mcpTransport ?? {}) as Record<string, unknown>;
        await plugin.saveData({
          ...data,
          mcpTransport: { ...existing, serverName: trimmed },
        });
      });

      if (plugin.mcpTransportState) {
        await mcpTransportTeardown(plugin.mcpTransportState);
        plugin.mcpTransportState = undefined;
      }

      const result = await mcpTransportSetup(plugin);
      if (!result.success) {
        new Notice(`MCP Connector: failed to restart — ${result.error}`);
        return;
      }

      plugin.mcpTransportState = result.state;
      bearerToken = result.state.bearerToken;
      port = result.state.server.port;
      serverNameInput = trimmed;
      new Notice("Server name saved.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`MCP Connector: failed to save server name — ${message}`);
    } finally {
      serverNameBusy = false;
    }
  }

  /**
   * Copy a string value to the clipboard and show a brief Notice.
   *
   * Args:
   *   value: The string to copy.
   */
  async function copyToClipboard(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    new Notice("Copied to clipboard.");
  }

  /**
   * Regenerate the bearer token.
   *
   * Flow:
   *   1. Confirm with the user (native dialog — no extra modal dependency).
   *   2. Generate a new token via generateToken().
   *   3. Persist to data.json under mcpTransport.bearerToken.
   *   4. Tear down the running transport and restart it with the new token.
   *   5. Update plugin.mcpTransportState and the local reactive variables so
   *      the settings UI reflects the new token immediately.
   *
   * Approach: reactive re-assign of local `bearerToken`/`port` variables
   * rather than closing/reopening the tab — no page reload needed.
   */
  async function handleRegenerate(): Promise<void> {
    const confirmed = confirm(
      "Regenerate API key? This invalidates the current token — all MCP clients will need updated config.",
    );
    if (!confirmed) return;

    busy = true;
    try {
      // 1. Generate fresh token.
      const newToken = generateToken();

      // 2. Persist: load current data, update only the mcpTransport
      //    slice. Serialized through the shared mutex so this write
      //    cannot clobber a concurrent settings write. The mutex is
      //    released BEFORE step 4 (mcpTransportSetup), which itself
      //    acquires the same mutex — keep it non-nested to avoid a
      //    deadlock.
      await globalSettingsMutex.run(async () => {
        const data = ((await plugin.loadData()) ?? {}) as Record<
          string,
          unknown
        >;
        const existing = (data.mcpTransport ?? {}) as Record<string, unknown>;
        await plugin.saveData({
          ...data,
          mcpTransport: { ...existing, bearerToken: newToken },
        });
      });

      // 3. Tear down the current transport if it is running.
      if (plugin.mcpTransportState) {
        await mcpTransportTeardown(plugin.mcpTransportState);
        plugin.mcpTransportState = undefined;
      }

      // 4. Restart with the new token (setup() reads from data.json,
      //    which we just updated, so the new token is picked up automatically).
      const result = await mcpTransportSetup(plugin);
      if (!result.success) {
        new Notice(`MCP Connector: failed to restart — ${result.error}`);
        return;
      }

      // 5. Update plugin state and local reactive variables.
      plugin.mcpTransportState = result.state;
      bearerToken = result.state.bearerToken;
      port = result.state.server.port;

      // 6. If the user has opted in to auto-write, sync
      // claude_desktop_config.json so Claude Desktop picks up the new
      // token without manual paste. Off by default — see autoWrite.ts.
      const autoWriteResult = await applyAutoWrite(plugin);
      if (autoWriteResult.applied) {
        new Notice(
          "API key regenerated and Claude Desktop config updated.",
        );
      } else {
        new Notice("API key regenerated. Update your MCP client config.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`MCP Connector: regenerate failed — ${message}`);
    } finally {
      busy = false;
    }
  }
</script>

<div class="mcp-access-control">
  <h3>Access Control</h3>

  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">API key</div>
      <div class="setting-item-description">
        Bearer token required by MCP clients. Treat as a secret.
      </div>
    </div>
    <div class="setting-item-control token-control">
      {#if bearerToken}
        <input
          type={showToken ? "text" : "password"}
          value={bearerToken}
          readonly
          aria-label="Bearer token"
          class="token-input"
        />
        <button
          type="button"
          on:click={() => (showToken = !showToken)}
          aria-label={showToken ? "Hide token" : "Show token"}
        >
          {showToken ? "Hide" : "Show"}
        </button>
        <button
          type="button"
          on:click={() => copyToClipboard(bearerToken)}
          aria-label="Copy token to clipboard"
        >
          Copy
        </button>
      {:else}
        <span class="token-unavailable">HTTP transport not running</span>
      {/if}
      <button
        type="button"
        on:click={handleRegenerate}
        disabled={busy}
        aria-label="Regenerate bearer token"
      >
        {busy ? "Regenerating…" : "Regenerate"}
      </button>
    </div>
  </div>

  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">Server port</div>
      <div class="setting-item-description">
        {#if port}
          HTTP MCP endpoint at
          <code>http://{BIND_HOST}:{port}{MCP_PATH_PREFIX}</code>
        {:else}
          HTTP transport not running — port unavailable.
        {/if}
      </div>
    </div>
  </div>

  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">Server name</div>
      <div class="setting-item-description">
        Shown as this server's identity in MCP clients that list multiple
        servers. Leave blank to use "Obsidian - &lt;vault name&gt;".
      </div>
    </div>
    <div class="setting-item-control token-control">
      <input
        type="text"
        bind:value={serverNameInput}
        placeholder="Obsidian - {plugin.app.vault.getName()}"
        aria-label="Server name"
        class="server-name-input"
      />
      <button
        type="button"
        on:click={handleSaveServerName}
        disabled={serverNameBusy}
      >
        {serverNameBusy ? "Saving…" : "Save"}
      </button>
    </div>
  </div>
</div>

<style>
  .mcp-access-control {
    margin-bottom: 1.5em;
  }

  .token-control {
    display: flex;
    align-items: center;
    gap: 0.4em;
    flex-wrap: wrap;
  }

  .token-input {
    flex: 1;
    min-width: 180px;
    font-family: var(--font-monospace);
    font-size: 0.9em;
  }

  .token-unavailable {
    color: var(--text-muted);
    font-size: 0.9em;
    font-style: italic;
  }

  .server-name-input {
    flex: 1;
    min-width: 180px;
  }

  code {
    font-family: var(--font-monospace);
    font-size: 0.9em;
  }
</style>
