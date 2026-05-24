import type { App, TFile } from "obsidian";
import { moment } from "obsidian";
import type { Moment } from "moment";
import * as periodicNotesLib from "obsidian-daily-notes-interface";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";

export type PeriodType =
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly";

export interface ResolvedPeriodicNote {
  /** Vault-relative path for the given period + date. */
  path: string;
  /** Whether the note already exists. */
  exists: boolean;
  /**
   * Create the note and return it. Delegates to the Daily Notes /
   * Periodic Notes plugin API when available (so the user's template +
   * {{date}}/{{title}} interpolations run); falls back to an empty file
   * at the ISO path under the vault root when neither plugin is on.
   * Callers check `exists` first and only call `create()` when needed.
   */
  create(): Promise<TFile>;
}

/**
 * Path / existence / creation seam for a periodic note. The 3 tools compose:
 *   get_or_create_*       -> resolve -> exists ? read : create()+read
 *   append_to_periodic_*  -> resolve -> (create() if !exists) -> append
 *
 * Plugin detection at call time:
 *   app.internalPlugins.plugins["daily-notes"]  (core)
 *   app.plugins.plugins["periodic-notes"]       (community)
 *
 * Matrix (ADR-0002): Daily ON -> daily via its API; Periodic ON -> all
 * periods via its API; both OFF -> vault root + ISO path + empty file.
 *
 * `date` is period-specific ISO (YYYY-MM-DD / YYYY-Www / YYYY-MM /
 * YYYY-QN / YYYY), default = period containing today. Tools validate the
 * regex before calling; the detector trusts a well-formed value.
 */
export function resolvePeriodicNote(
  app: App,
  period: PeriodType,
  date?: string,
): ResolvedPeriodicNote {
  const dateStr = date ?? defaultIsoForPeriod(period);
  const m = parsePeriodicDate(period, dateStr);
  const pluginOn = pluginLoadedFor(period);
  const settings = pluginOn ? settingsFor(period) : null;
  const path = computePath(period, m, settings);

  // Folder-vs-file guard via duck-type per `appendToVaultFile.ts` — and per
  // Stefano's heads-up on PR #2: `instanceof TFile` is always false under
  // the test mock (synthetic `TFile` is an empty class), so use null-check
  // + `children !== undefined` for "is a folder".
  const existing = app.vault.getAbstractFileByPath(path);
  const exists =
    existing != null &&
    (existing as { children?: unknown }).children === undefined;

  return {
    path,
    exists,
    create: async () => {
      if (pluginOn) {
        // Plugin-delegation path: the lib computes its own path from the
        // same settings + format we read above, applies the configured
        // template, and runs `{{date}}` / `{{title}}` interpolations.
        // Returned TFile lives at the same path the tool already exposed.
        return await createForPeriod(period, m);
      }
      // Fallback path: vault root + ISO format + empty file. Parent
      // folder is the vault root here (empty `settings.folder`), so the
      // ensure call is a no-op — kept for symmetry in case the fallback
      // ever evolves to a non-root folder.
      await ensureParentFolderExists(app, path);
      return await app.vault.create(path, "");
    },
  };
}

// ── Period <-> lib function dispatch ─────────────────────────────────────
//
// The shipped `obsidian-daily-notes-interface@0.9.4` .d.ts only declares
// the daily surface (`appHasDailyNotesPluginLoaded`, `createDailyNote`,
// etc.), but the runtime ships the full per-period set
// (`appHasWeeklyNotesPluginLoaded`, `createWeeklyNote`, …). Cast the
// import as a typed bag — same pattern CLAUDE.md prescribes for stale /
// runtime-only Obsidian APIs (`listTags.ts:30` cast for `getTags`).

interface PeriodicNoteSettings {
  folder?: string;
  format?: string;
  template?: string;
}

interface PeriodicNotesLibRuntime {
  appHasDailyNotesPluginLoaded: () => boolean;
  appHasWeeklyNotesPluginLoaded: () => boolean;
  appHasMonthlyNotesPluginLoaded: () => boolean;
  appHasQuarterlyNotesPluginLoaded: () => boolean;
  appHasYearlyNotesPluginLoaded: () => boolean;
  getDailyNoteSettings: () => PeriodicNoteSettings;
  getWeeklyNoteSettings: () => PeriodicNoteSettings;
  getMonthlyNoteSettings: () => PeriodicNoteSettings;
  getQuarterlyNoteSettings: () => PeriodicNoteSettings;
  getYearlyNoteSettings: () => PeriodicNoteSettings;
  createDailyNote: (date: Moment) => Promise<TFile>;
  createWeeklyNote: (date: Moment) => Promise<TFile>;
  createMonthlyNote: (date: Moment) => Promise<TFile>;
  createQuarterlyNote: (date: Moment) => Promise<TFile>;
  createYearlyNote: (date: Moment) => Promise<TFile>;
}

const lib = periodicNotesLib as unknown as PeriodicNotesLibRuntime;

function pluginLoadedFor(period: PeriodType): boolean {
  switch (period) {
    case "daily":
      return lib.appHasDailyNotesPluginLoaded();
    case "weekly":
      return lib.appHasWeeklyNotesPluginLoaded();
    case "monthly":
      return lib.appHasMonthlyNotesPluginLoaded();
    case "quarterly":
      return lib.appHasQuarterlyNotesPluginLoaded();
    case "yearly":
      return lib.appHasYearlyNotesPluginLoaded();
  }
}

