/**
 * The vault's bearer tokens: one record per configured MCP client.
 *
 * Credentials live in the `mcpTransport` slice and tool policy lives in
 * `toolLoading.profiles`, joined by an opaque id (ADR-0014 §1), so the
 * tool-selection UI never gets write access to a secret. This module is
 * the only writer of `mcpTransport.tokens`, and — together with
 * `tokenPolicyStore.updateToolLoading` — one of exactly two writers of
 * the legacy mirror (§7).
 *
 * The mirror (`mcpTransport.bearerToken`, `toolLoading.profile` /
 * `promoted`) tracks `tokens[0]` POSITIONALLY, not the literal id
 * "default": revoking the migrated entry must promote the next token
 * into the mirror rather than leave a downgraded plugin pointing at a
 * dead secret.
 *
 * Everything here is a plain function over `PluginDataLike`, so the
 * migration is testable against a fixture `data.json` with no Obsidian
 * `App` in sight.
 */

import { jsonEqual, SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";
// Type-only: the policy shape is owned by the adaptive-tool-loading
// feature. The migration has to seed one entry, but it acquires no
// runtime dependency on that feature to do it.
import type { TokenPolicy } from "$/features/adaptive-tool-loading/tokenPolicyStore";
import { MAX_TOKENS, TOKEN_BYTE_LENGTH } from "../constants";
import { generateToken, generateTokenId } from "./token";

export type TokenRecord = {
  /** Stable, opaque, never reused. Keys `toolLoading.profiles`. */
  id: string;
  /** User-facing and purely cosmetic; duplicates are allowed. */
  label: string;
  /** The secret presented as `Authorization: Bearer <token>`. */
  token: string;
  createdAt: number;
};

const TRANSPORT_SLICE = "mcpTransport";
const TOOL_LOADING_SLICE = "toolLoading";

/**
 * Id and label the 0.28.2 → 0.29.0 migration gives the pre-existing
 * token. Only the first entry is ever named this way; nothing reads the
 * literal id (see the mirror note in the file header).
 */
const MIGRATED_TOKEN_ID = "default";
const MIGRATED_TOKEN_LABEL = "Default";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored secret is usable only at or above the same byte floor
 * `generateToken` produces. Byte length, not UTF-16 code units: the
 * 32-byte floor is a security threshold and must hold regardless of
 * encoding. Anything shorter (or absent) is treated as no token at all
 * and re-minted, so a hand-mangled `data.json` cannot leave the server
 * running with a credential nobody would consider secret.
 */
function isUsableSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") >= TOKEN_BYTE_LENGTH
  );
}

/** Keep only well-formed records; a malformed entry is dropped, not repaired. */
function parseTokens(value: unknown): TokenRecord[] {
  if (!Array.isArray(value)) return [];
  const tokens: TokenRecord[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { id, label, token, createdAt } = entry;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!isUsableSecret(token)) continue;
    tokens.push({
      id,
      label: typeof label === "string" ? label : id,
      token,
      createdAt: typeof createdAt === "number" ? createdAt : 0,
    });
  }
  return tokens;
}

function readProfile(value: unknown): TokenPolicy["profile"] {
  return value === "core" || value === "adaptive" ? value : "all";
}

function readPromoted(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((n): n is string => typeof n === "string")
    : [];
}

/**
 * Read the token list without touching it. Deliberately strict: an
 * empty result means "no credential configured" and the middleware
 * fails closed on it (ADR-0014 §2). `ensureTokenStore` runs before the
 * listener binds and guarantees a non-empty list, so falling back to
 * the legacy `bearerToken` here would only hide a broken migration.
 */
export async function readTokens(
  plugin: PluginDataLike,
): Promise<TokenRecord[]> {
  const slice = await new SettingsStore(plugin).readSlice(TRANSPORT_SLICE);
  return parseTokens(isRecord(slice) ? slice.tokens : undefined);
}

/**
 * Rebuild the `mcpTransport` slice around `tokens`, recomputing the
 * mirror in the same recipe. Returns `current` (NO_CHANGE, no write)
 * when the result is structurally identical.
 */
function withTokens(current: unknown, tokens: readonly TokenRecord[]): unknown {
  const slice = isRecord(current) ? current : {};
  const next = { ...slice, tokens, bearerToken: tokens[0].token };
  return jsonEqual(current, next) ? current : next;
}

/**
 * Seed `profiles[mirrorId]` from the legacy global profile when it is
 * missing, then point the legacy mirror at that entry.
 */
function withPolicyFor(current: unknown, mirrorId: string): unknown {
  const slice = isRecord(current) ? current : {};
  const profiles: Record<string, TokenPolicy> = {
    ...((isRecord(slice.profiles) ? slice.profiles : {}) as Record<
      string,
      TokenPolicy
    >),
  };
  if (!isRecord(profiles[mirrorId])) {
    // The 0.28.2 globals ARE this token's policy: a user upgrading with
    // `core` selected must keep seeing `core`, not silently widen to
    // `all`. A fresh vault has no globals and lands on the default
    // policy, which is the same thing 0.28.2 did with no settings.
    profiles[mirrorId] = {
      profile: readProfile(slice.profile),
      promoted: readPromoted(slice.promoted),
      allowed: null,
    };
  }
  const mirror = profiles[mirrorId];
  const next = {
    ...slice,
    profile: mirror.profile,
    promoted: [...mirror.promoted],
    profiles,
  };
  return jsonEqual(current, next) ? current : next;
}

