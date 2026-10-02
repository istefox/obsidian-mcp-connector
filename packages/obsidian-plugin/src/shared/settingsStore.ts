/**
 * Typed accessor over the plugin's `data.json` slices.
 *
 * Every read-modify-write of a slice must serialize through the
 * process-wide `globalSettingsMutex`: `loadData`/`saveData` are not
 * atomic, so two features writing different slices concurrently would
 * each save "before + my slice" and the last writer would clobber the
 * other (cross-feature lost update). This store owns that discipline so
 * call sites stop hand-rolling `mutex.run(...)` + `{ ...raw, [key]: x }`.
 *
 * Imported by direct path (`$/shared/settingsStore`), never via the
 * `$/shared` barrel — the barrel pulls in `src/main` and would cycle.
 */

import { type } from "arktype";
import { globalSettingsMutex, type Mutex } from "./settingsLock";
import {
  loadSettingsSnapshot,
  primeSettingsReadCache,
} from "./settingsReadCache";
import type { PluginDataLike } from "./types";
import { logger } from "./logger";

/**
 * Deep structural equality for plain JSON values. Exported because a
 * recipe that rebuilds a whole slice (rather than patching one field)
 * cannot decide NO_CHANGE by reference and must not decide it by
 * `JSON.stringify`, which reports a mere key reordering as a change and
 * would re-persist the slice on every load.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(bo, k) && jsonEqual(ao[k], bo[k]),
    );
  }
  return false;
}

export class SettingsStore {
  constructor(
    private readonly plugin: PluginDataLike,
    private readonly mutex: Mutex = globalSettingsMutex,
  ) {}

  /**
   * Atomic read-modify-write of one slice. `recipe` receives the
   * current slice value and returns the next one; every other key is
   * preserved. Returning the SAME reference `recipe` was given signals
   * "no change" and skips the write — so a conditional writer (e.g.
   * "already active, nothing to do") costs no disk I/O. Returns the
   * recipe's value.
   *
   * `recipe`'s second argument is the whole `data.json` snapshot the
   * mutex is holding, for the case where the next value of one slice
   * depends on another. Reading a sibling with a separate `loadData()`
   * before `updateSlice` cannot be made safe: the mutex is
   * non-re-entrant, so that read necessarily happens outside the lock
   * and can be stale by the time the recipe runs. Treat `raw` as
   * read-only — mutating it corrupts the write below.
   */
  updateSlice<T>(
    key: string,
    recipe: (current: unknown, raw: Record<string, unknown>) => T,
  ): Promise<T> {
    return this.mutex.run(async () => {
      const raw = await this.loadForWrite();
      const current = raw[key];
      const next = recipe(current, raw);
      if ((next as unknown) !== current) {
        await this.save({ ...raw, [key]: next });
      }
      return next;
    });
  }

  /**
   * Load a slice merged over `defaults`, optionally arktype-validated,
   * persisting only when the merged result differs from what is on disk
   * (deep equality, not stringify — arktype may reorder keys, which a
   * stringify compare would treat as a change and re-persist on every
   * load). Data that fails the schema falls back to `defaults` (which
   * are persisted) with a warning; never throws.
   */
  loadSlice<T>(
    key: string,
    // schema is any arktype `Type` (callable, returns the parsed value
    // or `type.errors`); typed as a bare validator so the generic T is
    // anchored by `defaults`, not by arktype's complex Type<> form.
    opts: { schema?: (data: unknown) => unknown; defaults: T },
  ): Promise<T> {
    return this.mutex.run(async () => {
      const raw = await this.loadForWrite();
      const stored = raw[key];
      const merged = {
        ...(opts.defaults as object),
        ...(stored && typeof stored === "object" ? stored : {}),
      } as T;

      let resolved: T = merged;
      if (opts.schema) {
        const validated = opts.schema(merged);
        if (validated instanceof type.errors) {
          logger.warn(`settings slice "${key}" invalid, using defaults`, {
            summary: validated.summary,
          });
          resolved = opts.defaults;
        } else {
          resolved = validated as T;
        }
      }

      if (!jsonEqual(stored, resolved)) {
        await this.save({ ...raw, [key]: resolved });
      }
      return resolved;
    });
  }

  /**
   * Read one slice without acquiring the write lock. `loadData` is a
   * single atomic read+parse, so a concurrent in-flight write can only
   * make this return the pre- or post-write snapshot, never a torn one.
   *
   * Served from the read cache when `main.ts` has enabled one for this
   * plugin (`settingsReadCache.ts`): the request path reads three or four
   * slices per call and they collapse into one disk read. Treat the
   * returned value as read-only — it may be the cached object itself.
   */
  async readSlice(key: string): Promise<unknown> {
    const raw = await loadSettingsSnapshot(this.plugin);
    return raw[key];
  }

  /**
   * The snapshot a write starts from. Always disk, never the cache: a
   * read-modify-write that began from a stale snapshot would lose an
   * update the cache had not seen yet, and the mutex this runs under is
   * exactly the guarantee that forbids that.
   */
  private async loadForWrite(): Promise<Record<string, unknown>> {
    return (
      ((await this.plugin.loadData()) as Record<string, unknown> | null) ?? {}
    );
  }

  /** Persist, then make the written state the cache's current snapshot. */
  private async save(next: Record<string, unknown>): Promise<void> {
    await this.plugin.saveData(next);
    primeSettingsReadCache(this.plugin, next);
  }
}
