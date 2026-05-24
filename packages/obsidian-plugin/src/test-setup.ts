/**
 * Test-only setup file, loaded by bun:test via `bunfig.toml` preload.
 *
 * The `obsidian` npm package ships only TypeScript declarations —
 * there is no runtime JavaScript. At production runtime, Obsidian
 * itself injects the module when it loads the plugin. For unit tests
 * running outside Obsidian, any file that imports a named binding
 * from "obsidian" (e.g. `Plugin`, `Notice`, `FileSystemAdapter`) will
 * crash at module load with `Cannot find package 'obsidian'`.
 *
 * This preload registers a synthetic module for "obsidian" so such
 * imports resolve to no-op stubs. Tests that need to assert specific
 * Obsidian runtime behavior (e.g. verifying `new Notice(...)` was
 * called with a specific message) should override these stubs with
 * their own per-test spies via `spyOn`.
 *
 * NOTE: this file is intentionally NOT imported anywhere in the
 * production code. The bundler entrypoint is `src/main.ts`, so this
 * module is not included in the shipped plugin.
 */

import { mock } from "bun:test";
import moment from "moment";

// Obsidian injects `activeWindow` as a global (points to the focused Window
// in popout-window scenarios). Tests run outside Obsidian, so we stub it to
// the global timer functions so timer-dependent production code still works.
// We delegate through an accessor so tests that swap `globalThis.setTimeout`
// (e.g. the modal-timeout test) still take effect — activeWindow.setTimeout
// reads the live globalThis binding at call time, not the one at setup time.
(
  globalThis as unknown as {
    activeWindow: {
      setTimeout: typeof setTimeout;
      clearTimeout: typeof clearTimeout;
    };
  }
).activeWindow = {
  setTimeout: ((...args: Parameters<typeof setTimeout>) =>
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout(
      ...args,
    )) as typeof setTimeout,
  clearTimeout: (...args: Parameters<typeof clearTimeout>) =>
    (
      globalThis as unknown as { clearTimeout: typeof clearTimeout }
    ).clearTimeout(...args),
};

void mock.module("obsidian", () => {
  class Notice {
    constructor(_message?: string, _timeout?: number) {}
    setMessage(_message: string | DocumentFragment) {
      return this;
    }
    hide() {}
  }

  class Plugin {}

  /**
   * Configurable stub for Obsidian's FileSystemAdapter. Tests that
   * need to anchor the plugin's vault at a real temp directory pass
   * the path to the constructor:
   *
   *     import { FileSystemAdapter } from "obsidian";
   *     const adapter = new FileSystemAdapter(tmpRoot);
   *
   * The production code never constructs a FileSystemAdapter itself
   * — Obsidian injects one via `plugin.app.vault.adapter` — so the
   * extra constructor argument is invisible to the prod build path.
   */
  class FileSystemAdapter {
    #basePath: string;
    constructor(basePath: string = "/fake/vault") {
      this.#basePath = basePath;
    }
    getBasePath(): string {
      return this.#basePath;
    }
  }

  class TFile {}

  class PluginSettingTab {}

  class App {}

  /**
   * Shallow stub of Obsidian's `Modal` base class. Exposes only what
   * subclasses under test actually touch:
   *
   *   - `contentEl` — the DOM container where Svelte components are
   *     mounted. We stub `empty()` (called in `onClose`) as a no-op.
   *   - `open()` / `close()` — public entry points. They invoke the
   *     subclass's `onOpen()` / `onClose()` hooks synchronously, which
   *     is enough to exercise the lifecycle contract in tests. Real
   *     Obsidian adds DOM transitions and focus management; neither
   *     matters here.
   *
   * The `resolved`-guard semantics of `CommandPermissionModal` rely on
   * `close()` triggering `onClose()` exactly once even when called
   * multiple times, so we track that with a flag.
   */
  class Modal {
    app: unknown;
    contentEl: { empty: () => void } = { empty: () => {} };
    private _closed = false;
    constructor(app: unknown) {
      this.app = app;
    }
    onOpen() {}
    onClose() {}
    open() {
      this._closed = false;
      this.onOpen();
    }
    close() {
      if (this._closed) return;
      this._closed = true;
      this.onClose();
    }
  }

  /**
   * Mock of Obsidian's exported `getAllTags(cache)` helper. Mirrors
   * the real behaviour: merges inline tag entries (`cache.tags[].tag`)
   * with frontmatter tags (`cache.frontmatter.tags`, supports array
   * or single-string forms), normalises every entry to include the
   * leading `#`, dedupes, and returns `null` when the cache is null
   * or yields no tags at all.
   */
  function getAllTags(
    cache:
      | {
          tags?: Array<{ tag: string }>;
          frontmatter?: Record<string, unknown>;
        }
      | null
      | undefined,
  ): string[] | null {
    if (!cache) return null;
    const out: string[] = [];
    for (const t of cache.tags ?? []) {
      out.push(t.tag.startsWith("#") ? t.tag : `#${t.tag}`);
    }
    const fmTags = cache.frontmatter?.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        if (typeof t === "string") {
          out.push(t.startsWith("#") ? t : `#${t}`);
        }
      }
    } else if (typeof fmTags === "string") {
      out.push(fmTags.startsWith("#") ? fmTags : `#${fmTags}`);
    }
    return out.length === 0 ? null : Array.from(new Set(out));
  }

  // Platform shape mirrors `obsidian.d.ts` enough for tests to import
  // `Platform.isMobile` / `Platform.isDesktop` without crashing. Default
  // to "desktop" since the plugin is `isDesktopOnly: true`.
  const Platform = {
    isMobile: false,
    isDesktop: true,
    isMacOS: process.platform === "darwin",
    isLinux: process.platform === "linux",
    isWin: process.platform === "win32",
  };

  return {
    Notice,
    Plugin,
    FileSystemAdapter,
    TFile,
    PluginSettingTab,
    App,
    Modal,
    Platform,
    getAllTags,
    // Obsidian re-exports the `moment` library at runtime; pin to the real
    // npm package in tests so code that does `import { moment } from "obsidian"`
    // (e.g. the periodic-notes detector) resolves without crashing at module
    // load. Production paths that actually invoke moment (plugin-delegation
    // branches) are exercised in tests by seeding the periodicNotes mock
    // state below.
    moment,
    requestUrl: async (req: { url: string } | string) => {
      const url = typeof req === "string" ? req : req.url;
      const r = _mockState.requestUrlResponses.get(url);
      if (!r) {
        throw new Error(
          `No mock response for ${url} — use setMockRequestUrl() in your test.`,
        );
      }
      return {
        status: r.status,
        text: r.text,
        headers: r.headers,
        arrayBuffer: r.arrayBuffer,
        json: r.text
          ? (() => {
              try {
                return JSON.parse(r.text);
              } catch {
                return null;
              }
            })()
          : null,
      };
    },
  };
});

