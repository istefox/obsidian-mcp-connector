import { type } from "arktype";
import type { App, WorkspaceLeaf } from "obsidian";
import { successJson } from "../services/responseBuilders";

export const getWorkspaceStateSchema = type({
  name: '"get_workspace_state"',
  arguments: {
    "includeSidebars?": type("boolean").describe(
      "Also list the leaves docked in the left and right sidebars (file explorer, search, outline, backlinks, ...). Default false: main area and pop-out windows only.",
    ),
  },
}).describe(
  "Returns what is open in Obsidian right now: every tab (leaf) with its location, view type, title, file, editor mode, pin state and whether it is the active one; the active file; and the recently opened files, most recent first. Read-only, no I/O. Use it to see what the user is working on before reading or editing, or to find the tab a note is already open in.",
);

export type GetWorkspaceStateContext = {
  arguments: { includeSidebars?: boolean };
  app: App;
};

export type LeafLocation = "main" | "left-sidebar" | "right-sidebar" | "popout";

export type WorkspaceLeafEntry = {
  location: LeafLocation;
  /** Obsidian view type: `markdown`, `canvas`, `pdf`, `graph`, `file-explorer`, ... */
  viewType: string;
  title: string;
  /** Vault path of the file the leaf shows, or null for a non-file view. */
  file: string | null;
  /** `source` or `preview` for markdown views, else null. */
  mode: string | null;
  pinned: boolean;
  active: boolean;
  /** Obsidian has not loaded the view yet (a tab not visited since startup). */
  deferred: boolean;
};

export type WorkspaceState = {
  layoutReady: boolean;
  activeFile: string | null;
  leaves: WorkspaceLeafEntry[];
  lastOpenFiles: string[];
};

type LeafView = {
  getViewType?: () => string;
  file?: { path: string } | null;
  getMode?: () => string;
};

export function describeLeaf(
  leaf: WorkspaceLeaf,
  location: LeafLocation,
): WorkspaceLeafEntry {
  const view = (leaf.view ?? {}) as LeafView;
  const viewState = leaf.getViewState();
  const state = (viewState.state ?? {}) as Record<string, unknown>;
  const stateFile = typeof state.file === "string" ? state.file : null;
  const stateMode = typeof state.mode === "string" ? state.mode : null;
  return {
    location,
    viewType:
      typeof view.getViewType === "function"
        ? view.getViewType()
        : viewState.type,
    title: leaf.getDisplayText(),
    file: view.file?.path ?? stateFile,
    mode: typeof view.getMode === "function" ? view.getMode() : stateMode,
    pinned: viewState.pinned === true,
    active: viewState.active === true,
    deferred: leaf.isDeferred === true,
  };
}

export function collectWorkspaceState(
  app: App,
  includeSidebars: boolean,
): WorkspaceState {
  const ws = app.workspace;
  const locationOf = (leaf: WorkspaceLeaf): LeafLocation => {
    const root: unknown = leaf.getRoot();
    if (root === ws.rootSplit) return "main";
    if (root === ws.leftSplit) return "left-sidebar";
    if (root === ws.rightSplit) return "right-sidebar";
    return "popout";
  };

  const leaves: WorkspaceLeafEntry[] = [];
  ws.iterateAllLeaves((leaf) => {
    const location = locationOf(leaf);
    if (!includeSidebars && location.endsWith("-sidebar")) return;
    leaves.push(describeLeaf(leaf, location));
  });

  return {
    layoutReady: ws.layoutReady === true,
    activeFile: ws.getActiveFile()?.path ?? null,
    leaves,
    lastOpenFiles: ws.getLastOpenFiles(),
  };
}

export async function getWorkspaceStateHandler(
  ctx: GetWorkspaceStateContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  return successJson(
    collectWorkspaceState(ctx.app, ctx.arguments.includeSidebars === true),
  );
}
