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
let timer: number | null = null;

/** Normalize a stored `eraCounters` value; anything absent or malformed reads as zero. */
export function readEraCounters(value: unknown): EraCounters {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    legacy: typeof raw.legacy === "number" ? raw.legacy : 0,
    modern: typeof raw.modern === "number" ? raw.modern : 0,
  };
}

/** Count one request against the era that served it. In memory only. */
export function record(era: Era): void {
  pending[era] += 1;
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
  pending = { legacy: 0, modern: 0 };
  try {
    await new SettingsStore(plugin).updateSlice(SLICE, (current) => {
      const slice = (current as Record<string, unknown> | undefined) ?? {};
      const stored = readEraCounters(slice.eraCounters);
      return {
        ...slice,
        eraCounters: {
          legacy: stored.legacy + batch.legacy,
          modern: stored.modern + batch.modern,
        },
      };
    });
  } catch (error) {
    // Put the batch back so a transient write failure does not drop the
    // counts; merge with anything recorded meanwhile.
    pending.legacy += batch.legacy;
    pending.modern += batch.modern;
    throw error;
  }
}