/**
 * Mock Svelte's `mount`/`unmount` so we can exercise Obsidian Modal
 * lifecycle without a real DOM runtime. The mock records every call
 * on the exported `svelteMockCalls` object so tests can:
 *
 *   1. inspect the props passed to the component (including the
 *      `onDecision` callback);
 *   2. simulate a user click by invoking that callback directly;
 *   3. assert that `unmount` was called with the same component ref
 *      that `mount` returned.
 *
 * Tests should reset the recorder in `beforeEach` for isolation:
 *   `import { svelteMockCalls } from "$/test-setup";`
 *   `beforeEach(() => { svelteMockCalls.mount = []; svelteMockCalls.unmount = []; });`
 */
export interface SvelteMockCalls {
  mount: Array<{ component: unknown; options: { props?: unknown } }>;
  unmount: Array<unknown>;
}

/** Module-scoped Svelte mount/unmount recorder. Import in tests to read and reset. */
export const svelteMockCalls: SvelteMockCalls = {
  mount: [],
  unmount: [],
};

void mock.module("svelte", () => ({
  mount: (component: unknown, options: { props?: unknown }) => {
    const ref = { __mockRef: Symbol("svelte-mock-ref"), component, options };
    svelteMockCalls.mount.push({ component, options });
    return ref;
  },
  unmount: (ref: unknown) => {
    svelteMockCalls.unmount.push(ref);
  },
}));

// === Mock for obsidian-daily-notes-interface (Module C / PR #2) ============
//
// The real library reads `window.app` + the Daily Notes / Periodic Notes
// plugin settings to decide where to put periodic notes and how to render
// the template. Tests don't have those plugins — so we mock the whole
// module and let each test seed the plugin-on flags and settings per
// period via `setMockPeriodicNotesPlugin(...)`. Defaults: all 5 periods
// OFF (so the detector falls back to vault root + ISO format + empty file,
// which is the expected behaviour when neither plugin is installed).
//
// The `createXNote(date)` stubs mirror the real library's effect: they
// compute the path from the mocked settings using the same `date.format()`
// the real lib uses, then commit the file via the existing mock vault
// (`_mockState.files`) so the tool under test can observe it. This keeps
// the seam at the lib boundary — the detector still does its own path
// computation for `exists`, and the same path is reproduced by the mock
// create stub, so the tool sees a coherent "resolved + created" state.

export type MockPeriodType =
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly";

export interface MockPeriodicNoteSettings {
  loaded: boolean;
  folder?: string;
  format?: string;
  template?: string;
}

