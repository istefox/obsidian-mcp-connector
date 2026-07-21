/**
 * Settings augmentation for the mcp-tools feature (#342). Kept here,
 * inside the feature module, per the .clinerules rule that features
 * own their own types.
 *
 * `maxTextOutputKB` bounds how much text `get_vault_file` (and, via the
 * shared `readVaultFileAsJson`, `get_vault_files`' `format=json` branch)
 * returns inline before falling back to a truncated response — without
 * it a single huge note can blow the client's context window.
 */
declare module "obsidian" {
  interface McpToolsPluginSettings {
    mcpTools?: {
      /**
       * Ceiling on inline text output, in KB. Undefined → plugin falls
       * back to DEFAULT_MAX_TEXT_OUTPUT_KB. Valid range 1..10240
       * (enforced at settings save via normalizeMaxTextOutputKB).
       */
      maxTextOutputKB?: number;
    };
  }
}

/**
 * Default ceiling on `get_vault_file` inline text output, in KB. Small
 * enough to keep a typical oversized note from saturating the context
 * window, generous enough that the overwhelming majority of real notes
 * never hit it.
 */
export const DEFAULT_MAX_TEXT_OUTPUT_KB = 100;

/**
 * Allowed range for the user-configurable ceiling. The lower bound (1)
 * still lets a getting-started note through; the upper bound (10240,
 * i.e. 10 MB) is a sanity cap matching the order of magnitude of the
 * existing binary INLINE_BYTE_CAP in getVaultFile.ts.
 */
export const MIN_MAX_TEXT_OUTPUT_KB = 1;
export const MAX_MAX_TEXT_OUTPUT_KB = 10240;

/**
 * Clamp a raw numeric input from the settings UI into the valid range.
 * Returns `undefined` when the input is NaN or not a positive number,
 * which the caller can interpret as "use the default".
 */
export function normalizeMaxTextOutputKB(
  raw: number | undefined,
): number | undefined {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.max(
    MIN_MAX_TEXT_OUTPUT_KB,
    Math.min(MAX_MAX_TEXT_OUTPUT_KB, Math.round(raw)),
  );
}
