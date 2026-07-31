<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { createEventDispatcher, onMount } from "svelte";
  import { ToolLoadingManager } from "../toolLoadingManager";
  import { readPolicy, updateTokenPolicy } from "../tokenPolicyStore";
  import type { TokenPolicy } from "../tokenPolicyStore";
  import { ALWAYS_ACTIVE_TOOLS, CORE_SET, META_TOOLS } from "../constants";

  export let plugin: McpToolsPlugin;
  /**
   * The token this panel edits — the row selected in Access Control.
   * One panel scoped to a selection rather than one panel per token:
   * the checklist below has a single implementation.
   */
  export let tokenId: string;

  // Access Control renders each token's profile and active tool count,
  // so it has to re-read them after every write here.
  const dispatch = createEventDispatcher<{ policychange: void }>();

  let profile: "all" | "core" | "adaptive" = "all";
  let promoted: string[] = [];
  let allowed: string[] | null = null;
  let busy = false;
  let mounted = false;
  let loadedTokenId = "";

  // All registered tool names, read from the live registry when the MCP
  // server is up. Empty when the server has not started yet (settings
  // opened before connect): the manual picker then shows a hint.
  let allToolNames: string[] = [];
  let selected = "";

  const mgr = new ToolLoadingManager();

  // Tools the user can usefully promote: everything except meta-tools and
  // core-set tools (always active anyway) and those already promoted.
  $: alwaysActive = new Set<string>([...META_TOOLS, ...CORE_SET]);
  $: promotable = allToolNames
    .filter((n) => !alwaysActive.has(n) && !promoted.includes(n))
    .sort((a, b) => a.localeCompare(b));
  // Meta-tools bypass the ceiling by construction, so offering them here
  // would advertise a choice the resolver ignores.
  $: limitable = allToolNames
    .filter((n) => !ALWAYS_ACTIVE_TOOLS.includes(n))
    .sort((a, b) => a.localeCompare(b));
  $: allowedSet = new Set(allowed ?? []);

  onMount(() => {
    const registry = plugin.mcpTransportState?.mcp.registry;
    allToolNames = registry ? registry.listAll().map((t) => t.name) : [];
  });

  // Follow the selection. `loadedTokenId` is set before the await so a
  // re-run triggered by the assignments below cannot loop.
  $: if (tokenId && tokenId !== loadedTokenId) void loadPolicy(tokenId);

  async function loadPolicy(id: string): Promise<void> {
    loadedTokenId = id;
    const policy = await readPolicy(plugin, id);
    profile = policy.profile;
    promoted = policy.promoted;
    allowed = policy.allowed;
    mounted = true;
  }

  /**
   * Every write goes through tokenPolicyStore, the single choke point
   * that keeps the legacy `toolLoading.profile`/`promoted` mirror in
   * step with the first token's policy.
   */
  async function savePolicy(patch: Partial<TokenPolicy>): Promise<void> {
    busy = true;
    try {
      await updateTokenPolicy(plugin, tokenId, patch);
      dispatch("policychange");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save tool loading settings: ${message}`);
    } finally {
      busy = false;
    }
  }

  function onProfileChange(value: "all" | "core" | "adaptive"): void {
    profile = value;
    void savePolicy({ profile });
  }

  async function addPromoted(name: string): Promise<void> {
    if (!name) return;
    busy = true;
    try {
      await mgr.activateTool(name, allToolNames, plugin, tokenId);
      promoted = [...promoted, name];
      selected = "";
      dispatch("policychange");
    } finally {
      busy = false;
    }
  }

  async function removePromoted(name: string): Promise<void> {
    await mgr.deactivateTool(name, plugin, tokenId);
    promoted = promoted.filter((n) => n !== name);
    dispatch("policychange");
  }

  async function resetAdaptiveData(): Promise<void> {
    await mgr.resetAll(plugin, tokenId);
    promoted = [];
    dispatch("policychange");
    new Notice("Adaptive tool data reset.");
  }

  /**
   * Off is `null` — no ceiling at all. On starts from `[]`, which is
   * legal and means "meta-tools only" until something is ticked; the
   * warning below keeps that visibly different from "no limit".
   */
  function onToggleLimit(
    event: Event & { currentTarget: HTMLInputElement },
  ): void {
    allowed = event.currentTarget.checked ? [] : null;
    void savePolicy({ allowed });
  }

  function onToggleAllowedTool(name: string, checked: boolean): void {
    const current = allowed ?? [];
    allowed = checked ? [...current, name] : current.filter((n) => n !== name);
    void savePolicy({ allowed });
  }
</script>

<div class="adaptive-tool-loading-settings">
  <h3>Tool Loading</h3>
  <p class="description">
    Control which MCP tools are loaded at connect time for the token
    selected under Access Control. "All tools" (default) loads every tool.
    "Core set" loads ~13 essential tools plus any you promote below.
    "Adaptive" is the core set plus your promotions, and also auto-promotes
    tools you use often. Other tokens are unaffected.
  </p>

  {#if !tokenId}
    <p class="muted empty-hint">
      Select a token under Access Control to edit its tool loading.
    </p>
  {/if}

  {#if mounted}
    <div class="profile-group">
      <label class="radio-row">
        <input
          type="radio"
          name="tool-loading-profile"
          value="all"
          checked={profile === "all"}
          on:change={() => onProfileChange("all")}
          disabled={busy}
        />
        <span>All tools <span class="muted">(default — loads every tool)</span></span>
      </label>
      <label class="radio-row">
        <input
          type="radio"
          name="tool-loading-profile"
          value="core"
          checked={profile === "core"}
          on:change={() => onProfileChange("core")}
          disabled={busy}
        />
        <span>Core set <span class="muted">(~13 essential tools)</span></span>
      </label>
      <label class="radio-row">
        <input
          type="radio"
          name="tool-loading-profile"
          value="adaptive"
          checked={profile === "adaptive"}
          on:change={() => onProfileChange("adaptive")}
          disabled={busy}
        />
        <span>Adaptive <span class="muted">(core + promoted tools)</span></span>
      </label>
    </div>

    {#if profile !== "all"}
      <div class="promoted-section">
        <p class="section-label">
          Promoted tools
          <span class="muted"
            >— added here, via <code>activate_tool</code>, or auto-promoted
            after {3} calls (Adaptive only). Active at connect time in both
            Core and Adaptive.</span
          >
        </p>

        {#if allToolNames.length === 0}
          <p class="muted empty-hint">
            Connect an MCP client once so the tool list is available, then
            reopen settings to add tools here.
          </p>
        {:else if promotable.length > 0}
          <div class="add-row">
            <select bind:value={selected} disabled={busy} aria-label="Tool to promote">
              <option value="" disabled selected>Add a tool…</option>
              {#each promotable as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
            <button
              type="button"
              on:click={() => void addPromoted(selected)}
              disabled={busy || !selected}
              aria-label="Add selected tool to promoted"
            >
              Add
            </button>
          </div>
        {/if}

        {#if promoted.length === 0}
          <p class="muted empty-hint">
            No promoted tools yet. Use a non-core tool 3 times in Adaptive mode
            to auto-promote it, or call <code>activate_tool</code> from chat.
          </p>
        {:else}
          <ul class="promoted-list">
            {#each promoted as name (name)}
              <li>
                <code>{name}</code>
                <button
                  type="button"
                  on:click={() => void removePromoted(name)}
                  disabled={busy}
                  aria-label="Remove {name} from promoted tools"
                >
                  Remove
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        <button
          type="button"
          class="reset-btn"
          on:click={() => void resetAdaptiveData()}
          disabled={busy}
          aria-label="Reset adaptive tool data"
        >
          Reset adaptive data
        </button>
      </div>
    {/if}

    <div class="allowlist-section">
      <label class="radio-row">
        <input
          type="checkbox"
          checked={allowed !== null}
          on:change={onToggleLimit}
          disabled={busy}
          aria-label="Limit this token to specific tools"
        />
        <span>
          Limit to specific tools
          <span class="muted"
            >— a hard ceiling for this token: anything outside the list is
            never listed, never callable, and <code>activate_tool</code> refuses
            it.</span
          >
        </span>
      </label>

      {#if allowed !== null}
        {#if allowed.length === 0}
          <p class="allowlist-warning">
            Nothing ticked: this token reaches the meta-tools only
            (<code>tool_catalog</code>, <code>activate_tool</code>,
            <code>activate_tools</code>). That is not the same as no limit —
            turn the toggle off for that.
          </p>
        {/if}

        {#if limitable.length === 0}
          <p class="muted empty-hint">
            Connect an MCP client once so the tool list is available, then
            reopen settings to choose the tools.
          </p>
        {:else}
          <ul class="allowlist">
            {#each limitable as name (name)}
              <li>
                <label class="radio-row">
                  <input
                    type="checkbox"
                    checked={allowedSet.has(name)}
                    on:change={(event) =>
                      onToggleAllowedTool(name, event.currentTarget.checked)}
                    disabled={busy}
                  />
                  <code>{name}</code>
                </label>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  {/if}

  <p class="footer-hint muted">
    Profile changes take effect on the next MCP client connection.
  </p>
</div>

<style>
  .adaptive-tool-loading-settings {
    margin-top: 2em;
  }

  .description {
    color: var(--text-muted);
    font-size: 0.9em;
    margin: 0.5em 0 0.8em;
  }

  .profile-group {
    display: flex;
    flex-direction: column;
    gap: 0.4em;
    margin-bottom: 1em;
  }

  .radio-row {
    display: flex;
    align-items: center;
    gap: 0.5em;
    cursor: pointer;
  }

  .muted {
    color: var(--text-muted);
    font-size: 0.9em;
  }

  .section-label {
    font-weight: 500;
    margin: 0 0 0.5em;
  }

  .promoted-section {
    padding: 0.6em 0.8em;
    background: var(--background-secondary);
    border-radius: 4px;
    margin-bottom: 0.8em;
  }

  .add-row {
    display: flex;
    gap: 0.5em;
    align-items: center;
    margin-bottom: 0.6em;
  }

  .add-row select {
    flex: 1;
    min-width: 0;
  }

  .promoted-list {
    list-style: none;
    padding: 0;
    margin: 0 0 0.6em;
    display: flex;
    flex-direction: column;
    gap: 0.3em;
  }

  .promoted-list li {
    display: flex;
    align-items: center;
    gap: 0.6em;
  }

  .promoted-list code {
    font-family: var(--font-monospace);
    font-size: 0.9em;
    flex: 1;
  }

  .empty-hint {
    font-size: 0.85em;
    margin: 0 0 0.5em;
  }

  .allowlist-section {
    padding: 0.6em 0.8em;
    background: var(--background-secondary);
    border-radius: 4px;
    margin-bottom: 0.8em;
  }

  .allowlist-warning {
    color: var(--text-warning, var(--text-error));
    font-size: 0.85em;
    margin: 0.4em 0;
  }

  .allowlist {
    list-style: none;
    padding: 0;
    margin: 0.5em 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.2em;
    max-height: 16em;
    overflow-y: auto;
  }

  .allowlist code {
    font-family: var(--font-monospace);
    font-size: 0.9em;
  }

  .reset-btn {
    margin-top: 0.4em;
  }

  .footer-hint {
    font-size: 0.82em;
    margin: 0.4em 0 0;
  }
</style>
