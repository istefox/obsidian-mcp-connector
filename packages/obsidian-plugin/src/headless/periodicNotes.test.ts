import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import moment from "moment";
import type { App } from "obsidian";
import * as mocked from "obsidian";
import { createRequire } from "node:module";
import * as mockedLib from "obsidian-daily-notes-interface";
import { createGuardedApp } from "$/shared/guardedApp";
import { compilePolicy } from "$/shared/pathPolicy";
import { createHeadlessApp } from "./headlessApp";
import * as shim from "./obsidianShim";
import {
  exposeObsidianGlobals,
  loadPeriodicNotesConfig,
  periodicNotesMembers,
} from "./periodicNotes";

type Tools = {
  daily: typeof import("$/features/mcp-tools/tools/getOrCreateDailyNote");
  periodic: typeof import("$/features/mcp-tools/tools/getOrCreatePeriodicNote");
  append: typeof import("$/features/mcp-tools/tools/appendToPeriodicNote");
};
type Lib = typeof import("obsidian-daily-notes-interface");

const original = { ...mocked };
const originalLib = { ...mockedLib };
let tools: Tools;
let lib: Lib;

/**
 * The daily notes library itself. The unit-test preload replaces it with a
 * stub, so it is evaluated here from its file, against the `obsidian`
 * module of this test. It reads `window.app` and `window.moment`, which
 * `exposeObsidianGlobals` sets (`window` is the global object in tests).
 */
function loadRealLibrary(obsidian: unknown): Lib {
  const file = createRequire(import.meta.url).resolve(
    "obsidian-daily-notes-interface",
  );
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", fs.readFileSync(file, "utf8"))(
    (id: string) => {
      if (id === "obsidian") return obsidian;
      throw new Error(`unexpected require: ${id}`);
    },
    module,
    module.exports,
  );
  return module.exports as unknown as Lib;
}

beforeAll(async () => {
  // The tools test `instanceof TFile`, so they need the headless classes.
  const obsidian = {
    ...original,
    TFile: shim.TFile,
    TFolder: shim.TFolder,
    normalizePath: shim.normalizePath,
  };
  void mock.module("obsidian", () => obsidian);
  lib = loadRealLibrary(obsidian);
  void mock.module("obsidian-daily-notes-interface", () => lib);
  tools = {
    daily: await import("$/features/mcp-tools/tools/getOrCreateDailyNote"),
    periodic:
      await import("$/features/mcp-tools/tools/getOrCreatePeriodicNote"),
    append: await import("$/features/mcp-tools/tools/appendToPeriodicNote"),
  };
});
afterAll(() => {
  void mock.module("obsidian", () => original);
  void mock.module("obsidian-daily-notes-interface", () => originalLib);
  for (const name of ["app", "moment"]) delete (globalThis as never)[name];
});

let dir: string;
let root: string;
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(root, rel));
const config = (rel: string, value: unknown) =>
  write(`.obsidian/${rel}`, JSON.stringify(value));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-periodic-"));
  root = path.join(dir, "vault");
  fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Result = { content: Array<{ text: string }>; isError?: boolean };
const json = (r: Result) => JSON.parse(r.content[0].text);

/**
 * Run `fn` with the app the tools receive in production: the raw one behind
 * a policy that excludes `folders`, which is also the `app` the library
 * reads.
 */
async function withApp<T>(
  fn: (app: App) => Promise<T>,
  folders: string[] = [],
): Promise<T> {
  const { app, close } = await createHeadlessApp(root);
  try {
    const guarded = createGuardedApp(app, () => compilePolicy(folders));
    exposeObsidianGlobals(guarded);
    return await fn(guarded);
  } finally {
    close();
  }
}

