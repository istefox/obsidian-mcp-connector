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
    readEraCounters,
    readEraCountersByToken,
    type EraCounters,
    type EraCountersByToken,
  } from "$/features/mcp-transport/services/eraCounters";
  import {
    BIND_HOST,
    MAX_TOKENS,
    MCP_PATH_PREFIX,
  } from "$/features/mcp-transport/constants";
  import {
    applyAutoWrite,
    codexConfigSnippet,
    CopyConfigMenu,
    detectNode,
    disableCodexDiscovery,
    enableCodexDiscovery,
    getCodexConnection,
    inspectCodexInstall,
    installCodexConfig,
    releaseAutoWriteOwner,
    releaseCodexDiscoveryOwner,
    resolveAutoWriteOwner,
    resolveCodexDiscoveryOwner,
    setAutoWriteOwner,
    type NodeDetectResult,
  } from "$/features/mcp-client-config";
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

  /**
   * The token whose secret this vault keeps in
   * `claude_desktop_config.json`, or null if nobody's. At most one row
   * is ticked: the file holds one `mcpServers` entry, so a second owner
   * could only mean one of them silently losing.
   */
  let autoWriteOwner: string | null = null;
  let codexDiscoveryOwner: string | null = null;

  /**
   * Node presence, detected once for the whole list. A `.mcpb` runs
   * under `command: "node"`, so exporting one while Node is missing
   * produces a bundle that cannot start. `detectNode` caches at module
   * level, so one call covers every row and every re-render.
   */
  let nodeStatus: NodeDetectResult | null = null;
  $: mcpbDisabled = nodeStatus !== null && !nodeStatus.found;

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

  // How many requests each protocol era has served, as persisted at the
  // moment this pane opened. Diagnostic and read-only: the value exists so
  // the `legacy: 'reject'` trigger (ADR-0016 §8) can be observed rather
  // than guessed at, and nothing here writes it back.
  let eraCounters: EraCounters = { legacy: 0, modern: 0 };

  // The same counts split by token, which is the only level at which "which
  // protocol is in use" has an answer: the transport is stateless and the era
  // is chosen per request, so the server as a whole can be speaking both at
  // once — and in a real vault it was. Not derivable from `eraCounters` and
  // not a breakdown OF it: requests counted before this field existed, and
  // those that left with a revoked token, are in the total and in no bucket.
  let eraByToken: EraCountersByToken = {};

  /**
   * What one token's row says about the protocol it speaks. Deliberately not
   * a pair of raw numbers: the question the row exists to answer is "which
   * era", and two counters make the reader do the comparison themselves.
   */
  function eraLabel(id: string): string {
    const counts = eraByToken[id];
    if (counts === undefined) return "";
    const { legacy, modern } = counts;
    if (legacy === 0 && modern === 0) return "";
    if (modern === 0) return `2025 · ${legacy}`;
    if (legacy === 0) return `2026-07-28 · ${modern}`;
    return `2025 · ${legacy} + 2026-07-28 · ${modern}`;
  }

  onMount(async () => {
    const raw = (await new SettingsStore(plugin).readSlice("mcpTransport")) as
      | {
          port?: number;
          serverName?: string;
          eraCounters?: unknown;
          eraCountersByToken?: unknown;
        }
      | undefined;
    portInput = raw?.port ?? null;
    serverNameInput = raw?.serverName ?? "";
    eraCounters = readEraCounters(raw?.eraCounters);
    eraByToken = readEraCountersByToken(raw?.eraCountersByToken);
    const registry = plugin.mcpTransportState?.mcp.registry;
    allToolNames = registry ? registry.listAll().map((t) => t.name) : [];
    await refreshTokens();
    nodeStatus = await detectNode();
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
    // Read after the token list, never before: resolving the owner
    // validates it against that list and can rewrite it.
    autoWriteOwner = await resolveAutoWriteOwner(plugin);
    codexDiscoveryOwner = await resolveCodexDiscoveryOwner(plugin);
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
      // Sync claude_desktop_config.json only if THIS token owns it, so
      // the Notice below can never claim an update that did not happen —
      // and, more to the point, so rotating one token cannot write
      // another one's secret into a client's config. See autoWrite.ts.
      const autoWriteResult = await applyAutoWrite(plugin, token.id);
      new Notice(
        autoWriteResult.applied
          ? "Secret regenerated and Claude Desktop config updated."
          : codexDiscoveryOwner === token.id
            ? "Secret regenerated. The Codex connection will use it on the next request."
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
      // Before refreshTokens: that call re-resolves the owner, and the
      // release has to be the thing that clears it rather than a
      // validation failure that leaves the config entry behind.
      const [released, codexRelease] = await Promise.all([
        releaseAutoWriteOwner(plugin, token.id),
        releaseCodexDiscoveryOwner(
          plugin,
          token.id,
          plugin.codexDiscoveryState,
        )
          .then((released) => ({ released }))
          .catch((error) => ({
            released: false,
            error: error instanceof Error ? error.message : String(error),
          })),
      ]);
      if (codexRelease.released) plugin.codexDiscoveryState = undefined;
      await refreshTokens();
      const cleanupError =
        released.error ??
        ("error" in codexRelease ? codexRelease.error : undefined);
      if (cleanupError) {
        new Notice(
          `Token "${token.label}" revoked, but a managed client entry could not be removed: ${cleanupError}`,
        );
      } else {
        new Notice(
          released.released || codexRelease.released
            ? `Token "${token.label}" revoked and removed from managed client access.`
            : `Token "${token.label}" revoked.`,
        );
      }
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
   * Hand `claude_desktop_config.json` to this token, or release it.
   *
   * Ticking a row takes ownership from whichever row held it — the file
   * has one entry for this vault, so ownership is exclusive by
   * construction — and immediately writes it, matching "I turned it on,
   * so it should be in sync now". Unticking stops future syncs but does
   * not undo the write already on disk; the client keeps working until
   * the user changes it, which is the conservative half of touching a
   * file outside the vault.
   */
  async function handleToggleAutoWrite(
    token: TokenRecord,
    checked: boolean,
  ): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await setAutoWriteOwner(plugin, checked ? token.id : null);
      autoWriteOwner = checked ? token.id : null;
      if (!checked) {
        new Notice("Claude Desktop config sync disabled.");
        return;
      }
      const result = await applyAutoWrite(plugin, token.id);
      if (result.applied) {
        new Notice(`claude_desktop_config.json now uses "${token.label}".`);
      } else if (result.reason === "transport-offline") {
        new Notice("Sync enabled, but the MCP transport is not running yet.");
      } else if (result.reason === "error") {
        new Notice(`Sync enabled, but the write failed: ${result.error}`);
      } else {
        new Notice("Sync enabled.");
      }
    } catch (err) {
      noticeFailure("changing the Claude Desktop sync", err);
      // Re-read rather than assume the flip landed.
      autoWriteOwner = await resolveAutoWriteOwner(plugin);
    } finally {
      busy = false;
    }
  }

  async function handleToggleCodexDiscovery(
    token: TokenRecord,
    checked: boolean,
  ): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (!checked) {
        await disableCodexDiscovery(plugin, plugin.codexDiscoveryState);
        plugin.codexDiscoveryState = undefined;
        codexDiscoveryOwner = null;
        new Notice("Codex connection disabled. The installed config entry was left unchanged.");
        return;
      }

      await plugin.codexDiscoveryState?.stop();
      plugin.codexDiscoveryState = await enableCodexDiscovery(plugin, token.id);
      codexDiscoveryOwner = token.id;
      new Notice(`The Codex connection now uses "${token.label}". Install or copy the config once.`);
    } catch (err) {
      noticeFailure("changing the Codex connection", err);
      codexDiscoveryOwner = await resolveCodexDiscoveryOwner(plugin);
    } finally {
      busy = false;
    }
  }

  async function connectionSnippet(): Promise<string> {
    const connection = await getCodexConnection(plugin);
    if (!connection)
      throw new Error("Enable the Codex connection for this vault first.");
    return codexConfigSnippet(connection);
  }

  async function handleCopyCodexConfig(): Promise<void> {
    try {
      await copyToClipboard(await connectionSnippet());
    } catch (err) {
      noticeFailure("copying the Codex config", err);
    }
  }

  async function handleInstallCodexConfig(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const connection = await getCodexConnection(plugin);
      if (!connection)
        throw new Error("Enable the Codex connection for this vault first.");
      const preview = await inspectCodexInstall(connection);
      if (preview.action === "unchanged") {
        new Notice(`Codex config is already installed at ${preview.configPath}.`);
        return;
      }
      const action = preview.action === "add" ? "Add" : "Replace";
      const confirmed = confirm(
        `Install Codex MCP entry?\n\nTarget: ${preview.configPath}\nAction: ${action} [mcp_servers.${preview.serverId}]${preview.action === "replace" ? " and its transport-specific nested tables" : ""}\n\nA timestamped backup will be created before an existing file is changed.`,
      );
      if (!confirmed) return;
      const result = await installCodexConfig(connection, {
        expectedRevision: preview.revision,
      });
      new Notice(
        `${result.action === "add" ? "Added" : "Replaced"} the Codex MCP entry. Restart Codex once.`,
      );
    } catch (err) {
      noticeFailure("installing the Codex config", err);
    } finally {
      busy = false;
    }
  }

  /**
   * Copy a string value to the clipboard and show a brief Notice.
   *
   * Args:
   *   value: The string to copy.
   */
  async function copyToClipboard(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      new Notice("Copied to clipboard.");
    } catch (err) {
      // Silence here is worse than usual: the user walks away believing
      // the secret is on the clipboard. Same shape as CopyConfigMenu's
      // copyJson.
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Copy failed: ${message}`);
    }
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
            <!-- Absent until this client has actually been served: a row
                 reading "2025 · 0" on a token nothing has ever used says
                 something false about which protocol it speaks. -->
            {#if eraLabel(token.id) !== ""}
              <span
                class="token-era"
                title="Requests this client has been served, by protocol era, as of when this pane opened"
              >
                {eraLabel(token.id)}
              </span>
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
              {mcpbDisabled}
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

          <label class="token-autowrite">
            <input
              type="checkbox"
              checked={autoWriteOwner === token.id}
              disabled={busy}
              on:change={(event) =>
                void handleToggleAutoWrite(token, event.currentTarget.checked)}
            />
            Keep <code>claude_desktop_config.json</code> in sync with this
            token
          </label>
          <label class="token-autowrite">
            <input
              type="checkbox"
              checked={codexDiscoveryOwner === token.id}
              disabled={busy || mcpbDisabled}
              on:change={(event) =>
                void handleToggleCodexDiscovery(
                  token,
                  event.currentTarget.checked,
                )}
            />
            Enable Codex connection for this vault
          </label>
          {#if codexDiscoveryOwner === token.id}
            <div class="token-actions">
              <button
                type="button"
                on:click={() => void handleCopyCodexConfig()}
                disabled={busy}
              >
                Copy Codex config
              </button>
              <button
                type="button"
                on:click={() => void handleInstallCodexConfig()}
                disabled={busy}
              >
                Install Codex config…
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    {#if mcpbDisabled}
      <p class="token-hint">
        Node.js was not found on PATH, so <strong>.mcpb</strong> export and
        the Codex connection is disabled — both run under <code>node</code>. See
        <em>Claude Desktop integration</em> below to install it.
      </p>
    {/if}
    <p class="token-hint">
      Codex connects through the shared local broker using the selected token
      and this vault's current port. This checkbox does not edit
      <code>config.toml</code>. Use one of the configuration actions after
      enabling it.
    </p>
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
      <div class="setting-item-name">Requests served</div>
      <!-- The non-breaking spaces keep each era's label glued to its own
           number, and the separator glued to the count before it, so a
           narrow pane or a five-digit count cannot wrap a bare number or a
           lone `·` onto a line of its own. The single ordinary space
           between the two groups is the one break point left, which is
           also the only one that reads correctly. -->
      <div class="setting-item-description">
        2025&nbsp;era&nbsp;{eraCounters.legacy}&nbsp;· 2026-07-28&nbsp;era&nbsp;{eraCounters.modern}.
        Read when this pane opened, so requests still batched in memory are
        not counted yet.
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
    /* The label is user-typed and can be one long unbroken string. A flex
       item defaults to min-width:auto, i.e. its content width, so without
       these it pushes the row past the settings pane instead of wrapping. */
    min-width: 0;
    overflow-wrap: anywhere;
    text-align: left;
  }

  .token-profile,
  .token-count,
  .token-era {
    color: var(--text-muted);
    font-size: 0.85em;
  }

  /* The era label is the one span here that can hold a long string (both
     eras plus two counts), and it sits in a settings pane that is narrow on
     a split view. Let it wrap as a unit rather than push the row wider. */
  .token-era {
    white-space: nowrap;
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

  .token-autowrite {
    display: flex;
    align-items: center;
    gap: 0.4em;
    flex-wrap: wrap;
    color: var(--text-muted);
    font-size: 0.85em;
    cursor: pointer;
  }

  .token-autowrite input {
    /* Flex would otherwise stretch the box to the row's height. */
    flex: none;
  }

  .token-hint {
    color: var(--text-muted);
    font-size: 0.85em;
    margin: 0 0 1em;
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