function settingsFor(period: PeriodType): PeriodicNoteSettings {
  switch (period) {
    case "daily":
      return lib.getDailyNoteSettings();
    case "weekly":
      return lib.getWeeklyNoteSettings();
    case "monthly":
      return lib.getMonthlyNoteSettings();
    case "quarterly":
      return lib.getQuarterlyNoteSettings();
    case "yearly":
      return lib.getYearlyNoteSettings();
  }
}

function createForPeriod(period: PeriodType, m: Moment): Promise<TFile> {
  switch (period) {
    case "daily":
      return lib.createDailyNote(m);
    case "weekly":
      return lib.createWeeklyNote(m);
    case "monthly":
      return lib.createMonthlyNote(m);
    case "quarterly":
      return lib.createQuarterlyNote(m);
    case "yearly":
      return lib.createYearlyNote(m);
  }
}

// ── Date format defaults + parsing ───────────────────────────────────────
//
// Period-specific ISO formats. The detector uses these only as the
// *fallback* format when no plugin is on; if a plugin is enabled, the
// plugin's configured `format` (e.g. `DD-MM-YYYY` for daily) is used
// instead, so a vault with a custom format keeps resolving against the
// same path the Obsidian UI uses.

const DEFAULT_FORMAT_BY_PERIOD: Record<PeriodType, string> = {
  daily: "YYYY-MM-DD",
  // ISO 8601 week dates use the `GGGG-[W]WW` moment format (uppercase G/W
  // for ISO week-year and ISO week-of-year). `YYYY` would round to the
  // calendar year and break the year-boundary case (e.g. 2026-01-01 is in
  // ISO week 2025-W53 on some calendars).
  weekly: "GGGG-[W]WW",
  monthly: "YYYY-MM",
  // moment has no native `Q` quarter token in `format()` that matches the
  // bare digit form we want (`YYYY-Q3`). `[Q]Q` quotes the literal `Q`
  // then emits the quarter digit (1-4).
  quarterly: "YYYY-[Q]Q",
  yearly: "YYYY",
};

/**
 * Per-period ISO regex for `date?` arguments. Shape match only — semantic
 * validity (Feb 30, month 13, ISO-week 99) is rejected by
 * `isValidPeriodicDate` below via moment's strict-mode parse.
 */
export const DATE_REGEX_BY_PERIOD: Record<PeriodType, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-W\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
  quarterly: /^\d{4}-Q[1-4]$/,
  yearly: /^\d{4}$/,
};

/**
 * Semantic validity check on a period-specific date string. Returns false
 * for shape mismatch OR impossible values (e.g. `2026-02-30` → daily, or
 * `2026-W99` → weekly). Tools should run `DATE_REGEX_BY_PERIOD` first for
 * the shape check (clearer error), then this for the value check.
 */
export function isValidPeriodicDate(
  period: PeriodType,
  dateStr: string,
): boolean {
  if (!DATE_REGEX_BY_PERIOD[period].test(dateStr)) return false;
  return parsePeriodicDate(period, dateStr).isValid();
}

function parsePeriodicDate(period: PeriodType, dateStr: string): Moment {
  switch (period) {
    case "daily":
      return moment(dateStr, "YYYY-MM-DD", true);
    case "weekly":
      return moment(dateStr, "GGGG-[W]WW", true);
    case "monthly":
      return moment(dateStr, "YYYY-MM", true);
    case "quarterly": {
      // moment cannot parse `YYYY-QN` directly (`Q` is output-only in
      // older versions); split and seed the moment manually.
      const m = /^(\d{4})-Q([1-4])$/.exec(dateStr);
      if (!m) return moment.invalid();
      return moment()
        .year(parseInt(m[1], 10))
        .quarter(parseInt(m[2], 10))
        .startOf("quarter");
    }
    case "yearly":
      return moment(dateStr, "YYYY", true);
  }
}

function defaultIsoForPeriod(period: PeriodType): string {
  const now = moment();
  switch (period) {
    case "daily":
      return now.format("YYYY-MM-DD");
    case "weekly":
      return now.format("GGGG-[W]WW");
    case "monthly":
      return now.format("YYYY-MM");
    case "quarterly":
      return `${now.format("YYYY")}-Q${now.quarter()}`;
    case "yearly":
      return now.format("YYYY");
  }
}

function computePath(
  period: PeriodType,
  m: Moment,
  settings: PeriodicNoteSettings | null,
): string {
  const format = settings?.format ?? DEFAULT_FORMAT_BY_PERIOD[period];
  // Trim leading/trailing slashes so a settings folder of `Daily/` or
  // `/Daily` both resolve to `Daily/<filename>.md` — matches Obsidian UI
  // tolerance for folder-setting whitespace.
  const folder = (settings?.folder ?? "").replace(/^\/+|\/+$/g, "").trim();
  const filename = `${m.format(format)}.md`;
  return folder ? `${folder}/${filename}` : filename;
}

/**
 * Human-readable expected date format for a period, used in the
 * `invalid_date_for_period` error message. Shared by the periodic-note
 * tools so the wording stays in one place.
 */
export function describeFormat(period: PeriodType): string {
  switch (period) {
    case "daily":
      return "`YYYY-MM-DD`";
    case "weekly":
      return "`YYYY-Www` (ISO week, e.g. `2026-W21`)";
    case "monthly":
      return "`YYYY-MM`";
    case "quarterly":
      return "`YYYY-QN` (N=1-4)";
    case "yearly":
      return "`YYYY`";
  }
}
