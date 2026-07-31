/**
 * Per-token tool policy: the `toolLoading` slice's owner.
 *
 * `updateToolLoading` is the single choke point for every write to the
 * slice (ADR-0014 §7). It exists because the legacy mirror
 * (`toolLoading.profile` / `promoted`, which a downgraded 0.28.x build
 * still reads) is not maintainable by convention across a dozen call
 * sites: it is recomputed here, inside the same `updateSlice` recipe,
 * so slice and mirror can never be written apart.
 *
 * The credential side of the join lives in `mcpTransport.tokens`
 * (`mcp-transport/services/tokenStore.ts`). This module reads the token
 * ids from that slice structurally and never writes it: the
 * tool-selection UI must not hold write access to a secret.
 */

import { jsonEqual, SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";

export type ToolProfile = "all" | "core" | "adaptive";

/** One token's tool policy. `allowed: null` means no ceiling. */
export type TokenPolicy = {
  profile: ToolProfile;
  promoted: string[];
  allowed: string[] | null;
};

/**
 * What a live token with no `profiles` entry resolves to — the 0.28.2
 * surface. Load-bearing: an orphaned or half-written record must never
 * fail closed into a client that can reach nothing, so a missing entry
 * degrades to prior behaviour rather than to a lockout.
 */
export const DEFAULT_POLICY: TokenPolicy = {
  profile: "all",
  promoted: [],
  allowed: null,
};

/** Normalized view of the whole `toolLoading` slice. */
export type ToolLoadingState = {
  /** Legacy mirror of `profiles[tokens[0].id].profile`. */
  profile: ToolProfile;
  /** Global, never per token: frequency describes the vault, not the client. */
  counters: Record<string, number>;
  /** Legacy mirror of `profiles[tokens[0].id].promoted`. */
  promoted: string[];
  profiles: Record<string, TokenPolicy>;
};

/** Context every `updateToolLoading` recipe gets alongside the state. */
export type MirrorContext = {
  /**
   * The token whose policy the legacy fields mirror — `tokens[0]` by
   * POSITION, not the literal id "default", so revoking the migrated
   * entry promotes the next one into the mirror instead of leaving a
   * downgraded plugin pointing at a dead secret. `null` when no token
   * list exists yet (a pre-migration vault), where the legacy fields
   * are themselves the only policy there is.
   */
  mirrorId: string | null;
  /** Ids of the live tokens, in order. */
  tokenIds: readonly string[];
};

const SLICE = "toolLoading";
const TRANSPORT_SLICE = "mcpTransport";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((n): n is string => typeof n === "string")
    : [];
}

/** A fresh, mutable copy — callers own the arrays they get back. */
export function defaultPolicy(): TokenPolicy {
  return { ...DEFAULT_POLICY, promoted: [], allowed: null };
}

function normalizePolicy(value: unknown): TokenPolicy {
  const p = isRecord(value) ? value : {};
  return {
    profile:
      p.profile === "core" || p.profile === "adaptive" ? p.profile : "all",
    // `allowed: []` is legal and means "meta-tools only" — distinct
    // from `null`, which means no ceiling at all.
    promoted: readNames(p.promoted),
    allowed: Array.isArray(p.allowed) ? readNames(p.allowed) : null,
  };
}

function normalizeProfiles(value: unknown): Record<string, TokenPolicy> {
  if (!isRecord(value)) return {};
  const profiles: Record<string, TokenPolicy> = {};
  for (const [id, policy] of Object.entries(value)) {
    profiles[id] = normalizePolicy(policy);
  }
  return profiles;
}

/**
 * Normalize a raw `toolLoading` slice value into a well-formed state.
 *
 * Unknown keys are preserved: this slice is only partly ours, and a
 * recipe must not silently drop a field a future version added.
 *
 * Every field a recipe may touch is COPIED, never aliased to the stored
 * value. A recipe that incremented a counter in place would otherwise
 * mutate the very object the NO_CHANGE comparison below diffs against,
 * so the write would be skipped and the increment lost.
 */
