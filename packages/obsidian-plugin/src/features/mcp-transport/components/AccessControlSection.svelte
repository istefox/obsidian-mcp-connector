<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { onMount } from "svelte";
  import {
    setup as mcpTransportSetup,
    teardown as mcpTransportTeardown,
  } from "$/features/mcp-transport/services/setup";
  import { generateToken } from "$/features/mcp-transport/services/token";
  import { parsePortInput } from "$/features/mcp-transport/services/portInput";
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

  // The configured (possibly blank) fixed-port override, read from
  // data.json on mount. Typed as `number | null` because the field is
  // an `<input type="number">` and Svelte's `bind:value` coerces such
  // inputs to `number` (or `null` when blank). `null` means "use the
  // automatic range" — see resolvePorts in services/port.ts.
  //
  // Historical note: this used to be `string` (with a `.trim()` in the
  // save handler), which throws a TypeError once Svelte hands you the
  // coerced number back. That failure escaped the try/catch and left
  // the save silently no-op. See #358 for the diagnosis; the pure
  // parsing helper lives in services/portInput.ts.
  let portInput: number | null = null;
  let portBusy = false;

  // The configured (possibly blank) server-name override, read from
  // data.json on mount. Blank means "use the computed default" — see
  // resolveServerName in services/setup.ts.
  let serverNameInput = "";
  let serverNameBusy = false;

  onMount(async () => {
    const raw = (await new SettingsStore(plugin).readSlice("mcpTransport")) as
      | { port?: number; serverName?: string }
      | undefined;
    portInput = raw?.port ?? null;
    serverNameInput = raw?.serverName ?? "";
  });

  /**
   * Persist the fixed-port override and restart the transport so it
   * rebinds to the new port (see issue #337). Validates client-side
   * before touching data.json; an invalid entry shows a Notice and
   * changes nothing.
   *
   * Mirrors handleRegenerate(): persist → teardown → setup → update
   * local/plugin state. On a busy configured port, setup() fails and
   * the transport is left down — no silent fallback to the range.
   */
  async function handleSavePort(): Promise<void> {
    portBusy = true;
    try {
      const parsed = parsePortInput(portInput);
      if (!parsed.ok) {
        new Notice(parsed.error);
        return;
      }
      const portValue = parsed.port;

      await globalSettingsMutex.run(async () => {
        const data = ((await plugin.loadData()) ?? {}) as Record<
          string,
          unknown
        >;
        const existing = (data.mcpTransport ?? {}) as Record<string, unknown>;
        await plugin.saveData({
          ...data,
          mcpTransport: { ...existing, port: portValue },
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
      portInput = portValue ?? null;
      new Notice("Fixed port saved.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`MCP Connector: failed to save port — ${message}`);
    } finally {
      portBusy = false;
    }
  }

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
      <div class="setting-item-name">Fixed port</div>
      <div class="setting-item-description">
        Pin this vault to one port so its MCP client config never drifts
        across sessions. Leave blank for the automatic 27200-27205 range.
        If the port is already in use, the server will not start.
      </div>
    </div>
    <div class="setting-item-control token-control">
      <input
        type="number"
        bind:value={portInput}
        placeholder="Automatic"
        min="1024"
        max="65535"
        aria-label="Fixed port"
        class="port-input"
      />
      <button type="button" on:click={handleSavePort} disabled={portBusy}>
        {portBusy ? "Saving…" : "Save"}
      </button>
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

  .port-input {
    flex: 1;
    min-width: 120px;
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
