/**
 * The folder-exclusion enforcement seam (ADR-0020 §D1–§D3, §D17).
 *
 * `createGuardedApp` returns an `App` whose vault-reaching surfaces
 * refuse anything under an excluded folder. It is handed to the two
 * composition roots that build the MCP tool and prompt surfaces, and to
 * nothing else — so every tool is covered without knowing this file
 * exists, including one written next year.
 *
 * Three properties are load-bearing and easy to lose in a refactor:
 *
 * 1. **Denial is inherited, not authored.** `getAbstractFileByPath`
 *    returns `null` and reads throw the ENOENT that Obsidian throws for
 *    a missing parent folder, so each tool takes its own existing
 *    not-found branch. No tool carries exclusion-aware code, and none
 *    can therefore leak a distinguishable refusal.
 * 2. **Unclassified members throw.** A member that is neither guarded
 *    nor explicitly passed through is a member nobody thought about, and
 *    silence there is a hole. The colocated test walks the real objects
 *    and names anything unclassified.
 * 3. **The policy is read per call, never captured.** `policySource` is
 *    invoked on every guarded operation so the request-scoped policy is
 *    the one that applies. Capturing a policy at construction would work
 *    today and break the moment phase 2 makes it per token.
 *
 * Scope note: default-deny applies to `vault`, `vault.adapter`,
 * `metadataCache`, `workspace` and `fileManager` — the surfaces where
 * vault paths live. `App` itself passes through, because it also carries
 * the plugin registry and the command surface, which third-party code
 * reaches into and which have nothing to do with paths.
 */
import type { App } from "obsidian";
import type { PathPolicy } from "$/shared/pathPolicy";

/** Supplies the policy in force for the current call. */
export type PolicySource = () => PathPolicy;

/** Brand proving an `App` went through {@link createGuardedApp}. */
const GUARDED = Symbol.for("obsidian-mcp-connector.guardedApp");

/** Anything with a vault-relative path: a `TFile`, a `TFolder`. */
interface PathLike {
  path: string;
  children?: unknown;
}

/**
 * The error Obsidian throws for a path whose parent folder is missing,
 * reproduced so an excluded folder is indistinguishable from an absent
 * one. The mock vault models the same string
 * (`test-setup.ts:1078-1082`), which is what lets the existing per-tool
 * tests keep passing unchanged.
 */
function enoent(path: string): Error {
  const err = new Error(
    `ENOENT: no such file or directory, open '<vault>/${path}'`,
  );
  return Object.assign(err, { code: "ENOENT" });
}

/**
 * Refusal for a recursive operation on an ancestor of an excluded folder
 * (ADR-0020 §D17). Deliberately NOT ENOENT: the folder demonstrably
 * exists and the client can list it, so claiming it is absent is a
 * contradiction the client can see, which is a louder signal than the
 * refusal was meant to hide.
 */
function eperm(path: string): Error {
  const err = new Error(`EPERM: operation not permitted, '${path}'`);
  return Object.assign(err, { code: "EPERM" });
}

function pathOf(file: unknown): string {
  return typeof (file as PathLike | null)?.path === "string"
    ? (file as PathLike).path
    : "";
}

/** True for a `TFolder`; Obsidian marks folders by a `children` array. */
function isFolder(file: unknown): boolean {
  return (file as PathLike | null)?.children !== undefined;
}

/**
 * Language-level members that every object carries and that name no
 * vault path. `toString` in particular is a string key, not a symbol, so
 * it does not ride the symbol escape below — and `String(vault)` in a
 * log line would throw without this.
 */
const UNIVERSAL_PASSTHROUGH: readonly string[] = [
  "toString",
  "valueOf",
  "toLocaleString",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "constructor",
  "then",
  "inspect",
];

/**
 * Wrap `raw` so guarded members are replaced, passthrough and
 * language-level members are forwarded, explicitly denied members throw
 * their stated reason, and anything left over throws for not having been
 * thought about.
 *
 * Symbols always forward: `Symbol.toPrimitive`, `Symbol.iterator` and
 * `util.inspect.custom` are reached that way, and throwing on them would
 * break unrelated machinery in ways that look nothing like this file.
 */
