/**
 * The `app.vault` the headless server exposes: a file index over a vault
 * directory plus the write operations the MCP tools call.
 *
 * Three rules keep the index honest:
 *
 * 1. Our own writes update the index and the metadata cache before the
 *    promise resolves, so a tool call that follows a write sees it. The
 *    file watcher sees the same write later and finds nothing to do,
 *    because `reconcile` compares a stat signature first.
 * 2. Writes to one path are serialised through a per-path queue, and each
 *    write reads fresh, then lands atomically (temp file in the same
 *    directory, then rename), so a reader never sees half a file. A rename
 *    of a file or folder takes the whole vault: it waits for every write in
 *    flight, and writes that arrive meanwhile wait for it, so no writer
 *    holds text read from a path that has moved.
 * 3. Every index update runs through one serial queue: a rescan, a
 *    watcher reconcile, and our own write once it is on disk, which
 *    reconciles its path. A rescan therefore never applies its listing
 *    over a change made after the listing was taken.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { errorWithReason } from "./domainError";
import { HeadlessEvents } from "./events";
import { HeadlessMetadataCache } from "./headlessMetadataCache";
import {
  moveNoReplace,
  nodeMoveOps,
  type MoveOps,
  type MoveResult,
} from "./moveEntry";
import { TAbstractFile, TFile, TFolder } from "./obsidianShim";
import { isLinkableName } from "./renameLinks";
import {
  hasBackslashName,
  isSkippedPath,
  isSkippedSegment,
  normalizeVaultPath,
  VaultFs,
  VaultPathError,
} from "./vaultFs";

const READ_CONCURRENCY = 16;

type FileStat = { ctime: number; mtime: number; size: number };

/** The SHA-256 of what an edit read, for the check right before its write lands. */
type CommitCheck = { rel: string; digest: string };

function toFileStat(stats: Stats): FileStat {
  return {
    ctime: Math.floor(
      stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs,
    ),
    mtime: Math.floor(stats.mtimeMs),
    size: stats.size,
  };
}