const _mockPeriodicNotesState: Record<
  MockPeriodType,
  MockPeriodicNoteSettings
> = {
  daily: { loaded: false },
  weekly: { loaded: false },
  monthly: { loaded: false },
  quarterly: { loaded: false },
  yearly: { loaded: false },
};

/**
 * Seed plugin state for a single period. Pass `{ loaded: true, folder,
 * format, template? }` to simulate Daily Notes (or the daily slot of
 * Periodic Notes) being enabled with those settings. Use the default
 * "all off" state for fallback-path tests.
 */
export function setMockPeriodicNotesPlugin(
  period: MockPeriodType,
  settings: MockPeriodicNoteSettings,
): void {
  _mockPeriodicNotesState[period] = { ...settings };
}

export function resetMockPeriodicNotes(): void {
  for (const k of Object.keys(_mockPeriodicNotesState) as MockPeriodType[]) {
    _mockPeriodicNotesState[k] = { loaded: false };
  }
}

function _defaultFormat(period: MockPeriodType): string {
  switch (period) {
    case "daily":
      return "YYYY-MM-DD";
    case "weekly":
      // ISO 8601 week-year (GGGG/WW), matching the detector. The locale
      // form `gggg-[W]ww` diverges at year boundaries (e.g. 2026-12-28 →
      // ISO 2026-W53 vs locale 2027-W01); keep the mock aligned so the
      // plugin-on weekly path is exercised against the real path shape.
      return "GGGG-[W]WW";
    case "monthly":
      return "YYYY-MM";
    case "quarterly":
      return "YYYY-[Q]Q";
    case "yearly":
      return "YYYY";
  }
}

function _createPeriodicNote(period: MockPeriodType, date: unknown): unknown {
  const s = _mockPeriodicNotesState[period];
  const fmt = s.format ?? _defaultFormat(period);
  // `date` is a Moment instance; use real `.format()` via duck-type.
  const formatted = (date as { format: (fmt: string) => string }).format(fmt);
  const filename = `${formatted}.md`;
  const folder = s.folder ?? "";
  const path = folder ? `${folder}/${filename}` : filename;
  if (folder && !_mockState.folders.has(folder)) {
    _mockState.folders.add(folder);
  }
  _mockState.files.set(path, s.template ?? "");
  return fileFromPath(path);
}

void mock.module("obsidian-daily-notes-interface", () => ({
  appHasDailyNotesPluginLoaded: (): boolean =>
    _mockPeriodicNotesState.daily.loaded,
  appHasWeeklyNotesPluginLoaded: (): boolean =>
    _mockPeriodicNotesState.weekly.loaded,
  appHasMonthlyNotesPluginLoaded: (): boolean =>
    _mockPeriodicNotesState.monthly.loaded,
  appHasQuarterlyNotesPluginLoaded: (): boolean =>
    _mockPeriodicNotesState.quarterly.loaded,
  appHasYearlyNotesPluginLoaded: (): boolean =>
    _mockPeriodicNotesState.yearly.loaded,
  getDailyNoteSettings: () => ({ ..._mockPeriodicNotesState.daily }),
  getWeeklyNoteSettings: () => ({ ..._mockPeriodicNotesState.weekly }),
  getMonthlyNoteSettings: () => ({ ..._mockPeriodicNotesState.monthly }),
  getQuarterlyNoteSettings: () => ({ ..._mockPeriodicNotesState.quarterly }),
  getYearlyNoteSettings: () => ({ ..._mockPeriodicNotesState.yearly }),
  createDailyNote: async (date: unknown) => _createPeriodicNote("daily", date),
  createWeeklyNote: async (date: unknown) =>
    _createPeriodicNote("weekly", date),
  createMonthlyNote: async (date: unknown) =>
    _createPeriodicNote("monthly", date),
  createQuarterlyNote: async (date: unknown) =>
    _createPeriodicNote("quarterly", date),
  createYearlyNote: async (date: unknown) =>
    _createPeriodicNote("yearly", date),
}));

// === Phase 2 mock vault state for tool tests ===

