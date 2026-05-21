import { type } from "arktype";
import type { App, TFile } from "obsidian";

import {
  planRename,
  type HeadingCacheEntry,
  type RenameError,
  type ResolveLinkpath,
} from "../services/headingRename";

export const renameHeadingSchema = type({
  name: '"rename_heading"',
  arguments: {
    path: type("string>0").describe(
      "Vault-relative path of the file containing the heading to rename.",
    ),
    from: {
      text: type("string>0").describe(
        "Exact (case-sensitive) heading text to match. Cache-derived; matching is case-sensitive, mirroring Obsidian's link resolution.",
      ),
      "level?": type("1<=number.integer<=6").describe(
        "Heading level (1-6). Optional. When omitted, ambiguity across levels surfaces as `errorCode: ambiguous-heading` with a `candidates` array.",
      ),
    },
    to: type("string>0").describe(
      "New heading text. Must not match an existing same-level heading in the file (fail-loud per `heading-collision`).",
    ),
  },
}).describe(
  "Renames a heading in a vault file and rewrites every backlinking reference (wikilinks, markdown links, subheading-path links) across the vault to keep link integrity. Two-phase commit: dry-run plan first, then apply atomically. Fails loud on missing heading, multi-match ambiguity, or destination collision. Out of scope for v1: frontmatter aliases. Implements RFC #68.",
);

export type RenameHeadingContext = {
  arguments: {
    path: string;
    from: { text: string; level?: number };
    to: string;
  };
  app: App;
};

type MockCacheShape = {
  headings?: Array<HeadingCacheEntry>;
};

function errorResponse(payload: {
  errorCode: string;
  message: string;
  [k: string]: unknown;
}): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function successResponse(payload: {
  ok: true;
  updatedFiles: string[];
  linkRewriteCount: number;
}): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function partialFailureResponse(payload: {
  errorCode: "partial-failure";
  message: string;
  updatedFiles: string[];
  failedFiles: Array<{ path: string; error: string }>;
  linkRewriteCount: number;
}): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/**
 * Find every file in the vault that has a resolved link to `sourcePath`.
 * Reads `app.metadataCache.resolvedLinks`, which is shaped as
 * `Record<linkingFile, Record<targetFile, count>>`. Excludes the source
 * file itself — self-references are handled inside the source patch.
 */
function findBacklinkerPaths(
  resolvedLinks: Record<string, Record<string, number>>,
  sourcePath: string,
): string[] {
  const out: string[] = [];
  for (const [linkingPath, targets] of Object.entries(resolvedLinks)) {
    if (linkingPath === sourcePath) continue;
    if (sourcePath in targets) out.push(linkingPath);
  }
  return out;
}

