<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Menu, Notice } from "obsidian";
  import { createEventDispatcher } from "svelte";
  import {
    CODEX_TOKEN_ENV_VAR,
    CodexInstallError,
    codexConfigSnippet,
    codexEntryFor,
    codexMcpAddCommand,
    locateCodexHome,
    locateCodexProject,
    type CodexHomeLocation,
    type CodexInstallTarget,
    type CodexProjectLocation,
  } from "../services/codexConfig";
  import {
    codexInstallNotice,
    commitCodexInstall,
    prepareCodexInstall,
  } from "../services/codexInstallFlow";
  import { CodexInstallModal } from "../services/codexInstallModal";
  import { codexMenuItems, type CodexMenuAction } from "../services/codexMenu";
  import { savedRouteId } from "../services/discoveryBroker";
  import { vaultServerId } from "../services/generators";

  /**
   * The Codex menu of one token row (ADR-0028 D1): copy the snippet, copy
   * the `codex mcp add` command, install into the user's Codex config or
   * into the shared project path. An install always runs preview, modal,
   * then install, and only from a click here.
   */

  export let plugin: McpToolsPlugin;
  /** The client endpoint; "" disables every action, like the copy buttons. */
  export let url: string;
  export let token: string;
  export let tokenId: string;
  export let tokenLabel: string;
  /** The saved project path shared with Claude Code, or "". */
  export let projectPath = "";
  /** The per-session choice to keep the token out of config.toml. */
  export let tokenFromEnv = false;
  export let disabled = false;

  const dispatch = createEventDispatcher<{ policychange: void }>();
  const NOTICE_MS = 15_000;

  let running = false;

  $: serverId = vaultServerId(plugin.app.vault.getName());
  $: tokenForm = tokenFromEnv ? ("env" as const) : ("literal" as const);

  function failure(action: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const backup =
      err instanceof CodexInstallError && err.backupPath
        ? ` The previous file is saved as ${err.backupPath}.`
        : "";
    new Notice(`Failed ${action}: ${message}${backup}`, NOTICE_MS);
  }

  async function copyText(text: string, notice: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(notice);
    } catch (err) {
      failure("to copy", err);
    }
  }

  // async: the builders throw synchronously on an invalid key or URL, and the
  // throw must become a rejection the click handler's .catch reports
  async function copySnippet(): Promise<void> {
    const snippet = codexConfigSnippet(
      codexEntryFor({ serverId, url, token, tokenForm }),
    );
    return copyText(
      snippet,
      tokenFromEnv
        ? `Codex config.toml entry copied. Export ${CODEX_TOKEN_ENV_VAR} with the ${tokenLabel} token before starting Codex.`
        : "Codex config.toml entry copied. Install it from this menu instead to keep this vault's tool settings and to be warned about an equally named vault.",
    );
  }

  async function copyCommand(): Promise<void> {
    return copyText(
      codexMcpAddCommand({ serverId, url }),
      `codex mcp add command copied. Export ${CODEX_TOKEN_ENV_VAR} with the ${tokenLabel} token before starting Codex.`,
    );
  }

  async function install(
    target: CodexInstallTarget,
    homeSource?: "CODEX_HOME" | "default",
  ): Promise<void> {
    running = true;
    try {
      const prepared = await prepareCodexInstall(plugin, {
        tokenId,
        token,
        serverId,
        url,
        routeId: await savedRouteId(plugin),
        tokenForm,
        target,
      });
      if (
        prepared.preview.action === "unchanged" &&
        prepared.profileOffer === null
      ) {
        new Notice(
          `The Codex entry '${serverId}' in ${target.configPath} is already up to date.`,
        );
        return;
      }
      const modal = new CodexInstallModal(plugin.app, {
        preview: prepared.preview,
        profileOffer: prepared.profileOffer,
        tokenLabel,
        ...(homeSource ? { homeSource } : {}),
      });
      modal.open();
      // Awaited outside any settings update, see CodexInstallModal
      const decision = await modal.waitForDecision();
      const outcome = await commitCodexInstall(plugin, prepared, decision);
      if (outcome.status === "cancelled") return;
      new Notice(codexInstallNotice(outcome), NOTICE_MS);
      if (outcome.profileSwitched) dispatch("policychange");
    } catch (err) {
      failure("to install the Codex config", err);
    } finally {
      running = false;
    }
  }

  async function openMenu(event: MouseEvent): Promise<void> {
    if (disabled || running) return;
    let located: [CodexHomeLocation, CodexProjectLocation];
    try {
      located = await Promise.all([
        locateCodexHome(),
        locateCodexProject(projectPath),
      ]);
    } catch (err) {
      failure("to locate the Codex config", err);
      return;
    }
    const [home, project] = located;
    const run: Record<CodexMenuAction, () => Promise<void>> = {
      "copy-snippet": copySnippet,
      "copy-command": copyCommand,
      "install-user": () =>
        home.located
          ? install(
              { scope: "user", configPath: home.configPath },
              home.source,
            )
          : Promise.resolve(),
      "install-project": () =>
        project.located
          ? install({ scope: "project", configPath: project.configPath })
          : Promise.resolve(),
    };
    const menu = new Menu();
    for (const item of codexMenuItems({
      endpointUrl: url,
      busy: disabled || running,
      home,
      project,
    })) {
      menu.addItem((menuItem) =>
        menuItem
          .setTitle(
            item.disabled && item.reason
              ? `${item.title} (${item.reason})`
              : item.title,
          )
          .setDisabled(item.disabled)
          .onClick(() => {
            void run[item.action]().catch((err) =>
              failure("to run the Codex action", err),
            );
          }),
      );
    }
    menu.showAtMouseEvent(event);
  }
</script>

<button
  type="button"
  on:click={(event) =>
    void openMenu(event).catch((err) =>
      failure("to open the Codex menu", err),
    )}
  disabled={disabled || running || !url}
  aria-label="Codex actions for {tokenLabel}"
>
  {running ? "Codex…" : "Codex"}
</button>
