<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { FileSystemAdapter, Notice } from "obsidian";
  import { onMount } from "svelte";
  import { BIND_HOST, MCP_PATH_PREFIX } from "$/features/mcp-transport/constants";
  import {
    claudeCodeConfig,
    claudeDesktopConfig,
    streamableHttpConfig,
    wrapInMcpServers,
  } from "../services/generators";
  import { generateMcpb } from "../services/mcpbGenerator";
  import {
    getAutoWriteEnabled,
    setAutoWriteEnabled,
    applyAutoWrite,
  } from "../services/autoWrite";
  import {
    detectBrew,
    detectNode,
    installNodeViaBrew,
    type BrewDetectResult,
    type NodeDetectResult,
  } from "../services/nodeDetect";
  import {
    getPreWarmCache,
    preWarm,
    type PreWarmCacheEntry,
  } from "../services/preWarm";

  /**
   * Settings UI for MCP client configuration.
   *
   * Three "Copy config" buttons emit ready-to-paste JSON for each
   * supported client family (design D6). An opt-in "Auto-write Claude
   * Desktop config" toggle, default OFF, lets the plugin keep
   * `claude_desktop_config.json` in sync on token rotation or port
   * change without manual paste — see `services/autoWrite.ts`.
   *
   * The bearer token + port come from the live `McpTransportState` on
   * the plugin. If the transport is not running (setup failed earlier
   * in plugin load) the buttons are disabled with a hint.
   */

  export let plugin: McpToolsPlugin;

  let token = "";
  let port = 0;
  let url = "";
  let autoWrite = false;
  let busy = false;
  let mcpbBusy = false;

  // Claude Desktop integration (T9 + T10): Node.js presence + mcp-remote
  // pre-warm. Both are read-only/idempotent UX hints driven from the
  // services in this module. Homebrew is detected on macOS so we can
  // offer a one-click `brew install node` if Node is missing.
  let nodeStatus: NodeDetectResult | null = null;
  let nodeBusy = false;
  let brewStatus: BrewDetectResult | null = null;
  let brewInstallBusy = false;
  let brewInstallStatus: string | null = null;
  let preWarmEntry: PreWarmCacheEntry | null = null;
  let preWarmBusy = false;
  let preWarmError: string | null = null;

  const NODEJS_DOWNLOAD_URL = "https://nodejs.org/en/download/";

  $: {
    token = plugin.mcpTransportState?.bearerToken ?? "";
    port = plugin.mcpTransportState?.server.port ?? 0;
    url = port ? `http://${BIND_HOST}:${port}${MCP_PATH_PREFIX}` : "";
  }

  onMount(async () => {
    autoWrite = await getAutoWriteEnabled(plugin);
    nodeStatus = await detectNode();
    preWarmEntry = await getPreWarmCache(plugin);
    // Detect Homebrew lazily — only after we know Node is missing,
    // since the brew offer is meaningless if Node is already detected.
    if (nodeStatus && !nodeStatus.found) {
      brewStatus = await detectBrew();
    }
  });

  async function handleVerifyNode(): Promise<void> {
    if (nodeBusy) return;
    nodeBusy = true;
    try {
      nodeStatus = await detectNode({ forceRefresh: true });
      // Re-evaluate brew offer based on the refreshed state.
      if (nodeStatus && !nodeStatus.found && brewStatus === null) {
        brewStatus = await detectBrew();
      }
    } finally {
      nodeBusy = false;
    }
  }

  function handleOpenNodeDownload(): void {
    window.open(NODEJS_DOWNLOAD_URL, "_blank");
  }

  async function handleInstallNodeViaBrew(): Promise<void> {
    if (brewInstallBusy) return;
    brewInstallBusy = true;
    brewInstallStatus = "Starting Homebrew install…";
    try {
      const result = await installNodeViaBrew({
        onLine: (line) => {
          // brew is verbose — keep just the latest meaningful line so
          // the UI does not turn into a tail -f. Truncate long lines.
          brewInstallStatusFromLine(line);
        },
      });
      if (result.ok) {
        brewInstallStatus = `Node ${result.version} installed.`;
        nodeStatus = { found: true, version: result.version, raw: `v${result.version}` };
        new Notice(`Node.js ${result.version} installed via Homebrew.`);
      } else {
        brewInstallStatus = `Failed: ${result.error}`;
        new Notice(`Homebrew install failed: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      brewInstallStatus = `Failed: ${msg}`;
      new Notice(`Homebrew install failed: ${msg}`);
    } finally {
      brewInstallBusy = false;
    }
  }

  function brewInstallStatusFromLine(line: string): void {
    // Trim arrow / progress prefixes brew emits.
    const cleaned = line.replace(/^==> /, "").trim();
    if (cleaned.length === 0) return;
    brewInstallStatus = cleaned.length > 80 ? cleaned.slice(0, 77) + "…" : cleaned;
  }

  async function handlePreWarm(): Promise<void> {
    if (preWarmBusy) return;
    preWarmBusy = true;
    preWarmError = null;
    try {
      const r = await preWarm(plugin);
      if (r.ok) {
        preWarmEntry = r.entry;
        new Notice("mcp-remote pre-warmed.");
      } else {
        preWarmError = r.error;
        new Notice(`Pre-warm failed: ${r.error}`);
      }
    } finally {
      preWarmBusy = false;
    }
  }

  function formatTimestamp(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  async function handleDownloadMcpb(): Promise<void> {
    if (mcpbBusy) return;
    mcpbBusy = true;
    try {
      const adapter = plugin.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) {
        new Notice(
          "Download .mcpb requires a desktop vault (FileSystemAdapter).",
        );
        return;
      }
      const bytes = generateMcpb({
        version: plugin.manifest.version,
        vaultPath: adapter.getBasePath(),
      });
      const filename = "obsidian-mcp-connector.mcpb";

      // Detect Electron remote (desktop only). If unavailable, fall back to vault.
      const electronRemote = (() => {
        try {
          const r = (require("electron") as { remote?: { dialog: Electron.Dialog } }).remote;
          return r?.dialog ? r : null;
        } catch {
          return null;
        }
      })();

      if (electronRemote) {
        const { filePath } = await electronRemote.dialog.showSaveDialog({
          defaultPath: filename,
          filters: [{ name: "Claude Desktop Extension", extensions: ["mcpb"] }],
        });
        if (!filePath) {
          new Notice("Save cancelled.");
          return;
        }
        // require() is reliable for Node built-ins in Electron; dynamic import() is not.
        const { writeFile } = require("fs/promises") as typeof import("fs/promises");
        await writeFile(filePath, Buffer.from(bytes));
        new Notice(`${filename} saved.`);
      } else {
        // Vault fallback when Electron remote is unavailable (mobile / unusual env).
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        await plugin.app.vault.adapter.writeBinary(filename, ab as ArrayBuffer);
        new Notice(`Saved to vault root: ${filename}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to generate .mcpb: ${msg}`);
      console.error("[mcpb] generation failed", err);
    } finally {
      mcpbBusy = false;
    }
  }

  /**
   * Copy a JSON-serialized object to the clipboard. We pretty-print
   * with 2-space indent so the user can paste straight into a config
   * file and review the structure.
   */
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

  /**
   * Persist the toggle and, when flipping to ON, run a one-shot
   * sync so the user immediately sees their config rewritten —
   * matching the mental model "I turned it on, it should be in sync now."
   * Disabling the toggle does not undo prior writes.
   */
  async function onToggleAutoWrite(
    event: Event & { currentTarget: HTMLInputElement },
  ): Promise<void> {
    if (busy) return;
    const desired = event.currentTarget.checked;
    busy = true;
    try {
      await setAutoWriteEnabled(plugin, desired);
      autoWrite = desired;
      if (desired) {
        const r = await applyAutoWrite(plugin);
        if (r.applied) {
          new Notice("Claude Desktop config rewritten.");
        } else if (r.applied === false && r.reason === "transport-offline") {
          new Notice(
            "Auto-write enabled, but the MCP transport is not running yet.",
          );
        } else if (r.applied === false && r.reason === "error") {
          new Notice(`Auto-write enabled, but write failed: ${r.error}`);
        }
      } else {
        new Notice("Auto-write disabled.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Toggle failed: ${msg}`);
      // Revert the visual state to the persisted value.
      autoWrite = await getAutoWriteEnabled(plugin);
    } finally {
      busy = false;
    }
  }
</script>

<div class="mcp-client-config">
  <h3>Quick setup for clients</h3>

  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">Copy config snippets</div>
      <div class="setting-item-description">
        Each button copies a ready-to-paste JSON block for the
        corresponding MCP client. Paste into the client's config file
        under <code>mcpServers</code>.
      </div>
    </div>
    <div class="setting-item-control copy-buttons">
      <button
        type="button"
        on:click={copyClaudeDesktop}
        disabled={!token || !port}
        aria-label="Copy Claude Desktop config"
      >
        Claude Desktop
      </button>
      <button
        type="button"
        on:click={copyClaudeCode}
        disabled={!token || !port}
        aria-label="Copy Claude Code config"
      >
        Claude Code
      </button>
      <button
        type="button"
        on:click={copyStreamableHttp}
        disabled={!token || !port}
        aria-label="Copy streamable-http config (Cursor, Cline, Continue, VS Code)"
      >
        Cursor / Cline / Continue
      </button>
    </div>
  </div>

  <div class="setting-item mcpb-row">
    <div class="setting-item-info">
      <div class="setting-item-name">Claude Desktop extension</div>
      <div class="setting-item-description">
        Drag the downloaded file onto Claude Desktop — no paste needed. It
        resolves the current port and token from this vault at connect time,
        so it keeps working even after a token rotation or a port change.
        Node.js must be on your PATH (see below).
      </div>
    </div>
    <div class="setting-item-control">
      <button
        type="button"
        on:click={handleDownloadMcpb}
        disabled={!token ||
          !port ||
          (nodeStatus !== null && !nodeStatus.found) ||
          mcpbBusy}
        aria-label="Download Claude Desktop extension (.mcpb)"
      >
        {mcpbBusy ? "Generating…" : "Download .mcpb"}
      </button>
    </div>
  </div>

  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">Auto-write Claude Desktop config</div>
      <div class="setting-item-description">
        When enabled, the plugin rewrites
        <code>claude_desktop_config.json</code>
        whenever the bearer token rotates or the port changes. A
        backup is saved alongside the file as
        <code>.backup</code>. Off by default — turning it on touches
        a user-managed file outside the vault.
      </div>
    </div>
    <div class="setting-item-control">
      <input
        type="checkbox"
        checked={autoWrite}
        disabled={busy}
        on:change={onToggleAutoWrite}
        aria-label="Auto-write Claude Desktop config"
      />
    </div>
  </div>

  {#if !token || !port}
    <p class="hint">
      MCP transport is not running. Copy buttons are disabled until the
      HTTP server is up.
    </p>
  {/if}

  <h3>Claude Desktop integration</h3>
  <p class="lead">
    Claude Desktop reaches the in-process MCP server through the
    <code>mcp-remote</code>
    bridge, which requires Node.js on PATH. Other clients (Claude
    Code, Cursor, Cline, Continue) speak HTTP MCP natively and do
    NOT need either of these.
  </p>

  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">Node.js</div>
      <div class="setting-item-description">
        {#if nodeStatus === null}
          Checking…
        {:else if nodeStatus.found}
          <span class="status-ok">Detected v{nodeStatus.version}</span>
        {:else}
          <span class="status-fail">{nodeStatus.error}</span>
          <p class="hint">
            <strong>Note for fnm / nvm / asdf users:</strong>
            Obsidian inherits PATH from <code>launchctl</code> and does
            not see version-manager-shimmed Node binaries. Install Node
            globally (Homebrew on macOS, system installer otherwise) so
            Obsidian and Claude Desktop can both find it.
          </p>
        {/if}
      </div>
    </div>
    <div class="setting-item-control">
      <button
        type="button"
        on:click={handleVerifyNode}
        disabled={nodeBusy}
        aria-label="Verify Node.js installation"
      >
        {nodeBusy ? "Checking…" : "Verify again"}
      </button>
    </div>
  </div>

  {#if nodeStatus !== null && !nodeStatus.found}
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">Install Node.js</div>
        <div class="setting-item-description">
          {#if brewStatus?.found}
            Homebrew detected (v{brewStatus.version}). Click below to
            install Node.js with one command. No sudo needed.
          {:else}
            Open the Node.js download page and run the installer for
            your platform.
          {/if}
          {#if brewInstallStatus}
            <p class="brew-status">{brewInstallStatus}</p>
          {/if}
        </div>
      </div>
      <div class="setting-item-control install-buttons">
        <button
          type="button"
          on:click={handleOpenNodeDownload}
          aria-label="Open Node.js download page"
        >
          Open download page
        </button>
        {#if brewStatus?.found}
          <button
            type="button"
            on:click={handleInstallNodeViaBrew}
            disabled={brewInstallBusy}
            aria-label="Install Node.js via Homebrew"
          >
            {brewInstallBusy ? "Installing…" : "Install via Homebrew"}
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="setting-item">
    <div class="setting-item-info">
      <div class="setting-item-name">mcp-remote (npm cache)</div>
      <div class="setting-item-description">
        {#if preWarmEntry}
          Cached
          {#if preWarmEntry.version}
            (v{preWarmEntry.version})
          {/if}
          on {formatTimestamp(preWarmEntry.lastWarmedAt)}.
        {:else}
          Not cached. The first Claude Desktop launch will pause for
          20-60s while npx downloads the package (~5 MB).
        {/if}
        {#if preWarmError}
          <span class="status-fail"> — {preWarmError}</span>
        {/if}
      </div>
    </div>
    <div class="setting-item-control">
      <button
        type="button"
        on:click={handlePreWarm}
        disabled={preWarmBusy ||
          (nodeStatus !== null && !nodeStatus.found)}
        aria-label="Pre-warm mcp-remote"
      >
        {preWarmBusy ? "Pre-warming…" : "Pre-warm now"}
      </button>
    </div>
  </div>
</div>

<style>
  .mcp-client-config {
    margin-bottom: 1.5em;
  }

  .copy-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4em;
  }

  .hint {
    color: var(--text-muted);
    font-size: 0.85em;
    margin-top: 0.4em;
  }

  code {
    font-family: var(--font-monospace);
    font-size: 0.9em;
  }

  .lead {
    color: var(--text-normal);
    margin: 0.5em 0 1em;
  }

  .status-ok {
    color: var(--text-success);
    font-weight: 600;
  }

  .status-fail {
    color: var(--text-error);
  }

  .install-buttons {
    display: flex;
    gap: 0.4em;
    flex-wrap: wrap;
  }

  .brew-status {
    margin: 0.4em 0 0;
    padding: 0.3em 0.5em;
    border-radius: 3px;
    background: var(--background-secondary);
    font-family: var(--font-monospace);
    font-size: 0.8em;
    color: var(--text-muted);
  }
</style>
