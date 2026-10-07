import {
  readPolicy,
  updateTokenPolicy,
} from "$/features/adaptive-tool-loading/tokenPolicyStore";
import type { PluginDataLike } from "$/shared/types";
import {
  CODEX_TOKEN_ENV_VAR,
  CodexInstallError,
  codexEntryFor,
  inspectCodexInstall,
  installCodexConfig,
  type CodexInstallInput,
  type CodexInstallPreview,
  type CodexInstallResult,
  type CodexInstallTarget,
  type CodexTokenForm,
} from "./codexConfig";

/**
 * The Codex install flow behind the menu (ADR-0028 D1, D8): prepare
 * (preview, write nothing), ask, then commit. `commitCodexInstall` is the
 * only production caller of `installCodexConfig`.
 */

export const CODEX_OFFERED_PROFILE = "all" as const;

export type CodexProfileOffer = {
  tokenId: string;
  from: "adaptive";
  to: typeof CODEX_OFFERED_PROFILE;
} | null;

/**
 * Codex does not refetch `tools/list`, so an `adaptive` token is offered
 * All tools. A `core` or `all` token keeps the surface its owner chose.
 */
export async function codexProfileOffer(
  plugin: PluginDataLike,
  tokenId: string,
): Promise<CodexProfileOffer> {
  const policy = await readPolicy(plugin, tokenId);
  return policy.profile === "adaptive"
    ? { tokenId, from: "adaptive", to: CODEX_OFFERED_PROFILE }
    : null;
}

export type PreparedCodexInstall = {
  tokenId: string;
  input: CodexInstallInput;
  target: CodexInstallTarget;
  preview: CodexInstallPreview;
  profileOffer: CodexProfileOffer;
};

/** Build the entry and preview the install. Writes nothing. */
export async function prepareCodexInstall(
  plugin: PluginDataLike,
  request: {
    tokenId: string;
    token: string;
    serverId: string;
    url: string;
    routeId: string | null;
    tokenForm: CodexTokenForm;
    target: CodexInstallTarget;
  },
): Promise<PreparedCodexInstall> {
  // A project file may be committed: the environment variable form only,
  // and the input carries no token that anything could write there
  const project = request.target.scope === "project";
  const entry = codexEntryFor({
    serverId: request.serverId,
    url: request.url,
    token: request.token,
    tokenForm: project ? "env" : request.tokenForm,
  });
  const input: CodexInstallInput = {
    ...entry,
    ...(project ? { accessToken: "" } : {}),
    routeId: request.routeId,
  };
  const preview = await inspectCodexInstall(input, request.target);
  return {
    tokenId: request.tokenId,
    input,
    target: request.target,
    preview,
    profileOffer: await codexProfileOffer(plugin, request.tokenId),
  };
}

export type CodexInstallDecision = {
  confirmed: boolean;
  switchProfile: boolean;
};

export type CodexInstallOutcome =
  | { status: "cancelled" }
  | {
      status: "installed";
      result: CodexInstallResult;
      profileSwitched: boolean;
    };

/**
 * Install what the user confirmed, then, only after the install succeeded
 * or found the entry unchanged, switch the profile when the box was
 * ticked. Rejects with a CodexInstallError and leaves the profile as it
 * was when the install fails.
 */
export async function commitCodexInstall(
  plugin: PluginDataLike,
  prepared: PreparedCodexInstall,
  decision: CodexInstallDecision,
): Promise<CodexInstallOutcome> {
  if (!decision.confirmed) return { status: "cancelled" };
  let result: CodexInstallResult;
  try {
    result = await installCodexConfig(prepared.input, prepared.target, {
      expectedRevision: prepared.preview.revision,
    });
  } catch (error) {
    if (error instanceof CodexInstallError) throw error;
    throw new CodexInstallError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const offer = prepared.profileOffer;
  let profileSwitched = false;
  // Re-read, so a profile changed while the modal was open is not overridden
  if (
    decision.switchProfile &&
    offer !== null &&
    (await readPolicy(plugin, offer.tokenId)).profile === offer.from
  ) {
    await updateTokenPolicy(plugin, offer.tokenId, { profile: offer.to });
    profileSwitched = true;
  }
  return { status: "installed", result, profileSwitched };
}

/** The Notice after an install. Never carries the token. */
export function codexInstallNotice(
  outcome: Extract<CodexInstallOutcome, { status: "installed" }>,
): string {
  const { result } = outcome;
  const where = `'${result.serverId}' in ${result.configPath}`;
  const parts = [
    result.action === "unchanged"
      ? `The Codex entry ${where} is already up to date.`
      : result.action === "add"
        ? `Added the Codex entry ${where}.`
        : result.action === "replace"
          ? `Updated the Codex entry ${where}.`
          : `Moved the Codex entry '${result.previousServerId ?? ""}' to ${where}. Codex tool names change with the entry name, so update any reference to the old name.`,
  ];
  if (result.backupPath)
    parts.push(`The previous file is saved as ${result.backupPath}.`);
  if (result.tokenForm === "env")
    parts.push(
      `Start Codex with ${CODEX_TOKEN_ENV_VAR} set to this row's token.`,
    );
  if (result.scope === "project")
    parts.push("Codex loads this file only for a trusted project.");
  if (outcome.profileSwitched) parts.push("The token now uses All tools.");
  return parts.join(" ");
}