describe("loadPeriodicNotesConfig", () => {
  const load = async () => {
    const warnings: string[] = [];
    const loaded = await loadPeriodicNotesConfig(root, (m) => warnings.push(m));
    return { loaded, warnings };
  };

  test("a vault with no settings has every plugin off", async () => {
    expect(await load()).toEqual({ loaded: {}, warnings: [] });
  });

  test("the core Daily notes plugin, listed as enabled ids", async () => {
    config("core-plugins.json", ["file-explorer", "daily-notes"]);
    config("daily-notes.json", { folder: "Journal", format: "DD-MM-YYYY" });
    expect((await load()).loaded).toEqual({
      dailyNotes: { folder: "Journal", format: "DD-MM-YYYY" },
    });
  });

  test("the core Daily notes plugin, as a map of flags", async () => {
    config("core-plugins.json", { "daily-notes": true, templates: false });
    expect((await load()).loaded).toEqual({ dailyNotes: {} });
  });

  test("a disabled core plugin ignores its settings file", async () => {
    config("core-plugins.json", ["file-explorer"]);
    config("daily-notes.json", { folder: "Journal" });
    expect((await load()).loaded).toEqual({});
    config("core-plugins.json", { "daily-notes": false });
    expect((await load()).loaded).toEqual({});
  });

  test("the Periodic Notes plugin, with its enabled flags", async () => {
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      daily: { enabled: true, folder: "D", format: "YYYYMMDD" },
      weekly: { enabled: false, folder: "W" },
      monthly: "not an object",
      showGettingStartedBanner: false,
    });
    expect((await load()).loaded).toEqual({
      periodicNotes: {
        daily: { enabled: true, folder: "D", format: "YYYYMMDD" },
        weekly: { enabled: false, folder: "W" },
      },
    });
  });

  test("settings of a plugin that is not enabled are not read", async () => {
    config("community-plugins.json", ["calendar"]);
    config("plugins/periodic-notes/data.json", { daily: { enabled: true } });
    expect((await load()).loaded).toEqual({ calendar: {} });
  });

  test("an enabled Periodic Notes plugin without data has every period off", async () => {
    config("community-plugins.json", ["periodic-notes"]);
    expect((await load()).loaded).toEqual({ periodicNotes: {} });
  });

  test("the Calendar plugin's weekly options", async () => {
    config("community-plugins.json", ["calendar"]);
    config("plugins/calendar/data.json", { weeklyNoteFolder: "Wk" });
    expect((await load()).loaded).toEqual({
      calendar: { weeklyNoteFolder: "Wk" },
    });
  });

  test("an invalid file counts as missing and warns once", async () => {
    write(".obsidian/core-plugins.json", "[oops");
    config("community-plugins.json", ["periodic-notes"]);
    write(".obsidian/plugins/periodic-notes/data.json", "{");
    const { loaded, warnings } = await load();
    expect(loaded).toEqual({ periodicNotes: {} });
    expect(warnings).toEqual([
      "Ignoring .obsidian/core-plugins.json: it is not valid JSON",
      "Ignoring .obsidian/plugins/periodic-notes/data.json: it is not valid JSON",
    ]);
  });
});