type MockVaultState = {
  files: Map<string, string>;
  folders: Set<string>;
  activeFilePath: string | null;
  metadataCache: Map<
    string,
    {
      headings: Array<{
        heading: string;
        level: number;
        position: { start: { line: number } };
      }>;
      blocks: Record<
        string,
        { position: { start: { line: number }; end: { line: number } } }
      >;
      frontmatter: Record<string, unknown>;
      tags: Array<{
        tag: string;
        position: { start: { line: number } };
      }>;
      links: Array<{
        link: string;
        original: string;
        displayText?: string;
        position: { start: { line: number } };
      }>;
      embeds: Array<{
        link: string;
        original: string;
        displayText?: string;
        position: { start: { line: number } };
      }>;
      frontmatterLinks: Array<{
        link: string;
        original: string;
        displayText?: string;
        key: string;
      }>;
    }
  >;
  commands: Array<{ id: string; name: string }>;
  executedCommands: string[];
  tags: Record<string, number>;
  resolvedLinks: Record<string, Record<string, number>>;
  unresolvedLinks: Record<string, Record<string, number>>;
  requestUrlResponses: Map<
    string,
    {
      status: number;
      text: string;
      headers: Record<string, string>;
      arrayBuffer: ArrayBuffer;
    }
  >;
  // Per-file ctime / mtime overrides for `MockTFile.stat`. Default 0 when
  // a path is absent so existing tests keep observing 0/0 — only tests
  // that need recency ordering (`get_recent_files` etc.) populate this.
  fileStats: Map<string, { ctime: number; mtime: number }>;
  // Paths returned as `true` by `MetadataCache.isUserIgnored`. Mirrors
  // Obsidian's `Files & Links → Excluded files` runtime behaviour without
  // depending on the glob/regex compilation path. Empty by default so
  // tests that don't exercise exclusion keep observing the full vault.
  ignored: Set<string>;
  // Records which destructive path a delete took. `trashFile` honours the
  // vault "Deleted files" setting (recoverable); raw `vault.delete` is a
  // permanent unlink. Tests assert delete handlers route through the
  // former (regression guard for fork issue #96).
  trashedPaths: string[];
  deletedPaths: string[];
  // Test hooks for the rename_heading apply path (#143 hardening):
  // paths whose `vault.modify` throws, and paths whose content mutates
  // after the first read (TOCTOU / concurrent-edit simulation).
  modifyFailPaths: Set<string>;
  readMutations: Map<string, { content: string; firstReadSeen: boolean }>;
};

// Synthetic absolute filesystem prefix used by the mock `adapter.rmdir`
// to mirror the path embedded in real Node `fs.rmdir` errors. Tests
// assert that handler code suppresses this trailer before surfacing
// errors to the MCP client (regression guard for #88 absolute-path
// leak). Kept in `/Users/...` shape so the regression check works on
// macOS- and Linux-like fixtures alike.
const MOCK_VAULT_ABS_PREFIX = "/Users/test/Obsidian/MockVault";

const _mockState: MockVaultState = {
  files: new Map(),
  folders: new Set(),
  activeFilePath: null,
  metadataCache: new Map(),
  commands: [],
  executedCommands: [],
  tags: {},
  resolvedLinks: {},
  unresolvedLinks: {},
  requestUrlResponses: new Map(),
  fileStats: new Map(),
  ignored: new Set(),
  trashedPaths: [],
  deletedPaths: [],
  modifyFailPaths: new Set(),
  readMutations: new Map(),
};

export function resetMockVault(): void {
  _mockState.files.clear();
  _mockState.folders.clear();
  _mockState.activeFilePath = null;
  _mockState.metadataCache.clear();
  _mockState.commands = [];
  _mockState.executedCommands = [];
  _mockState.tags = {};
  // Mutate in place rather than reassign so references captured by
  // mockApp().metadataCache stay valid across tests.
  for (const k of Object.keys(_mockState.resolvedLinks)) {
    delete _mockState.resolvedLinks[k];
  }
  for (const k of Object.keys(_mockState.unresolvedLinks)) {
    delete _mockState.unresolvedLinks[k];
  }
  _mockState.requestUrlResponses.clear();
  _mockState.fileStats.clear();
  _mockState.ignored.clear();
  _mockState.trashedPaths = [];
  _mockState.deletedPaths = [];
  _mockState.modifyFailPaths.clear();
  _mockState.readMutations.clear();
  resetMockPeriodicNotes();
}

/** Make `vault.modify(file)` reject for `path` (rename_heading #143 M2). */
export function setMockModifyFail(path: string): void {
  _mockState.modifyFailPaths.add(path);
}

/**
 * Simulate a concurrent edit: `path` reads its stored content the first
 * time, then `mutated` on every subsequent read (rename_heading #143 H3
 * TOCTOU guard).
 */
export function setMockReadMutation(path: string, mutated: string): void {
  _mockState.readMutations.set(path, {
    content: mutated,
    firstReadSeen: false,
  });
}

/** Paths routed through `fileManager.trashFile` (recoverable delete). */
export function getMockTrashedPaths(): string[] {
  return [..._mockState.trashedPaths];
}

/** Paths routed through `vault.delete` (permanent unlink). */
export function getMockDeletedPaths(): string[] {
  return [..._mockState.deletedPaths];
}

