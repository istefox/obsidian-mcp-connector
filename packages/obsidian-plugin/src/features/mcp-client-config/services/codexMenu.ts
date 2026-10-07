import type { CodexHomeLocation, CodexProjectLocation } from "./codexConfig";

export type CodexMenuAction =
  | "copy-snippet"
  | "copy-command"
  | "install-user"
  | "install-project";

export type CodexMenuItem = {
  action: CodexMenuAction;
  title: string;
  disabled: boolean;
  reason?: string;
};

/**
 * The Codex menu of one token row (ADR-0028 D1). Every action needs the
 * client endpoint, like every other copy button; each install also needs
 * its target located. Pure, so the Svelte menu only renders it.
 */
export function codexMenuItems(state: {
  endpointUrl: string;
  busy: boolean;
  home: CodexHomeLocation;
  project: CodexProjectLocation;
}): CodexMenuItem[] {
  const blocked =
    state.endpointUrl === ""
      ? "The client endpoint is not available yet."
      : state.busy
        ? "Another action is still running."
        : undefined;
  const item = (
    action: CodexMenuAction,
    title: string,
    unavailable?: string,
  ): CodexMenuItem => {
    const reason = blocked ?? unavailable;
    return {
      action,
      title,
      disabled: reason !== undefined,
      ...(reason !== undefined ? { reason } : {}),
    };
  };
  return [
    item("copy-snippet", "Copy config.toml snippet"),
    item("copy-command", "Copy codex mcp add command"),
    item(
      "install-user",
      "Install into user Codex config…",
      state.home.located ? undefined : state.home.reason,
    ),
    item(
      "install-project",
      "Install into project…",
      state.project.located ? undefined : state.project.reason,
    ),
  ];
}
