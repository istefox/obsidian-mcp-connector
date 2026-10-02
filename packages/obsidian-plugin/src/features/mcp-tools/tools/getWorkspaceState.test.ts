import { describe, expect, test } from "bun:test";
import type { App } from "obsidian";
import { createGuardedApp } from "$/shared/guardedApp";
import { EMPTY_POLICY, compilePolicy } from "$/shared/pathPolicy";
import {
  getWorkspaceStateHandler,
  getWorkspaceStateSchema,
  type WorkspaceState,
} from "./getWorkspaceState";

/**
 * Drives the handler through `createGuardedApp`, the way production does,
 * so these tests also pin the guarded leaf (ADR-0020 D2 addendum): a leaf
 * on an excluded file never reaches the tool, and the leaves that do
 * cannot open anything.
 */

const rootSplit = { kind: "root" };
const leftSplit = { kind: "left" };
const rightSplit = { kind: "right" };
const popoutRoot = { kind: "window" };

type FakeLeaf = {
  view: Record<string, unknown>;
  getViewState: () => Record<string, unknown>;
  getDisplayText: () => string;
  getRoot: () => object;
  isDeferred: boolean;
  openFile: () => Promise<void>;
};

function leaf(options: {
  type: string;
  title: string;
  file?: string;
  mode?: string;
  root?: object;
  active?: boolean;
  pinned?: boolean;
  deferred?: boolean;
}): FakeLeaf {
  const deferred = options.deferred === true;
  const view: Record<string, unknown> = deferred
    ? { getViewType: () => options.type }
    : {
        getViewType: () => options.type,
        file: options.file ? { path: options.file } : null,
        ...(options.mode ? { getMode: () => options.mode } : {}),
      };
  return {
    view,
    getViewState: () => ({
      type: options.type,
      state: {
        ...(options.file ? { file: options.file } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
      },
      active: options.active === true,
      pinned: options.pinned === true,
      group: { raw: "leaf" },
    }),
    getDisplayText: () => options.title,
    getRoot: () => options.root ?? rootSplit,
    isDeferred: deferred,
    openFile: async () => {},
  };
}

function fakeApp(
  leaves: FakeLeaf[],
  extra?: Partial<Record<string, unknown>>,
): App {
  const workspace = {
    layoutReady: true,
    rootSplit,
    leftSplit,
    rightSplit,
    getActiveFile: () => ({ path: "Public/active.md" }),
    getLastOpenFiles: () => [
      "Public/active.md",
      "Therapy/session.md",
      "Public/older.md",
    ],
    iterateAllLeaves: (cb: (l: FakeLeaf) => void) => leaves.forEach(cb),
    iterateRootLeaves: (cb: (l: FakeLeaf) => void) =>
      leaves.filter((l) => l.getRoot() === rootSplit).forEach(cb),
    ...extra,
  };
  return {
    vault: { adapter: {} },
    metadataCache: {},
    fileManager: {},
    workspace,
  } as unknown as App;
}

const LEAVES = [
  leaf({
    type: "markdown",
    title: "active",
    file: "Public/active.md",
    mode: "source",
    active: true,
  }),
  leaf({
    type: "markdown",
    title: "pinned",
    file: "Public/pinned.md",
    mode: "preview",
    pinned: true,
  }),
  leaf({ type: "canvas", title: "board", file: "Public/board.canvas" }),
  leaf({
    type: "markdown",
    title: "later",
    file: "Public/later.md",
    deferred: true,
  }),
  leaf({ type: "file-explorer", title: "Files", root: leftSplit }),
  leaf({ type: "outline", title: "Outline", root: rightSplit }),
  leaf({
    type: "markdown",
    title: "popout",
    file: "Public/popout.md",
    mode: "source",
    root: popoutRoot,
  }),
  leaf({
    type: "markdown",
    title: "session",
    file: "Therapy/session.md",
    mode: "source",
  }),
];

async function run(
  app: App,
  includeSidebars?: boolean,
): Promise<WorkspaceState> {
  const result = await getWorkspaceStateHandler({
    arguments: includeSidebars === undefined ? {} : { includeSidebars },
    app,
  });
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text) as WorkspaceState;
}

