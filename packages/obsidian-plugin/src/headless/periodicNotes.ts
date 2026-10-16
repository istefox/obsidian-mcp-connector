/**
 * Daily and periodic notes without Obsidian.
 *
 * On desktop the three periodic-note tools reach `obsidian-daily-notes-
 * interface`, which reads the core Daily notes plugin, the Periodic Notes
 * plugin and the Calendar plugin through the global `window.app`, and
 * creates notes with their template substitutions. Headless runs that same
 * library and gives it what it reads:
 *
 * - The vault's own files say which of those plugins are on and how they
 *   are set (`loadPeriodicNotesConfig`, read once at startup:
 *   `core-plugins.json`, `community-plugins.json`, `daily-notes.json` and
 *   the plugins' `data.json`). `periodicNotesMembers` shapes them as the
 *   library finds them on Obsidian's `App`: `internalPlugins`, `plugins`
 *   and a `foldManager` that remembers nothing.
 * - `exposeObsidianGlobals` sets the globals Obsidian has, `app` and
 *   `moment`. The bundle rewrites the library's `window` to `globalThis`
 *   (see bun.headless.config.ts), and a test, where `window` is already the
 *   global object, needs no rewrite.
 *
 * The `app` that is exposed is the guarded one, so every read and write the
 * library makes goes through the same folder exclusions as the tools: a
 * template in an excluded folder reads as missing, and a note is never
 * created in one. The guard asks for the policy of the request that is
 * running, which the library's calls happen under.
 *
 * A template is a note in the vault, read as text. Its `{{date}}`,
 * `{{time}}`, `{{title}}`, `{{yesterday}}`, `{{tomorrow}}` and weekday
 * placeholders are substituted by the library. No template engine runs, so
 * Templater syntax stays as written.
 */

import type { App } from "obsidian";
import type { PeriodType } from "$/features/mcp-tools/services/periodicNotesDetector";
import { moment } from "./obsidianShim";
import { readConfigJson } from "./vaultSettings";

/** What one period's settings file or plugin section may hold. */
type RawSettings = { folder?: unknown; format?: unknown; template?: unknown };

type PeriodSection = RawSettings & { enabled: boolean };

/** The plugin state the vault's files describe. */
export type PeriodicNotesConfig = {
  /** Core Daily notes plugin: present when enabled, with its options. */
  dailyNotes?: RawSettings;
  /** Periodic Notes plugin: present when enabled, one section per period. */
  periodicNotes?: Partial<Record<PeriodType, PeriodSection>>;
  /** Calendar plugin: present when enabled, with its weekly-note options. */
  calendar?: {
    weeklyNoteFormat?: unknown;
    weeklyNoteFolder?: unknown;
    weeklyNoteTemplate?: unknown;
  };
};

const PERIODS: readonly PeriodType[] = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `core-plugins.json` is a list of enabled ids, or a map of id to flag. */
function coreEnabled(json: unknown, id: string): boolean {
  if (Array.isArray(json)) return json.includes(id);
  return isRecord(json) && json[id] === true;
}

function communityEnabled(json: unknown, id: string): boolean {
  return Array.isArray(json) && json.includes(id);
}

/** The Periodic Notes plugin's `data.json`, keeping only the period sections. */
function parsePeriodicNotesData(
  json: unknown,
): Partial<Record<PeriodType, PeriodSection>> {
  const sections: Partial<Record<PeriodType, PeriodSection>> = {};
  if (!isRecord(json)) return sections;
  for (const period of PERIODS) {
    const section = json[period];
    if (isRecord(section)) {
      sections[period] = { ...section, enabled: Boolean(section.enabled) };
    }
  }
  return sections;
}

/**
 * Read which periodic-note plugins are on and their settings. A missing
 * or invalid file means that plugin is off, which is what makes every tool
 * fall back to an empty note named by ISO date at the vault root.
 */
export async function loadPeriodicNotesConfig(
  root: string,
  warn: (message: string) => void,
): Promise<PeriodicNotesConfig> {
  const config: PeriodicNotesConfig = {};
  const core = await readConfigJson(root, "core-plugins.json", warn);
  if (coreEnabled(core, "daily-notes")) {
    const options = await readConfigJson(root, "daily-notes.json", warn);
    config.dailyNotes = isRecord(options) ? options : {};
  }
  const community = await readConfigJson(root, "community-plugins.json", warn);
  if (communityEnabled(community, "periodic-notes")) {
    config.periodicNotes = parsePeriodicNotesData(
      await readConfigJson(root, "plugins/periodic-notes/data.json", warn),
    );
  }
  if (communityEnabled(community, "calendar")) {
    const options = await readConfigJson(
      root,
      "plugins/calendar/data.json",
      warn,
    );
    config.calendar = isRecord(options) ? options : {};
  }
  return config;
}

/**
 * The members of Obsidian's `App` the daily notes library reads, built from
 * the vault's configuration. Each is present where the plugin is on, as in
 * Obsidian, and absent where it is off.
 */
export function periodicNotesMembers(config: PeriodicNotesConfig) {
  const internal: Record<string, unknown> = {};
  if (config.dailyNotes !== undefined) {
    internal["daily-notes"] = {
      enabled: true,
      instance: { options: config.dailyNotes },
    };
  }
  const community: Record<string, unknown> = {};
  if (config.periodicNotes !== undefined) {
    community["periodic-notes"] = { settings: config.periodicNotes };
  }
  if (config.calendar !== undefined) {
    community["calendar"] = { options: config.calendar };
  }
  return {
    internalPlugins: {
      plugins: internal,
      getPluginById: (id: string): unknown => internal[id],
    },
    // `plugins.plugins` is what `search_vault` reads to find Dataview.
    plugins: {
      plugins: {} as Record<string, unknown>,
      getPlugin: (id: string): unknown => community[id] ?? null,
    },
    // Obsidian keeps a note's folded headings here. Nothing is folded.
    foldManager: { load: (): null => null, save: (): void => {} },
  };
}

/**
 * Set the globals the daily notes library reads, `app` and `moment`, as
 * Obsidian does. `app` should be the guarded one.
 */
export function exposeObsidianGlobals(app: App): void {
  Object.assign(globalThis, { app, moment });
}
