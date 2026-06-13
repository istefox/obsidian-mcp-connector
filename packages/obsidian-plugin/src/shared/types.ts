/**
 * Structural duck-types for plugin-runtime collaborators, kept here so
 * features don't redeclare them (or import a sibling feature for a
 * two-line type). Imported directly via `$/shared/types`, never through
 * the `$/shared` barrel (which pulls in `src/main` and risks a cycle).
 */

/** Read-only view of the Obsidian plugin's `data.json` persistence. */
export interface PluginReadLike {
  loadData: () => Promise<unknown>;
}

/** Read-write view of the plugin's `data.json` persistence. */
export interface PluginDataLike extends PluginReadLike {
  saveData: (data: unknown) => Promise<void>;
}