describe("get_workspace_state", () => {
  test("schema declares the tool name and the one optional argument", () => {
    expect(getWorkspaceStateSchema.get("name").toString()).toContain(
      "get_workspace_state",
    );
    expect(getWorkspaceStateSchema.get("arguments").assert({})).toEqual({});
    expect(
      getWorkspaceStateSchema
        .get("arguments")
        .assert({ includeSidebars: true }),
    ).toEqual({ includeSidebars: true });
  });

  test("lists main-area and pop-out leaves with file, mode, pin, active and deferred state; sidebars are left out by default", async () => {
    const app = createGuardedApp(fakeApp(LEAVES), () => EMPTY_POLICY);
    const state = await run(app);
    expect(state.layoutReady).toBe(true);
    expect(state.activeFile).toBe("Public/active.md");
    expect(state.lastOpenFiles).toEqual([
      "Public/active.md",
      "Therapy/session.md",
      "Public/older.md",
    ]);
    expect(state.leaves).toEqual([
      {
        location: "main",
        viewType: "markdown",
        title: "active",
        file: "Public/active.md",
        mode: "source",
        pinned: false,
        active: true,
        deferred: false,
      },
      {
        location: "main",
        viewType: "markdown",
        title: "pinned",
        file: "Public/pinned.md",
        mode: "preview",
        pinned: true,
        active: false,
        deferred: false,
      },
      {
        location: "main",
        viewType: "canvas",
        title: "board",
        file: "Public/board.canvas",
        mode: null,
        pinned: false,
        active: false,
        deferred: false,
      },
      // Deferred: no loaded view, so file and mode come from the persisted state.
      {
        location: "main",
        viewType: "markdown",
        title: "later",
        file: "Public/later.md",
        mode: null,
        pinned: false,
        active: false,
        deferred: true,
      },
      {
        location: "popout",
        viewType: "markdown",
        title: "popout",
        file: "Public/popout.md",
        mode: "source",
        pinned: false,
        active: false,
        deferred: false,
      },
      {
        location: "main",
        viewType: "markdown",
        title: "session",
        file: "Therapy/session.md",
        mode: "source",
        pinned: false,
        active: false,
        deferred: false,
      },
    ]);
  });

  test("includeSidebars adds the docked leaves with their side", async () => {
    const app = createGuardedApp(fakeApp(LEAVES), () => EMPTY_POLICY);
    const state = await run(app, true);
    const sidebars = state.leaves.filter((l) =>
      l.location.endsWith("-sidebar"),
    );
    expect(sidebars).toEqual([
      {
        location: "left-sidebar",
        viewType: "file-explorer",
        title: "Files",
        file: null,
        mode: null,
        pinned: false,
        active: false,
        deferred: false,
      },
      {
        location: "right-sidebar",
        viewType: "outline",
        title: "Outline",
        file: null,
        mode: null,
        pinned: false,
        active: false,
        deferred: false,
      },
    ]);
  });

  test("an excluded folder hides its leaf, its recent-files entry and the active file alike", async () => {
    const policy = compilePolicy(["Therapy"]);
    const raw = fakeApp(LEAVES, {
      getActiveFile: () => ({ path: "Therapy/session.md" }),
    });
    const state = await run(createGuardedApp(raw, () => policy));
    expect(state.activeFile).toBeNull();
    expect(state.lastOpenFiles).toEqual([
      "Public/active.md",
      "Public/older.md",
    ]);
    expect(state.leaves.map((l) => l.title)).toEqual([
      "active",
      "pinned",
      "board",
      "later",
      "popout",
    ]);
    expect(JSON.stringify(state)).not.toContain("Therapy");
  });

  test("a deferred leaf on an excluded file is hidden through its persisted state", async () => {
    const policy = compilePolicy(["Therapy"]);
    const raw = fakeApp([
      leaf({
        type: "markdown",
        title: "hidden later",
        file: "Therapy/later.md",
        deferred: true,
      }),
      leaf({ type: "markdown", title: "shown", file: "Public/a.md" }),
    ]);
    const state = await run(createGuardedApp(raw, () => policy));
    expect(state.leaves.map((l) => l.title)).toEqual(["shown"]);
  });

  test("the guarded leaf refuses to open a file", () => {
    const app = createGuardedApp(fakeApp(LEAVES), () => EMPTY_POLICY);
    const seen: unknown[] = [];
    app.workspace.iterateAllLeaves((l) => seen.push(l));
    expect(seen.length).toBe(LEAVES.length);
    const first = seen[0] as Record<string, unknown>;
    expect(() => first.openFile).toThrow(/refused by policy/);
    expect(() => first.parent).toThrow(/refused by policy/);
    expect(() => (first.view as Record<string, unknown>).leaf).toThrow(
      /refused by policy/,
    );
  });
});
