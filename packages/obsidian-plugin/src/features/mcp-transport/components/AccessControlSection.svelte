<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { onMount } from "svelte";
  import {
    setup as mcpTransportSetup,
    teardown as mcpTransportTeardown,
  } from "$/features/mcp-transport/services/setup";
  import {
    addToken,
    readTokens,
    regenerateToken,
    renameToken,
    revokeToken,
    type TokenRecord,
  } from "$/features/mcp-transport/services/tokenStore";
  import { parsePortInput } from "$/features/mcp-transport/services/portInput";
  import {
    BIND_HOST,
    MAX_TOKENS,
    MCP_PATH_PREFIX,
  } from "$/features/mcp-transport/constants";
  import { applyAutoWrite, CopyConfigMenu } from "$/features/mcp-client-config";
  import {
    readPolicy,
    type TokenPolicy,
  } from "$/features/adaptive-tool-loading/tokenPolicyStore";
  import { resolveToolScope } from "$/features/adaptive-tool-loading/resolveToolScope";
  import { globalSettingsMutex } from "$/features/command-permissions";
  import { SettingsStore } from "$/shared/settingsStore";

  export let plugin: McpToolsPlugin;
  /** The row the Tool Loading panel edits. Bound by the settings tab. */
  export let selectedTokenId = "";
  /** Bumped by that panel after every write, so these rows re-read. */
  export let policyRevision = 0;

  let tokens: TokenRecord[] = [];
  let policies: Record<string, TokenPolicy> = {};
  let toolCounts: Record<string, number> = {};
  let revealed: Record<string, boolean> = {};
  let renamingId: string | null = null;
  let renameValue = "";
  let allToolNames: string[] = [];
  let seenRevision = 0;
  let busy = false;

  let port: number = plugin.mcpTransportState?.server.port ?? 27200;

  $: url = port ? `http://${BIND_HOST}:${port}${MCP_PATH_PREFIX}` : "";

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
    const registry = plugin.mcpTransportState?.mcp.registry;
    allToolNames = registry ? registry.listAll().map((t) => t.name) : [];
    await refreshTokens();
  });

  // The Tool Loading panel writes the policies these rows display.
  $: if (policyRevision !== seenRevision) {
    seenRevision = policyRevision;
    void refreshPolicies();
  }

  async function refreshTokens(): Promise<void> {
    tokens = await readTokens(plugin);
    // A revoked row must not stay selected: the policy panel would edit
    // an entry that no longer exists.
    if (!tokens.some((t) => t.id === selectedTokenId)) {
      selectedTokenId = tokens[0]?.id ?? "";
    }
    await refreshPolicies();
    syncMirror();
  }

  async function refreshPolicies(): Promise<void> {
    const nextPolicies: Record<string, TokenPolicy> = {};
    const nextCounts: Record<string, number> = {};
    for (const token of tokens) {
      const policy = await readPolicy(plugin, token.id);
      nextPolicies[token.id] = policy;
      nextCounts[token.id] = resolveToolScope(
        token.id,
        policy,
        allToolNames,
      ).active.size;
    }
    policies = nextPolicies;
    toolCounts = nextCounts;
  }

  /**
   * The running transport keeps the first token's secret for the client
   * config UI and for auto-write. Token mutations no longer tear the
   * transport down — the server re-reads the token list from data.json
   * on every request, so a rotation takes effect on the next one — and
   * the in-memory copy is updated in place instead.
   */
  function syncMirror(): void {
    const state = plugin.mcpTransportState;
    if (state && tokens.length > 0) state.bearerToken = tokens[0].token;
  }

  function noticeFailure(action: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    new Notice(`MCP Connector: ${action} failed — ${message}`);
  }

  /**
   * Mint a token under a placeholder label and let the user name it in
   * place. Electron implements no `window.prompt`, so asking for the
   * label up front threw before the token was ever created; the inline
   * rename control below is the only working way to collect it.
   */
  async function handleAddToken(): Promise<void> {
    if (busy || tokens.length >= MAX_TOKENS) return;
    busy = true;
    try {
      const created = await addToken(plugin, "New client");
      await refreshTokens();
      selectedTokenId = created.id;
      // Open the new row straight in rename mode: the placeholder is
      // there to be replaced, and the label is cosmetic, so leaving it
      // costs nothing.
      renamingId = created.id;
      renameValue = created.label;
      new Notice(`Token "${created.label}" added.`);
    } catch (err) {
      noticeFailure("adding a token", err);
    } finally {
      busy = false;
    }
  }

  function startRename(token: TokenRecord): void {
    renamingId = token.id;
    renameValue = token.label;
  }

  async function commitRename(): Promise<void> {
    const id = renamingId;
    renamingId = null;
    if (id === null) return;
    const label = renameValue.trim();
    const current = tokens.find((t) => t.id === id);
    if (!current || label === "" || label === current.label) return;
    busy = true;
    try {
      await renameToken(plugin, id, label);
      await refreshTokens();
    } catch (err) {
      noticeFailure("renaming the token", err);
    } finally {
      busy = false;
    }
  }

  /**
   * Mint a new secret in place. The id, the label and the tool policy
   * survive, so rotating a leaked string does not mean rebuilding that
   * client's tool selection.
   */
  async function handleRegenerate(token: TokenRecord): Promise<void> {
    const confirmed = confirm(
      `Regenerate the secret for "${token.label}"? Every client and generated bundle configured with the current string stops working until you paste the new one. The token keeps its name and its tool profile.`,
    );
    if (!confirmed) return;

    busy = true;
    try {
      await regenerateToken(plugin, token.id);
      await refreshTokens();
      // If the user opted in to auto-write, sync
      // claude_desktop_config.json so Claude Desktop picks up the new
      // token without manual paste. Off by default — see autoWrite.ts.
      const autoWriteResult = await applyAutoWrite(plugin);
      new Notice(
        autoWriteResult.applied
          ? "Secret regenerated and Claude Desktop config updated."
          : "Secret regenerated. Update the client configured with this token.",
      );
    } catch (err) {
      noticeFailure("regenerating the token", err);
    } finally {
      busy = false;
    }
  }

  async function handleRevoke(token: TokenRecord): Promise<void> {
    if (tokens.length <= 1) return;
    const confirmed = confirm(
      `Revoke "${token.label}"? Every MCP client configured with it, including any .mcpb bundle generated for it, stops working. The token string is not recoverable — a client that needs access again has to be given a new token.`,
    );
    if (!confirmed) return;

    busy = true;
    try {
      await revokeToken(plugin, token.id);
      await refreshTokens();
      await applyAutoWrite(plugin);
      new Notice(`Token "${token.label}" revoked.`);
    } catch (err) {
      noticeFailure("revoking the token", err);
    } finally {
      busy = false;
    }
  }

  /**
   * Persist the fixed-port override and restart the transport so it
   * rebinds to the new port (see issue #337). Validates client-side
   * before touching data.json; an invalid entry shows a Notice and
   * changes nothing.
   *
   * On a busy configured port, setup() fails and the transport is left
   * down — no silent fallback to the range.
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
</script>

<div class="mcp-access-control">
  <h3>Access Control</h3>

  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">Tokens</div>
      <div class="setting-item-description">
        One bearer token per MCP client, each with its own tool selection.
        Select a row to edit its profile under Tool Loading. Treat every
        string as a secret.
      </div>
    </div>
    <div class="setting-item-control">
      <button
        type="button"
        on:click={handleAddToken}
        disabled={busy || tokens.length >= MAX_TOKENS}
        aria-label="Add token"
      >
        Add token
      </button>
    </div>
  </div>

  {#if tokens.length === 0}
    <p class="token-unavailable">HTTP transport not running</p>
  {:else}
    <ul class="token-list">
      {#each tokens as token (token.id)}
        <li class="token-row" class:selected={token.id === selectedTokenId}>
          <div class="token-identity">
            <input
              type="radio"
              name="selected-token"
              value={token.id}
              checked={token.id === selectedTokenId}
              on:change={() => (selectedTokenId = token.id)}
              aria-label="Edit tool loading for {token.label}"
            />
            {#if renamingId === token.id}
              <!-- svelte-ignore a11y-autofocus -->
              <input
                type="text"
                class="rename-input"
                bind:value={renameValue}
                on:blur={commitRename}
                on:keydown={(event) => {
                  if (event.key === "Enter") commitRename();
                  if (event.key === "Escape") renamingId = null;
                }}
                autofocus
                aria-label="Token label"
              />
            {:else}
              <button
                type="button"
                class="token-label"
                on:click={() => startRename(token)}
                disabled={busy}
                aria-label="Rename {token.label}"
              >
                {token.label}
              </button>
            {/if}
            <span class="token-profile">
              {policies[token.id]?.profile ?? "all"}
            </span>
            {#if allToolNames.length > 0}
              <span class="token-count">{toolCounts[token.id] ?? 0} tools</span>
            {/if}
          </div>

          <div class="token-secret">
            <input
              type={revealed[token.id] ? "text" : "password"}
              value={token.token}
              readonly
              aria-label="Bearer token for {token.label}"
              class="token-input"
            />
            <button
              type="button"
              on:click={() =>
                (revealed = { ...revealed, [token.id]: !revealed[token.id] })}
              aria-label={revealed[token.id] ? "Hide token" : "Show token"}
            >
              {revealed[token.id] ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              on:click={() => copyToClipboard(token.token)}
              aria-label="Copy token to clipboard"
            >
              Copy
            </button>
          </div>

          <div class="token-actions">
            <CopyConfigMenu
              {plugin}
              {url}
              token={token.token}
              tokenId={token.id}
            />
            <button
              type="button"
              on:click={() => void handleRegenerate(token)}
              disabled={busy}
              aria-label="Regenerate the secret for {token.label}"
            >
              Regenerate
            </button>
            <button
              type="button"
              on:click={() => void handleRevoke(token)}
              disabled={busy || tokens.length <= 1}
              aria-label="Revoke {token.label}"
              title={tokens.length <= 1
                ? "The last token cannot be revoked — the server would authenticate nobody."
                : undefined}
            >
              Revoke
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

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
        If the port is already in use, the server will not start. Saving
        restarts the server, which clears every client's non-persisted
        tool promotions.
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

  .token-list {
    list-style: none;
    padding: 0;
    margin: 0 0 1em;
    display: flex;
    flex-direction: column;
    gap: 0.5em;
  }

  .token-row {
    display: flex;
    flex-direction: column;
    gap: 0.4em;
    padding: 0.6em 0.8em;
    border-radius: 4px;
    background: var(--background-secondary);
    border: 1px solid transparent;
  }

  .token-row.selected {
    border-color: var(--interactive-accent);
  }

  .token-identity,
  .token-secret,
  .token-actions {
    display: flex;
    align-items: center;
    gap: 0.4em;
    flex-wrap: wrap;
  }

  .token-label {
    background: none;
    border: none;
    box-shadow: none;
    padding: 0;
    font-weight: 600;
    cursor: text;
    color: var(--text-normal);
  }

  .token-profile,
  .token-count {
    color: var(--text-muted);
    font-size: 0.85em;
  }

  .rename-input {
    min-width: 140px;
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
