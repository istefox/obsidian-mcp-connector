import { logger } from "$/shared/logger";
import type { PluginDataLike } from "$/shared/types";
import { SettingsStore } from "$/shared/settingsStore";
// Direct path, not the `mcp-transport` barrel: that barrel re-exports
// `AccessControlSection`, which imports `$/features/mcp-client-config`,
// so going through it would close a cycle. Same edge `mcpbDownload.ts`
// already takes, for the same reason.
import { readTokens } from "$/features/mcp-transport/services/tokenStore";
import {
  removeFromClaudeDesktopConfig,
  updateClaudeDesktopConfig,
} from "./claudeDesktop";

/**
 * Auto-write Claude Desktop config glue.
 *
 * The Settings UI exposes an opt-in toggle (default OFF)
 * that, when ON, automatically rewrites `claude_desktop_config.json`
 * whenever the bearer token rotates or the HTTP server's port changes.
 * This module owns the read/write of that flag and the one-shot sync
 * action invoked by callers.
 *
 * The flag lives at `mcpClientConfig.autoWriteClaudeDesktopConfig` in
 * `data.json`. Default is `false` — a "config rewrite" is a touch on
 * a user-managed file outside the vault, so we do not perform it
 * without explicit consent.
 *
 * `claude_desktop_config.json` holds ONE `mcpServers` entry for this
 * vault, so at most one token can own it, and which one is recorded
 * beside the flag as `autoWriteTokenId`. Before 1.0.0 there was no such
 * field and every sync wrote `mcpTransportState.bearerToken`, i.e.
 * `tokens[0]` — so regenerating any other token rewrote the config with
 * the FIRST token's secret and handed Claude Desktop access it was never
 * given. That is the ADR-0014 §11 re-pointing, reached through the
 * auto-write door instead of the `.mcpb` one.
 *
 * Why this is a separate module rather than inline in
 * `AccessControlSection.svelte`: it lets the regenerate flow in
 * `mcp-transport` and the migration executor in `migration` share a
 * single sync entry point, and it keeps the persistence shape testable
 * without a Svelte runtime.
 */

const DATA_KEY = "mcpClientConfig";
const FLAG_KEY = "autoWriteClaudeDesktopConfig";
const OWNER_KEY = "autoWriteTokenId";