export function setMockFile(path: string, content: string): void {
  _mockState.files.set(path, content);
}

/**
 * Override `ctime` / `mtime` on a file's `stat` block. Both default to
 * 0 in the synthetic `MockTFile`, which works for most tests but not
 * for tools that order files by recency (`get_recent_files`,
 * `get_vault_files`-with-stats, etc.). Setting one or both lets a test
 * pin a specific timestamp without having to construct a TFile by hand.
 *
 * Args:
 *   path: vault-relative file path; the file should already exist via
 *         `setMockFile()` (the override is keyed by path, not by file
 *         identity, so calling order doesn't matter).
 *   stat: `{ ctime?, mtime? }`. Omitted fields default to 0 — pass
 *         only the field the test cares about.
 */
export function setMockFileStat(
  path: string,
  stat: { ctime?: number; mtime?: number },
): void {
  _mockState.fileStats.set(path, {
    ctime: stat.ctime ?? 0,
    mtime: stat.mtime ?? 0,
  });
}

/**
 * Mark a vault path as user-ignored, mirroring Obsidian's
 * `Files & Links → Excluded files` runtime setting. Reflected by
 * `app.metadataCache.isUserIgnored(path)` returning `true` for any
 * registered path. Used by tools that filter against the exclusion set
 * (`get_recent_files`, etc.).
 */
export function setMockIgnored(path: string): void {
  _mockState.ignored.add(path);
}

/**
 * Pre-populate a directory in the mock vault. Tests use this to set up
 * the "parent already exists" precondition without having to call
 * `vault.createFolder` from the production helper.
 */
export function setMockFolder(path: string): void {
  if (!path) return;
  _mockState.folders.add(path);
}

export function setMockActiveFile(path: string | null): void {
  _mockState.activeFilePath = path;
}

export function setMockMetadata(
  path: string,
  metadata: {
    headings?: Array<{ heading: string; level: number; line: number }>;
    blocks?: Record<string, { startLine: number; endLine: number }>;
    frontmatter?: Record<string, unknown>;
    tags?: Array<{ tag: string; line?: number }>;
    links?: Array<{
      link: string;
      original?: string;
      displayText?: string;
      line?: number;
    }>;
    embeds?: Array<{
      link: string;
      original?: string;
      displayText?: string;
      line?: number;
    }>;
    frontmatterLinks?: Array<{
      link: string;
      original?: string;
      displayText?: string;
      key: string;
    }>;
  },
): void {
  _mockState.metadataCache.set(path, {
    headings: (metadata.headings ?? []).map((h) => ({
      heading: h.heading,
      level: h.level,
      position: { start: { line: h.line } },
    })),
    blocks: Object.fromEntries(
      Object.entries(metadata.blocks ?? {}).map(([id, b]) => [
        id,
        {
          position: { start: { line: b.startLine }, end: { line: b.endLine } },
        },
      ]),
    ),
    frontmatter: metadata.frontmatter ?? {},
    tags: (metadata.tags ?? []).map((t) => ({
      tag: t.tag,
      position: { start: { line: t.line ?? 0 } },
    })),
    links: (metadata.links ?? []).map((l) => ({
      link: l.link,
      original: l.original ?? `[[${l.link}]]`,
      displayText: l.displayText,
      position: { start: { line: l.line ?? 0 } },
    })),
    embeds: (metadata.embeds ?? []).map((e) => ({
      link: e.link,
      original: e.original ?? `![[${e.link}]]`,
      displayText: e.displayText,
      position: { start: { line: e.line ?? 0 } },
    })),
    frontmatterLinks: (metadata.frontmatterLinks ?? []).map((f) => ({
      link: f.link,
      original: f.original ?? `[[${f.link}]]`,
      displayText: f.displayText,
      key: f.key,
    })),
  });
}

export function setMockCommands(
  commands: Array<{ id: string; name: string }>,
): void {
  _mockState.commands = [...commands];
}

export function getExecutedCommands(): string[] {
  return [..._mockState.executedCommands];
}

/**
 * Set the tag→count map returned by `app.metadataCache.getTags()`.
 * Mirrors Obsidian's API shape: keys include the leading `#`, values
 * are aggregated counts across the vault.
 */
export function setMockTags(tags: Record<string, number>): void {
  _mockState.tags = { ...tags };
}

/**
 * Populate the entry in `metadataCache.resolvedLinks` for a single
 * source file. `targets` maps target file path → link count, matching
 * Obsidian's `Record<string, Record<string, number>>` shape. Mutates
 * the existing object so references captured by `mockApp()` stay
 * valid across tests.
 */
export function setMockResolvedLinks(
  source: string,
  targets: Record<string, number>,
): void {
  _mockState.resolvedLinks[source] = { ...targets };
}

