/**
 * Keeps a semantic-search wiring from outliving the plugin that asked
 * for it. Obsidian awaits neither `onload` nor `onunload`, so `onunload`
 * can run while the wiring is still paused (say, in the v1 migration or
 * the stale-store wipe). The wiring then finishes after unload.
 */

import { logger } from "$/shared/logger";
import type { SemanticSearchState } from "../index";

export interface SemanticWiring {
  /**
   * Run the wiring. Resolves with its state, or with `undefined` when
   * the plugin was unloaded before or meanwhile: that late state is torn down
   * here, before the promise resolves, and never handed out.
   */
  wire(): Promise<SemanticSearchState | undefined>;
  /** True once `unload()` has been called. */
  readonly unloaded: boolean;
  /**
   * Mark the plugin unloaded, then wait for a pending wiring (and the
   * teardown of its late state) to settle. Never rejects.
   */
  unload(): Promise<void>;
}

export function createSemanticWiring(
  wire: () => Promise<SemanticSearchState | undefined>,
): SemanticWiring {
  let unloaded = false;
  let settled: Promise<void> = Promise.resolve();
  return {
    wire() {
      // Unloaded before the wiring was even asked for: do not start it.
      if (unloaded) return Promise.resolve(undefined);
      const run = (async () => {
        const state = await wire();
        if (!unloaded) return state;
        try {
          await state?.teardown();
        } catch (error) {
          logger.warn("semantic-search: teardown of a late wiring failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return undefined;
      })();
      settled = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    get unloaded() {
      return unloaded;
    },
    unload() {
      unloaded = true;
      return settled;
    },
  };
}