describe("what the library finds on the app", () => {
  /** The library's answers for a vault, through the real library. */
  async function ask() {
    const { app, close } = await createHeadlessApp(root);
    exposeObsidianGlobals(app);
    const answers = {
      loaded: {
        daily: lib.appHasDailyNotesPluginLoaded(),
        weekly: lib.appHasWeeklyNotesPluginLoaded(),
        monthly: lib.appHasMonthlyNotesPluginLoaded(),
        quarterly: lib.appHasQuarterlyNotesPluginLoaded(),
        yearly: lib.appHasYearlyNotesPluginLoaded(),
      },
      settings: {
        daily: lib.getDailyNoteSettings(),
        weekly: lib.getWeeklyNoteSettings(),
        monthly: lib.getMonthlyNoteSettings(),
        quarterly: lib.getQuarterlyNoteSettings(),
        yearly: lib.getYearlyNoteSettings(),
      },
    };
    close();
    return answers;
  }
  const falsy = (value: unknown) => !value;

  test("a vault with no settings has every plugin off and the library's defaults", async () => {
    const { loaded, settings } = await ask();
    expect(Object.values(loaded).every(falsy)).toBe(true);
    expect(settings.daily).toEqual({
      format: "YYYY-MM-DD",
      folder: "",
      template: "",
    });
    expect(settings.weekly.format).toBe("gggg-[W]ww");
    expect(settings.monthly.format).toBe("YYYY-MM");
    expect(settings.quarterly.format).toBe("YYYY-[Q]Q");
    expect(settings.yearly.format).toBe("YYYY");
  });

  test("the core Daily notes plugin serves daily only, with trimmed settings", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", {
      folder: "  Journal ",
      template: " T ",
      format: "",
    });
    const { loaded, settings } = await ask();
    expect(loaded.daily).toBe(true);
    expect(Object.entries(loaded).filter(([, on]) => on)).toHaveLength(1);
    expect(settings.daily).toEqual({
      format: "YYYY-MM-DD",
      folder: "Journal",
      template: "T",
    });
  });

  test("an enabled Periodic Notes section wins over the core plugin and Calendar", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { folder: "Core" });
    config("community-plugins.json", ["periodic-notes", "calendar"]);
    config("plugins/calendar/data.json", { weeklyNoteFolder: "Cal" });
    config("plugins/periodic-notes/data.json", {
      daily: { enabled: true, folder: "Periodic" },
      weekly: { enabled: true, folder: "PeriodicWeekly" },
      monthly: { enabled: false, folder: "Off" },
      yearly: { enabled: true },
    });
    const { loaded, settings } = await ask();
    expect(settings.daily.folder).toBe("Periodic");
    expect(settings.weekly.folder).toBe("PeriodicWeekly");
    expect(loaded.monthly).toBeFalsy();
    expect(loaded.yearly).toBeTruthy();
  });

  test("a Periodic Notes section that is off falls back to the core plugin and Calendar", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { folder: "Core" });
    config("community-plugins.json", ["periodic-notes", "calendar"]);
    config("plugins/calendar/data.json", { weeklyNoteFolder: "Cal" });
    config("plugins/periodic-notes/data.json", {
      daily: { enabled: false, folder: "Periodic" },
      weekly: { enabled: false },
    });
    const { settings } = await ask();
    expect(settings.daily.folder).toBe("Core");
    expect(settings.weekly.folder).toBe("Cal");
  });

  test("the Calendar plugin alone serves weekly notes", async () => {
    config("community-plugins.json", ["calendar"]);
    config("plugins/calendar/data.json", { weeklyNoteFormat: "[W]WW-GGGG" });
    const { loaded, settings } = await ask();
    expect(loaded.weekly).toBeTruthy();
    expect(loaded.daily).toBeFalsy();
    expect(settings.weekly.format).toBe("[W]WW-GGGG");
  });

  test("a plugin that is not enabled is not asked about its settings file", async () => {
    config("plugins/periodic-notes/data.json", { daily: { enabled: true } });
    const { loaded } = await ask();
    expect(Object.values(loaded).every(falsy)).toBe(true);
  });

  test("the members are the ones the library reads, and nothing is folded", () => {
    const members = periodicNotesMembers({ dailyNotes: { folder: "J" } });
    expect(members.internalPlugins.getPluginById("daily-notes")).toMatchObject({
      enabled: true,
      instance: { options: { folder: "J" } },
    });
    expect(members.internalPlugins.getPluginById("templates")).toBeUndefined();
    expect(members.plugins.getPlugin("periodic-notes")).toBeNull();
    expect(members.foldManager.load()).toBeNull();
  });
});

describe("get_or_create_daily_note", () => {
  test("without any plugin: an empty note at the ISO path, then read back", async () => {
    await withApp(async (app) => {
      const first = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(first).toMatchObject({
        path: "2026-03-15.md",
        content: "",
        created: true,
      });
      expect(read("2026-03-15.md")).toBe("");
      write("2026-03-15.md", "later");
      const second = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(second.created).toBe(false);
    });
  });

  test("with the core plugin: folder, nested format and template substitution", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", {
      folder: "/Journal/",
      format: "YYYY/MM/DD",
      template: "Templates/Daily",
    });
    write(
      "Templates/Daily.md",
      "# {{title}}\n{{date:dddd}} {{tomorrow}}\n{{time}}\n<% tp.date.now() %>\n",
    );
    await withApp(async (app) => {
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(out.path).toBe("Journal/2026/03/15.md");
      expect(out.created).toBe(true);
      expect(read("Journal/2026/03/15.md")).toMatch(
        /^# 2026\/03\/15\nSunday 2026\/03\/16\n\d\d:\d\d\n<% tp\.date\.now\(\) %>\n$/,
      );
      expect(out.content).toBe(read("Journal/2026/03/15.md"));
    });
  });

  test("a template that cannot be read gives an empty note", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { template: "Templates/Missing" });
    await withApp(async (app) => {
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(out).toMatchObject({ path: "2026-03-15.md", content: "" });
    });
  });

  test("with the Periodic Notes plugin on daily, its settings replace the core plugin's", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { folder: "Core" });
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      daily: { enabled: true, folder: "PN", format: "YYYYMMDD" },
    });
    await withApp(async (app) => {
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(out.path).toBe("PN/20260315.md");
    });
  });

  test("a plugin that is installed but off changes nothing", async () => {
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      daily: { enabled: false, folder: "PN" },
    });
    await withApp(async (app) => {
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(out.path).toBe("2026-03-15.md");
    });
  });

  test("without a date it uses today on the host clock", async () => {
    await withApp(async (app) => {
      const before = moment().format("YYYY-MM-DD");
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({ arguments: {}, app }),
      );
      const after = moment().format("YYYY-MM-DD");
      // A run that crosses midnight may land on either day.
      expect([`${before}.md`, `${after}.md`]).toContain(out.path);
    });
  });
});