function guardObject<T extends object>(
  raw: T,
  label: string,
  guards: Record<string, unknown>,
  passthrough: readonly string[],
  denied: Readonly<Record<string, string>> = {},
): T {
  const allowed = new Set([...passthrough, ...UNIVERSAL_PASSTHROUGH]);
  return new Proxy(raw, {
    get(target, prop) {
      if (typeof prop === "symbol") {
        const value: unknown = Reflect.get(target, prop, target);
        return value;
      }
      if (Object.prototype.hasOwnProperty.call(guards, prop)) {
        return guards[prop];
      }
      if (Object.prototype.hasOwnProperty.call(denied, prop)) {
        throw new Error(
          `Guarded ${label}: '${prop}' is refused by policy. ${denied[prop]}`,
        );
      }
      if (allowed.has(prop)) {
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      }
      throw new Error(
        `Guarded ${label}: '${prop}' is not classified. Every member that can ` +
          `reach a vault path must be guarded, and every member that provably ` +
          `cannot must be listed as passthrough. See src/shared/guardedApp.ts ` +
          `and ADR-0020 D2.`,
      );
    },
  });
}

/* ------------------------------------------------------------------ */
/* vault.adapter                                                       */
/* ------------------------------------------------------------------ */

/** Members of `DataAdapter` that cannot name a vault path. */
const ADAPTER_PASSTHROUGH = ["getName", "getBasePath", "getResourcePath"];

function guardAdapter(raw: object, policy: PolicySource): object {
  const call = <A extends unknown[], R>(name: string) =>
    (raw as unknown as Record<string, (...a: A) => R>)[name].bind(raw);

  const refuseIfExcluded = (path: string) => {
    if (policy().isExcluded(path)) throw enoent(path);
  };

  const guards: Record<string, unknown> = {
    read: (path: string) => {
      refuseIfExcluded(path);
      return call<[string], Promise<string>>("read")(path);
    },
    readBinary: (path: string) => {
      refuseIfExcluded(path);
      return call<[string], Promise<ArrayBuffer>>("readBinary")(path);
    },
    write: (path: string, data: string, opts?: unknown) => {
      refuseIfExcluded(path);
      return call<[string, string, unknown?], Promise<void>>("write")(
        path,
        data,
        opts,
      );
    },
    writeBinary: (path: string, data: ArrayBuffer, opts?: unknown) => {
      refuseIfExcluded(path);
      return call<[string, ArrayBuffer, unknown?], Promise<void>>(
        "writeBinary",
      )(path, data, opts);
    },
    append: (path: string, data: string, opts?: unknown) => {
      refuseIfExcluded(path);
      return call<[string, string, unknown?], Promise<void>>("append")(
        path,
        data,
        opts,
      );
    },
    remove: (path: string) => {
      refuseIfExcluded(path);
      return call<[string], Promise<void>>("remove")(path);
    },
    mkdir: (path: string) => {
      refuseIfExcluded(path);
      return call<[string], Promise<void>>("mkdir")(path);
    },
    // The one that would destroy the protected material rather than
    // merely disclose it — see ADR-0020 D17.
    rmdir: (path: string, recursive: boolean) => {
      const current = policy();
      if (current.isExcluded(path)) throw enoent(path);
      if (current.containsExcluded(path)) throw eperm(path);
      return call<[string, boolean], Promise<void>>("rmdir")(path, recursive);
    },
    // `false`, not a throw: `exists` answers a question, and the answer
    // for a hidden path is the same as for an absent one.
    exists: async (path: string, sensitive?: boolean) => {
      if (policy().isExcluded(path)) return false;
      return call<[string, boolean?], Promise<boolean>>("exists")(
        path,
        sensitive,
      );
    },
    stat: async (path: string) => {
      if (policy().isExcluded(path)) return null;
      return call<[string], Promise<unknown>>("stat")(path);
    },
    list: async (path: string) => {
      const current = policy();
      if (current.isExcluded(path)) throw enoent(path);
      const listing = (await call<[string], Promise<unknown>>("list")(
        path,
      )) as {
        files?: string[];
        folders?: string[];
      };
      return {
        ...listing,
        files: (listing.files ?? []).filter((p) => !current.isExcluded(p)),
        folders: (listing.folders ?? []).filter((p) => !current.isExcluded(p)),
      };
    },
    // Both ends: a move out of a hidden folder would expose it, a move
    // into one would write there.
    rename: (from: string, to: string) => {
      const current = policy();
      if (current.isExcluded(from)) throw enoent(from);
      if (current.isExcluded(to)) throw enoent(to);
      if (current.containsExcluded(from)) throw eperm(from);
      return call<[string, string], Promise<void>>("rename")(from, to);
    },
    copy: (from: string, to: string) => {
      const current = policy();
      if (current.isExcluded(from)) throw enoent(from);
      if (current.isExcluded(to)) throw enoent(to);
      return call<[string, string], Promise<void>>("copy")(from, to);
    },
  };

  return guardObject(raw, "vault.adapter", guards, ADAPTER_PASSTHROUGH);
}