/**
 * Populate `metadataCache.unresolvedLinks` for a single source. Same
 * shape as `setMockResolvedLinks` but the keys are unresolved
 * linkpaths (link target text that doesn't resolve to a real file).
 */
export function setMockUnresolvedLinks(
  source: string,
  targets: Record<string, number>,
): void {
  _mockState.unresolvedLinks[source] = { ...targets };
}

export function setMockRequestUrl(
  url: string,
  response: {
    status?: number;
    text?: string;
    headers?: Record<string, string>;
    bytes?: Uint8Array;
  },
): void {
  let buf: ArrayBuffer;
  if (response.bytes) {
    const u8 = response.bytes;
    const slice = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    buf = slice as ArrayBuffer;
  } else {
    buf = new ArrayBuffer(0);
  }
  _mockState.requestUrlResponses.set(url, {
    status: response.status ?? 200,
    text: response.text ?? "",
    headers: response.headers ?? {},
    arrayBuffer: buf,
  });
}

/** Test-only access to the requestUrl mock dispatcher. */
export function _getMockRequestUrlResponse(url: string) {
  return _mockState.requestUrlResponses.get(url);
}

// === Mock TFile / TFolder / App ===

class MockTFile {
  constructor(
    public path: string,
    public name: string,
    public parent: MockTFolder | null = null,
  ) {}
  get extension(): string {
    const i = this.name.lastIndexOf(".");
    return i >= 0 ? this.name.slice(i + 1) : "";
  }
  get basename(): string {
    const i = this.name.lastIndexOf(".");
    return i >= 0 ? this.name.slice(0, i) : this.name;
  }
  get stat() {
    const override = _mockState.fileStats.get(this.path);
    return {
      ctime: override?.ctime ?? 0,
      mtime: override?.mtime ?? 0,
      size: (_mockState.files.get(this.path) ?? "").length,
    };
  }
}

class MockTFolder {
  children: Array<MockTFile | MockTFolder> = [];
  constructor(
    public path: string,
    public name: string,
    public parent: MockTFolder | null = null,
  ) {}
}

function fileFromPath(path: string): MockTFile | null {
  if (!_mockState.files.has(path)) return null;
  const name = path.split("/").pop() ?? path;
  return new MockTFile(path, name);
}

function folderFromPath(path: string): MockTFolder | null {
  if (!_mockState.folders.has(path)) return null;
  const name = path.split("/").pop() ?? path;
  return new MockTFolder(path, name);
}

/** Test-only access to the folder set, for assertions on createFolder. */
export function getMockFolders(): string[] {
  return Array.from(_mockState.folders).sort();
}

import type { App, TAbstractFile, TFile, TFolder } from "obsidian";

