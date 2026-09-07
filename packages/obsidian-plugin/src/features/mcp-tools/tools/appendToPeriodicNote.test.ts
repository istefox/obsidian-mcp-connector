// See docs/architecture/ADR-0024-converge-anchor-matchers.md.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockPeriodicNotesPlugin,
} from "$/test-setup";
import { appendToPeriodicNoteHandler } from "./appendToPeriodicNote";

function parse(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("append_to_periodic_note", () => {
  beforeEach(() => {
    resetMockVault();
  });

  test("EOF append on existing daily note (default period)", async () => {
    setMockFile("2026-05-22.md", "first line\n");
    const app = mockApp();
    const res = await appendToPeriodicNoteHandler({
      arguments: { content: "- new bullet", date: "2026-05-22" },
      app,
    });
    expect(res.isError).toBeUndefined();
    const body = parse(res);
    expect(body.period).toBe("daily");
    expect(body.path).toBe("2026-05-22.md");
    expect(body.appended).toBe(true);
    expect(body.created).toBe(false);
    const file = app.vault.getAbstractFileByPath("2026-05-22.md");
    expect(file).not.toBeNull();
    const text = await app.vault.read(file as import("obsidian").TFile);
    expect(text).toContain("first line");
    expect(text).toContain("- new bullet");
  });

  test("EOF append on auto-created weekly note (fallback, period explicit)", async () => {
    const app = mockApp();
    const res = await appendToPeriodicNoteHandler({
      arguments: {
        period: "weekly",
        content: "## Highlights\n- shipped #159\n",
        date: "2026-W21",
      },
      app,
    });
    const body = parse(res);
    expect(body.period).toBe("weekly");
    expect(body.path).toBe("2026-W21.md");
    expect(body.created).toBe(true);
    const file = app.vault.getAbstractFileByPath("2026-W21.md");
    const text = await app.vault.read(file as import("obsidian").TFile);
    expect(text).toContain("Highlights");
  });

  test("monthly append under heading — section walk inserts at section end", async () => {
    setMockFile(
      "2026-05.md",
      "# Monthly\n\n## Highlights\nfirst\n\n## Next month\nplan\n",
    );
    const app = mockApp();
    const res = await appendToPeriodicNoteHandler({
      arguments: {
        period: "monthly",
        content: "second\n",
        date: "2026-05",
        underHeading: "Highlights",
      },
      app,
    });
    expect(res.isError).toBeUndefined();
    const file = app.vault.getAbstractFileByPath("2026-05.md");
    const text = await app.vault.read(file as import("obsidian").TFile);
    // Insert lands before the next sibling heading (Next month), after the
    // existing "first" line — same semantic as patch_vault_file "append".
    const idxFirst = text.indexOf("first");
    const idxSecond = text.indexOf("second");
    const idxNext = text.indexOf("## Next month");
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxSecond).toBeGreaterThan(idxFirst);
    expect(idxSecond).toBeLessThan(idxNext);
  });

  test("underHeading not found on auto-created note → heading_not_found, file IS left in place", async () => {
    const app = mockApp();
    const res = await appendToPeriodicNoteHandler({
      arguments: {
        period: "weekly",
        content: "would-be",
        date: "2026-W21",
        underHeading: "Highlights", // freshly auto-created file is empty — no heading
      },
      app,
    });
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.errorCode).toBe("heading_not_found");
    expect(body.created).toBe(true);
    // The file MUST still exist — strict-by-default no-rollback per ADR-0002.
    expect(app.vault.getAbstractFileByPath("2026-W21.md")).not.toBeNull();
  });

  test("plugin-on path — append after auto-create via plugin API + template", async () => {
    setMockPeriodicNotesPlugin("daily", {
      loaded: true,
      folder: "Daily",
      format: "YYYY-MM-DD",
      template: "## Today\n",
    });
    const app = mockApp();
    const res = await appendToPeriodicNoteHandler({
      arguments: {
        period: "daily",
        content: "- done #159",
        date: "2026-05-22",
        underHeading: "Today",
      },
      app,
    });
    expect(res.isError).toBeUndefined();
    const file = app.vault.getAbstractFileByPath("Daily/2026-05-22.md");
    const text = await app.vault.read(file as import("obsidian").TFile);
    expect(text).toContain("## Today");
    expect(text).toContain("- done #159");
  });

  test("invalid date → invalid_date_for_period (no file created)", async () => {
    const app = mockApp();
    const res = await appendToPeriodicNoteHandler({
      arguments: { period: "daily", content: "x", date: "bad" },
      app,
    });
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.errorCode).toBe("invalid_date_for_period");
    expect(app.vault.getAbstractFileByPath("bad.md")).toBeNull();
  });
});

describe("append_to_periodic_note — converged heading targets", () => {
  beforeEach(() => {
    resetMockVault();
  });

  test("R-01/R-03: resolves underHeading case-insensitively", async () => {
    setMockFile("2026-09-07.md", "# Top\n\n## Section A\n\nold\n");
    const app = mockApp();
    const result = await appendToPeriodicNoteHandler({
      arguments: {
        period: "daily",
        date: "2026-09-07",
        underHeading: "section a",
        content: "patched",
      },
      app,
    });

    expect(result.isError).toBeUndefined();
    const file = app.vault.getAbstractFileByPath("2026-09-07.md");
    if (!file) throw new Error("expected file");
    const final = await app.vault.read(file as import("obsidian").TFile);
    expect(final.indexOf("patched")).toBeGreaterThan(final.indexOf("old"));
  });

  test("R-04: explicit nested path appends only inside the matching ancestor branch", async () => {
    setMockFile(
      "2026-09-07.md",
      "# A\n\n## X\n\nfromA\n\n# B\n\n## X\n\nfromB\n",
    );
    const app = mockApp();
    const result = await appendToPeriodicNoteHandler({
      arguments: {
        period: "daily",
        date: "2026-09-07",
        underHeading: "B::X",
        content: "patchedB",
      },
      app,
    });

    expect(result.isError).toBeUndefined();
    const file = app.vault.getAbstractFileByPath("2026-09-07.md");
    if (!file) throw new Error("expected file");
    const final = await app.vault.read(file as import("obsidian").TFile);
    expect(final).toContain("# A\n\n## X\n\nfromA");
    expect(final.indexOf("patchedB")).toBeGreaterThan(final.indexOf("# B"));
    expect(final.indexOf("patchedB")).toBeGreaterThan(final.indexOf("fromB"));
  });

  test("R-05: ambiguous same-level underHeading errors without changing the file", async () => {
    const fixture = "# A\n\n## Notes\n\nfirst\n\n# B\n\n## Notes\n\nsecond\n";
    setMockFile("2026-09-07.md", fixture);
    const app = mockApp();
    const result = await appendToPeriodicNoteHandler({
      arguments: {
        period: "daily",
        date: "2026-09-07",
        underHeading: "Notes",
        content: "must-not-write",
      },
      app,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Ambiguous heading target");
    const file = app.vault.getAbstractFileByPath("2026-09-07.md");
    if (!file) throw new Error("expected file");
    expect(await app.vault.read(file as import("obsidian").TFile)).toBe(
      fixture,
    );
  });
});