/* ------------------------------------------------------------------ */
/* vault                                                               */
/* ------------------------------------------------------------------ */

/**
 * Members of `Vault` that provably cannot name a vault path.
 *
 * The event methods are here rather than guarded on purpose: the prompts
 * watcher and the semantic indexer compare already-filtered snapshots,
 * so an event about an excluded file causes a recompute that finds
 * nothing and discloses nothing.
 */
const VAULT_PASSTHROUGH = [
  "getName",
  "configDir",
  "on",
  "off",
  "offref",
  "trigger",
  "tryTrigger",
];

function guardVault(raw: object, policy: PolicySource): object {
  const call = <A extends unknown[], R>(name: string) =>
    (raw as unknown as Record<string, (...a: A) => R>)[name].bind(raw);

  const refuseFile = (file: unknown) => {
    if (policy().isExcluded(pathOf(file))) throw enoent(pathOf(file));
  };
  const refusePath = (path: string) => {
    if (policy().isExcluded(path)) throw enoent(path);
  };
  const filterFiles = <T>(files: T[]): T[] => {
    const current = policy();
    if (current.isEmpty) return files;
    return files.filter((f) => !current.isExcluded(pathOf(f)));
  };

  const lookup = (name: string) => (path: string) =>
    policy().isExcluded(path)
      ? null
      : (call<[string], unknown>(name)(path) ?? null);

  const guards: Record<string, unknown> = {
    getAbstractFileByPath: lookup("getAbstractFileByPath"),
    getFileByPath: lookup("getFileByPath"),
    getFolderByPath: lookup("getFolderByPath"),

    getMarkdownFiles: () =>
      filterFiles(call<[], unknown[]>("getMarkdownFiles")()),
    getFiles: () => filterFiles(call<[], unknown[]>("getFiles")()),
    getAllLoadedFiles: () =>
      filterFiles(call<[], unknown[]>("getAllLoadedFiles")()),
    getAllFolders: (includeRoot?: boolean) =>
      filterFiles(
        call<[boolean?], unknown[]>("getAllFolders")(includeRoot) ?? [],
      ),

    read: (file: unknown) => {
      refuseFile(file);
      return call<[unknown], Promise<string>>("read")(file);
    },
    cachedRead: (file: unknown) => {
      refuseFile(file);
      return call<[unknown], Promise<string>>("cachedRead")(file);
    },
    readBinary: (file: unknown) => {
      refuseFile(file);
      return call<[unknown], Promise<ArrayBuffer>>("readBinary")(file);
    },

    create: (path: string, data: string, opts?: unknown) => {
      refusePath(path);
      return call<[string, string, unknown?], Promise<unknown>>("create")(
        path,
        data,
        opts,
      );
    },
    createBinary: (path: string, data: ArrayBuffer, opts?: unknown) => {
      refusePath(path);
      return call<[string, ArrayBuffer, unknown?], Promise<unknown>>(
        "createBinary",
      )(path, data, opts);
    },
    createFolder: (path: string) => {
      refusePath(path);
      return call<[string], Promise<unknown>>("createFolder")(path);
    },

    modify: (file: unknown, data: string, opts?: unknown) => {
      refuseFile(file);
      return call<[unknown, string, unknown?], Promise<void>>("modify")(
        file,
        data,
        opts,
      );
    },
    modifyBinary: (file: unknown, data: ArrayBuffer, opts?: unknown) => {
      refuseFile(file);
      return call<[unknown, ArrayBuffer, unknown?], Promise<void>>(
        "modifyBinary",
      )(file, data, opts);
    },
    append: (file: unknown, data: string, opts?: unknown) => {
      refuseFile(file);
      return call<[unknown, string, unknown?], Promise<void>>("append")(
        file,
        data,
        opts,
      );
    },
    process: (file: unknown, fn: unknown, opts?: unknown) => {
      refuseFile(file);
      return call<[unknown, unknown, unknown?], Promise<string>>("process")(
        file,
        fn,
        opts,
      );
    },

    // A folder delete takes its whole subtree, so it has to ask the
    // ancestor question as well (ADR-0020 D17).
    delete: (file: unknown, force?: boolean) => {
      const current = policy();
      const path = pathOf(file);
      if (current.isExcluded(path)) throw enoent(path);
      if (isFolder(file) && current.containsExcluded(path)) throw eperm(path);
      return call<[unknown, boolean?], Promise<void>>("delete")(file, force);
    },
    trash: (file: unknown, system?: boolean) => {
      const current = policy();
      const path = pathOf(file);
      if (current.isExcluded(path)) throw enoent(path);
      if (isFolder(file) && current.containsExcluded(path)) throw eperm(path);
      return call<[unknown, boolean?], Promise<void>>("trash")(file, system);
    },
    rename: (file: unknown, newPath: string) => {
      const current = policy();
      const path = pathOf(file);
      if (current.isExcluded(path)) throw enoent(path);
      if (current.isExcluded(newPath)) throw enoent(newPath);
      if (isFolder(file) && current.containsExcluded(path)) throw eperm(path);
      return call<[unknown, string], Promise<void>>("rename")(file, newPath);
    },
    copy: (file: unknown, newPath: string) => {
      const current = policy();
      const path = pathOf(file);
      if (current.isExcluded(path)) throw enoent(path);
      if (current.isExcluded(newPath)) throw enoent(newPath);
      return call<[unknown, string], Promise<unknown>>("copy")(file, newPath);
    },

    adapter: guardAdapter(
      (raw as unknown as { adapter: object }).adapter,
      policy,
    ),
  };

  return guardObject(raw, "vault", guards, VAULT_PASSTHROUGH);
}

