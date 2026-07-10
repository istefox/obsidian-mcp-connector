import type { App, EventRef, TAbstractFile } from "obsidian";

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

  return {
    stop: () => {
      app.vault.offref(createRef);
      app.vault.offref(deleteRef);
      app.vault.offref(renameRef);
      app.vault.offref(modifyRef);
    },
  };
}
