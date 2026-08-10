import { SettingsStore } from "$/shared/settingsStore";
import type { PluginDataLike } from "$/shared/types";
import type { Era } from "./eraRouter";

/**
 * How many requests each protocol era has served, cumulative over the life
 * of the vault. Diagnostic only: nothing reads it to make a runtime
 * decision. It exists so the `legacy: 'reject'` trigger recorded in
 * ADR-0016 §8 — the legacy count staying at zero across two minor releases
 * or 60 days, whichever is longer — can be observed rather than guessed at.
 */
export type EraCounters = { legacy: number; modern: number };

/**
 * The same counts, split by the token that authenticated each request — the
 * question `EraCounters` cannot answer. The transport is stateless and the era
 * is decided per request, so "which era does this server speak" has no single
 * answer; "which era does this CLIENT speak" does, and ADR-0014 already gives
 * every client an id to key it on.
 *
 * Additive alongside `eraCounters`, never a replacement for it. The counts
 * already on disk predate the split and belong to no token: attributing them
 * to one would invent data, and dropping them would damage the ADR-0016 §8
 * trigger, which reads the vault-wide legacy total. So
 * `sum(byToken) <= eraCounters` holds forever, by construction — the
 * difference is history recorded before the split, plus whatever left with a
 * revoked token. Nothing should compute one from the other.
 */
export type EraCountersByToken = Record<string, EraCounters>;

const SLICE = "mcpTransport";

/**
 * Trailing debounce for persisting the batch. `record` fires on EVERY
 * classified request, and a settings write per request is a disk write per
 * request, under the process-wide mutex, in front of the transport — for a
 * number nothing reads at runtime (ADR-0016 §7, alternative G). Matching
 * `ToolLoadingManager`'s window: the timer is armed by the first record and
 * not re-armed by later ones, so it caps writes at one per window rather
 * than deferring them indefinitely under sustained traffic.
 */
const FLUSH_DELAY_MS = 2_000;

/**
 * The unflushed batch, module-level and NOT keyed by plugin: a vault runs
 * one transport, `record` is called from the request path where no plugin
 * reference is in hand, and the counter is a property of the server rather
 * than of any particular caller. `flush(plugin)` is the only function that
 * needs one.
 */
let pending: EraCounters = { legacy: 0, modern: 0 };
let pendingByToken = new Map<string, EraCounters>();
let timer: number | null = null;

/** Normalize a stored `eraCounters` value; anything absent or malformed reads as zero. */
export function readEraCounters(value: unknown): EraCounters {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    legacy: typeof raw.legacy === "number" ? raw.legacy : 0,
    modern: typeof raw.modern === "number" ? raw.modern : 0,
  };
}

/**
 * Normalize a stored `eraCountersByToken` value. Absent reads as `{}`, and a
 * malformed entry reads as zeros rather than throwing — this is diagnostic
 * data behind a settings pane, so half-written state must degrade to a
 * boring row instead of breaking the section that renders it.
 */
export function readEraCountersByToken(value: unknown): EraCountersByToken {
  if (value === null || typeof value !== "object") return {};
  const out: EraCountersByToken = {};
  for (const [id, counts] of Object.entries(value as Record<string, unknown>)) {
    out[id] = readEraCounters(counts);
  }
  return out;
}

/**
 * Count one request against the era that served it, and against the token
 * that authenticated it. In memory only.
 *
 * An empty `tokenId` moves the vault total and creates no bucket: a request
 * with no attributable client must not invent one, the same rule the era
 * classification itself follows when it declines to guess an era.
 */
export function record(era: Era, tokenId = ""): void {
  pending[era] += 1;
  if (tokenId === "") return;
  const bucket = pendingByToken.get(tokenId) ?? { legacy: 0, modern: 0 };
  bucket[era] += 1;
  pendingByToken.set(tokenId, bucket);
}

/**
 * Arm the debounced flush, so a vault that stays open for weeks persists
 * its counts without waiting for a teardown. Already-armed is a no-op —
 * re-arming on every request would let a busy server postpone the write
 * forever.
 */