/* ------------------------------------------------------------------ */
/* metadataCache                                                       */
/* ------------------------------------------------------------------ */

const METADATA_PASSTHROUGH = ["on", "off", "offref", "trigger", "tryTrigger"];

function guardMetadataCache(raw: object, policy: PolicySource): object {
  const call = <A extends unknown[], R>(name: string) =>
    (raw as unknown as Record<string, (...a: A) => R>)[name].bind(raw);

  /**
   * Filter a link map in BOTH directions: drop excluded sources, and
   * drop excluded targets from every surviving source. Filtering sources
   * alone still leaks excluded paths as link targets through
   * `get_outgoing_links` and `find_broken_links`.
   */
  const filterLinkMap = (
    map: Record<string, Record<string, number>> | undefined,
  ) => {
    const current = policy();
    const source = map ?? {};
    if (current.isEmpty) return source;
    const out: Record<string, Record<string, number>> = {};
    for (const [from, targets] of Object.entries(source)) {
      if (current.isExcluded(from)) continue;
      const kept: Record<string, number> = {};
      for (const [to, count] of Object.entries(targets ?? {})) {
        if (!current.isExcluded(to)) kept[to] = count;
      }
      out[from] = kept;
    }
    return out;
  };

  const guards: Record<string, unknown> = {
    getFileCache: (file: unknown) =>
      policy().isExcluded(pathOf(file))
        ? null
        : call<[unknown], unknown>("getFileCache")(file),
    getCache: (path: string) =>
      policy().isExcluded(path)
        ? null
        : call<[string], unknown>("getCache")(path),
    // `null` makes a link into an excluded folder report as broken,
    // which is exactly what a client would see if the target really did
    // not exist.
    getFirstLinkpathDest: (linkpath: string, sourcePath: string) => {
      const current = policy();
      if (current.isExcluded(sourcePath)) return null;
      const dest = call<[string, string], unknown>("getFirstLinkpathDest")(
        linkpath,
        sourcePath,
      );
      return dest && current.isExcluded(pathOf(dest)) ? null : dest;
    },
    isUserIgnored: (path: string) =>
      policy().isExcluded(path)
        ? true
        : ((
            raw as unknown as { isUserIgnored?: (p: string) => boolean }
          ).isUserIgnored?.(path) ?? false),

    // Tag counts carry no file attribution, so honouring an exclusion is
    // a rebuild rather than a filter — see `getTagCounts` in
    // `listTags.ts`, which needs the vault and therefore lives at the App
    // level, not here. With nothing excluded there is nothing to rebuild
    // for, so the native call is passed straight through and output stays
    // byte-identical to pre-feature behaviour (ADR-0020 D10).
    getTags: () => {
      if (policy().isEmpty) {
        return call<[], Record<string, number>>("getTags")();
      }
      throw new Error(
        "Guarded metadataCache: getTags() cannot honour a folder exclusion — " +
          "its counts carry no file attribution. Use getTagCounts(app), which " +
          "rebuilds them from the guarded file list. See ADR-0020 D10.",
      );
    },
  };

  const proxy = guardObject(raw, "metadataCache", guards, METADATA_PASSTHROUGH);

  // `resolvedLinks` / `unresolvedLinks` are data properties, not
  // methods, so they are defined on the proxy target rather than routed
  // through `get`. Redefining them here keeps the proxy's own `get`
  // trap in charge of everything else.
  return new Proxy(proxy, {
    get(target, prop) {
      if (prop === "resolvedLinks" || prop === "unresolvedLinks") {
        return filterLinkMap(
          (
            raw as unknown as Record<
              string,
              Record<string, Record<string, number>>
            >
          )[prop],
        );
      }
      const value: unknown = Reflect.get(target, prop);
      return value;
    },
  });
}

