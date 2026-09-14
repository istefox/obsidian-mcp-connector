import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockPeriodicNotesPlugin,
} from "$/test-setup";
import { getOrCreateDailyNoteHandler } from "./getOrCreateDailyNote";

function parse(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("get_or_create_daily_note", () => {
  beforeEach(() => {
    resetMockVault();
  });

  test("happy path — creates from scratch in fallback mode, returns created=true + empty content", async () => {
    const app = mockApp();
    const res = await getOrCreateDailyNoteHandler({
      arguments: { date: "2026-05-22" },
      app,
    });
    expect(res.isError).toBeUndefined();
    const body = parse(res);
    expect(body.path).toBe("2026-05-22.md");
    expect(body.created).toBe(true);
    expect(body.content).toBe("");
    expect(body.uri).toBe(
      "obsidian://open?vault=Test%20Vault&file=2026-05-22.md",
    );
    // File must exist in the vault after.
    expect(app.vault.getAbstractFileByPath("2026-05-22.md")).not.toBeNull();
  });

  test("happy path — returns existing without re-creating", async () => {
    setMockFile("2026-05-22.md", "yesterday's notes");
    const app = mockApp();
    const res = await getOrCreateDailyNoteHandler({
      arguments: { date: "2026-05-22" },
      app,
    });
    expect(res.isError).toBeUndefined();
    const body = parse(res);
    expect(body.created).toBe(false);
    expect(body.content).toBe("yesterday's notes");
  });

  test("plugin-on path — uses plugin folder/format and seeds template content", async () => {
    setMockPeriodicNotesPlugin("daily", {
      loaded: true,
      folder: "Daily",
      format: "YYYY-MM-DD",
      template: "## Daily plan\n",
    });
    const app = mockApp();
    const res = await getOrCreateDailyNoteHandler({
      arguments: { date: "2026-05-22" },
      app,
    });
    const body = parse(res);
    expect(body.path).toBe("Daily/2026-05-22.md");
    expect(body.created).toBe(true);
    expect(body.content).toBe("## Daily plan\n");
  });

  test("default date — returns today's path even when no `date` is passed", async () => {
    const app = mockApp();
    const res = await getOrCreateDailyNoteHandler({ arguments: {}, app });
    const body = parse(res);
    expect(body.path).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
    expect(body.created).toBe(true);
  });

  test("invalid date format → invalid_date_for_period (shape)", async () => {
    const app = mockApp();
    const res = await getOrCreateDailyNoteHandler({
      arguments: { date: "22/05/2026" },
      app,
    });
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.errorCode).toBe("invalid_date_for_period");
    expect(body.period).toBe("daily");
  });

  test("invalid date value (Feb 30) → invalid_date_for_period (semantic)", async () => {
    const app = mockApp();
    const res = await getOrCreateDailyNoteHandler({
      arguments: { date: "2026-02-30" },
      app,
    });
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.errorCode).toBe("invalid_date_for_period");
  });

  describe("heading input (ADR-0026 D7-D9, R-01, R-04, R-05)", () => {
    test("heading matching a heading in a template-seeded just-created note resolves via content-first, even with an empty cache", async () => {
      setMockPeriodicNotesPlugin("daily", {
        loaded: true,
        folder: "Daily",
        format: "YYYY-MM-DD",
        template: "## Daily plan\n",
      });
      const app = mockApp();
      const res = await getOrCreateDailyNoteHandler({
        arguments: { date: "2026-05-22", heading: "Daily plan" },
        app,
      });
      expect(res.isError).toBeUndefined();
      const body = parse(res);
      expect(body.created).toBe(true);
      expect(body.uri).toBe(
        "obsidian://open?vault=Test%20Vault&file=Daily%2F2026-05-22.md%23Daily%20plan",
      );
    });

    test("heading absent → heading_not_found naming heading + path; note is still created", async () => {
      const app = mockApp();
      const res = await getOrCreateDailyNoteHandler({
        arguments: { date: "2026-05-22", heading: "Nope" },
        app,
      });
      expect(res.isError).toBe(true);
      const body = parse(res);
      expect(body.errorCode).toBe("heading_not_found");
      expect(body.heading).toBe("Nope");
      expect(body.path).toBe("2026-05-22.md");
      // The error happens AFTER create — the note still exists.
      expect(app.vault.getAbstractFileByPath("2026-05-22.md")).not.toBeNull();
    });
  });
});
