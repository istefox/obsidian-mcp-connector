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

/**
 * One caller's already-resolved tool surface, handed to the registry
 * per request (ADR-0014 §3). It lives here, not in either feature,
 * because both sides need it and neither should import the other for a
 * three-field type: the transport would otherwise depend on
 * adaptive-tool-loading, and the registry would grow a concept of a
 * bearer token.
 */
export type ToolScope = {
  /**
   * Opaque policy key — in practice the bearer token's id. The registry
   * never dereferences it; it only forwards it to the meta-tools, which
   * do own the policy.
   */
  id: string;
  /** Tool names servable to this caller, meta-tools included. */
  active: ReadonlySet<string>;
  /** Hard ceiling, or null for none. Meta-tools bypass it. */
  allowed: ReadonlySet<string> | null;
};
