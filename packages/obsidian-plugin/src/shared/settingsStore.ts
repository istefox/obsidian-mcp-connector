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
import type { PluginDataLike } from "./types";
import { logger } from "./logger";

/** Deep structural equality for plain JSON values. */
function jsonEqual(a: unknown, b: unknown): boolean {
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
   */
  updateSlice<T>(key: string, recipe: (current: unknown) => T): Promise<T> {
    return this.mutex.run(async () => {
      const raw =
        ((await this.plugin.loadData()) as Record<string, unknown> | null) ??
        {};
      const current = raw[key];
      const next = recipe(current);
      if ((next as unknown) !== current) {
        await this.plugin.saveData({ ...raw, [key]: next });
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
      const raw =
        ((await this.plugin.loadData()) as Record<string, unknown> | null) ??
        {};
      const stored = raw[key];
      const merged = {
        ...(opts.defaults as object),
        ...((stored && typeof stored === "object" ? stored : {}) as object),
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
        await this.plugin.saveData({ ...raw, [key]: resolved });
      }
      return resolved;
    });
  }

  /**
   * Read one slice without acquiring the write lock. `loadData` is a
   * single atomic read+parse, so a concurrent in-flight write can only
   * make this return the pre- or post-write snapshot, never a torn one.
   */
  async readSlice(key: string): Promise<unknown> {
    const raw = (await this.plugin.loadData()) as Record<
      string,
      unknown
    > | null;
    return raw?.[key];
  }
}