/** Changes whenever the file's bytes or identity change on disk. */
function signature(stats: Stats): string {
  return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}`;
}

function parentOf(rel: string): string {
  const slash = rel.lastIndexOf("/");
  return slash < 0 ? "" : rel.slice(0, slash);
}

function errorWithCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Lookups take the same stand as writes on a path with a backslash on
 * POSIX: the index never holds such a name, so an answer of "not found"
 * would hide that the client named a path the vault cannot address.
 */
function refuseBackslash(p: string): void {
  if (hasBackslashName(p)) normalizeVaultPath(p);
}

/** SHA-256 of a text, as UTF-8. Two reads of one file agree when its decoded text does. */
const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** What a rename changed, for the caller that rewrites the links. */
export type RenameResult = {
  /** Every file that moved, old path to new path. */
  moves: Map<string, string>;
  /** Every file path before the move. */
  before: string[];
  /** Notes (by their old path) that link to a moved file, or moved themselves. */
  linkers: string[];
  /**
   * Vault-relative path of a hidden temporary name of the moved file that
   * could not be removed. The move itself succeeded.
   */
  leftover?: string;
};

/** Seams for tests. Production uses the defaults. */
export type HeadlessVaultOptions = {
  /** Clock for trash names. */
  now?: () => number;
  /** Runs after `rescan` read a file and before it finishes. */
  afterScanRead?: (rel: string) => Promise<void>;
  /** Runs after `rescan` listed the disk and before it applies the listing. */
  afterScanList?: () => Promise<void>;
  /** Runs each time a rescan or reconcile is requested and waits its turn. */
  onQueued?: () => void;
  /**
   * Runs once an edit's new content is staged and before the check that
   * the file still holds what the edit started from. The path is
   * vault-relative.
   */
  beforeCommit?: (rel: string) => Promise<void>;
  /** The stat a reconcile makes. Tests use it to act like a case-insensitive filesystem. */
  lstat?: (abs: string) => Promise<Stats>;
  /** The filesystem calls a move or trash makes. */
  moveOps?: MoveOps;
};

export class HeadlessVault extends HeadlessEvents {
  readonly configDir = ".obsidian";
  readonly metadata: HeadlessMetadataCache;
  readonly adapter: HeadlessAdapter;
  private readonly rootFolder: TFolder;
  private readonly files = new Map<string, TFile>();
  private readonly folders = new Map<string, TFolder>();
  private readonly signatures = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Writes in flight (they share the vault) and the rename that waits for them. */
  private writers = 0;
  private renaming: Promise<void> | null = null;
  private drainWaiters: Array<() => void> = [];
  /** Tail of the serial queue every index update runs through. */
  private indexTail: Promise<unknown> = Promise.resolve();
  /** A rescan that is queued and not started yet, shared by new requests. */
  private pendingScan: Promise<void> | null = null;
  /** Reconciles queued and not started yet, which run as one batch. */
  private pendingReconcile: {
    paths: Set<string>;
    errors: Map<string, unknown>;
    done: Promise<void>;
  } | null = null;
  private batchDepth = 0;
  private deferred: Array<[string, TAbstractFile, ...unknown[]]> = [];

  private constructor(
    private readonly vfs: VaultFs,
    private readonly options: HeadlessVaultOptions,
  ) {
    super();
    // Obsidian names the root folder "/"; the index keys it as "".
    this.rootFolder = new TFolder(this, "/");
    this.folders.set("", this.rootFolder);
    this.metadata = new HeadlessMetadataCache({
      allPaths: () => this.files.keys(),
      getFileByPath: (p) => this.files.get(p) ?? null,
    });
    this.adapter = new HeadlessAdapter(this, vfs);
  }

  /** Open the vault directory. The index stays empty until `rescan`. */
  static async open(
    dir: string,
    options: HeadlessVaultOptions = {},
  ): Promise<HeadlessVault> {
    return new HeadlessVault(await VaultFs.open(dir), options);
  }

  get root(): string {
    return this.vfs.root;
  }

  /* ---------------------------------------------------------------- */
  /* Lookups                                                           */
  /* ---------------------------------------------------------------- */

  getName(): string {
    return path.basename(this.vfs.root);
  }

  getRoot(): TFolder {
    return this.rootFolder;
  }

  getAbstractFileByPath(p: string): TAbstractFile | null {
    if (p === "/") return this.rootFolder;
    if (p === "") return null;
    refuseBackslash(p);
    return this.files.get(p) ?? this.folders.get(p) ?? null;
  }

  getFileByPath(p: string): TFile | null {
    refuseBackslash(p);
    return this.files.get(p) ?? null;
  }

  getFolderByPath(p: string): TFolder | null {
    if (p === "/") return this.rootFolder;
    if (p === "") return null;
    refuseBackslash(p);
    return this.folders.get(p) ?? null;
  }

  getFiles(): TFile[] {
    return [...this.files.values()];
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].filter((f) => f.extension === "md");
  }

  getAllFolders(includeRoot = false): TFolder[] {
    return [...this.folders.values()].filter(
      (f) => includeRoot || f !== this.rootFolder,
    );
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.folders.values(), ...this.files.values()];
  }

  /* ---------------------------------------------------------------- */
  /* Reads                                                             */
  /* ---------------------------------------------------------------- */

  async read(file: TFile): Promise<string> {
    return this.guard(async () =>
      fs.readFile(await this.vfs.resolve(file.path), "utf8"),
    );
  }

  /** There is no in-memory copy to prefer; the disk is the source of truth. */
  cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.guard(async () => {
      const buf = await fs.readFile(await this.vfs.resolve(file.path));
      return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Writes                                                            */
  /* ---------------------------------------------------------------- */

  create(rel: string, data: string): Promise<TFile> {
    return this.createFile(rel, data);
  }

  createBinary(rel: string, data: ArrayBuffer): Promise<TFile> {
    return this.createFile(rel, new Uint8Array(data));
  }

  async createFolder(rel: string): Promise<TFolder> {
    return this.guard(async () => {
      const normalized = normalizeVaultPath(rel);
      if (this.folders.has(normalized) || this.files.has(normalized)) {
        throw new Error("Folder already exists.");
      }
      await fs.mkdir(await this.vfs.resolveEntry(normalized), {
        recursive: true,
      });
      await this.reconcile(normalized);
      const folder = this.folders.get(normalized);
      if (!folder)
        throw errorWithCode("ENOENT: no such file or directory", "ENOENT");
      return folder;
    });
  }

  modify(file: TFile, data: string): Promise<void> {
    return this.enqueue(
      () => file.path,
      async () => {
        await this.writeExisting(file, data);
      },
    );
  }

  modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    return this.enqueue(
      () => file.path,
      async () => {
        await this.writeExisting(file, new Uint8Array(data));
      },
    );
  }

  append(file: TFile, data: string): Promise<void> {
    return this.process(file, (current) => current + data).then(() => {});
  }

  /**
   * Read the file fresh, run the synchronous callback, write the result.
   * No write made through this vault can land on this path between the
   * read and the write, and no rename can move it: both happen inside the
   * path's queue. A program outside the server can write, so the write
   * checks the file once more right before it lands (see `writeAtomic`) and
   * fails instead of replacing an edit it never saw.
   */
  process(file: TFile, fn: (data: string) => string): Promise<string> {
    return this.enqueue(
      () => file.path,
      async () => {
        const current = await this.read(file);
        const next = fn(current);
        if (next !== current) {
          await this.writeExisting(file, next, {
            rel: file.path,
            digest: sha256(current),
          });
        }
        return next;
      },
    );
  }

  /**
   * Run `edit` on the file's parsed text under the same per-path queue as
   * `process`. Exposed for fileManager.processFrontMatter.
   */
  processText(file: TFile, edit: (data: string) => string): Promise<void> {
    return this.process(file, edit).then(() => {});
  }

  async delete(file: TAbstractFile, _force?: boolean): Promise<void> {
    await this.guard(async () => {
      const abs = await this.vfs.resolveEntry(file.path);
      if (file instanceof TFolder) await fs.rm(abs, { recursive: true });
      else await fs.unlink(abs);
      await this.reconcile(file.path);
    });
  }

  /** Move to `<vault>/.trash/`, the Obsidian "move to Obsidian trash" setting. */
  async trash(file: TAbstractFile, _system?: boolean): Promise<void> {
    await this.guard(async () => {
      const abs = await this.vfs.resolveEntry(file.path);
      const trashDir = await this.vfs.trashDir();
      const { leftover } = await this.moveToFreeName(abs, trashDir, file.name);
      await this.reconcile(file.path);
      if (leftover !== undefined) {
        throw errorWithReason(
          `The file was moved to the trash, but its temporary name ${this.relative(leftover)} could not be removed`,
          "ELEFTOVER",
        );
      }
    });
  }

  /**
   * Move a file or folder to `newPath` on disk and in the index, and emit
   * `rename` for it and everything below it. Does not touch links: the
   * result tells the caller what moved. The destination must not exist and
   * its parent folder must. The move waits for every write in flight and
   * holds off new ones, then takes its turn in the index queue, so it never
   * interleaves with a rescan, a reconcile or another write.
   */
  rename(entry: TAbstractFile, newPath: string): Promise<RenameResult> {
    return this.guard(() =>
      this.exclusive(async () => {
        // An edit made outside that the watcher has not applied yet would
        // hide a note that links here.
        await this.flushPending();
        return this.serial(() => this.renameNow(entry, newPath));
      }),
    );
  }

  /**
   * Settles the changes the file watcher has seen and not applied yet. The
   * watcher sets it. A change the operating system has not reported yet
   * cannot be known.
   */
  flushPending: () => Promise<void> = async () => {};

  private async renameNow(
    entry: TAbstractFile,
    newPath: string,
  ): Promise<RenameResult> {
    if (entry === this.rootFolder) {
      throw new VaultPathError("The vault root cannot be changed", "EACCES");
    }
    const from = normalizeVaultPath(entry.path);
    const to = normalizeVaultPath(newPath);
    // A name that a link cannot spell would break every link written to it.
    // Desktop Obsidian refuses `[ ] | # ^` too. Only the name this rename
    // gives the entry is checked. The folders above it already exist, so
    // the rename creates and changes no segment of them, and a file may
    // move into a folder with such a name or keep one. A link that cannot
    // be written for that reason is left as it was and reported.
    const name = to.slice(to.lastIndexOf("/") + 1);
    if (
      name !== from.slice(from.lastIndexOf("/") + 1) &&
      !isLinkableName(name)
    ) {
      throw new VaultPathError(
        "A name cannot contain any of [ ] | # ^ ` or start or end with whitespace because it would break links",
        "EINVAL",
      );
    }
    const isFolder = entry instanceof TFolder;
    const indexed = isFolder ? this.folders.get(from) : this.files.get(from);
    if (indexed !== entry) {
      throw errorWithCode("ENOENT: no such file or directory", "ENOENT");
    }
    const absFrom = await this.vfs.resolveEntry(from);
    const absTo = await this.vfs.resolveEntry(to);
    if (from === to) {
      throw errorWithReason("Source and destination are identical", "EINVAL");
    }
    if (isFolder && to.startsWith(`${from}/`)) {
      throw errorWithReason("A folder cannot move into itself", "EINVAL");
    }
    if (this.files.has(to) || this.folders.has(to)) {
      throw errorWithReason("Destination already exists", "EEXIST");
    }
    const parent = parentOf(to);
    if (parent !== "" && !this.folders.has(parent)) {
      throw errorWithReason(
        "Destination parent folder does not exist",
        "ENOENT",
      );
    }

    const before = [...this.files.keys()];
    const moves = new Map<string, string>();
    for (const p of before) {
      if (p === from) moves.set(p, to);
      else if (p.startsWith(`${from}/`))
        moves.set(p, to + p.slice(from.length));
    }
    const linkers = new Set<string>();
    for (const p of moves.keys()) if (p.endsWith(".md")) linkers.add(p);
    for (const [note, targets] of Object.entries(this.metadata.resolvedLinks)) {
      if (Object.keys(targets).some((t) => moves.has(t))) linkers.add(note);
    }

    // The signatures from before the move go with the files: the move
    // changes none of their bytes, and a change made outside since the index
    // last looked then shows as a mismatch at the next reconcile instead of
    // being paired with metadata that does not describe it.
    const signatures = new Map<string, string | undefined>();
    for (const old of moves.keys())
      signatures.set(old, this.signatures.get(old));

    const { leftover } = await moveNoReplace(
      absFrom,
      absTo,
      isFolder,
      this.options.moveOps ?? nodeMoveOps,
    );

    // A file that becomes a note, or stops being one, has no metadata to
    // carry over: a note's is parsed from the disk, as the scan would.
    const isNote = (p: string) => p.endsWith(".md");
    const fresh = new Map<string, { signature: string; content: string }>();
    for (const [old, next] of moves) {
      if (isNote(old) || !isNote(next)) continue;
      const abs = path.join(this.vfs.root, ...next.split("/"));
      const st = await fs.lstat(abs).catch(() => null);
      if (!st?.isFile()) continue;
      const content = await fs.readFile(abs, "utf8").catch(() => null);
      if (content !== null)
        fresh.set(next, { signature: signature(st), content });
    }
    await this.batch(async () => {
      const renamed: Array<[TAbstractFile, string]> = [];
      this.detach(entry);
      if (isFolder) {
        const old = [...this.folders.keys()]
          .filter((p) => p === from || p.startsWith(`${from}/`))
          .sort((a, b) => a.length - b.length);
        const folders = old.map((p) => this.folders.get(p) as TFolder);
        for (const p of old) this.folders.delete(p);
        folders.forEach((folder, i) => {
          folder.path = to + old[i].slice(from.length);
          folder.syncName();
          this.folders.set(folder.path, folder);
          renamed.push([folder, old[i]]);
        });
      }
      for (const [old, next] of moves) {
        const file = this.files.get(old) as TFile;
        const becomesNote = !isNote(old) && isNote(next);
        const stopsBeingNote = isNote(old) && !isNote(next);
        if (stopsBeingNote) this.metadata.removeFile(file);
        this.files.delete(old);
        file.path = next;
        file.syncName();
        this.files.set(next, file);
        this.signatures.delete(old);
        const kept = fresh.get(next);
        const sig = becomesNote ? kept?.signature : signatures.get(old);
        if (sig !== undefined) this.signatures.set(next, sig);
        if (becomesNote) {
          if (kept) this.metadata.setContent(file, kept.content, false);
        } else if (!stopsBeingNote) {
          this.metadata.moveFile(file, old);
        }
        renamed.push([file, old]);
      }
      const home = this.ensureFolder(parentOf(to));
      entry.parent = home;
      home.children.push(entry);
      this.metadata.fileSetChanged();
      for (const [moved, old] of renamed) this.emit("rename", moved, old);
    });
    return {
      moves,
      before,
      linkers: [...linkers].sort(),
      ...(leftover === undefined ? {} : { leftover: this.relative(leftover) }),
    };
  }

  /** The vault-relative path of an absolute path inside the vault. */
  private relative(abs: string): string {
    return path.relative(this.vfs.root, abs).split(path.sep).join("/");
  }

  /* ---------------------------------------------------------------- */
  /* Index maintenance                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Run an index update whose link resolution is settled once at the end.
   * Events raised inside wait for that, so a listener that reacts to
   * "create" sees links already resolved against the new file set.
   */
  private async batch(fn: () => Promise<void>): Promise<void> {
    this.batchDepth += 1;
    try {
      await this.metadata.batch(fn);
    } finally {
      this.batchDepth -= 1;
    }
    if (this.batchDepth === 0) {
      const events = this.deferred;
      this.deferred = [];
      for (const [name, ...args] of events) this.trigger(name, ...args);
    }
  }

  private emit(name: string, entry: TAbstractFile, ...rest: unknown[]): void {
    if (this.batchDepth > 0) this.deferred.push([name, entry, ...rest]);
    else this.trigger(name, entry, ...rest);
  }

  /**
   * Run one index update after every update queued before it, so no two
   * ever interleave.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.indexTail.then(fn);
    this.indexTail = next.catch(() => {});
    return next;
  }

  /**
   * Re-walk the whole vault and reconcile the index with the disk. A
   * request made while a rescan is queued shares it, so requests made
   * during a rescan add at most one more.
   */
  rescan(): Promise<void> {
    this.pendingScan ??= this.serial(() => {
      this.pendingScan = null;
      return this.scan();
    });
    this.options.onQueued?.();
    return this.pendingScan;
  }

  private async scan(): Promise<void> {
    await this.batch(async () => {
      const found = {
        files: new Map<string, Stats>(),
        folders: new Set<string>(),
      };
      await this.walk("", this.vfs.root, found);
      await this.options.afterScanList?.();

      for (const p of [...this.files.keys()]) {
        if (!found.files.has(p)) this.removeEntry(p);
      }
      for (const p of [...this.folders.keys()]) {
        if (p !== "" && !found.folders.has(p)) this.removeEntry(p);
      }
      for (const p of found.folders) this.ensureFolder(p);

      const pending = [...found.files];
      const worker = async () => {
        for (let next = pending.pop(); next; next = pending.pop()) {
          await this.indexFromDisk(next[0], next[1]);
          await this.options.afterScanRead?.(next[0]);
        }
      };
      await Promise.all(
        Array.from({ length: READ_CONCURRENCY }, () => worker()),
      );
    });
  }

  /**
   * Bring one path in line with the disk: added, changed or gone. Called
   * by the watcher and after each of our writes, and safe to call for any
   * path any number of times. It stats the path when its turn in the
   * queue comes, not when it is called. Requests that wait together run
   * together, so a burst of changes costs one link recompute, not one
   * per path.
   */
  async reconcile(rel: string): Promise<void> {
    if (rel === "" || isSkippedPath(rel)) return;
    if (this.pendingReconcile === null) {
      const paths = new Set<string>();
      const errors = new Map<string, unknown>();
      const done = this.serial(() => {
        this.pendingReconcile = null;
        return this.batch(async () => {
          for (const p of paths) {
            await this.reconcileNow(p).catch((err) => errors.set(p, err));
          }
        });
      });
      this.pendingReconcile = { paths, errors, done };
    }
    const pending = this.pendingReconcile;
    pending.paths.add(rel);
    this.options.onQueued?.();
    await pending.done;
    if (pending.errors.has(rel)) throw pending.errors.get(rel);
  }

  private async reconcileNow(rel: string): Promise<void> {
    const abs = await this.vfs.tryResolve(rel);
    const lstat = this.options.lstat ?? ((p: string) => fs.lstat(p));
    const stats = abs === null ? null : await lstat(abs).catch(() => null);
    if (stats === null || !(stats.isFile() || stats.isDirectory())) {
      if (this.files.has(rel) || this.folders.has(rel)) {
        await this.batch(async () => this.removeEntry(rel));
      }
      return;
    }
    // On a case-insensitive filesystem a stat for the old spelling of a path
    // that was renamed in case still succeeds: only the name the parent
    // folder lists is real.
    if (
      !this.files.has(rel) &&
      !this.folders.has(rel) &&
      !(await this.isListed(abs as string))
    ) {
      return;
    }
    if (stats.isDirectory()) {
      await this.batch(async () => {
        const found = {
          files: new Map<string, Stats>(),
          folders: new Set<string>([rel]),
        };
        await this.walk(rel, abs as string, found);
        for (const p of [...this.files.keys()]) {
          if (p.startsWith(`${rel}/`) && !found.files.has(p)) {
            this.removeEntry(p);
          }
        }
        for (const p of [...this.folders.keys()]) {
          if (p.startsWith(`${rel}/`) && !found.folders.has(p)) {
            this.removeEntry(p);
          }
        }
        for (const p of found.folders) this.ensureFolder(p);
        for (const [p, st] of found.files) await this.indexFromDisk(p, st);
      });
      return;
    }
    if (stats.isFile()) {
      await this.batch(() => this.indexFromDisk(rel, stats));
    }
  }

  /** True when the folder that holds `abs` lists its exact name. */
  private async isListed(abs: string): Promise<boolean> {
    const name = path.basename(abs).normalize("NFC");
    const names = await fs.readdir(path.dirname(abs)).catch(() => null);
    return names?.some((n) => n.normalize("NFC") === name) ?? false;
  }

  private async walk(
    relDir: string,
    absDir: string,
    out: { files: Map<string, Stats>; folders: Set<string> },
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    // A folder's files are stat'ed together: the walk holds the index
    // queue, so its length is how long a write may wait.
    const stats: Promise<void>[] = [];
    for (const entry of entries) {
      if (isSkippedSegment(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      // A symlink is neither, so it is skipped.
      if (entry.isDirectory()) {
        out.folders.add(rel);
        await this.walk(rel, abs, out);
      } else if (entry.isFile()) {
        stats.push(
          fs.lstat(abs).then(
            (st) => {
              if (st.isFile()) out.files.set(rel, st);
            },
            () => {},
          ),
        );
      }
    }
    await Promise.all(stats);
  }

  /** Add or refresh a file found on disk; skip it when nothing changed. */
  private async indexFromDisk(rel: string, stats: Stats): Promise<void> {
    const sig = signature(stats);
    if (this.files.has(rel) && this.signatures.get(rel) === sig) return;
    let content: string | null = null;
    if (rel.endsWith(".md")) {
      const abs = await this.vfs.tryResolve(rel);
      if (abs === null) return;
      try {
        content = await fs.readFile(abs, "utf8");
      } catch {
        return;
      }
    }
    this.applyFile(rel, stats, content);
  }

  private applyFile(rel: string, stats: Stats, content: string | null): void {
    let file = this.files.get(rel);
    const isNew = file === undefined;
    const fileStat = toFileStat(stats);
    if (file === undefined) {
      file = new TFile(this, rel, fileStat);
      const parent = this.ensureFolder(parentOf(rel));
      file.parent = parent;
      parent.children.push(file);
      this.files.set(rel, file);
    } else {
      file.stat = fileStat;
    }
    this.signatures.set(rel, signature(stats));
    if (content !== null) this.metadata.setContent(file, content, !isNew);
    if (isNew) {
      this.metadata.fileSetChanged();
      this.emit("create", file);
    } else {
      this.emit("modify", file);
    }
  }

  /** Create the folder and every missing ancestor in the index. */
  private ensureFolder(rel: string): TFolder {
    const existing = this.folders.get(rel);
    if (existing) return existing;
    const parent = this.ensureFolder(parentOf(rel));
    const folder = new TFolder(this, rel);
    folder.parent = parent;
    parent.children.push(folder);
    this.folders.set(rel, folder);
    this.emit("create", folder);
    return folder;
  }

  /** Drop a file, or a folder with everything below it, from the index. */
  private removeEntry(rel: string): void {
    const file = this.files.get(rel);
    if (file) {
      this.detach(file);
      this.files.delete(rel);
      this.signatures.delete(rel);
      this.metadata.removeFile(file);
      this.metadata.fileSetChanged();
      this.emit("delete", file);
      return;
    }
    const folder = this.folders.get(rel);
    if (!folder) return;
    for (const p of [...this.files.keys()]) {
      if (p.startsWith(`${rel}/`)) this.removeEntry(p);
    }
    for (const p of [...this.folders.keys()]) {
      if (p.startsWith(`${rel}/`)) this.removeEntry(p);
    }
    this.detach(folder);
    this.folders.delete(rel);
    this.emit("delete", folder);
  }

  private detach(entry: TAbstractFile): void {
    const siblings = entry.parent?.children;
    if (siblings) {
      const at = siblings.indexOf(entry);
      if (at >= 0) siblings.splice(at, 1);
    }
    entry.parent = null;
  }

  /* ---------------------------------------------------------------- */
  /* Write plumbing                                                    */
  /* ---------------------------------------------------------------- */

  private createFile(rel: string, data: string | Uint8Array): Promise<TFile> {
    let normalized: string;
    try {
      normalized = normalizeVaultPath(rel);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.enqueue(
      () => normalized,
      async () => {
        if (this.files.has(normalized) || this.folders.has(normalized)) {
          throw new Error("File already exists.");
        }
        const abs = await this.vfs.resolveEntry(normalized);
        await this.writeAtomic(abs, data, true);
        await this.reconcile(normalized);
        const file = this.files.get(normalized);
        if (!file)
          throw errorWithCode("ENOENT: no such file or directory", "ENOENT");
        return file;
      },
    );
  }

  private async writeExisting(
    file: TFile,
    data: string | Uint8Array,
    expect?: CommitCheck,
  ): Promise<void> {
    const abs = await this.vfs.resolveEntry(file.path);
    await this.writeAtomic(abs, data, false, expect);
    await this.reconcile(file.path);
  }

  /**
   * Write to a temp file beside the target, then move it into place. An
   * exclusive write links instead of renaming so it fails rather than
   * replace a file that appeared meanwhile. The temp name is hidden, which
   * keeps the watcher from indexing it. An edit keeps the permission bits
   * of the file it replaces, and the temp file never starts looser.
   *
   * With `expect`, the write is the second half of a read-modify-write.
   * The target is read again after the temp file is complete and just
   * before the rename, and the write is abandoned with `ECONFLICT` when it
   * no longer decodes to the text the edit started from, or is gone. That
   * closes the long window (the edit callback, the temp file write, a slow
   * disk). It cannot close the last one: a program that writes between
   * this check and the rename still loses its edit, because a rename
   * cannot be made conditional on the old contents. That gap is a few
   * system calls wide.
   */
  private async writeAtomic(
    abs: string,
    data: string | Uint8Array,
    exclusive: boolean,
    expect?: CommitCheck,
  ): Promise<void> {
    await this.guard(async () => {
      const tmp = path.join(
        path.dirname(abs),
        `.${path.basename(abs)}.${randomBytes(6).toString("hex")}.tmp`,
      );
      const kept = exclusive ? null : await fs.stat(abs).catch(() => null);
      const mode = kept ? kept.mode & 0o777 : 0o666;
      try {
        await fs.writeFile(tmp, data, { mode });
        if (kept) await fs.chmod(tmp, mode);
        if (exclusive) {
          try {
            await fs.link(tmp, abs);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "EEXIST") throw new Error("File already exists.");
            // A filesystem without hard links: settle for check-then-rename.
            if (
              await fs.stat(abs).then(
                () => true,
                () => false,
              )
            ) {
              throw new Error("File already exists.");
            }
            await fs.rename(tmp, abs);
          }
        } else {
          if (expect) await this.checkUnchanged(abs, expect);
          await fs.rename(tmp, abs);
        }
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    });
  }

  private async checkUnchanged(
    abs: string,
    expect: CommitCheck,
  ): Promise<void> {
    await this.options.beforeCommit?.(expect.rel);
    const now = await fs.readFile(abs, "utf8").then(
      (text) => sha256(text),
      () => null,
    );
    if (now !== expect.digest) {
      throw errorWithReason(
        `The file changed on disk while it was being edited, so nothing was written. Read it again and retry (${expect.rel}).`,
        "ECONFLICT",
      );
    }
  }

  /**
   * Run `fn` as a write to the path `key()` names, after the writes queued
   * before it on that path. It shares the vault with other writes and not
   * with a rename: it waits for one in progress or pending, and a rename
   * waits for it. The key is read once the rename is over, so a path that
   * moved meanwhile is queued under its new name.
   */
  private async enqueue<T>(
    key: () => string,
    fn: () => Promise<T>,
  ): Promise<T> {
    while (this.renaming !== null) await this.renaming;
    this.writers += 1;
    try {
      const rel = key();
      const previous = this.queues.get(rel) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(fn);
      this.queues.set(rel, next);
      void next
        .finally(() => {
          if (this.queues.get(rel) === next) this.queues.delete(rel);
        })
        .catch(() => {});
      return await next;
    } finally {
      this.writers -= 1;
      if (this.writers === 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const wake of waiters) wake();
      }
    }
  }

  /**
   * Run `fn` with no write in flight and none starting. Renames run one at
   * a time. Writers never wait on a rename from inside a write, so this
   * cannot deadlock.
   */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.renaming !== null) await this.renaming;
    let release!: () => void;
    this.renaming = new Promise<void>((resolve) => (release = resolve));
    try {
      while (this.writers > 0) {
        await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
      }
      return await fn();
    } finally {
      this.renaming = null;
      release();
    }
  }

  /**
   * Move `abs` into `dir` as `name`, or `name <time>`, `name <time> 1` and
   * so on when taken. The move never replaces an entry, so it keeps a file
   * trashed earlier, even within the same clock tick.
   */
  private async moveToFreeName(
    abs: string,
    dir: string,
    name: string,
  ): Promise<MoveResult> {
    const isFolder = (await fs.stat(abs)).isDirectory();
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const time = (this.options.now ?? Date.now)();
    for (let n = 0; ; n++) {
      const candidate = path.join(
        dir,
        n === 0 ? name : `${stem} ${time}${n > 1 ? ` ${n - 1}` : ""}${ext}`,
      );
      try {
        return await moveNoReplace(
          abs,
          candidate,
          isFolder,
          this.options.moveOps ?? nodeMoveOps,
        );
      } catch (err) {
        // A file stranded at its temporary name also carries EEXIST in its
        // message, but its reason is ESTRANDED: it is never a taken name.
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
    }
  }

  /**
   * Run `fn`, rewriting host paths in any error so a client never learns
   * where the vault lives on disk. Keeps the errno `code` and the `reason`,
   * which callers branch on.
   */
  async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VaultPathError || !(err instanceof Error)) throw err;
      const { code, reason } = err as NodeJS.ErrnoException & {
        reason?: string;
      };
      const message = err.message.split(this.vfs.root).join("<vault>");
      if (code !== undefined) throw errorWithCode(message, code);
      if (reason !== undefined) throw errorWithReason(message, reason);
      throw err;
    }
  }
}

