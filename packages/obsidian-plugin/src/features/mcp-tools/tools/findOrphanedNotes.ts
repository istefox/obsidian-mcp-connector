import { type } from "arktype";
import type { App } from "obsidian";
import { logger } from "$/shared/logger";

export const findOrphanedNotesSchema = type({
  name: '"find_orphaned_notes"',
  arguments: {
    "exclude_folders?": type("string[]").describe(
      'Vault-relative folder prefixes whose notes are omitted from the orphan list. Default: `["templates","attachments","_archive"]`. Links FROM excluded folders still count as incoming references — they do not make a note an orphan.',
    ),
  },
}).describe(
  "Returns all markdown notes that have zero incoming resolved links from any vault file. Builds the referenced-file set from Obsidian's resolvedLinks cache (no file I/O). Notes in excluded folders are omitted from the output but their outgoing links still count toward other notes' reference status. Always read-only.",
);

export type FindOrphanedNotesContext = {
  arguments: { exclude_folders?: string[] };
  app: App;
};

const DEFAULT_EXCLUDE = ["templates", "attachments", "_archive"];

export async function findOrphanedNotesHandler(
  ctx: FindOrphanedNotesContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const rawExcludes = ctx.arguments.exclude_folders ?? DEFAULT_EXCLUDE;
  const excludes = rawExcludes.map((e) => e.replace(/\/+$/, ""));

  const isExcluded = (path: string): boolean =>
    excludes.some((ex) => path === ex || path.startsWith(ex + "/"));

  // Build the referenced set from ALL resolvedLinks values — excludes do NOT
  // filter link sources here (ADR-0004 §Decision 2).
  const referenced = new Set<string>();
  const resolvedLinks = (
    ctx.app.metadataCache as unknown as {
      resolvedLinks: Record<string, Record<string, number>>;
    }
  ).resolvedLinks;
  for (const targets of Object.values(resolvedLinks)) {
    for (const target of Object.keys(targets)) {
      referenced.add(target);
    }
  }

  const files = ctx.app.vault.getMarkdownFiles();
  const orphans: Array<{ path: string; mtime: number; size: number }> = [];
  let scannedFiles = 0;

  for (const file of files) {
    if (isExcluded(file.path)) continue;
    scannedFiles++;
    if (referenced.has(file.path)) continue;
    const stat = (file as unknown as { stat?: { mtime: number; size: number } })
      .stat;
    if (!stat) {
      logger.warn("find_orphaned_notes: file has no stat, skipping", {
        path: file.path,
      });
      continue;
    }
    orphans.push({ path: file.path, mtime: stat.mtime, size: stat.size });
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total_orphaned: orphans.length,
            scanned_files: scannedFiles,
            excluded_folders: excludes,
            orphaned_notes: orphans,
          },
          null,
          2,
        ),
      },
    ],
  };
}
