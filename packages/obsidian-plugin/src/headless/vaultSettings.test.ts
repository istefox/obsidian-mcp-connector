import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHeadlessApp } from "./headlessApp";
import {
  createIgnoreMatcher,
  loadVaultSettings,
  parseAppSettings,
  readConfigJson,
} from "./vaultSettings";
import { searchFilesByNameHandler } from "$/features/mcp-tools/tools/searchFilesByName";
import { getRecentFilesHandler } from "$/features/mcp-tools/tools/getRecentFiles";
import {
  parseFrontMatterAliases,
  prepareFuzzySearch,
  sortSearchResults,
} from "./fuzzySearch";
import { mock } from "bun:test";
import * as mocked from "obsidian";

describe("createIgnoreMatcher", () => {
  test("a plain entry is a path prefix", () => {
    const ignored = createIgnoreMatcher(["Private/", "Archive"]);
    expect(ignored("Private/a.md")).toBe(true);
    expect(ignored("Archive/old.md")).toBe(true);
    expect(ignored("Archive2024.md")).toBe(true);
    expect(ignored("Notes/Private/a.md")).toBe(false);
    expect(ignored("private/a.md")).toBe(false);
    expect(ignored("Public/a.md")).toBe(false);
  });

  test("an entry wrapped in slashes is a regular expression on the path", () => {
    const ignored = createIgnoreMatcher(["/\\.png$/", "/^Daily\\/\\d{4}/"]);
    expect(ignored("img/a.png")).toBe(true);
    expect(ignored("img/a.png.md")).toBe(false);
    expect(ignored("Daily/2026-01-01.md")).toBe(true);
    expect(ignored("Other/Daily/2026.md")).toBe(false);
  });

  test("an invalid expression excludes nothing and does not stop the others", () => {
    const ignored = createIgnoreMatcher(["/([/", "Keep/"]);
    expect(ignored("anything.md")).toBe(false);
    expect(ignored("Keep/a.md")).toBe(true);
  });

  test("empty entries and an empty expression exclude nothing", () => {
    const ignored = createIgnoreMatcher(["", "//"]);
    expect(ignored("a.md")).toBe(false);
    expect(ignored("")).toBe(false);
  });

  test("no entries excludes nothing", () => {
    expect(createIgnoreMatcher([])("a.md")).toBe(false);
  });
});

describe("parseAppSettings", () => {
  test("keeps string filters and drops other values", () => {
    expect(
      parseAppSettings({ userIgnoreFilters: ["a/", 3, null, "/b/"] }),
    ).toEqual({ userIgnoreFilters: ["a/", "/b/"] });
  });

  test("uses the default for a missing or wrongly shaped value", () => {
    for (const json of [
      undefined,
      null,
      [],
      "x",
      {},
      { userIgnoreFilters: "a/" },
      { userIgnoreFilters: { 0: "a/" } },
    ]) {
      expect(parseAppSettings(json)).toEqual({ userIgnoreFilters: [] });
    }
  });
});