/** The slice of `vault.adapter` the tools call. */
class HeadlessAdapter {
  constructor(
    private readonly vault: HeadlessVault,
    private readonly vfs: VaultFs,
  ) {}

  getName(): string {
    return this.vault.getName();
  }

  async exists(rel: string): Promise<boolean> {
    return this.vault.getAbstractFileByPath(rel) !== null;
  }

  async stat(rel: string): Promise<{
    type: "file" | "folder";
    ctime: number;
    mtime: number;
    size: number;
  } | null> {
    const entry = this.vault.getAbstractFileByPath(rel);
    if (entry instanceof TFile) return { type: "file", ...entry.stat };
    if (entry instanceof TFolder) {
      return { type: "folder", ctime: 0, mtime: 0, size: 0 };
    }
    return null;
  }

  async list(rel: string): Promise<{ files: string[]; folders: string[] }> {
    const folder = this.vault.getAbstractFileByPath(rel === "" ? "/" : rel);
    if (!(folder instanceof TFolder)) {
      throw errorWithCode("ENOENT: no such file or directory", "ENOENT");
    }
    return {
      files: folder.children
        .filter((c) => c instanceof TFile)
        .map((c) => c.path),
      folders: folder.children
        .filter((c) => c instanceof TFolder)
        .map((c) => c.path),
    };
  }

  async rmdir(rel: string, recursive: boolean): Promise<void> {
    try {
      await this.vault.guard(async () => {
        const abs = await this.vfs.resolveEntry(rel);
        if (recursive) await fs.rm(abs, { recursive: true });
        else await fs.rmdir(abs);
        await this.vault.reconcile(rel);
      });
    } catch (err) {
      // `delete_vault_directory` answers an `EACCES` code with its
      // permission_denied error. A refusal of that kind keeps earning it,
      // at the price of its explanation, which that tool then does not show.
      if (err instanceof VaultPathError && err.reason === "EACCES") {
        throw Object.assign(err, { code: "EACCES" });
      }
      throw err;
    }
  }
}
