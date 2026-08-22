import { describe, expect, test } from "bun:test";
import type { App } from "obsidian";
import { createGuardedApp, isGuardedApp } from "./guardedApp";
import { EMPTY_POLICY, compilePolicy, type PathPolicy } from "./pathPolicy";
import { mockApp } from "$/test-setup";

const SECRET = "Therapy";
const secretFile = { path: "Therapy/session.md" };
const publicFile = { path: "Public/note.md" };
const secretFolder = { path: "Therapy", children: [] };
const parentFolder = { path: "Journal", children: [] };

/**
 * A raw `App` whose every guarded member records that it was reached.
 * The assertions below are mostly "did the call get through", so the
 * fake returns a marker rather than realistic data.
 */
function makeRawApp() {
  const reached: string[] = [];
  const hit = <T>(name: string, value: T) =>
    ((...args: unknown[]) => {
      reached.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
      return value;
    }) as unknown as (...a: unknown[]) => T;

  const adapter = {
    read: hit("adapter.read", Promise.resolve("raw")),
    readBinary: hit("adapter.readBinary", Promise.resolve(new ArrayBuffer(0))),
    write: hit("adapter.write", Promise.resolve()),
    writeBinary: hit("adapter.writeBinary", Promise.resolve()),
    append: hit("adapter.append", Promise.resolve()),
    remove: hit("adapter.remove", Promise.resolve()),
    mkdir: hit("adapter.mkdir", Promise.resolve()),
    rmdir: hit("adapter.rmdir", Promise.resolve()),
    exists: hit("adapter.exists", Promise.resolve(true)),
    stat: hit("adapter.stat", Promise.resolve({ size: 1 })),
    list: hit(
      "adapter.list",
      Promise.resolve({
        files: ["Public/note.md", "Therapy/session.md"],
        folders: ["Public", "Therapy"],
      }),
    ),
    rename: hit("adapter.rename", Promise.resolve()),
    copy: hit("adapter.copy", Promise.resolve()),
    getName: () => "adapter",
    getBasePath: () => "/vault",
    getResourcePath: hit("adapter.getResourcePath", "app://x"),
    secretlyUnclassified: hit("adapter.secretlyUnclassified", "leak"),
  };

  const vault = {
    adapter,
    getAbstractFileByPath: hit("vault.getAbstractFileByPath", secretFile),
    getFileByPath: hit("vault.getFileByPath", secretFile),
    getFolderByPath: hit("vault.getFolderByPath", secretFolder),
    getMarkdownFiles: () => [publicFile, secretFile],
    getFiles: () => [publicFile, secretFile],
    getAllLoadedFiles: () => [publicFile, secretFile, secretFolder],
    getAllFolders: () => [parentFolder, secretFolder],
    read: hit("vault.read", Promise.resolve("body")),
    cachedRead: hit("vault.cachedRead", Promise.resolve("body")),
    readBinary: hit("vault.readBinary", Promise.resolve(new ArrayBuffer(0))),
    create: hit("vault.create", Promise.resolve(publicFile)),
    createBinary: hit("vault.createBinary", Promise.resolve(publicFile)),
    createFolder: hit("vault.createFolder", Promise.resolve(parentFolder)),
    modify: hit("vault.modify", Promise.resolve()),
    modifyBinary: hit("vault.modifyBinary", Promise.resolve()),
    append: hit("vault.append", Promise.resolve()),
    process: hit("vault.process", Promise.resolve("body")),
    delete: hit("vault.delete", Promise.resolve()),
    trash: hit("vault.trash", Promise.resolve()),
    rename: hit("vault.rename", Promise.resolve()),
    copy: hit("vault.copy", Promise.resolve(publicFile)),
    getName: () => "vault",
    configDir: ".obsidian",
    on: hit("vault.on", { id: 1 }),
    off: hit("vault.off", undefined),
    offref: hit("vault.offref", undefined),
    trigger: hit("vault.trigger", undefined),
    tryTrigger: hit("vault.tryTrigger", undefined),
  };

  const metadataCache = {
    getFileCache: hit("metadataCache.getFileCache", { tags: [] }),
    getCache: hit("metadataCache.getCache", { tags: [] }),
    getFirstLinkpathDest: hit("metadataCache.getFirstLinkpathDest", secretFile),
    isUserIgnored: () => false,
    getTags: () => ({ "#a": 1 }),
    resolvedLinks: {
      "Public/note.md": { "Therapy/session.md": 1, "Public/other.md": 2 },
      "Therapy/session.md": { "Public/note.md": 1 },
    } as Record<string, Record<string, number>>,
    unresolvedLinks: {
      "Public/note.md": { "Therapy/ghost": 1 },
    } as Record<string, Record<string, number>>,
    on: hit("metadataCache.on", { id: 2 }),
    off: hit("metadataCache.off", undefined),
    offref: hit("metadataCache.offref", undefined),
    trigger: hit("metadataCache.trigger", undefined),
    tryTrigger: hit("metadataCache.tryTrigger", undefined),
  };

  const workspace = {
    getActiveFile: () => secretFile as unknown,
    openLinkText: hit("workspace.openLinkText", Promise.resolve()),
    onLayoutReady: hit("workspace.onLayoutReady", undefined),
    on: hit("workspace.on", { id: 3 }),
    off: hit("workspace.off", undefined),
    offref: hit("workspace.offref", undefined),
    trigger: hit("workspace.trigger", undefined),
  };

  const fileManager = {
    processFrontMatter: hit(
      "fileManager.processFrontMatter",
      Promise.resolve(),
    ),
    trashFile: hit("fileManager.trashFile", Promise.resolve()),
    renameFile: hit("fileManager.renameFile", Promise.resolve()),
    generateMarkdownLink: hit("fileManager.generateMarkdownLink", "[[x]]"),
  };

  const app = {
    vault,
    metadataCache,
    workspace,
    fileManager,
    // App-level members that name no vault path and must keep working.
    commands: { executeCommandById: hit("app.commands", true) },
    plugins: { plugins: {} },
  } as unknown as App;

  return { app, reached, rawWorkspace: workspace };
}