/* ------------------------------------------------------------------ */
/* workspace / fileManager                                             */
/* ------------------------------------------------------------------ */

/**
 * A `WorkspaceLeaf` can open any file in the vault, so a raw one is never
 * handed out. The members that return one are refused; the two iterators
 * `get_workspace_state` needs hand out `guardLeaf` wrappers instead, a
 * read-only view that skips excluded files (ADR-0020 D2 addendum).
 */
const WORKSPACE_LEAF_REASON =
  "It yields a WorkspaceLeaf, which can open any file and bypass the " +
  "folder-exclusion policy. Guard the leaf before allowing this (ADR-0020 D2).";

const WORKSPACE_PASSTHROUGH = [
  "onLayoutReady",
  "layoutReady",
  "on",
  "off",
  "offref",
  "trigger",
];

/**
 * The write half of a leaf. The snapshot `get_workspace_state` takes is
 * read-only, so anything that opens, moves, pins or closes is refused
 * rather than guarded: a guard would need to vet the file every one of
 * these can reach, for a capability no tool asks for.
 */
const LEAF_WRITE_REASON =
  "The guarded leaf is a read-only snapshot for get_workspace_state; it " +
  "cannot open, move, pin or close anything (ADR-0020 D2 addendum).";

const RAW_BACKREF_REASON =
  "It is a back-reference to the unguarded workspace, leaf or App and " +
  "would route around the facade (ADR-0020 D2 addendum).";

const LEAF_PASSTHROUGH = [
  "getDisplayText",
  "getIcon",
  "getEphemeralState",
  "isDeferred",
  "on",
  "off",
  "offref",
  "trigger",
];

const VIEW_PASSTHROUGH = [
  "getViewType",
  "getDisplayText",
  "getIcon",
  "getMode",
  "getState",
  "getEphemeralState",
  "navigation",
  "editor",
];

/**
 * Identity-preserving wrappers for the workspace containers (`rootSplit`,
 * `leftSplit`, `rightSplit`, pop-out windows), so `leaf.getRoot() ===
 * workspace.rootSplit` keeps meaning what it means on the raw objects.
 * Nothing on a container is classified: `children` walks straight to raw
 * leaves, and a snapshot only ever compares containers by identity.
 */
const guardedContainers = new WeakMap<object, object>();
function guardContainer(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  let guarded = guardedContainers.get(raw);
  if (!guarded) {
    guarded = guardObject(raw, "workspace container", {}, [], {
      children: RAW_BACKREF_REASON,
      parent: RAW_BACKREF_REASON,
      win: RAW_BACKREF_REASON,
      doc: RAW_BACKREF_REASON,
    });
    guardedContainers.set(raw, guarded);
  }
  return guarded;
}