export function mockApp(): App {
  const vault = {
    getAbstractFileByPath: (path: string): TAbstractFile | null => {
      const f = fileFromPath(path);
      if (f) return f as unknown as TAbstractFile;
      const d = folderFromPath(path);
      if (d) return d as unknown as TAbstractFile;
      return null;
    },
    getFiles: (): TFile[] =>
      Array.from(_mockState.files.keys())
        .map((p) => fileFromPath(p))
        .filter((f): f is MockTFile => f !== null) as unknown as TFile[],
    getMarkdownFiles: (): TFile[] =>
      Array.from(_mockState.files.keys())
        .filter((p) => p.endsWith(".md"))
        .map((p) => fileFromPath(p))
        .filter((f): f is MockTFile => f !== null) as unknown as TFile[],
    read: async (file: TFile): Promise<string> => {
      const path = (file as unknown as MockTFile).path;
      const content = _mockState.files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      const mut = _mockState.readMutations.get(path);
      if (mut) {
        if (mut.firstReadSeen) return mut.content;
        mut.firstReadSeen = true;
      }
      return content;
    },
    cachedRead: async (file: TFile): Promise<string> => {
      return vault.read(file);
    },
    readBinary: async (file: TFile): Promise<ArrayBuffer> => {
      const path = (file as unknown as MockTFile).path;
      const content = _mockState.files.get(path) ?? "";
      const buf = new TextEncoder().encode(content).buffer;
      return buf as ArrayBuffer;
    },
    create: async (path: string, content: string): Promise<TFile> => {
      // Mirror Obsidian semantics: bottom-level fs operation throws
      // ENOENT when the parent directory doesn't exist. The mock walks
      // every ancestor segment (excluding the leaf filename) and
      // requires each to be in the folders set.
      const slash = path.lastIndexOf("/");
      if (slash > 0) {
        const parent = path.slice(0, slash);
        if (!_mockState.folders.has(parent)) {
          throw new Error(
            `ENOENT: no such file or directory, open '<vault>/${path}'`,
          );
        }
      }
      _mockState.files.set(path, content);
      return fileFromPath(path) as unknown as TFile;
    },
    createFolder: async (path: string): Promise<TFolder> => {
      // Real Obsidian throws "Folder already exists" on a duplicate.
      // The production helper swallows that case, so the mock must
      // throw to exercise that swallow path.
      if (_mockState.folders.has(path)) {
        throw new Error(`Folder already exists: ${path}`);
      }
      _mockState.folders.add(path);
      return folderFromPath(path) as unknown as TFolder;
    },
    modify: async (file: TFile, content: string): Promise<void> => {
      const path = (file as unknown as MockTFile).path;
      if (_mockState.modifyFailPaths.has(path)) {
        throw new Error(`mock modify failure: ${path}`);
      }
      _mockState.files.set(path, content);
    },
    append: async (file: TFile, content: string): Promise<void> => {
      const path = (file as unknown as MockTFile).path;
      const existing = _mockState.files.get(path) ?? "";
      _mockState.files.set(path, existing + content);
    },
    delete: async (file: TAbstractFile): Promise<void> => {
      const path = (file as unknown as MockTFile).path;
      _mockState.deletedPaths.push(path);
      _mockState.files.delete(path);
      if (_mockState.activeFilePath === path) {
        _mockState.activeFilePath = null;
      }
    },
    on: (_event: string, _handler: unknown) => ({
      unsubscribe: () => {},
    }),
    off: () => {},
    adapter: {
      // Recursive rmdir over the mock vault: removes the folder, every
      // descendant folder, and every descendant file. Errors mirror the
      // real Node `fs.rmdir` shape (absolute host path embedded in the
      // message + `.code` set on the Error instance) so handler tests
      // can assert that the production code suppresses the absolute
      // path before surfacing it to the MCP client (regression guard
      // for fork issue #88).
      rmdir: async (path: string, recursive: boolean): Promise<void> => {
        const absPath = `${MOCK_VAULT_ABS_PREFIX}/${path}`;
        if (!_mockState.folders.has(path)) {
          const err: NodeJS.ErrnoException = new Error(
            `ENOENT: no such file or directory, rmdir '${absPath}'`,
          );
          err.code = "ENOENT";
          throw err;
        }
        const prefix = `${path}/`;
        const childFiles = Array.from(_mockState.files.keys()).filter((p) =>
          p.startsWith(prefix),
        );
        const childFolders = Array.from(_mockState.folders).filter((p) =>
          p.startsWith(prefix),
        );
        if (!recursive && (childFiles.length > 0 || childFolders.length > 0)) {
          const err: NodeJS.ErrnoException = new Error(
            `ENOTEMPTY: directory not empty, rmdir '${absPath}'`,
          );
          err.code = "ENOTEMPTY";
          throw err;
        }
        for (const f of childFiles) _mockState.files.delete(f);
        for (const d of childFolders) _mockState.folders.delete(d);
        _mockState.folders.delete(path);
      },
      exists: async (path: string): Promise<boolean> =>
        _mockState.files.has(path) || _mockState.folders.has(path),
    },
  };

  const workspace = {
    getActiveFile: (): TFile | null => {
      if (!_mockState.activeFilePath) return null;
      return fileFromPath(_mockState.activeFilePath) as unknown as TFile | null;
    },
    openLinkText: async (
      linktext: string,
      _sourcePath: string,
      _newLeaf?: boolean,
    ): Promise<void> => {
      if (!_mockState.files.has(linktext)) {
        _mockState.files.set(linktext, "");
      }
      _mockState.activeFilePath = linktext;
    },
    getLeaf: () => ({
      openFile: async (file: TFile) => {
        _mockState.activeFilePath = (file as unknown as MockTFile).path;
      },
    }),
  };

  const metadataCache = {
    getFileCache: (file: TFile) => {
      const path = (file as unknown as MockTFile).path;
      return _mockState.metadataCache.get(path) ?? null;
    },
    getTags: (): Record<string, number> => ({ ..._mockState.tags }),
    // Mirrors Obsidian's runtime `MetadataCache.isUserIgnored` (not in
    // the bundled `obsidian.d.ts`). Backed by `setMockIgnored()`.
    isUserIgnored: (path: string): boolean => _mockState.ignored.has(path),
    // Live references — `resetMockVault()` mutates these in place so
    // the bindings stay valid across tests without re-creating the App.
    get resolvedLinks(): Record<string, Record<string, number>> {
      return _mockState.resolvedLinks;
    },
    get unresolvedLinks(): Record<string, Record<string, number>> {
      return _mockState.unresolvedLinks;
    },
    /**
     * Mock implementation of Obsidian's `getFirstLinkpathDest`. Resolves
     * a linkpath against the mock vault using a small subset of the
     * real algorithm: exact path match → path with `.md` appended →
     * basename match (with or without extension).
     */
    getFirstLinkpathDest: (
      linkpath: string,
      _sourcePath: string,
    ): TFile | null => {
      if (_mockState.files.has(linkpath)) {
        return fileFromPath(linkpath) as unknown as TFile | null;
      }
      const withMd = linkpath.endsWith(".md") ? linkpath : `${linkpath}.md`;
      if (_mockState.files.has(withMd)) {
        return fileFromPath(withMd) as unknown as TFile | null;
      }
      for (const path of _mockState.files.keys()) {
        const name = path.split("/").pop() ?? path;
        const base = name.replace(/\.md$/, "");
        if (base === linkpath || name === linkpath) {
          return fileFromPath(path) as unknown as TFile | null;
        }
      }
      return null;
    },
  };

  const fileManager = {
    processFrontMatter: async (
      file: TFile,
      fn: (frontmatter: Record<string, unknown>) => void,
    ): Promise<void> => {
      const path = (file as unknown as MockTFile).path;
      const cache = _mockState.metadataCache.get(path) ?? {
        headings: [],
        blocks: {},
        frontmatter: {},
        tags: [],
        links: [],
        embeds: [],
        frontmatterLinks: [],
      };
      const fm = { ...cache.frontmatter };
      fn(fm);
      cache.frontmatter = fm;
      _mockState.metadataCache.set(path, cache);
    },
    /**
     * Mock of `app.fileManager.renameFile`. The real Obsidian
     * implementation also rewrites every wikilink / markdown link /
     * embed / frontmatter alias pointing at the source path; here we
     * only migrate the file's own state (content, metadata cache,
     * stats, active-file pointer) since `rename_vault_file` tests
     * exercise the handler's branching, not link-rewrite fidelity.
     * Folder rename is out of scope (the handler rejects it via the
     * existing API surface — TFolder cannot be passed as `from`).
     */
    renameFile: async (file: TAbstractFile, newPath: string): Promise<void> => {
      const path = (file as unknown as MockTFile).path;
      if (!_mockState.files.has(path)) {
        throw new Error(`File not found: ${path}`);
      }
      const content = _mockState.files.get(path) ?? "";
      _mockState.files.delete(path);
      _mockState.files.set(newPath, content);
      const meta = _mockState.metadataCache.get(path);
      if (meta) {
        _mockState.metadataCache.delete(path);
        _mockState.metadataCache.set(newPath, meta);
      }
      const stat = _mockState.fileStats.get(path);
      if (stat) {
        _mockState.fileStats.delete(path);
        _mockState.fileStats.set(newPath, stat);
      }
      if (_mockState.activeFilePath === path) {
        _mockState.activeFilePath = newPath;
      }
    },
    /**
     * Mock of `app.fileManager.trashFile`. The real implementation
     * honours the vault's "Deleted files" setting (system trash /
     * `.trash/` / permanent). Here the destination is irrelevant —
     * tests only need to observe that the recoverable path was taken
     * (vs. the permanent `vault.delete`), so the call is recorded and
     * the file removed from the live vault.
     */
    trashFile: async (file: TAbstractFile): Promise<void> => {
      const path = (file as unknown as MockTFile).path;
      _mockState.trashedPaths.push(path);
      _mockState.files.delete(path);
      if (_mockState.activeFilePath === path) {
        _mockState.activeFilePath = null;
      }
    },
  };

  const commands = {
    listCommands: (): Array<{ id: string; name: string }> => [
      ..._mockState.commands,
    ],
    executeCommandById: (id: string): boolean => {
      _mockState.executedCommands.push(id);
      return _mockState.commands.some((c) => c.id === id);
    },
  };

  return {
    vault,
    workspace,
    metadataCache,
    fileManager,
    commands,
  } as unknown as App;
}

import type McpToolsPlugin from "$/main";

export function mockPlugin(
  overrides: Partial<McpToolsPlugin> = {},
): McpToolsPlugin {
  const app = mockApp();
  const plugin = {
    app,
    manifest: { version: "0.4.0-alpha.2", id: "mcp-tools-istefox" },
    loadData: async () => ({}),
    saveData: async (_data: unknown) => undefined,
    // Default to the historical hardcoded URL so pre-existing tests
    // that don't override it keep matching `setMockRequestUrl(...)`
    // entries keyed at `https://127.0.0.1:27124/...`. Tests for
    // non-default LRA ports must override `getLocalRestApiUrl`.
    getLocalRestApiUrl: () => "https://127.0.0.1:27124",
    ...overrides,
  };
  return plugin as unknown as McpToolsPlugin;
}