describe("the guarded app", () => {
  test("a template in an excluded folder reads as missing: nothing of it is copied", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { template: "Secret/Template" });
    write("Secret/Template.md", "TOP SECRET {{title}}");
    await withApp(
      async (app) => {
        const out = json(
          await tools.daily.getOrCreateDailyNoteHandler({
            arguments: { date: "2026-03-15" },
            app,
          }),
        );
        expect(out).toMatchObject({ path: "2026-03-15.md", content: "" });
        expect(read("2026-03-15.md")).toBe("");
        expect(read("Secret/Template.md")).toBe("TOP SECRET {{title}}");
      },
      ["Secret"],
    );
  });

  test("the same template is used when its folder is not excluded", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { template: "Secret/Template" });
    write("Secret/Template.md", "TOP SECRET {{title}}");
    await withApp(
      async (app) => {
        const out = json(
          await tools.daily.getOrCreateDailyNoteHandler({
            arguments: { date: "2026-03-15" },
            app,
          }),
        );
        expect(out.content).toBe("TOP SECRET 2026-03-15");
      },
      ["Other"],
    );
  });

  test("a destination in an excluded folder is refused before anything is written", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { folder: "Secret/Journal" });
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      weekly: { enabled: true, folder: "Secret/Weeks" },
    });
    await withApp(
      async (app) => {
        await expect(
          tools.daily.getOrCreateDailyNoteHandler({
            arguments: { date: "2026-03-15" },
            app,
          }),
        ).rejects.toThrow();
        await expect(
          tools.periodic.getOrCreatePeriodicNoteHandler({
            arguments: { period: "weekly", date: "2026-W11" },
            app,
          }),
        ).rejects.toThrow();
        await expect(
          tools.append.appendToPeriodicNoteHandler({
            arguments: { content: "x", date: "2026-03-15" },
            app,
          }),
        ).rejects.toThrow();
        expect(exists("Secret")).toBe(false);
      },
      ["Secret"],
    );
  });

  test("a note that already exists in an excluded folder is never read", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { folder: "Secret/Journal" });
    write("Secret/Journal/2026-03-15.md", "PRIVATE");
    await withApp(
      async (app) => {
        // The guard hides the note, so the tool takes it for missing and
        // goes to create it, which the guard refuses. Nothing is returned.
        await expect(
          tools.daily.getOrCreateDailyNoteHandler({
            arguments: { date: "2026-03-15" },
            app,
          }),
        ).rejects.toThrow();
        await expect(
          tools.append.appendToPeriodicNoteHandler({
            arguments: { content: "x", date: "2026-03-15" },
            app,
          }),
        ).rejects.toThrow();
        expect(read("Secret/Journal/2026-03-15.md")).toBe("PRIVATE");
      },
      ["Secret"],
    );
  });

  test("the library meets the policy of the request it runs under, not one fixed at start", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { folder: "Journal" });
    const { app, close } = await createHeadlessApp(root);
    try {
      let folders: string[] = ["Journal"];
      exposeObsidianGlobals(
        createGuardedApp(app, () => compilePolicy(folders)),
      );
      await expect(lib.createDailyNote(moment("2026-03-15"))).rejects.toThrow();
      expect(exists("Journal")).toBe(false);
      folders = [];
      const note = await lib.createDailyNote(moment("2026-03-15"));
      expect(note.path).toBe("Journal/2026-03-15.md");
      expect(exists("Journal/2026-03-15.md")).toBe(true);
    } finally {
      close();
    }
  });
});