const guarded = (policy: PathPolicy) => {
  const { app, reached, rawWorkspace } = makeRawApp();
  return { app: createGuardedApp(app, () => policy), reached, rawWorkspace };
};

const denySecret = () => guarded(compilePolicy([SECRET]));
const denyNothing = () => guarded(EMPTY_POLICY);

/** Assert a call rejects or throws with the given errno code. */
async function expectCode(fn: () => unknown, code: string) {
  try {
    await fn();
  } catch (e) {
    expect((e as NodeJS.ErrnoException).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} error, but the call succeeded`);
}

describe("createGuardedApp — the brand", () => {
  test("a guarded app is recognisable, a raw one is not", () => {
    const { app } = makeRawApp();
    expect(isGuardedApp(app)).toBe(false);
    expect(isGuardedApp(createGuardedApp(app, () => EMPTY_POLICY))).toBe(true);
  });

  test("isGuardedApp tolerates junk", () => {
    for (const junk of [undefined, null, 42, "app", {}, []]) {
      expect(isGuardedApp(junk)).toBe(false);
    }
  });

  test("app-level members that name no path still work", () => {
    const { app } = denySecret();
    expect(
      (
        app as unknown as { commands: { executeCommandById: () => boolean } }
      ).commands.executeCommandById(),
    ).toBe(true);
  });
});

// The acceptance criterion for the whole facade: with nothing
// configured, every member must behave exactly as the raw one.
describe("createGuardedApp — inert when nothing is excluded", () => {
  test("lookups, listings and reads are untouched", async () => {
    const { app } = denyNothing();
    expect(app.vault.getAbstractFileByPath("Therapy/session.md")).toEqual(
      secretFile as never,
    );
    expect(app.vault.getMarkdownFiles()).toHaveLength(2);
    expect(app.vault.getFiles()).toHaveLength(2);
    expect(await app.vault.cachedRead(secretFile as never)).toBe("body");
    expect(app.workspace.getActiveFile()).toEqual(secretFile as never);
  });

  test("the link maps are handed back unchanged", () => {
    const { app } = denyNothing();
    expect(app.metadataCache.resolvedLinks["Therapy/session.md"]).toEqual({
      "Public/note.md": 1,
    });
    expect(app.metadataCache.unresolvedLinks["Public/note.md"]).toEqual({
      "Therapy/ghost": 1,
    });
  });

  test("writes and deletes go through", async () => {
    const { app, reached } = denyNothing();
    await app.vault.create("Therapy/new.md", "x");
    await app.vault.delete(secretFolder as never);
    expect(reached.some((r) => r.startsWith("vault.create"))).toBe(true);
    expect(reached.some((r) => r.startsWith("vault.delete"))).toBe(true);
  });
});

describe("guarded vault — lookups and listings", () => {
  test("an excluded path resolves to null, exactly like an absent one", () => {
    const { app } = denySecret();
    expect(app.vault.getAbstractFileByPath("Therapy/session.md")).toBeNull();
    expect(app.vault.getAbstractFileByPath("Therapy")).toBeNull();
  });

  test("a path outside the excluded folder resolves normally", () => {
    const { app } = denySecret();
    expect(app.vault.getAbstractFileByPath("Public/note.md")).toEqual(
      secretFile as never,
    );
  });

  test("every wholesale enumeration drops excluded entries", () => {
    const { app } = denySecret();
    for (const files of [
      app.vault.getMarkdownFiles(),
      app.vault.getFiles(),
      (
        app.vault as unknown as { getAllLoadedFiles: () => unknown[] }
      ).getAllLoadedFiles(),
      (
        app.vault as unknown as { getAllFolders: () => unknown[] }
      ).getAllFolders(),
    ]) {
      expect(files.map((f) => (f as { path: string }).path)).not.toContain(
        "Therapy/session.md",
      );
      expect(files.map((f) => (f as { path: string }).path)).not.toContain(
        "Therapy",
      );
    }
  });
});

describe("guarded vault — reads and writes", () => {
  test("every read of an excluded file throws ENOENT", async () => {
    const { app } = denySecret();
    const v = app.vault as unknown as Record<
      string,
      (f: unknown) => Promise<unknown>
    >;
    for (const name of ["read", "cachedRead", "readBinary"]) {
      await expectCode(() => v[name](secretFile), "ENOENT");
    }
  });

  test("every write into an excluded folder throws ENOENT", async () => {
    const { app } = denySecret();
    await expectCode(() => app.vault.create("Therapy/new.md", "x"), "ENOENT");
    await expectCode(
      () => app.vault.createBinary("Therapy/n.bin", new ArrayBuffer(0)),
      "ENOENT",
    );
    await expectCode(() => app.vault.createFolder("Therapy/sub"), "ENOENT");
    await expectCode(
      () => app.vault.modify(secretFile as never, "x"),
      "ENOENT",
    );
    await expectCode(
      () => app.vault.process(secretFile as never, (s: string) => s),
      "ENOENT",
    );
  });

  test("the raw member is never reached for an excluded path", async () => {
    const { app, reached } = denySecret();
    await expectCode(() => app.vault.read(secretFile as never), "ENOENT");
    expect(reached).toHaveLength(0);
  });

  test("a rename is refused from either side", async () => {
    const { app } = denySecret();
    await expectCode(
      () => app.vault.rename(secretFile as never, "Public/moved.md"),
      "ENOENT",
    );
    await expectCode(
      () => app.vault.rename(publicFile as never, "Therapy/moved.md"),
      "ENOENT",
    );
  });
});

// ADR-0020 D17. Getting this wrong destroys the protected material
// rather than merely disclosing it.
describe("guarded vault — the ancestor rule", () => {
  test("deleting an excluded folder is ENOENT", async () => {
    const { app } = denySecret();
    await expectCode(() => app.vault.delete(secretFolder as never), "ENOENT");
  });

  test("deleting an ancestor of an excluded folder is EPERM, not ENOENT", async () => {
    const { app } = guarded(compilePolicy(["Journal/Therapy"]));
    // Journal demonstrably exists and the client can list it, so
    // claiming it is absent would be a contradiction the client can see.
    await expectCode(() => app.vault.delete(parentFolder as never), "EPERM");
    await expectCode(
      () => app.vault.trash(parentFolder as never, true),
      "EPERM",
    );
  });

  test("deleting an unrelated folder still works", async () => {
    const { app, reached } = guarded(compilePolicy(["Therapy"]));
    await app.vault.delete({ path: "Archive", children: [] } as never);
    expect(reached.some((r) => r.startsWith("vault.delete"))).toBe(true);
  });

  test("a FILE that merely shares a prefix is not treated as an ancestor", async () => {
    const { app, reached } = guarded(compilePolicy(["Journal/Therapy"]));
    await app.vault.delete({ path: "Journal" } as never); // no children: a file
    expect(reached.some((r) => r.startsWith("vault.delete"))).toBe(true);
  });
});

describe("guarded adapter", () => {
  test("reads and writes of an excluded path throw ENOENT", async () => {
    const { app } = denySecret();
    const a = app.vault.adapter as unknown as Record<
      string,
      (...x: unknown[]) => Promise<unknown>
    >;
    for (const name of ["read", "readBinary", "remove", "mkdir"]) {
      await expectCode(() => a[name]("Therapy/session.md"), "ENOENT");
    }
    await expectCode(() => a.write("Therapy/x.md", "data"), "ENOENT");
  });

  test("exists answers false rather than throwing", async () => {
    const { app } = denySecret();
    const a = app.vault.adapter as unknown as {
      exists: (p: string) => Promise<boolean>;
      stat: (p: string) => Promise<unknown>;
    };
    expect(await a.exists("Therapy/session.md")).toBe(false);
    expect(await a.stat("Therapy/session.md")).toBeNull();
    expect(await a.exists("Public/note.md")).toBe(true);
  });

  test("a listing omits excluded files and folders", async () => {
    const { app } = denySecret();
    const a = app.vault.adapter as unknown as {
      list: (p: string) => Promise<{ files: string[]; folders: string[] }>;
    };
    const listing = await a.list("");
    expect(listing.files).toEqual(["Public/note.md"]);
    expect(listing.folders).toEqual(["Public"]);
  });

  test("rmdir on an ancestor is EPERM, on the folder itself ENOENT", async () => {
    const { app } = guarded(compilePolicy(["Journal/Therapy"]));
    const a = app.vault.adapter as unknown as {
      rmdir: (p: string, r: boolean) => Promise<void>;
    };
    await expectCode(() => a.rmdir("Journal", true), "EPERM");
    await expectCode(() => a.rmdir("Journal/Therapy", true), "ENOENT");
  });

  test("path-free members pass through", () => {
    const { app } = denySecret();
    const a = app.vault.adapter as unknown as {
      getName: () => string;
      getBasePath: () => string;
    };
    expect(a.getName()).toBe("adapter");
    expect(a.getBasePath()).toBe("/vault");
  });
});

describe("guarded metadataCache", () => {
  test("the cache of an excluded file is null", () => {
    const { app } = denySecret();
    expect(app.metadataCache.getFileCache(secretFile as never)).toBeNull();
    expect(app.metadataCache.getFileCache(publicFile as never)).not.toBeNull();
  });

  test("a link into an excluded folder resolves to null, i.e. broken", () => {
    const { app } = denySecret();
    expect(
      app.metadataCache.getFirstLinkpathDest("session", "Public/note.md"),
    ).toBeNull();
  });

  // Both directions. Filtering sources alone still leaks excluded paths
  // as link TARGETS through get_outgoing_links and find_broken_links.
  test("the link graph is filtered in both directions", () => {
    const { app } = denySecret();
    const resolved = app.metadataCache.resolvedLinks;
    expect(Object.keys(resolved)).toEqual(["Public/note.md"]);
    expect(resolved["Public/note.md"]).toEqual({ "Public/other.md": 2 });
  });

  test("unresolved links are filtered the same way", () => {
    const { app } = denySecret();
    expect(app.metadataCache.unresolvedLinks["Public/note.md"]).toEqual({});
  });

  test("isUserIgnored is true for an excluded path", () => {
    const { app } = denySecret();
    const mc = app.metadataCache as unknown as {
      isUserIgnored: (p: string) => boolean;
    };
    expect(mc.isUserIgnored("Therapy/session.md")).toBe(true);
    expect(mc.isUserIgnored("Public/note.md")).toBe(false);
  });

  // Its counts carry no file attribution, so it cannot be filtered and
  // must not be silently served either.
  test("getTags refuses rather than returning unfiltered counts", () => {
    const { app } = denySecret();
    const mc = app.metadataCache as unknown as { getTags: () => unknown };
    expect(() => mc.getTags()).toThrow(/no file attribution/);
  });
});

describe("guarded workspace and fileManager", () => {
  test("an excluded active file reads as no active file", () => {
    const { app } = denySecret();
    expect(app.workspace.getActiveFile()).toBeNull();
  });

  test("openLinkText into an excluded folder is a silent no-op", async () => {
    const { app, reached } = denySecret();
    await app.workspace.openLinkText("Therapy/session.md", "");
    expect(reached).toHaveLength(0);
    await app.workspace.openLinkText("Public/note.md", "");
    expect(reached.some((r) => r.startsWith("workspace.openLinkText"))).toBe(
      true,
    );
  });

  test("fileManager refuses every excluded file", async () => {
    const { app } = denySecret();
    await expectCode(
      () => app.fileManager.processFrontMatter(secretFile as never, () => {}),
      "ENOENT",
    );
    await expectCode(
      () => app.fileManager.trashFile(secretFile as never),
      "ENOENT",
    );
    await expectCode(
      () => app.fileManager.renameFile(secretFile as never, "Public/x.md"),
      "ENOENT",
    );
  });

  test("renameFile is refused when the DESTINATION is excluded", async () => {
    const { app } = denySecret();
    await expectCode(
      () => app.fileManager.renameFile(publicFile as never, "Therapy/x.md"),
      "ENOENT",
    );
  });
});

// Property 2 of the module header. A member nobody classified is a
// member nobody thought about, and silence there is a hole.
describe("default-deny", () => {
  test("an unclassified member throws, and the message says what to do", () => {
    const { app } = denySecret();
    const a = app.vault.adapter as unknown as Record<string, unknown>;
    expect(() => a.secretlyUnclassified).toThrow(/is not classified/);
    expect(() => a.secretlyUnclassified).toThrow(/ADR-0020 D2/);
  });

  test("symbols always pass, so unrelated machinery keeps working", () => {
    const { app } = denySecret();
    expect(() => String(app.vault)).not.toThrow();
    expect(() => JSON.stringify({ v: typeof app.vault })).not.toThrow();
  });

  test("a member refused on purpose says so, and says why", () => {
    const { app } = denySecret();
    const ws = app.workspace as unknown as Record<string, unknown>;
    // Handing out a WorkspaceLeaf would route around the facade
    // entirely, so it is refused until someone guards the leaf.
    expect(() => ws.getLeaf).toThrow(/refused by policy/);
    expect(() => ws.getLeaf).toThrow(/WorkspaceLeaf/);
    // ...and it is a different message from the oversight case, which is
    // what the exhaustiveness check below relies on.
    expect(() => ws.getLeaf).not.toThrow(/is not classified/);
  });

  // The exhaustiveness check. Walks the objects Obsidian actually hands
  // us and names anything the facade does not classify, so a new member
  // is a red test rather than a runtime surprise in one tool.
  test("every member of the real mock App is classified", () => {
    const raw = mockApp();
    const app = createGuardedApp(raw, () => EMPTY_POLICY);
    const surfaces: [string, object, object][] = [
      ["vault", raw.vault, app.vault],
      ["metadataCache", raw.metadataCache, app.metadataCache],
      ["workspace", raw.workspace, app.workspace],
      ["fileManager", raw.fileManager, app.fileManager],
    ];

    const unclassified: string[] = [];
    for (const [label, rawObj, guardedObj] of surfaces) {
      const names = new Set<string>();
      for (
        let o: object | null = rawObj;
        o && o !== Object.prototype;
        o = Object.getPrototypeOf(o) as object | null
      ) {
        for (const k of Object.getOwnPropertyNames(o)) names.add(k);
      }
      for (const name of names) {
        if (name === "constructor") continue;
        try {
          (guardedObj as Record<string, unknown>)[name];
        } catch (e) {
          // A member refused ON PURPOSE says so and carries its reason;
          // only silence counts as an oversight here.
          if (/is not classified/.test((e as Error).message)) {
            unclassified.push(`${label}.${name}`);
          }
        }
      }
    }
    expect(unclassified).toEqual([]);
  });
});