/** The vault path a leaf is showing, from its view or its persisted state. */
function leafPath(leaf: object): string | undefined {
  const view = (leaf as { view?: { file?: unknown } }).view;
  if (view?.file) return pathOf(view.file);
  const state = (
    leaf as { getViewState?: () => { state?: unknown } }
  ).getViewState?.()?.state;
  const file = (state as { file?: unknown } | undefined)?.file;
  return typeof file === "string" ? file : undefined;
}

function guardView(raw: object, policy: PolicySource): object {
  const guards: Record<string, unknown> = {};
  // `file` is read fresh each time: a view can navigate to another note
  // after the wrapper was made.
  Object.defineProperty(guards, "file", {
    enumerable: true,
    get: () => {
      const file = (raw as { file?: unknown }).file;
      return file && policy().isExcluded(pathOf(file)) ? null : file;
    },
  });
  return guardObject(raw, "view", guards, VIEW_PASSTHROUGH, {
    leaf: RAW_BACKREF_REASON,
    app: RAW_BACKREF_REASON,
    containerEl: RAW_BACKREF_REASON,
    contentEl: RAW_BACKREF_REASON,
    setState: LEAF_WRITE_REASON,
    setEphemeralState: LEAF_WRITE_REASON,
  });
}

/**
 * A read-only leaf (ADR-0020 D2 addendum). The iterators below hand out
 * nothing else, and skip any leaf whose file is excluded, so such a tab
 * is indistinguishable from one that is not open.
 */
function guardLeaf(raw: object, policy: PolicySource): object {
  const call = <A extends unknown[], R>(name: string) =>
    (raw as unknown as Record<string, (...a: A) => R>)[name].bind(raw);
  const guards: Record<string, unknown> = {
    getRoot: () => guardContainer(call<[], unknown>("getRoot")()),
    // `group` is a raw WorkspaceLeaf; everything else in a ViewState is
    // plain data about this leaf.
    getViewState: () => {
      const { group: _group, ...rest } = call<
        [],
        Record<string, unknown> & { group?: unknown }
      >("getViewState")();
      return rest;
    },
  };
  Object.defineProperty(guards, "view", {
    enumerable: true,
    get: () => {
      const view = (raw as { view?: unknown }).view;
      return typeof view === "object" && view !== null
        ? guardView(view, policy)
        : view;
    },
  });
  return guardObject(raw, "leaf", guards, LEAF_PASSTHROUGH, {
    parent: RAW_BACKREF_REASON,
    hoverPopover: RAW_BACKREF_REASON,
    openFile: LEAF_WRITE_REASON,
    open: LEAF_WRITE_REASON,
    setViewState: LEAF_WRITE_REASON,
    setEphemeralState: LEAF_WRITE_REASON,
    loadIfDeferred: LEAF_WRITE_REASON,
    togglePinned: LEAF_WRITE_REASON,
    setPinned: LEAF_WRITE_REASON,
    setGroupMember: LEAF_WRITE_REASON,
    setGroup: LEAF_WRITE_REASON,
    detach: LEAF_WRITE_REASON,
  });
}

function guardWorkspace(raw: object, policy: PolicySource): object {
  const call = <A extends unknown[], R>(name: string) =>
    (raw as unknown as Record<string, (...a: A) => R>)[name].bind(raw);

  // Leaves showing an excluded file are skipped, not blanked: a blank
  // entry would still say "a tab is open on something you cannot see".
  const iterate =
    (name: "iterateAllLeaves" | "iterateRootLeaves") =>
    (callback: (leaf: object) => unknown) =>
      call<[(leaf: object) => unknown], void>(name)((leaf) => {
        const path = leafPath(leaf);
        if (path !== undefined && policy().isExcluded(path)) return;
        callback(guardLeaf(leaf, policy));
      });

  const guards: Record<string, unknown> = {
    // `null`, so the whole active-file family answers "no active file"
    // when the user happens to have an excluded note focused.
    getActiveFile: () => {
      const file = call<[], unknown>("getActiveFile")();
      return file && policy().isExcluded(pathOf(file)) ? null : file;
    },
    // A no-op that still resolves: the schema says the file is created
    // if missing, and creating one inside an excluded folder is a write.
    openLinkText: async (
      linktext: string,
      sourcePath: string,
      ...rest: unknown[]
    ) => {
      const current = policy();
      if (current.isExcluded(linktext) || current.isExcluded(sourcePath)) {
        return;
      }
      return call<[string, string, ...unknown[]], Promise<void>>(
        "openLinkText",
      )(linktext, sourcePath, ...rest);
    },
    iterateAllLeaves: iterate("iterateAllLeaves"),
    iterateRootLeaves: iterate("iterateRootLeaves"),
    getLastOpenFiles: () => {
      const current = policy();
      return call<[], string[]>("getLastOpenFiles")().filter(
        (path) => !current.isExcluded(path),
      );
    },
  };
  for (const name of ["rootSplit", "leftSplit", "rightSplit"] as const) {
    Object.defineProperty(guards, name, {
      enumerable: true,
      get: () => guardContainer((raw as Record<string, unknown>)[name]),
    });
  }

  return guardObject(raw, "workspace", guards, WORKSPACE_PASSTHROUGH, {
    getLeaf: WORKSPACE_LEAF_REASON,
    getMostRecentLeaf: WORKSPACE_LEAF_REASON,
    getUnpinnedLeaf: WORKSPACE_LEAF_REASON,
    getActiveViewOfType: WORKSPACE_LEAF_REASON,
    getLeavesOfType: WORKSPACE_LEAF_REASON,
    activeLeaf: WORKSPACE_LEAF_REASON,
    activeEditor: RAW_BACKREF_REASON,
  });
}

