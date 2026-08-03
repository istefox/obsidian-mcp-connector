<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { onMount } from "svelte";
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
   * Machine-level prerequisites for the Claude Desktop bridge: is Node
   * on PATH, and is `mcp-remote` in the npm cache.
   *
   * Nothing here is per-token, which is why nothing here emits a
   * credential. The config snippets, the `.mcpb` export and the
   * `claude_desktop_config.json` sync toggle all used to live in this
   * component, bound to whichever token happened to be first; they are
   * now on the token rows in Access control, each carrying an explicit
   * token id (ADR-0014 §11).
   */

  export let plugin: McpToolsPlugin;

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

  onMount(async () => {
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

</script>

<div class="mcp-client-config">
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
    /* Holds a runtime error string, which routinely carries a filesystem
       path with no break opportunity. */
    overflow-wrap: anywhere;
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
    /* Homebrew's output is monospace and path-heavy: no spaces to wrap on. */
    overflow-wrap: anywhere;
  }
</style>
