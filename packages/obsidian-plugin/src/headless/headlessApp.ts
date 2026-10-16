/**
 * The `App` the MCP tools run against when there is no Obsidian: a vault
 * directory behind the same surface, restricted to what the retained
 * tools call. Wrapped in `createGuardedApp` by the shared composition
 * root exactly like the desktop `App`.
 */

import type { App } from "obsidian";
import { editFrontmatter } from "./frontmatterEdit";
import { HeadlessVault, type HeadlessVaultOptions } from "./headlessVault";
import { TFile } from "./obsidianShim";
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

/**
 * Start watching the vault directory, index it, and return the app. The
 * watcher opens first and holds its events through the scan, so an edit
 * made while the scan runs is reconciled once it is done.
 */
export async function createHeadlessApp(
  vaultDir: string,
  options: HeadlessVaultOptions = {},
): Promise<HeadlessAppHandle> {
  const vault = await HeadlessVault.open(vaultDir, options);
  const watcher = new VaultWatcher(vault);
  watcher.start({ held: true });
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
    // Dataview and Templater are desktop plugins; `search_vault` reads this
    // to answer `dataview_not_installed`.
    plugins: { plugins: {} },
  } as unknown as App;
  return { app, vault, close: () => watcher.stop() };
}
