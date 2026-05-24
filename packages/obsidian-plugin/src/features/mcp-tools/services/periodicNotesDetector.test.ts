import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockPeriodicNotesPlugin,
} from "$/test-setup";
import {
  DATE_REGEX_BY_PERIOD,
  isValidPeriodicDate,
  type PeriodType,
  resolvePeriodicNote,
} from "$/features/mcp-tools/services/periodicNotesDetector";

describe("periodicNotesDetector", () => {
  beforeEach(() => {
    resetMockVault();
  });

  describe("DATE_REGEX_BY_PERIOD shape match", () => {
    test("matches well-shaped ISO strings per period", () => {
      expect(DATE_REGEX_BY_PERIOD.daily.test("2026-05-22")).toBe(true);
      expect(DATE_REGEX_BY_PERIOD.weekly.test("2026-W21")).toBe(true);
      expect(DATE_REGEX_BY_PERIOD.monthly.test("2026-05")).toBe(true);
      expect(DATE_REGEX_BY_PERIOD.quarterly.test("2026-Q2")).toBe(true);
      expect(DATE_REGEX_BY_PERIOD.yearly.test("2026")).toBe(true);
    });

    test("rejects shape mismatches", () => {
      expect(DATE_REGEX_BY_PERIOD.daily.test("2026/05/22")).toBe(false);
      expect(DATE_REGEX_BY_PERIOD.weekly.test("2026-21")).toBe(false);
      expect(DATE_REGEX_BY_PERIOD.quarterly.test("2026-Q5")).toBe(false);
      expect(DATE_REGEX_BY_PERIOD.yearly.test("26")).toBe(false);
    });
  });

  describe("isValidPeriodicDate semantic check", () => {
    test("accepts real calendar values across all periods", () => {
      expect(isValidPeriodicDate("daily", "2026-02-28")).toBe(true);
      expect(isValidPeriodicDate("weekly", "2026-W21")).toBe(true);
      expect(isValidPeriodicDate("monthly", "2026-12")).toBe(true);
      expect(isValidPeriodicDate("quarterly", "2026-Q4")).toBe(true);
      expect(isValidPeriodicDate("yearly", "2026")).toBe(true);
    });

    test("rejects impossible values that pass the shape regex", () => {
      // Feb 30 — shape OK, value invalid.
      expect(isValidPeriodicDate("daily", "2026-02-30")).toBe(false);
      // Month 13.
      expect(isValidPeriodicDate("monthly", "2026-13")).toBe(false);
      // ISO week 54.
      expect(isValidPeriodicDate("weekly", "2026-W54")).toBe(false);
    });

    test("rejects shape mismatch too (composes regex check)", () => {
      expect(isValidPeriodicDate("daily", "garbage")).toBe(false);
    });
  });

  describe("resolvePeriodicNote — fallback path (no plugins)", () => {
    test("daily resolves to root + YYYY-MM-DD path; exists=false when absent", () => {
      const app = mockApp();
      const r = resolvePeriodicNote(app, "daily", "2026-05-22");
      expect(r.path).toBe("2026-05-22.md");
      expect(r.exists).toBe(false);
    });

    test("daily exists=true when the file is present in the vault", () => {
      setMockFile("2026-05-22.md", "hello");
      const app = mockApp();
      const r = resolvePeriodicNote(app, "daily", "2026-05-22");
      expect(r.exists).toBe(true);
      expect(r.path).toBe("2026-05-22.md");
    });

    test("create() falls back to empty file at root", async () => {
      const app = mockApp();
      const r = resolvePeriodicNote(app, "daily", "2026-05-22");
      const file = await r.create();
      // MockTFile exposes .path; assert via the vault read so we go through
      // the same surface the production tool uses.
      expect(file).toBeTruthy();
      const reread = app.vault.getAbstractFileByPath("2026-05-22.md");
      expect(reread).not.toBeNull();
    });

    test.each([
      ["weekly", "2026-W21", "2026-W21.md"],
      ["monthly", "2026-05", "2026-05.md"],
      ["quarterly", "2026-Q2", "2026-Q2.md"],
      ["yearly", "2026", "2026.md"],
    ] as const)(
      "%s fallback path is root + ISO + .md",
      (period, date, expectedPath) => {
        const app = mockApp();
        const r = resolvePeriodicNote(app, period as PeriodType, date);
        expect(r.path).toBe(expectedPath);
        expect(r.exists).toBe(false);
      },
    );
  });

  describe("resolvePeriodicNote — plugin-on path", () => {
    test("daily uses plugin folder + format from settings", () => {
      setMockPeriodicNotesPlugin("daily", {
        loaded: true,
        folder: "Daily",
        format: "YYYY-MM-DD",
        template: "",
      });
      setMockFolder("Daily");
      const app = mockApp();
      const r = resolvePeriodicNote(app, "daily", "2026-05-22");
      expect(r.path).toBe("Daily/2026-05-22.md");
      expect(r.exists).toBe(false);
    });

    test("custom plugin format (DD-MM-YYYY) is honored", () => {
      setMockPeriodicNotesPlugin("daily", {
        loaded: true,
        folder: "Journal",
        format: "DD-MM-YYYY",
      });
      const app = mockApp();
      const r = resolvePeriodicNote(app, "daily", "2026-05-22");
      expect(r.path).toBe("Journal/22-05-2026.md");
    });

    test("create() delegates to plugin API and the file lands at the resolved path", async () => {
      setMockPeriodicNotesPlugin("daily", {
        loaded: true,
        folder: "Daily",
        format: "YYYY-MM-DD",
        template: "# Daily\n",
      });
      const app = mockApp();
      const r = resolvePeriodicNote(app, "daily", "2026-05-22");
      expect(r.exists).toBe(false);
      const file = await r.create();
      expect(file).toBeTruthy();
      // The mocked `createDailyNote` writes the template content into the
      // mock vault at the same path the detector computed — assert both.
      const at = app.vault.getAbstractFileByPath("Daily/2026-05-22.md");
      expect(at).not.toBeNull();
    });

    test("folder setting with leading/trailing slashes is normalized", () => {
      setMockPeriodicNotesPlugin("monthly", {
        loaded: true,
        folder: "/Monthly/",
        format: "YYYY-MM",
      });
      const app = mockApp();
      const r = resolvePeriodicNote(app, "monthly", "2026-05");
      expect(r.path).toBe("Monthly/2026-05.md");
    });

    test("folder-vs-file: a folder at the resolved path is NOT counted as exists", () => {
      // Simulate someone naming a folder identically to where a periodic note
      // would land. `exists` must be false — otherwise tools would try to
      // read a folder as a file.
      setMockFolder("2026-05-22.md");
      const app = mockApp();
      const r = resolvePeriodicNote(app, "daily", "2026-05-22");
      expect(r.exists).toBe(false);
    });

    test("weekly default format matches the detector at an ISO year boundary", async () => {
      // `2026-W53` is a real ISO week (its Monday is 2026-12-28), but the
      // *locale* week-year of that date is 2027-W01. If the mock's default
      // weekly format were `gggg-[W]ww` (locale) while the detector uses
      // `GGGG-[W]WW` (ISO), create() would land the file at `2027-W01.md`
      // while the detector resolves `2026-W53.md` — a silent path mismatch.
      // Both must use ISO. (Regression guard for the mock format.)
      setMockPeriodicNotesPlugin("weekly", { loaded: true, folder: "Weekly" });
      const app = mockApp();
      const r = resolvePeriodicNote(app, "weekly", "2026-W53");
      expect(r.path).toBe("Weekly/2026-W53.md");
      expect(r.exists).toBe(false);
      await r.create();
      expect(
        app.vault.getAbstractFileByPath("Weekly/2026-W53.md"),
      ).not.toBeNull();
    });
  });

  describe("resolvePeriodicNote — date default = today", () => {
    test("daily default produces a YYYY-MM-DD path that matches today's shape", () => {
      const app = mockApp();
      const r = resolvePeriodicNote(app, "daily");
      expect(r.path).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
    });

    test("weekly default produces YYYY-Www shape", () => {
      const app = mockApp();
      const r = resolvePeriodicNote(app, "weekly");
      expect(r.path).toMatch(/^\d{4}-W\d{2}\.md$/);
    });
  });
});
