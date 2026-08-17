import type { App, EventRef, TAbstractFile, TFile } from "obsidian";

export type VaultWatcher = { stop: () => void };

function isPromptFile(path: string): boolean {
  if (!path.startsWith("Prompts/")) return false;
  if (!path.endsWith(".md")) return false;
  const rest = path.slice("Prompts/".length);
  return !rest.includes("/");
}

export function createVaultWatcher(
  app: App,
  notifier: () => void,
): VaultWatcher {
  const createRef: EventRef = app.vault.on("create", (file: TAbstractFile) => {
    if (isPromptFile(file.path)) notifier();
  });

  const deleteRef: EventRef = app.vault.on("delete", (file: TAbstractFile) => {
    if (isPromptFile(file.path)) notifier();
  });

  const renameRef: EventRef = app.vault.on(
    "rename",
    (file: TAbstractFile, oldPath: string) => {
      if (isPromptFile(file.path) || isPromptFile(oldPath)) notifier();
    },
  );

  // Content edits matter too: the prompt list embeds argument
  // declarations and the frontmatter description, both derived from the
  // file body.
  const modifyRef: EventRef = app.vault.on("modify", (file: TAbstractFile) => {
    if (isPromptFile(file.path)) notifier();
  });

  // The vault says a file EXISTS; the metadata cache says what is IN it, some
  // time later. `discoverPrompts` reads frontmatter, so a prompt is not a
  // prompt until this event — and this is the only moment no vault event
  // announces, which is what made the gap invisible (#483).
  //
  // What it costs: a save now reaches `notifier()` twice, once through
  // `modify` and once through here. That is intentional and cheap — the memo
  // invalidation is idempotent and the debounce collapses the pair into a
  // single re-scan. Losing the second one is not: it is the only signal that
  // arrives after the frontmatter is actually readable.
  //
  // `changed` is documented as NOT firing on rename, for performance. The
  // rename hook above already covers that case, so this is the one event to
  // add rather than the first of several.
  const indexedRef: EventRef = app.metadataCache.on(
    "changed",
    (file: TFile) => {
      if (isPromptFile(file.path)) notifier();
    },
  );

  return {
    stop: () => {
      app.vault.offref(createRef);
      app.vault.offref(deleteRef);
      app.vault.offref(renameRef);
      app.vault.offref(modifyRef);
      app.metadataCache.offref(indexedRef);
    },
  };
}
