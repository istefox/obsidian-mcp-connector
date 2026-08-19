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
import { normalizeFolderList, type PathPolicy } from "$/shared/pathPolicy";

declare module "obsidian" {
  interface McpToolsPluginSettings {
    mcpTools?: {
      /**
       * Ceiling on inline text output, in KB. Undefined → plugin falls
       * back to DEFAULT_MAX_TEXT_OUTPUT_KB. Valid range 1..10240
       * (enforced at settings save via normalizeMaxTextOutputKB).
       */
      maxTextOutputKB?: number;
      /**
       * When true, `patch_vault_file` and `patch_active_file` REQUIRE an
       * `expectedContent` argument for `operation: "replace"` and refuse
       * the call without one. Undefined/false → the argument is honoured
       * when passed and not demanded, which is today's behaviour exactly.
       *
       * Off by default on purpose, and that is a cost rather than a
       * preference: a guard nobody is forced to pass protects the careful
       * and not the default. Demanding it immediately would break every
       * configured client and every distributed `.mcpb` at their first
       * replace, which is the price this project already paid once with
       * `outputSchema`. ADR-0019 phases it: opt in here now, default in
       * the next major.
       */
      requireWritePreconditions?: boolean;
      /**
       * Folders no MCP client may read, list, search or write inside
       * (ADR-0020). Absent means no exclusion policy is in force; the
       * key is omitted rather than stored empty, so a vault that never
       * touches the feature keeps a byte-identical `data.json`.
       *
       * There is no third state. "Configured but empty" and "never
       * configured" are behaviourally identical, and encoding a
       * distinction with no meaning invites a consumer to branch on it
       * wrongly. Every reader goes through
       * {@link normalizeExcludedFolders} and treats `undefined` as
       * inert.
       */
      excludedFolders?: string[];
      /**
       * Record that the user was shown, and accepted, what hiding
       * folders costs them (ADR-0020 D12).
       *
       * A version rather than a boolean: the dialog enumerates specific
       * consequences, and if a later release changes them, a bumped
       * {@link EXCLUDED_FOLDERS_CONSENT_VERSION} re-asks exactly once. A
       * boolean cannot express "you agreed, but to an older set of
       * terms". `acceptedAt` is for the settings page and for support,
       * never for the decision.
       */
      excludedFoldersConsent?: {
        version: number;
        acceptedAt: string;
      };
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
 * Default for {@link McpToolsPluginSettings.mcpTools.requireWritePreconditions}.
 * False, so nothing that works today stops working (ADR-0019).
 */
export const DEFAULT_REQUIRE_WRITE_PRECONDITIONS = false;

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

/**
 * Current version of the terms the consent dialog states.
 *
 * **Bump this only when the set of consequences changes** — a fourth
 * tool turning out to be unfilterable, a new residual gap — and never
 * for a wording fix. A bump re-prompts every user who already accepted,
 * and doing that for a typo is how a consent dialog gets trained into a
 * reflex click.
 */
export const EXCLUDED_FOLDERS_CONSENT_VERSION = 1;

/**
 * The tools no path policy can constrain, disabled while any folder is
 * hidden (ADR-0020 D9).
 *
 * Each reaches vault content by a route the guarded `App` cannot follow:
 * `execute_obsidian_command` runs arbitrary registered code from an
 * opaque id, `execute_dataview_query` hands the whole query to
 * Dataview's own index, and `execute_template` runs Templater JS against
 * Templater's raw `app`.
 *
 * `list_bookmarks` is deliberately NOT here: its items carry `path`
 * strings and filter like anything else, and only `search` items are
 * opaque — those hold the user's own query, not results.
 */
export const UNFILTERABLE_TOOL_NAMES: readonly string[] = [
  "execute_obsidian_command",
  "execute_dataview_query",
  "execute_template",
];

/**
 * Canonicalise the configured folder list, or `undefined` when nothing
 * usable survives.
 *
 * Takes `unknown` because its two callers sit at different trust levels:
 * the settings UI passes a typed array, and the enforcement seam passes
 * whatever `data.json` holds after a hand edit or a downgrade round
 * trip. Total, and never throws.
 *
 * The per-entry rules and the cap live in `$/shared/pathPolicy`, shared
 * with the matcher, so a folder can never be normalised one way for
 * storage and another way for matching.
 */
export function normalizeExcludedFolders(raw: unknown): string[] | undefined {
  const folders = normalizeFolderList(raw);
  return folders.length === 0 ? undefined : folders;
}

/**
 * Whether the unfilterable tools must be refused for this call.
 *
 * Takes the compiled policy rather than the raw list, and that is not a
 * detail: under the pre-first-read deny-all posture the folder list is
 * empty while the policy refuses everything, so a list-based check would
 * cheerfully leave all three enabled at precisely the moment nothing is
 * known. `isEmpty` is the only field that answers "is any policy in
 * force", which is why `DENY_ALL_POLICY` sets it false.
 *
 * Phase 2 passes the union of the vault-wide and per-token lists; this
 * signature does not change.
 */
export function shouldDisableUnfilterableTools(policy: PathPolicy): boolean {
  return !policy.isEmpty;
}