export function mergeState(slice: unknown): ToolLoadingState {
  const s = isRecord(slice) ? slice : {};
  return {
    ...s,
    profile:
      s.profile === "core" || s.profile === "adaptive" ? s.profile : "all",
    counters: isRecord(s.counters)
      ? { ...(s.counters as Record<string, number>) }
      : {},
    promoted: readNames(s.promoted),
    profiles: normalizeProfiles(s.profiles),
  };
}

/**
 * Back to the on-disk shape. An empty `profiles` map is dropped rather
 * than written: a vault that has never had a token policy must stay
 * byte-identical to its 0.28.2 self, or every no-op write would rewrite
 * `data.json` and defeat the NO_CHANGE convention.
 */
function toSlice(state: ToolLoadingState): Record<string, unknown> {
  const { profiles, ...rest } = state;
  return Object.keys(profiles).length > 0 ? { ...rest, profiles } : rest;
}

async function readTokenIds(plugin: PluginDataLike): Promise<string[]> {
  const slice = await new SettingsStore(plugin).readSlice(TRANSPORT_SLICE);
  const tokens = isRecord(slice) ? slice.tokens : undefined;
  if (!Array.isArray(tokens)) return [];
  return tokens
    .map((t) => (isRecord(t) ? t.id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * The policy in force for `tokenId`, or {@link DEFAULT_POLICY} when it
 * has no entry (or the slice does not exist yet).
 */
export async function readPolicy(
  plugin: PluginDataLike,
  tokenId: string,
): Promise<TokenPolicy> {
  const slice = await new SettingsStore(plugin).readSlice(SLICE);
  const profiles = normalizeProfiles(isRecord(slice) ? slice.profiles : {});
  return profiles[tokenId] ?? defaultPolicy();
}

/**
 * The one write path into the `toolLoading` slice. Applies `mutate`,
 * prunes policy entries whose token no longer exists, and recomputes
 * the legacy mirror from the first token's entry — all inside a single
 * recipe, so the slice is atomic per write.
 *
 * The token list is read BEFORE `updateSlice` acquires the settings
 * mutex: it is non-re-entrant, and a nested acquisition would deadlock.
 * That costs one extra `loadData()` per policy write, never per
 * request, which is the trade that keeps the request path cheap.
 */
export async function updateToolLoading(
  plugin: PluginDataLike,
  mutate: (state: ToolLoadingState, ctx: MirrorContext) => ToolLoadingState,
): Promise<void> {
  const tokenIds = await readTokenIds(plugin);
  const ctx: MirrorContext = { mirrorId: tokenIds[0] ?? null, tokenIds };

  await new SettingsStore(plugin).updateSlice(SLICE, (current) => {
    const next = mutate(mergeState(current), ctx);

    // Orphans are inert (ids are never reused) but they accumulate, so
    // every policy write sweeps them. With no live token list there is
    // nothing to prune against — a pre-migration vault must not have
    // its policy entries deleted on the way to acquiring tokens.
    if (tokenIds.length > 0) {
      for (const id of Object.keys(next.profiles)) {
        if (!tokenIds.includes(id)) delete next.profiles[id];
      }
    }

    const mirror = ctx.mirrorId ? next.profiles[ctx.mirrorId] : undefined;
    if (mirror) {
      next.profile = mirror.profile;
      next.promoted = [...mirror.promoted];
    }

    const serialized = toSlice(next);
    return jsonEqual(current, serialized) ? current : serialized;
  });
}

/**
 * Patch one token's policy, creating the entry if it is missing.
 * Routes through {@link updateToolLoading}, so the mirror follows.
 */
export async function updateTokenPolicy(
  plugin: PluginDataLike,
  tokenId: string,
  patch: Partial<TokenPolicy>,
): Promise<void> {
  await updateToolLoading(plugin, (state) => {
    state.profiles[tokenId] = {
      ...(state.profiles[tokenId] ?? defaultPolicy()),
      ...patch,
    };
    return state;
  });
}