type PluginLike = PluginDataLike & {
  mcpTransportState?:
    | {
        bearerToken: string;
        server: { port: number };
      }
    | undefined;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Read the flag from `data.json`. Returns false on any of:
 *  - Missing `data.json` content (fresh install).
 *  - Missing `mcpClientConfig` slice.
 *  - Flag explicitly set to false.
 *  - Flag missing or non-boolean.
 *
 * Coerces unexpected shapes to false. The auto-write feature is
 * fail-safe: a corrupt or unexpected setting state should NOT
 * surprise-write to user files.
 */
export async function getAutoWriteEnabled(
  plugin: PluginLike,
): Promise<boolean> {
  try {
    const slice = await new SettingsStore(plugin).readSlice(DATA_KEY);
    if (!slice || typeof slice !== "object") return false;
    const flag = (slice as Record<string, unknown>)[FLAG_KEY];
    return flag === true;
  } catch (err) {
    logger.warn("autoWrite: getAutoWriteEnabled failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Give one token ownership of `claude_desktop_config.json`, or `null` to
 * release it. The flag and the owner id are written together and never
 * separately, so they cannot disagree — a `true` flag with no owner is
 * only ever legacy data, never something this module produces.
 *
 * `SettingsStore.updateSlice` mutates only the `mcpClientConfig` slice
 * under the shared settings mutex, preserving every other key, so this
 * write cannot clobber a concurrent settings write from another feature
 * (data.json is not atomic).
 *
 * Releasing does NOT undo prior writes: the entry already in the user's
 * config keeps working until something removes it. `releaseAutoWriteOwner`
 * is the path that does remove it, because a revoked token's credential
 * sitting in a config file is dead weight the user cannot see.
 */
export async function setAutoWriteOwner(
  plugin: PluginLike,
  tokenId: string | null,
): Promise<void> {
  await new SettingsStore(plugin).updateSlice(DATA_KEY, (current) => {
    const slice = (current as Record<string, unknown> | undefined) ?? {};
    return { ...slice, [FLAG_KEY]: tokenId !== null, [OWNER_KEY]: tokenId };
  });
}

/**
 * The token that owns `claude_desktop_config.json`, or `null` if nobody
 * does.
 *
 * Legacy resolution, and why it writes: a vault upgraded from 0.28.2
 * with the flag ON has no `autoWriteTokenId`, but its config was written
 * from `mcpTransportState.bearerToken`, which is the mirror of
 * `tokens[0]` — so `tokens[0]` IS the owner, by construction. Persisting
 * that on first resolution is what stops the answer from drifting: left
 * as a live `tokens[0]` lookup, revoking the first token would silently
 * move ownership to the survivor, which is the very defect this field
 * exists to close.
 *
 * An owner id naming a token that no longer exists resolves to `null`,
 * never to a survivor. Every caller then no-ops, which is the fail-closed
 * end of ADR-0014 §11: a revocation must not become a grant.
 */
export async function resolveAutoWriteOwner(
  plugin: PluginLike,
): Promise<string | null> {
  if (!(await getAutoWriteEnabled(plugin))) return null;

  let tokens;
  try {
    tokens = await readTokens(plugin);
  } catch (err) {
    logger.warn("autoWrite: could not read the token list", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const slice = (await new SettingsStore(plugin).readSlice(DATA_KEY)) as
    | Record<string, unknown>
    | undefined;
  const stored = slice?.[OWNER_KEY];
  if (typeof stored === "string" && stored.length > 0) {
    return tokens.some((t) => t.id === stored) ? stored : null;
  }

  const legacyOwner = tokens[0]?.id;
  if (!legacyOwner) return null;
  await setAutoWriteOwner(plugin, legacyOwner);
  return legacyOwner;
}

/**
 * Hand back ownership after `revokedTokenId` is revoked, and take the
 * dead credential out of the user's config.
 *
 * Rewriting the entry to point at another token would be exactly the
 * re-pointing ADR-0014 §11 forbids, so the entry is removed instead.
 * Touching a file outside the vault is in scope here only because
 * turning the toggle on is the consent for this module to manage that
 * one entry; `removeFromClaudeDesktopConfig` leaves every other
 * `mcpServers` key alone.
 *
 * A no-op when the revoked token was not the owner. Never throws — a
 * revoke has already happened by the time this runs and must not be
 * reported as failed because a config file was unwritable.
 */
export async function releaseAutoWriteOwner(
  plugin: PluginLike,
  revokedTokenId: string,
): Promise<{ released: boolean; error?: string }> {
  const slice = (await new SettingsStore(plugin).readSlice(DATA_KEY)) as
    | Record<string, unknown>
    | undefined;
  if (slice?.[OWNER_KEY] !== revokedTokenId) return { released: false };

  await setAutoWriteOwner(plugin, null);
  try {
    await removeFromClaudeDesktopConfig();
    return { released: true };
  } catch (err) {
    return {
      released: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// One-shot sync
// ---------------------------------------------------------------------------

export type ApplyAutoWriteResult =
  | { applied: true }
  | { applied: false; reason: "disabled" | "transport-offline" | "not-owner" }
  | { applied: false; reason: "error"; error: string };

/**
 * Rewrite the Claude Desktop config for `actedTokenId`, if and only if
 * that token owns it and the HTTP transport is up. No-op (with a
 * structured reason) otherwise.
 *
 * `actedTokenId` is required, and the secret written is that token's
 * own, read from the live list. Reading `mcpTransportState.bearerToken`
 * instead — as this did before 1.0.0 — means every rotation writes
 * `tokens[0]`'s credential no matter which token was rotated, so
 * regenerating the second token handed Claude Desktop the first token's
 * access and announced it as a successful sync.
 *
 * Caller responsibilities:
 *  - The rotation flow must call this AFTER the new secret is persisted,
 *    since the value written is re-read from `data.json` here.
 *  - The migration flow does NOT use this — it calls
 *    `updateClaudeDesktopConfig` directly through the executor (T2).
 *
 * Returns a structured result so the UI can decide whether to show a
 * toast, and in particular so it can avoid claiming a config was
 * updated when it was not.
 */
export async function applyAutoWrite(
  plugin: PluginLike,
  actedTokenId: string,
): Promise<ApplyAutoWriteResult> {
  const enabled = await getAutoWriteEnabled(plugin);
  if (!enabled) return { applied: false, reason: "disabled" };

  // Checked before ownership: with no transport there is no port to
  // write, so "the server is down" is the more useful of the two
  // answers and the one the UI already knows how to phrase.
  const state = plugin.mcpTransportState;
  if (!state) return { applied: false, reason: "transport-offline" };

  const owner = await resolveAutoWriteOwner(plugin);
  if (owner === null || owner !== actedTokenId) {
    return { applied: false, reason: "not-owner" };
  }

  let tokens;
  try {
    tokens = await readTokens(plugin);
  } catch (err) {
    return {
      applied: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const record = tokens.find((t) => t.id === owner);
  // resolveAutoWriteOwner already proved the id is in the list, so this
  // only fires if the list changed between the two reads. Refusing is
  // still the right answer: a token that vanished mid-flight must not be
  // substituted for.
  if (!record) return { applied: false, reason: "not-owner" };

  try {
    await updateClaudeDesktopConfig({
      port: state.server.port,
      token: record.token,
    });
    return { applied: true };
  } catch (err) {
    return {
      applied: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