function guardFileManager(raw: object, policy: PolicySource): object {
  const call = <A extends unknown[], R>(name: string) =>
    (raw as unknown as Record<string, (...a: A) => R>)[name].bind(raw);

  const guards: Record<string, unknown> = {
    processFrontMatter: (file: unknown, fn: unknown, opts?: unknown) => {
      const path = pathOf(file);
      if (policy().isExcluded(path)) throw enoent(path);
      return call<[unknown, unknown, unknown?], Promise<void>>(
        "processFrontMatter",
      )(file, fn, opts);
    },
    trashFile: (file: unknown) => {
      const current = policy();
      const path = pathOf(file);
      if (current.isExcluded(path)) throw enoent(path);
      if (isFolder(file) && current.containsExcluded(path)) throw eperm(path);
      return call<[unknown], Promise<void>>("trashFile")(file);
    },
    renameFile: (file: unknown, newPath: string) => {
      const current = policy();
      const path = pathOf(file);
      if (current.isExcluded(path)) throw enoent(path);
      if (current.isExcluded(newPath)) throw enoent(newPath);
      return call<[unknown, string], Promise<void>>("renameFile")(
        file,
        newPath,
      );
    },
    generateMarkdownLink: (file: unknown, ...rest: unknown[]) => {
      const path = pathOf(file);
      if (policy().isExcluded(path)) throw enoent(path);
      return call<[unknown, ...unknown[]], string>("generateMarkdownLink")(
        file,
        ...rest,
      );
    },
  };

  return guardObject(raw, "fileManager", guards, []);
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Wrap `app` so its vault-reaching surfaces honour `policySource`.
 *
 * `App` itself is passthrough: it also carries the plugin registry and
 * the command surface, which third-party code reaches into and which
 * name no vault path. The four objects replaced below are where paths
 * live, and each of those is default-deny.
 */
export function createGuardedApp(app: App, policySource: PolicySource): App {
  const vault = guardVault(app.vault, policySource);
  const metadataCache = guardMetadataCache(app.metadataCache, policySource);
  const workspace = guardWorkspace(app.workspace, policySource);
  const fileManager = guardFileManager(app.fileManager, policySource);

  return new Proxy(app, {
    get(target, prop) {
      switch (prop) {
        case GUARDED:
          return true;
        case "vault":
          return vault;
        case "metadataCache":
          return metadataCache;
        case "workspace":
          return workspace;
        case "fileManager":
          return fileManager;
        default: {
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        }
      }
    },
    has(target, prop) {
      return prop === GUARDED || Reflect.has(target, prop);
    },
  });
}

/**
 * True when `app` came from {@link createGuardedApp}.
 *
 * Asserted at both composition roots so wiring the raw `App` back in
 * during a refactor is a startup failure rather than a silent hole.
 */
export function isGuardedApp(app: unknown): boolean {
  return (
    typeof app === "object" &&
    app !== null &&
    (app as Record<symbol, unknown>)[GUARDED] === true
  );
}
