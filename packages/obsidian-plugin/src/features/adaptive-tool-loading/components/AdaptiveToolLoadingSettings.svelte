<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice } from "obsidian";
  import { createEventDispatcher, onMount } from "svelte";
  import { ToolLoadingManager } from "../toolLoadingManager";
  import {
    readEverCalled,
    readEverCalledSince,
    readPolicy,
    readTokenMeta,
    updateTokenPolicy,
  } from "../tokenPolicyStore";
  import type { TokenPolicy } from "../tokenPolicyStore";
  import {
    ALWAYS_ACTIVE_TOOLS,
    CORE_SET,
    META_TOOLS,
    MIGRATION_OBSERVATION_DAYS,
  } from "../constants";
  import { migrationEligibility } from "../services/migrationEligibility";
  import type { MigrationEligibility } from "../services/migrationEligibility";
  import { migrationViewState } from "../services/migrationViewState";
  import { planMigration } from "../services/planMigration";
  import {
    migrateTokenToAdaptive,
    revertTokenToAll,
  } from "../services/migrateToken";

  /** So the deactivation Notice stays on screen long enough to read (R-06). */
  const MIGRATION_NOTICE_DURATION_MS = 15000;

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
  // Same registry snapshot, filtered to what the registry actually
  // serves (ADR-0025 D8) — the `allNames` the migration preview and the
  // migration itself must use, so a user-disabled tool is never listed
  // as something the migration deactivates (it is already off).
  let servedToolNames: string[] = [];
  let selected = "";

  // Task 7 migration state: everCalled/label feed the preview and the
  // Notice, eligibility feeds the countdown (ADR-0025 D3, D8).
  let everCalled: string[] = [];
  let tokenLabel = "";
  let eligibility: MigrationEligibility = {
    eligible: false,
    daysRemaining: MIGRATION_OBSERVATION_DAYS,
  };
  $: viewState = migrationViewState(eligibility, profile);

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
    const all = registry ? registry.listAll() : [];
    allToolNames = all.map((t) => t.name);
    servedToolNames = all.filter((t) => t.enabled).map((t) => t.name);
  });

  // Follow the selection. `loadedTokenId` is set before the await so a
  // re-run triggered by the assignments below cannot loop.
  $: if (tokenId && tokenId !== loadedTokenId) void loadPolicy(tokenId);

  async function loadPolicy(id: string): Promise<void> {
    loadedTokenId = id;
    try {
      const [policy, calls, meta, everCalledSince] = await Promise.all([
        readPolicy(plugin, id),
        readEverCalled(plugin, id),
        readTokenMeta(plugin, id),
        readEverCalledSince(plugin),
      ]);
      profile = policy.profile;
      promoted = policy.promoted;
      allowed = policy.allowed;
      everCalled = calls;
      tokenLabel = meta?.label ?? id;
      eligibility = migrationEligibility(
        Date.now(),
        everCalledSince,
        meta?.createdAt ?? 0,
      );
      mounted = true;
    } catch (err) {
      // Without this the read rejects into a fire-and-forget `void` call
      // and the panel just stays on its empty state, with nothing said.
      // `loadedTokenId` deliberately stays set: clearing it here would
      // re-satisfy the reactive guard above and spin a failing read.
      // Selecting another token and coming back retries.
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to read tool loading settings: ${message}`);
    }
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

  /**
   * Flipping the migration toggle on. Confirms with the exact
   * `deactivated` list from {@link planMigration} BEFORE any write
   * (ADR-0025 D11), then migrates and announces the outcome. Not
   * optimistic like {@link onProfileChange}: the Notice reports what
   * actually happened, so `profile`/`promoted` only move after the
   * write lands, and the checkbox is reset by hand on cancel or
   * failure — a plain `checked={...}` binding does not revert itself.
   */
  async function confirmAndMigrate(checkbox: HTMLInputElement): Promise<void> {
    const currentPolicy: TokenPolicy = { profile, promoted, allowed };
    const plan = planMigration(servedToolNames, currentPolicy, everCalled);
    const list =
      plan.deactivated.length > 0 ? plan.deactivated.join(", ") : "none";
    const confirmed = confirm(
      `Switch "${tokenLabel}" to Adaptive? Tools this client has never called would deactivate until you call activate_tool or promote them again: ${list}.`,
    );
    if (!confirmed) {
      checkbox.checked = false;
      return;
    }

    busy = true;
    try {
      const deactivated = await migrateTokenToAdaptive(
        plugin,
        tokenId,
        servedToolNames,
      );
      await loadPolicy(tokenId);
      new Notice(
        `"${tokenLabel}" switched to Adaptive. ${deactivated.length} tool${
          deactivated.length === 1 ? "" : "s"
        } deactivated — call activate_tool from chat, or add it back under Promoted tools, to bring one back.`,
        MIGRATION_NOTICE_DURATION_MS,
      );
      plugin.mcpTransportState?.mcp.notifyToolsChanged?.();
      dispatch("policychange");
    } catch (err) {
      checkbox.checked = false;
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save tool loading settings: ${message}`);
    } finally {
      busy = false;
    }
  }

  /**
   * Flipping the migration toggle off. A widening needs no confirmation
   * (ADR-0025 D7): revert immediately. No Notice and no
   * `notifyToolsChanged` — R-06/R-07 are about announcing a migration,
   * not a revert.
   */
  async function revertAdaptive(checkbox: HTMLInputElement): Promise<void> {
    busy = true;
    try {
      await revertTokenToAll(plugin, tokenId);
      await loadPolicy(tokenId);
      dispatch("policychange");
    } catch (err) {
      checkbox.checked = true;
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to save tool loading settings: ${message}`);
    } finally {
      busy = false;
    }
  }

  function onAdaptiveToggle(
    event: Event & { currentTarget: HTMLInputElement },
  ): void {
    const checkbox = event.currentTarget;
    if (checkbox.checked) {
      void confirmAndMigrate(checkbox);
    } else {
      void revertAdaptive(checkbox);
    }
  }

  async function addPromoted(name: string): Promise<void> {
    if (!name) return;
    busy = true;
    try {
      await mgr.activateTool(name, allToolNames, plugin, tokenId);
      promoted = [...promoted, name];
      selected = "";
      dispatch("policychange");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to promote "${name}": ${message}`);
    } finally {
      busy = false;
    }
  }

  async function removePromoted(name: string): Promise<void> {
    busy = true;
    try {
      await mgr.deactivateTool(name, plugin, tokenId);
      promoted = promoted.filter((n) => n !== name);
      dispatch("policychange");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to remove "${name}": ${message}`);
    } finally {
      busy = false;
    }
  }

  async function resetAdaptiveData(): Promise<void> {
    busy = true;
    try {
      await mgr.resetAll(plugin, tokenId);
      promoted = [];
      dispatch("policychange");
      new Notice("Adaptive tool data reset.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to reset adaptive tool data: ${message}`);
    } finally {
      busy = false;
    }
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

  <!--
    `mounted` latches on the first successful load and never resets, so it
    alone would keep the editors up after the selection is cleared — and
    every write would then target `profiles[""]`, which the store prunes,
    losing the change silently. Gate on the selection too.
  -->
  {#if mounted && tokenId}
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

    <div class="migration-section">
      <label class="radio-row">
        <input
          type="checkbox"
          checked={viewState.checked}
          disabled={viewState.disabled || busy || allToolNames.length === 0}
          on:change={onAdaptiveToggle}
          aria-label="Migrate this token to Adaptive"
        />
        <span>
          Migrate to Adaptive
          {#if viewState.state === "under-observation"}
            <span class="muted"
              >— ready in {viewState.daysRemaining} day{viewState.daysRemaining ===
              1
                ? ""
                : "s"}. Reduces session-fixed tool-list cost; seeds Promoted
              tools from what this client has actually called.</span
            >
          {:else if viewState.state === "eligible-off"}
            <span class="muted"
              >— seeds Promoted tools from what this client has actually
              called, then behaves like Adaptive above. Shows exactly which
              tools would deactivate before anything changes.</span
            >
          {:else}
            <span class="muted"
              >— active for this token. Turn off to restore All tools
              immediately.</span
            >
          {/if}
        </span>
      </label>
      {#if viewState.state === "eligible-off" && allToolNames.length === 0}
        <p class="muted empty-hint">
          Connect an MCP client once so the tool list is available, then
          reopen settings to migrate.
        </p>
      {/if}
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

  .migration-section {
    padding: 0.6em 0.8em;
    background: var(--background-secondary);
    border-radius: 4px;
    margin-bottom: 0.8em;
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
    /* Tool names are single unbreakable words; without min-width:0 the
       flex item cannot shrink below its content and pushes Remove out. */
    min-width: 0;
    overflow-wrap: anywhere;
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
