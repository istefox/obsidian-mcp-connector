import {
  symlinkSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readlinkSync,
} from "fs";
import { dirname, join, resolve } from "node:path";

/**
 * This development script creates a symlink to the plugin in the Obsidian vault's plugin directory. This allows you to
 * develop the plugin in the repository and see the changes in Obsidian without having to manually copy the files.
 *
 * This function is not included in the plugin itself. It is only used to set up local development.
 *
 * Usage: `bun scripts/link.ts <path_to_obsidian_vault>`
 * @returns {Promise<void>}
 */

/** What the vault's plugin path turned out to be, as observed by `lstat`. */
export type LinkTargetState =
  | { kind: "absent" }
  /** `target` is the link's destination, already resolved to an absolute path. */
  | { kind: "symlink"; target: string }
  | { kind: "directory" }
  | { kind: "file" };

export type LinkDecision = {
  action: "create" | "ok" | "refuse";
  message: string;
};

/**
 * What to do about the vault's plugin path, given what is actually there.
 *
 * Pure so it can be tested without a filesystem, the same split
 * `verifyCommittedVersion` and `checkChangelogReady` use in scripts/version.ts:
 * the caller does the I/O, the decision is a function of the facts.
 *
 * This exists because the check it replaces was `existsSync(targetPath)`, which
 * is true for ANY existing path — a plain directory included. A vault whose
 * plugin directory is a hand-made COPY therefore got "Symlink already exists."
 * and no link, from the one tool whose job is to guarantee the link (#468). A
 * verification then measures whatever build was copied last: on 2026-08-16 that
 * was five days old and read as a defect in code merged hours earlier.
 *
 * It never deletes. A real directory there holds `data.json` and `embeddings/`,
 * live settings and a vector store, so replacing it is a human decision and the
 * refusal says so instead of acting.
 */
export function decideLinkAction(
  state: LinkTargetState,
  repoRoot: string,
  targetPath: string,
): LinkDecision {
  switch (state.kind) {
    case "absent":
      return { action: "create", message: `Creating symlink at ${targetPath}` };

    case "symlink":
      if (state.target === repoRoot) {
        return {
          action: "ok",
          message: `Already linked: ${targetPath} → ${repoRoot}`,
        };
      }
      // Silent before this change, and as stale-making as a copy: a link to
      // another checkout means `bun run build` here never reaches the vault.
      return {
        action: "refuse",
        message:
          `${targetPath} is a symlink to a DIFFERENT directory:\n` +
          `    it points at ${state.target}\n` +
          `    this repo is  ${repoRoot}\n` +
          `  A build here will never reach that vault. Remove the link and re-run to point it at this checkout.`,
      };

    case "directory":
      return {
        action: "refuse",
        message:
          `${targetPath} is a real directory, not a symlink — the plugin there is a COPY.\n` +
          `  A build in this repo does not reach it, and nothing else says so: this is #468.\n` +
          `  Not touching it, because it holds your live \`data.json\` and \`embeddings/\`.\n` +
          `  Move it aside yourself, then re-run this script:\n` +
          `    mv "${targetPath}" "${targetPath}.copy-backup"`,
      };

    case "file":
      return {
        action: "refuse",
        message: `${targetPath} is a file, not a directory or a symlink. Move it aside and re-run.`,
      };
  }
}

/**
 * `lstat`, never `stat`, and that is load-bearing: `stat` follows the link, so a
 * valid symlink would report as a directory and a broken one as absent — the
 * exact conflation this whole change exists to undo.
 */
export function inspectLinkTarget(targetPath: string): LinkTargetState {
  let stats;
  try {
    stats = lstatSync(targetPath);
  } catch {
    // Only "not there" is a legitimate absence. `lstat` does not follow the
    // link, so a symlink whose target was deleted still stats fine and is
    // reported as the symlink it is, rather than as absent.
    return { kind: "absent" };
  }
  if (stats.isSymbolicLink()) {
    // `readlink` may hand back a RELATIVE path, which is relative to the link's
    // own directory and not to the cwd this script happens to run from.
    // Resolving it against the cwd would compare two unrelated paths and refuse
    // a perfectly good link.
    return {
      kind: "symlink",
      target: resolve(dirname(targetPath), readlinkSync(targetPath)),
    };
  }
  if (stats.isDirectory()) return { kind: "directory" };
  return { kind: "file" };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: bun scripts/link.ts <path_to_obsidian_vault_config_folder>",
    );
    process.exit(1);
  }

  const vaultConfigPath = args[0];
  const projectRootDirectory = resolve(__dirname, "../../..");
  const pluginManifestPath = resolve(projectRootDirectory, "manifest.json");
  const pluginsDirectoryPath = join(vaultConfigPath!, "plugins");

  const file = Bun.file(pluginManifestPath);
  const manifest = await file.json();

  const pluginName = manifest.id;
  // Announces what it is about to inspect, not what it is about to do: this
  // line used to claim "Creating symlink…" before anything had been decided,
  // and then printed "Symlink already exists." over a directory that was not
  // one. Two false claims in four lines is how #468 stayed invisible.
  console.log(
    `Linking plugin ${pluginName} from ${projectRootDirectory} into ${pluginsDirectoryPath}`,
  );

  if (!existsSync(pluginsDirectoryPath)) {
    mkdirSync(pluginsDirectoryPath, { recursive: true });
  }

  const targetPath = join(pluginsDirectoryPath, pluginName);
  const decision = decideLinkAction(
    inspectLinkTarget(targetPath),
    projectRootDirectory,
    targetPath,
  );

  if (decision.action === "refuse") {
    // Non-zero, so a caller can tell. The old shape logged through
    // `.catch(console.error)` and exited 0 whatever happened.
    console.error(`\n✗ ${decision.message}\n`);
    process.exit(1);
  }

  console.log(decision.message);
  if (decision.action === "ok") return;

  symlinkSync(projectRootDirectory, targetPath, "dir");
  console.log("Symlink created successfully.");

  console.log(
    "Obsidian plugin linked for local development. Please restart Obsidian.",
  );
}

// Without this guard, importing the module to test it RUNS it — and with no
// argv that is a `process.exit(1)` in the middle of the test run. Same reason
// scripts/version.ts carries one, where the stakes are a release.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