/**
 * Bring `data.json` to the multi-token shape, idempotently, and return
 * the live token list. Handles all three states in one pass:
 *
 * - fresh vault — mints one token and writes both slices;
 * - 0.28.2 vault — `bearerToken` becomes `tokens[0]` with the SAME
 *   string (any other outcome breaks every configured client, every
 *   generated `.mcpb` and the Windows bridge), and the global profile
 *   is copied into its policy entry;
 * - already migrated — both recipes return NO_CHANGE and nothing is
 *   written; a desynced mirror self-heals here.
 *
 * Write order is `toolLoading` FIRST, `mcpTransport` SECOND, and that
 * is load-bearing: a crash between the two writes leaves a policy entry
 * nothing reads yet (no `tokens[]` exists) on top of a `data.json` that
 * is still exactly a working 0.28.2 vault, and the migration simply
 * re-runs on the next load. The reverse order would leave a live token
 * whose policy is missing, silently widening a `core` user's surface to
 * `all` until the next successful load.
 *
 * Runs before the HTTP listener binds: a server accepting requests
 * against an empty token list would 401 every client.
 */
export async function ensureTokenStore(
  plugin: PluginDataLike,
): Promise<TokenRecord[]> {
  const store = new SettingsStore(plugin);
  const slice = await store.readSlice(TRANSPORT_SLICE);
  const existing = parseTokens(isRecord(slice) ? slice.tokens : undefined);
  const legacySecret = isRecord(slice) ? slice.bearerToken : undefined;

  const tokens =
    existing.length > 0
      ? existing
      : [
          {
            id: MIGRATED_TOKEN_ID,
            label: MIGRATED_TOKEN_LABEL,
            token: isUsableSecret(legacySecret)
              ? legacySecret
              : generateToken(),
            createdAt: Date.now(),
          },
        ];

  await store.updateSlice(TOOL_LOADING_SLICE, (current) =>
    withPolicyFor(current, tokens[0].id),
  );
  await store.updateSlice(TRANSPORT_SLICE, (current) =>
    withTokens(current, tokens),
  );

  return tokens;
}

/**
 * Apply `mutate` to the stored token list and persist the result with
 * the mirror recomputed. `mutate` throws to refuse the mutation, which
 * aborts the write without releasing the settings lock (the mutex
 * releases on throw).
 */
async function updateTokens(
  plugin: PluginDataLike,
  mutate: (tokens: TokenRecord[]) => TokenRecord[],
): Promise<TokenRecord[]> {
  let result: TokenRecord[] = [];
  await new SettingsStore(plugin).updateSlice(TRANSPORT_SLICE, (current) => {
    const tokens = parseTokens(isRecord(current) ? current.tokens : undefined);
    result = mutate(tokens);
    return withTokens(current, result);
  });
  return result;
}

function findIndex(tokens: readonly TokenRecord[], id: string): number {
  const index = tokens.findIndex((t) => t.id === id);
  if (index === -1) throw new Error(`No token with id '${id}'.`);
  return index;
}

/** Mint a new token. Refused at `MAX_TOKENS`. */
export async function addToken(
  plugin: PluginDataLike,
  label: string,
): Promise<TokenRecord> {
  let created!: TokenRecord;
  await updateTokens(plugin, (tokens) => {
    if (tokens.length >= MAX_TOKENS) {
      throw new Error(`Cannot configure more than ${MAX_TOKENS} tokens.`);
    }
    created = {
      id: generateTokenId(),
      label,
      token: generateToken(),
      createdAt: Date.now(),
    };
    return [...tokens, created];
  });
  return created;
}

/** Change a token's display label. The label is cosmetic; the id is the identity. */
export async function renameToken(
  plugin: PluginDataLike,
  id: string,
  label: string,
): Promise<TokenRecord> {
  let renamed!: TokenRecord;
  await updateTokens(plugin, (tokens) => {
    const index = findIndex(tokens, id);
    renamed = { ...tokens[index], label };
    return tokens.map((t, i) => (i === index ? renamed : t));
  });
  return renamed;
}

/**
 * Mint a new secret in place, keeping id, label and `createdAt` — and
 * therefore the token's policy entry, which is keyed by id. Rotating a
 * leaked credential must not mean rebuilding its tool selection.
 */
export async function regenerateToken(
  plugin: PluginDataLike,
  id: string,
): Promise<TokenRecord> {
  let regenerated!: TokenRecord;
  await updateTokens(plugin, (tokens) => {
    const index = findIndex(tokens, id);
    regenerated = { ...tokens[index], token: generateToken() };
    return tokens.map((t, i) => (i === index ? regenerated : t));
  });
  return regenerated;
}

/**
 * Delete a token. Refused for the last remaining one: a vault with no
 * token authenticates nobody and there is no in-app path back.
 *
 * Only the `mcpTransport` slice is written. The credential has to die
 * even if a follow-up write is lost, and the orphaned `profiles` entry
 * is inert (ids are never reused) and pruned by the next policy write.
 */
export async function revokeToken(
  plugin: PluginDataLike,
  id: string,
): Promise<TokenRecord[]> {
  return updateTokens(plugin, (tokens) => {
    findIndex(tokens, id);
    if (tokens.length <= 1) {
      throw new Error(
        "Cannot revoke the last remaining token — the server would authenticate nobody.",
      );
    }
    return tokens.filter((t) => t.id !== id);
  });
}

/**
 * A token provider over one fixed secret, for callers that hold a bare
 * token string and no vault (tests and the bench harness).
 */
export function staticTokenProvider(
  token: string,
): () => Promise<readonly TokenRecord[]> {
  const tokens: readonly TokenRecord[] = [
    {
      id: MIGRATED_TOKEN_ID,
      label: MIGRATED_TOKEN_LABEL,
      token,
      createdAt: 0,
    },
  ];
  return async () => tokens;
}