let dir: string;
let root: string;
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-settings-"));
  root = path.join(dir, "vault");
  fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readConfigJson", () => {
  const read = async (rel = "app.json") => {
    const warnings: string[] = [];
    const value = await readConfigJson(root, rel, (m) => warnings.push(m));
    return { value, warnings };
  };

  test("a missing file or folder is undefined and silent", async () => {
    expect(await read()).toEqual({ value: undefined, warnings: [] });
    write(".obsidian/other.json", "{}");
    expect(await read()).toEqual({ value: undefined, warnings: [] });
  });

  test("valid JSON is returned", async () => {
    write(".obsidian/app.json", '{"a":1}');
    expect(await read()).toEqual({ value: { a: 1 }, warnings: [] });
  });

  test("invalid JSON is undefined with one warning naming the file", async () => {
    write(".obsidian/app.json", "{ not json");
    const { value, warnings } = await read();
    expect(value).toBeUndefined();
    expect(warnings).toEqual([
      "Ignoring .obsidian/app.json: it is not valid JSON",
    ]);
  });

  test("a file over 1 MB is ignored with a warning", async () => {
    write(
      ".obsidian/app.json",
      JSON.stringify({ pad: "x".repeat(1024 * 1024) }),
    );
    const { value, warnings } = await read();
    expect(value).toBeUndefined();
    expect(warnings).toEqual([
      "Ignoring .obsidian/app.json: it is larger than 1 MB",
    ]);
  });

  test("a symlinked file is not followed and says so", async () => {
    write("outside/app.json", '{"userIgnoreFilters":["x"]}');
    fs.mkdirSync(path.join(root, ".obsidian"));
    fs.symlinkSync(
      path.join(root, "outside/app.json"),
      path.join(root, ".obsidian/app.json"),
    );
    expect(await read()).toEqual({
      value: undefined,
      warnings: [
        "Ignoring .obsidian/app.json: it is a symlink, which is not followed",
      ],
    });
  });

  test("a symlinked .obsidian folder is not followed and says so", async () => {
    write("outside/app.json", '{"userIgnoreFilters":["x"]}');
    fs.symlinkSync(path.join(root, "outside"), path.join(root, ".obsidian"));
    expect(await read()).toEqual({
      value: undefined,
      warnings: [
        "Ignoring .obsidian/app.json: .obsidian is a symlink, which is not followed",
      ],
    });
  });

  test("a symlinked folder in the middle of the path is not followed", async () => {
    write("outside/periodic-notes/data.json", '{"daily":{"enabled":true}}');
    fs.mkdirSync(path.join(root, ".obsidian"));
    fs.symlinkSync(
      path.join(root, "outside"),
      path.join(root, ".obsidian/plugins"),
    );
    const rel = "plugins/periodic-notes/data.json";
    expect(await read(rel)).toEqual({
      value: undefined,
      warnings: [
        `Ignoring .obsidian/${rel}: .obsidian/plugins is a symlink, which is not followed`,
      ],
    });
  });

  test("a folder where the file should be is reported", async () => {
    fs.mkdirSync(path.join(root, ".obsidian/app.json"), { recursive: true });
    expect(await read()).toEqual({
      value: undefined,
      warnings: ["Ignoring .obsidian/app.json: it is not a regular file"],
    });
  });

  // Not a permission bit: the test may run as a user that ignores them.
  test("a file that cannot be read says why", async () => {
    write(".obsidian/app.json", '{"a":1}');
    const fsp = await import("node:fs/promises");
    const original = fsp.default.readFile;
    fsp.default.readFile = (async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }) as typeof fsp.default.readFile;
    try {
      expect(await read()).toEqual({
        value: undefined,
        warnings: ["Ignoring .obsidian/app.json: it cannot be read (EACCES)"],
      });
    } finally {
      fsp.default.readFile = original;
    }
  });

  test("a path below a file is as missing as a missing one", async () => {
    write(".obsidian", "a file, not a folder");
    expect(await read()).toEqual({ value: undefined, warnings: [] });
  });

  test("a symlinked plugin folder is not followed", async () => {
    write("outside/data.json", '{"weeklyNoteFolder":"Stolen"}');
    fs.mkdirSync(path.join(root, ".obsidian/plugins"), { recursive: true });
    fs.symlinkSync(
      path.join(root, "outside"),
      path.join(root, ".obsidian/plugins/calendar"),
    );
    expect(await read("plugins/calendar/data.json")).toEqual({
      value: undefined,
      warnings: [
        "Ignoring .obsidian/plugins/calendar/data.json: .obsidian/plugins/calendar is a symlink, which is not followed",
      ],
    });
    // A real plugin folder beside it still reads.
    write(".obsidian/plugins/other/data.json", '{"a":1}');
    expect(await read("plugins/other/data.json")).toEqual({
      value: { a: 1 },
      warnings: [],
    });
  });
});

