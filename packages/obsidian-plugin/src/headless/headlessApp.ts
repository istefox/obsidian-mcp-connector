/**
 * The `App` the MCP tools run against when there is no Obsidian: a vault
 * directory behind the same surface, restricted to what the retained
 * tools call. Wrapped in `createGuardedApp` by the shared composition
 * root exactly like the desktop `App`.
 */

import type { App } from "obsidian";
import { logger } from "$/shared/logger";
import { errorWithReason } from "./domainError";
import { editFrontmatter } from "./frontmatterEdit";
import { HeadlessVault, type HeadlessVaultOptions } from "./headlessVault";
import { TFile, TFolder, type TAbstractFile } from "./obsidianShim";
import { loadPeriodicNotesConfig, periodicNotesMembers } from "./periodicNotes";
import { createLinkRewriter, type LinkRewriter } from "./renameLinks";
import { baseRefersToRename, rewriteCanvas } from "./renameReferences";
import { reportRenameWarning } from "./renameWarnings";
import { createIgnoreMatcher, loadVaultSettings } from "./vaultSettings";
import { VaultWatcher } from "./watcher";

export class HeadlessFileManager {
  constructor(private readonly vault: HeadlessVault) {}

  processFrontMatter(
    file: TFile,
    fn: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    return this.vault.processText(file, (content) =>
      editFrontmatter(content, fn),
    );
  }

  trashFile(file: TFile): Promise<void> {
    return this.vault.trash(file);
  }

  /**
   * Move a file or folder, then rewrite the links that pointed at it (and
   * the relative links inside it) in every affected note. The move stands
   * if a note cannot be rewritten, or holds a link that no spelling can
   * lead to its target: the error then names the notes whose links are out
   * of date, and those links. It also stands when a hidden temporary name
   * of the file could not be removed, and the error names that name.
   */
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    const from = file.path;
    const isFolder = file instanceof TFolder;
    const { moves, before, linkers, leftover } = await this.vault.rename(
      file,
      newPath,
    );
    const rewriter = createLinkRewriter(before, moves);
    const failed: string[] = [];
    for (const oldPath of linkers) {
      const path = moves.get(oldPath) ?? oldPath;
      const note = this.vault.getFileByPath(path);
      if (note === null) continue;
      try {
        let unwritable: string[] = [];
        await this.vault.process(note, (content) => {
          const next = rewriter.rewrite(
            content,
            this.vault.metadata.getFileCacheIfCurrent(note, content),
            oldPath,
          );
          unwritable = next.unwritable;
          return next.content;
        });
        if (unwritable.length > 0) {
          failed.push(
            `${path} (no spelling leads to the target of ${unwritable.join(", ")})`,
          );
        }
      } catch (err) {
        failed.push(`${path} (${err instanceof Error ? err.message : err})`);
      }
    }
    failed.push(
      ...(await this.rewriteReferences(rewriter, moves, from, isFolder)),
    );
    if (failed.length > 0 || leftover !== undefined) {
      const problems: string[] = [];
      if (failed.length > 0) {
        problems.push(
          `links were not updated in ${failed.length} note(s): ${failed.join(", ")}`,
        );
      }
      if (leftover !== undefined) {
        problems.push(
          `the temporary name ${leftover} could not be removed and can be deleted`,
        );
      }
      throw errorWithReason(
        `The move succeeded, but ${problems.join(" and ")}`,
        failed.length > 0 ? "ELINKS" : "ELEFTOVER",
      );
    }
  }

  /**
   * Update the canvases that refer to what moved, which the metadata cache
   * does not know about (see renameReferences.ts), and report the `.base`
   * files that refer to it, which are never changed. Each base is named
   * through `reportRenameWarning`. Returns one entry for each canvas it
   * could not update, in the form of the notes' failures.
   */
  private async rewriteReferences(
    rewriter: LinkRewriter,
    moves: ReadonlyMap<string, string>,
    from: string,
    isFolder: boolean,
  ): Promise<string[]> {
    const wasAt = new Map([...moves].map(([old, next]) => [next, old]));
    const failed: string[] = [];
    for (const file of this.vault.getFiles()) {
      const isCanvas = file.extension === "canvas";
      if (!isCanvas && file.extension !== "base") continue;
      const oldPath = wasAt.get(file.path) ?? file.path;
      try {
        if (!isCanvas) {
          const content = await this.vault.read(file);
          if (baseRefersToRename(content, rewriter, oldPath, from)) {
            reportRenameWarning(
              `${file.path} refers to "${from}"${isFolder ? " or to a file in it" : ""} in a link or a filter. A rename does not change bases, so check it by hand.`,
            );
          }
          continue;
        }
        let unwritable: string[] = [];
        await this.vault.process(file, (content) => {
          const next = rewriteCanvas(content, rewriter, moves, oldPath);
          unwritable = next.unwritable;
          return next.content;
        });
        if (unwritable.length > 0) {
          failed.push(
            `${file.path} (no spelling leads to the target of ${unwritable.join(", ")})`,
          );
        }
      } catch (err) {
        failed.push(
          `${file.path} (${err instanceof Error ? err.message : err})`,
        );
      }
    }
    return failed;
  }
}

/** Nothing is ever open on a server, so every workspace question has the empty answer. */
const workspace = {
  getActiveFile: (): TFile | null => null,
  onLayoutReady: (callback: () => void): void => callback(),
  layoutReady: true,
  on: () => ({}),
  off: () => {},
  offref: () => {},
  trigger: () => {},
};

export type HeadlessAppHandle = {
  app: App;
  vault: HeadlessVault;
  /** Stop the file watcher. */
  close: () => void;
};

export type HeadlessAppOptions = HeadlessVaultOptions & {
  /** Receives one line for each settings file that is present but unusable. */
  warn?: (message: string) => void;
};

/**
 * Start watching the vault directory, index it, and return the app. The
 * watcher opens first and holds its events through the scan, so an edit
 * made while the scan runs is reconciled once it is done.
 *
 * The vault's Obsidian settings are read here, once: the "Excluded files"
 * list and the daily and periodic note configuration (see
 * periodicNotes.ts). A change to them needs a restart.
 */
export async function createHeadlessApp(
  vaultDir: string,
  options: HeadlessAppOptions = {},
): Promise<HeadlessAppHandle> {
  const { warn = (message) => logger.warn(message), ...vaultOptions } = options;
  const vault = await HeadlessVault.open(vaultDir, vaultOptions);
  const settings = await loadVaultSettings(vault.root, warn);
  vault.metadata.setUserIgnore(createIgnoreMatcher(settings.userIgnoreFilters));
  const periodicConfig = await loadPeriodicNotesConfig(vault.root, warn);
  const watcher = new VaultWatcher(vault);
  watcher.start({ held: true });
  vault.flushPending = () => watcher.flush();
  try {
    await vault.rescan();
    await watcher.release();
  } catch (err) {
    watcher.stop();
    throw err;
  }
  const app = {
    vault,
    metadataCache: vault.metadata,
    fileManager: new HeadlessFileManager(vault),
    workspace,
    // The plugin registry. Dataview and Templater are desktop plugins, so
    // `search_vault` finds no Dataview and answers `dataview_not_installed`.
    // The daily and periodic note plugins appear as the vault's files
    // describe them, for the library the periodic note tools use.
    ...periodicNotesMembers(periodicConfig),
  } as unknown as App;
  return { app, vault, close: () => watcher.stop() };
}