describe("get_or_create_periodic_note", () => {
  test("weekly through the Periodic Notes plugin, with weekday placeholders", async () => {
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      weekly: {
        enabled: true,
        folder: "Weekly",
        template: "Templates/Week.md",
      },
    });
    write("Templates/Week.md", "Week of {{monday:YYYY-MM-DD}} ({{title}})");
    await withApp(async (app) => {
      const out = json(
        await tools.periodic.getOrCreatePeriodicNoteHandler({
          arguments: { period: "weekly", date: "2026-W11" },
          app,
        }),
      );
      expect(out).toMatchObject({
        period: "weekly",
        path: "Weekly/2026-W11.md",
        content: "Week of 2026-03-09 (2026-W11)",
        created: true,
      });
    });
  });

  test("monthly, quarterly and yearly use their own sections", async () => {
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      monthly: { enabled: true, folder: "M", format: "YYYY-MM" },
      quarterly: { enabled: true, folder: "Q" },
      yearly: { enabled: true, folder: "Y", template: "Templates/Year" },
    });
    write("Templates/Year.md", "Y {{title}}");
    await withApp(async (app) => {
      const paths = [];
      for (const [period, date] of [
        ["monthly", "2026-03"],
        ["quarterly", "2026-Q1"],
        ["yearly", "2026"],
        ["daily", "2026-03-15"],
      ] as const) {
        const out = json(
          await tools.periodic.getOrCreatePeriodicNoteHandler({
            arguments: { period, date },
            app,
          }),
        );
        paths.push(out.path);
      }
      expect(paths).toEqual([
        "M/2026-03.md",
        "Q/2026-Q1.md",
        "Y/2026.md",
        "2026-03-15.md",
      ]);
      expect(read("Y/2026.md")).toBe("Y 2026");
    });
  });

  test("the Calendar plugin serves weekly notes when Periodic Notes does not", async () => {
    config("community-plugins.json", ["calendar"]);
    config("plugins/calendar/data.json", {
      weeklyNoteFolder: "Cal",
      weeklyNoteFormat: "[W]WW-GGGG",
    });
    await withApp(async (app) => {
      const out = json(
        await tools.periodic.getOrCreatePeriodicNoteHandler({
          arguments: { period: "weekly", date: "2026-W11" },
          app,
        }),
      );
      expect(out.path).toBe("Cal/W11-2026.md");
    });
  });

  test("an invalid date is refused before anything is written", async () => {
    await withApp(async (app) => {
      const out = await tools.periodic.getOrCreatePeriodicNoteHandler({
        arguments: { period: "monthly", date: "2026-13" },
        app,
      });
      expect(out.isError).toBe(true);
      expect(json(out).errorCode).toBe("invalid_date_for_period");
      expect(exists("2026-13.md")).toBe(false);
    });
  });
});

describe("append_to_periodic_note", () => {
  test("creates the note from its template, then appends under a heading", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { folder: "Journal", template: "Daily" });
    write("Daily.md", "# {{title}}\n## Log\n## Notes\nend\n");
    await withApp(async (app) => {
      const out = json(
        await tools.append.appendToPeriodicNoteHandler({
          arguments: {
            period: "daily",
            date: "2026-03-15",
            content: "- did a thing",
            underHeading: "Log",
          },
          app,
        }),
      );
      expect(out).toMatchObject({
        period: "daily",
        path: "Journal/2026-03-15.md",
        appended: true,
        created: true,
      });
      expect(read("Journal/2026-03-15.md")).toBe(
        "# 2026-03-15\n## Log\n- did a thing\n\n\n## Notes\nend\n",
      );
      const again = json(
        await tools.append.appendToPeriodicNoteHandler({
          arguments: { date: "2026-03-15", content: "tail" },
          app,
        }),
      );
      expect(again.created).toBe(false);
      expect(read("Journal/2026-03-15.md")).toMatch(/end\ntail\n\n$/);
    });
  });

  test("a missing heading keeps the created note and reports it", async () => {
    await withApp(async (app) => {
      const out = await tools.append.appendToPeriodicNoteHandler({
        arguments: { content: "x", date: "2026-03-15", underHeading: "Nope" },
        app,
      });
      expect(out.isError).toBe(true);
      expect(json(out)).toMatchObject({
        errorCode: "heading_not_found",
        created: true,
      });
      expect(exists("2026-03-15.md")).toBe(true);
    });
  });
});