describe("loadVaultSettings", () => {
  test("reads userIgnoreFilters from app.json", async () => {
    write(".obsidian/app.json", '{"userIgnoreFilters":["Private/"]}');
    expect(await loadVaultSettings(root, () => {})).toEqual({
      userIgnoreFilters: ["Private/"],
    });
  });

  test("an app.json that is a symlink is the default, and the warning says what that means", async () => {
    write("outside/app.json", '{"userIgnoreFilters":["Private/"]}');
    fs.mkdirSync(path.join(root, ".obsidian"));
    fs.symlinkSync(
      path.join(root, "outside/app.json"),
      path.join(root, ".obsidian/app.json"),
    );
    const warnings: string[] = [];
    expect(await loadVaultSettings(root, (m) => warnings.push(m))).toEqual({
      userIgnoreFilters: [],
    });
    expect(warnings).toEqual([
      'Ignoring .obsidian/app.json: it is a symlink, which is not followed. "Excluded files" is not applied, so those notes are served.',
    ]);
  });

  test("a missing app.json is the default", async () => {
    expect(await loadVaultSettings(root, () => {})).toEqual({
      userIgnoreFilters: [],
    });
  });
});

describe("a headless app", () => {
  const original = { ...mocked };
  afterAll(() => {
    void mock.module("obsidian", () => original);
  });

  const toolsOn = async (warnings: string[] = []) => {
    void mock.module("obsidian", () => ({
      ...original,
      prepareFuzzySearch,
      sortSearchResults,
      parseFrontMatterAliases,
    }));
    const handle = await createHeadlessApp(root, {
      warn: (m) => warnings.push(m),
    });
    return handle;
  };

  const names = async (app: Awaited<ReturnType<typeof toolsOn>>["app"]) => {
    const out = JSON.parse(
      (await searchFilesByNameHandler({ arguments: { query: "note" }, app }))
        .content[0].text,
    ) as { results: Array<{ path: string }> };
    return out.results.map((r) => r.path).sort();
  };

  test("honours Excluded files in the tools and answers isUserIgnored", async () => {
    write(
      ".obsidian/app.json",
      JSON.stringify({ userIgnoreFilters: ["Private/", "/draft-note/"] }),
    );
    write("Private/secret note.md", "x");
    write("Public/note.md", "x");
    write("Public/draft-note.md", "x");
    const { app, close } = await toolsOn();
    try {
      const cache = app.metadataCache as unknown as {
        isUserIgnored(p: string): boolean;
      };
      expect(cache.isUserIgnored("Private/secret note.md")).toBe(true);
      expect(cache.isUserIgnored("Public/note.md")).toBe(false);
      expect(await names(app)).toEqual(["Public/note.md"]);
      const recent = JSON.parse(
        (await getRecentFilesHandler({ arguments: {}, app })).content[0].text,
      ) as { files?: Array<{ path: string }> } | Array<{ path: string }>;
      const list = Array.isArray(recent) ? recent : (recent.files ?? []);
      expect(list.map((f) => f.path)).not.toContain("Private/secret note.md");
      // The setting hides files from the tools, not from the vault.
      expect(
        app.vault.getAbstractFileByPath("Private/secret note.md"),
      ).not.toBe(null);
    } finally {
      close();
    }
  });

  test("a missing app.json excludes nothing and warns nothing", async () => {
    write("Private/note.md", "x");
    const warnings: string[] = [];
    const { app, close } = await toolsOn(warnings);
    try {
      expect(await names(app)).toEqual(["Private/note.md"]);
      expect(warnings).toEqual([]);
    } finally {
      close();
    }
  });

  test("an invalid app.json is the default with exactly one warning", async () => {
    write(".obsidian/app.json", "{ broken");
    write("Private/note.md", "x");
    const warnings: string[] = [];
    const { app, close } = await toolsOn(warnings);
    try {
      expect(await names(app)).toEqual(["Private/note.md"]);
      expect(warnings).toEqual([
        'Ignoring .obsidian/app.json: it is not valid JSON. "Excluded files" is not applied, so those notes are served.',
      ]);
    } finally {
      close();
    }
  });

  test("a changed app.json is not picked up until the next start", async () => {
    write("Private/note.md", "x");
    const { app, close } = await toolsOn();
    try {
      write(".obsidian/app.json", '{"userIgnoreFilters":["Private/"]}');
      expect(await names(app)).toEqual(["Private/note.md"]);
    } finally {
      close();
    }
  });
});