export async function renameHeadingHandler(ctx: RenameHeadingContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, from, to } = ctx.arguments;

  // ── 1. Load source file ─────────────────────────────────────────────────
  const sourceFile = ctx.app.vault.getAbstractFileByPath(path) as TFile | null;
  if (!sourceFile) {
    return errorResponse({
      errorCode: "file-not-found",
      message: `Source file not found: ${path}`,
    });
  }

  const sourceText = await ctx.app.vault.cachedRead(sourceFile);
  const sourceCache = (ctx.app.metadataCache.getFileCache(sourceFile) ??
    {}) as MockCacheShape;
  const sourceHeadings = sourceCache.headings ?? [];

  // ── 2. Identify backlinkers + load their text ───────────────────────────
  const resolvedLinks =
    (
      ctx.app.metadataCache as unknown as {
        resolvedLinks?: Record<string, Record<string, number>>;
      }
    ).resolvedLinks ?? {};
  const backlinkerPaths = findBacklinkerPaths(resolvedLinks, path);

  const backlinkerTexts: Record<string, string> = {};
  for (const bp of backlinkerPaths) {
    const f = ctx.app.vault.getAbstractFileByPath(bp) as TFile | null;
    if (!f) continue; // resolvedLinks can lag behind file deletes
    try {
      backlinkerTexts[bp] = await ctx.app.vault.cachedRead(f);
    } catch {
      // Read failures during PRE-WRITE plan-building are non-fatal —
      // they surface as a partial-failure if/when we try to write.
      continue;
    }
  }

  // ── 3. Build `ResolveLinkpath` around the live metadataCache ────────────
  // `getFirstLinkpathDest` honours the vault's default linker setting
  // ("Use shortest path" / "Relative to file" / "Absolute"), so the
  // walker's link-match predicate is identical to Obsidian's at runtime.
  const resolve: ResolveLinkpath = (linkpath, fromPath) => {
    const dest = (
      ctx.app.metadataCache as unknown as {
        getFirstLinkpathDest?: (
          linkpath: string,
          sourcePath: string,
        ) => TFile | null;
      }
    ).getFirstLinkpathDest?.(linkpath, fromPath);
    return dest?.path ?? null;
  };

  // ── 4. Compute the plan ─────────────────────────────────────────────────
  const plan = planRename({
    sourcePath: path,
    sourceText,
    sourceHeadings,
    from,
    to,
    backlinkers: backlinkerTexts,
    resolve,
  });

  if ("errorCode" in plan) {
    return renameErrorToResponse(plan);
  }

  // ── 5. Phase-2 apply: write source, then each backlinker patch ──────────
  //
  // RFC edge case #6: two-phase commit. Phase 1 (plan computation) is
  // pure and reports collisions / ambiguity before any I/O. Phase 2
  // writes; on mid-walk failure we surface `partial-failure` with the
  // accurate list of files that did and did not get the rewrite.
  const updatedFiles: string[] = [];
  const failedFiles: Array<{ path: string; error: string }> = [];

  // Source first — if the source write fails, no backlinker has been
  // touched yet, so the file system is unchanged. TOCTOU guard: the plan
  // was built from a snapshot; if the file changed since (live editing in
  // Obsidian), abort rather than clobber the concurrent edit.
  try {
    const sourceNow = await ctx.app.vault.cachedRead(sourceFile);
    if (sourceNow !== sourceText) {
      return errorResponse({
        errorCode: "source-write-failed",
        message:
          "Source file changed between plan and apply; aborted before any write to avoid overwriting a concurrent edit. Re-run the rename.",
      });
    }
    await ctx.app.vault.modify(sourceFile, plan.source.newText);
    updatedFiles.push(plan.source.path);
  } catch (e) {
    return errorResponse({
      errorCode: "source-write-failed",
      message: `Failed to write source file: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  for (const bp of plan.backlinkers) {
    const f = ctx.app.vault.getAbstractFileByPath(bp.path) as TFile | null;
    if (!f) {
      failedFiles.push({
        path: bp.path,
        error: "Backlinker file disappeared between plan and apply.",
      });
      continue;
    }
    try {
      // TOCTOU guard: the patch was computed from the plan-phase snapshot.
      // If the file changed since, do NOT write the stale patch — surface
      // it as a failed file so the caller can re-run, not a silent
      // lost update.
      const currentText = await ctx.app.vault.cachedRead(f);
      if (currentText !== backlinkerTexts[bp.path]) {
        failedFiles.push({
          path: bp.path,
          error:
            "File changed between plan and apply; left untouched to avoid overwriting a concurrent edit. Re-run the rename.",
        });
        continue;
      }
      await ctx.app.vault.modify(f, bp.newText);
      updatedFiles.push(bp.path);
    } catch (e) {
      failedFiles.push({
        path: bp.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (failedFiles.length > 0) {
    return partialFailureResponse({
      errorCode: "partial-failure",
      message: `Heading renamed but ${failedFiles.length} backlinker write(s) failed. The source file was updated; some references may still point at the old heading.`,
      updatedFiles,
      failedFiles,
      linkRewriteCount: plan.linkRewriteCount,
    });
  }

  return successResponse({
    ok: true,
    updatedFiles,
    linkRewriteCount: plan.linkRewriteCount,
  });
}

/**
 * Map a `planRename` error to the MCP isError response shape, preserving
 * the discriminator (`errorCode`) + payload (`candidates`, etc.) so the
 * caller can branch on it.
 */
function renameErrorToResponse(err: RenameError): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  if (err.errorCode === "ambiguous-heading") {
    return errorResponse({
      errorCode: err.errorCode,
      message: err.message,
      candidates: err.candidates,
    });
  }
  return errorResponse({
    errorCode: err.errorCode,
    message: err.message,
  });
}