export function scheduleFlush(
  plugin: PluginDataLike,
  delayMs: number = FLUSH_DELAY_MS,
): void {
  if (timer !== null) return;
  // window.setTimeout (not the bare global): Obsidian popout-window
  // compatibility, and the plugin runs in the renderer where window is
  // always present.
  timer = window.setTimeout(() => {
    timer = null;
    // Fire-and-forget: a failed flush puts the batch back (see below) and
    // the next request re-arms the timer.
    void flush(plugin).catch(() => {});
  }, delayMs);
}

/**
 * Persist the batch in ONE settings write, accumulating onto whatever is
 * already stored. Callers: the debounce timer above, and
 * `McpService.flushPendingCalls` (hence service teardown, so an unload does
 * not drop a window of counts). Safe to call with nothing pending — it then
 * performs no read and no write at all.
 *
 * The write goes through `SettingsStore.updateSlice` because `data.json` is
 * shared by every feature: an unserialized read-modify-write here would
 * clobber another slice, or drop `livePort` written concurrently by setup.
 */
export async function flush(plugin: PluginDataLike): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (pending.legacy === 0 && pending.modern === 0) return;
  const batch = pending;
  const batchByToken = pendingByToken;
  pending = { legacy: 0, modern: 0 };
  pendingByToken = new Map();
  try {
    await new SettingsStore(plugin).updateSlice(SLICE, (current) => {
      const slice = (current as Record<string, unknown> | undefined) ?? {};
      const stored = readEraCounters(slice.eraCounters);
      const storedByToken = readEraCountersByToken(slice.eraCountersByToken);
      for (const [id, counts] of batchByToken) {
        const before = storedByToken[id] ?? { legacy: 0, modern: 0 };
        storedByToken[id] = {
          legacy: before.legacy + counts.legacy,
          modern: before.modern + counts.modern,
        };
      }
      const byToken = pruneToLiveTokens(storedByToken, slice.tokens);
      const next: Record<string, unknown> = {
        ...slice,
        eraCounters: {
          legacy: stored.legacy + batch.legacy,
          modern: stored.modern + batch.modern,
        },
      };
      // An empty map is dropped rather than written, the same rule
      // `tokenPolicyStore`'s `toSlice` applies to an empty `profiles`: a vault
      // that has never attributed a request must not gain a new key in
      // `data.json` just because this field now exists.
      if (Object.keys(byToken).length > 0) next.eraCountersByToken = byToken;
      else delete next.eraCountersByToken;
      return next;
    });
  } catch (error) {
    // Put both dimensions of the batch back so a transient write failure does
    // not drop counts; merge with anything recorded meanwhile. Restoring only
    // the totals would leave the per-token map permanently behind them.
    pending.legacy += batch.legacy;
    pending.modern += batch.modern;
    for (const [id, counts] of batchByToken) {
      const kept = pendingByToken.get(id) ?? { legacy: 0, modern: 0 };
      pendingByToken.set(id, {
        legacy: kept.legacy + counts.legacy,
        modern: kept.modern + counts.modern,
      });
    }
    throw error;
  }
}

/**
 * Drop buckets whose token no longer exists. Tokens live in this same slice,
 * so this runs inside the counter's own recipe, on the same atomic snapshot,
 * costing no extra read — and a revoked client stops occupying a settings row
 * it can no longer fill.
 *
 * A `tokens` value that is absent or not an array prunes NOTHING. Read
 * literally it would mean "no token exists", and acting on that during a boot
 * ordering where the counter writes before `ensureTokenStore` has seeded the
 * list would wipe the whole map. Keeping a stale bucket is recoverable; that
 * is not.
 */
function pruneToLiveTokens(
  byToken: EraCountersByToken,
  tokens: unknown,
): EraCountersByToken {
  if (!Array.isArray(tokens)) return byToken;
  const live = new Set(
    tokens
      .map((t) =>
        t !== null && typeof t === "object"
          ? (t as Record<string, unknown>).id
          : undefined,
      )
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  if (live.size === 0) return byToken;
  return Object.fromEntries(
    Object.entries(byToken).filter(([id]) => live.has(id)),
  );
}
