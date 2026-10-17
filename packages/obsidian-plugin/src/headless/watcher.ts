/**
 * Keeps the vault index in step with edits made outside the server (an
 * editor, a sync client, `git pull`).
 *
 * Each visible folder gets its own non-recursive `fs.watch`, which reports
 * its direct children. Dot-folders and symlinks are never watched, so
 * `.git` and `.obsidian` cost no inotify watches. Events are debounced per
 * path so a save that lands as several events costs one reconcile. A
 * folder appearing, vanishing or being renamed, a watcher error and an
 * event without a path all take the heavy route: close every watch, watch
 * the folders on disk afresh, rescan the whole vault. The reconcile is
 * idempotent, so the server's own writes showing up here are harmless.
 * The vault runs reconciles and rescans one at a time in request order,
 * so an event that arrives during a rescan is applied after it.
 *
 * A folder that cannot be watched (Linux: `fs.inotify.max_user_watches`
 * reached) is logged once. The rescan that follows every round of watches
 * still indexes it; only its live updates are lost until the next rescan.
 *
 * At startup the watcher opens before the initial scan and holds its
 * events until `release`, so an edit that lands while the scan runs is
 * reconciled afterwards instead of being missed.
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "$/shared/logger";
import type { HeadlessVault } from "./headlessVault";
import { isSkippedPath, isSkippedSegment } from "./vaultFs";

export const WATCH_DEBOUNCE_MS = 100;

type FolderWatch = {
  close(): void;
  on(event: "error", listener: (err: Error) => void): unknown;
};

/** Opens a non-recursive watch on one folder. A seam for tests. */
export type WatchFolder = (
  abs: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FolderWatch;

const watchFolder: WatchFolder = (abs, listener) =>
  fs.watch(abs, { persistent: false }, listener);

export class VaultWatcher {
  /** One watch per visible folder, by vault path; the root is "". */
  private readonly watches = new Map<string, FolderWatch>();
  private limitWarned = false;
  private readonly timers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; eventType: string }
  >();
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Events seen while held, by path; null when not held. */
  private held: Map<string, string> | null = null;
  private heldResync = false;

  constructor(
    private readonly vault: HeadlessVault,
    private readonly debounceMs: number = WATCH_DEBOUNCE_MS,
    private readonly watch: WatchFolder = watchFolder,
  ) {}

  /** Start watching. With `held`, events wait for `release`. */
  start(options: { held?: boolean } = {}): void {
    this.stopped = false;
    if (options.held) this.held = new Map();
    this.watchTree("");
  }

  /** Stop holding and reconcile every path that changed while held. */
  async release(): Promise<void> {
    const held = this.held;
    this.held = null;
    if (held === null) return;
    if (this.heldResync) {
      this.heldResync = false;
      this.scheduleResync();
    }
    for (const [rel, eventType] of held) await this.settle(rel, eventType);
  }

  stop(): void {
    this.stopped = true;
    this.held = null;
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.resyncTimer !== null) clearTimeout(this.resyncTimer);
    this.resyncTimer = null;
    this.closeWatches();
  }

  private closeWatches(): void {
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
  }

  /**
   * Watch `rel` and every visible folder below it. Synchronous, so the
   * rescan that follows reads each folder only once its watch is open.
   */
  private watchTree(rel: string): void {
    const abs = path.join(this.vault.root, ...rel.split("/"));
    if (!this.watches.has(rel)) {
      try {
        const watch = this.watch(abs, (eventType, filename) =>
          this.onEvent(rel, eventType, filename),
        );
        watch.on("error", (err) => {
          logger.warn("Vault watcher error; restarting", {
            error: err instanceof Error ? err.message : String(err),
          });
          if (this.held) this.heldResync = true;
          else this.scheduleResync();
        });
        this.watches.set(rel, watch);
      } catch (err) {
        if (!this.limitWarned) {
          this.limitWarned = true;
          logger.warn(
            "Vault watcher could not watch a folder. On Linux, raise fs.inotify.max_user_watches; until then edits there show up at the next full rescan",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      }
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !isSkippedSegment(entry.name)) {
        this.watchTree(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  }

  private onEvent(
    dir: string,
    eventType: string,
    filename: string | Buffer | null,
  ): void {
    if (this.stopped) return;
    if (filename === null) {
      if (this.held) this.heldResync = true;
      else this.scheduleResync();
      return;
    }
    const name = filename.toString();
    const rel = dir ? `${dir}/${name}` : name;
    if (isSkippedPath(rel)) return;
    if (this.held) {
      // A rename anywhere in the burst keeps the folder check in `settle`.
      if (this.held.get(rel) !== "rename") this.held.set(rel, eventType);
      return;
    }
    const pending = this.timers.get(rel);
    if (pending) clearTimeout(pending.timer);
    this.timers.set(rel, {
      timer: setTimeout(() => {
        this.timers.delete(rel);
        void this.settle(rel, eventType);
      }, this.debounceMs),
      eventType,
    });
  }

  /**
   * Apply now the events that are waiting out their debounce, and the full
   * rescan they or an event without a path asked for, and return when they
   * are applied. An event the operating system has not delivered yet is not
   * known.
   */
  async flush(): Promise<void> {
    const due = [...this.timers];
    this.timers.clear();
    for (const [, { timer }] of due) clearTimeout(timer);
    await Promise.all(
      due.map(([rel, { eventType }]) => this.settle(rel, eventType)),
    );
    if (this.resyncTimer !== null) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
      await this.resync();
    }
  }

  private async settle(rel: string, eventType: string): Promise<void> {
    try {
      const wasFolder = this.vault.getFolderByPath(rel) !== null;
      await this.vault.reconcile(rel);
      const isFolder = this.vault.getFolderByPath(rel) !== null;
      if (eventType === "rename" && (wasFolder || isFolder)) {
        this.scheduleResync();
      }
    } catch (err) {
      logger.warn("Vault watcher could not reconcile a path", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private scheduleResync(): void {
    if (this.stopped || this.resyncTimer !== null) return;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      void this.resync();
    }, this.debounceMs);
  }

  private async resync(): Promise<void> {
    if (this.stopped) return;
    this.closeWatches();
    this.watchTree("");
    try {
      await this.vault.rescan();
    } catch (err) {
      logger.warn("Vault rescan failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
