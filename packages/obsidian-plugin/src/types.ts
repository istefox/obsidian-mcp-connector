declare module "obsidian" {
  interface McpToolsPluginSettings {
    version?: string;
  }

  interface Plugin {
    loadData(): Promise<McpToolsPluginSettings>;
    saveData(data: McpToolsPluginSettings): Promise<void>;
  }
}

// Augmentation for obsidian-daily-notes-interface@0.9.4, whose .d.ts only
// ships the daily surface. The weekly/monthly/quarterly/yearly functions exist
// at runtime (shipped since the Periodic Notes plugin era) but are missing
// from upstream declarations.
declare module "obsidian-daily-notes-interface" {
  export interface PeriodicNoteSettings {
    folder?: string;
    format?: string;
    template?: string;
  }

  export function appHasDailyNotesPluginLoaded(): boolean;
  export function appHasWeeklyNotesPluginLoaded(): boolean;
  export function appHasMonthlyNotesPluginLoaded(): boolean;
  export function appHasQuarterlyNotesPluginLoaded(): boolean;
  export function appHasYearlyNotesPluginLoaded(): boolean;

  export function getDailyNoteSettings(): PeriodicNoteSettings;
  export function getWeeklyNoteSettings(): PeriodicNoteSettings;
  export function getMonthlyNoteSettings(): PeriodicNoteSettings;
  export function getQuarterlyNoteSettings(): PeriodicNoteSettings;
  export function getYearlyNoteSettings(): PeriodicNoteSettings;

  export function createDailyNote(
    date: import("moment").Moment,
  ): Promise<import("obsidian").TFile>;
  export function createWeeklyNote(
    date: import("moment").Moment,
  ): Promise<import("obsidian").TFile>;
  export function createMonthlyNote(
    date: import("moment").Moment,
  ): Promise<import("obsidian").TFile>;
  export function createQuarterlyNote(
    date: import("moment").Moment,
  ): Promise<import("obsidian").TFile>;
  export function createYearlyNote(
    date: import("moment").Moment,
  ): Promise<import("obsidian").TFile>;
}

export {};
