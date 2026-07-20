import { type } from "arktype";
import type { App } from "obsidian";
import { logger } from "$/shared/logger";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";

/** Reads per batch: bounds memory while hiding vault.read latency. */
const READ_BATCH_SIZE = 8;

export const searchAndReplaceSchema = type({
  name: '"search_and_replace"',
  arguments: {
    pattern: type("string>0").describe(
      "JavaScript regex pattern (passed to `new RegExp(pattern, flags)`). Do not include surrounding `/` delimiters.",
    ),
    replacement: type("string").describe(
      "Replacement string. Supports backreferences (`$1`, `$2`, `$&` for full match, `$'`/`$\\`` for surrounding text).",
    ),
    "flags?": type("string").describe(
      'Regex flags (default `"g"`). The `g` flag is always active — omitting it is equivalent to passing `"g"`. Combine: `"gi"`, `"gm"`, `"gims"`, etc.',
    ),
    "dry_run?": type('"true" | "false"').describe(
      'When `"true"` (default), no files are modified — returns a preview of changes. Pass `"false"` to apply. Always preview first to verify scope and intent.',
    ),
    "scope?": type("string[]").describe(
      "Optional list of vault-relative paths or folder prefixes to limit the search. A folder prefix matches any file under it. Omit for vault-wide search.",
    ),
  },
}).describe(
  'Regex find-and-replace across the vault or a scoped file list. `dry_run` defaults to `"true"` (preview only); pass `"false"` to write. Returns files_matched, total_replacements, and up to 5 match previews per file (`line_number: 0` = multi-line match). JavaScript regex, `g` flag always active; patterns with nested quantifiers are rejected.',
);

export type SearchAndReplaceContext = {
  arguments: {
    pattern: string;
    replacement: string;
    flags?: string;
    dry_run?: "true" | "false";
    scope?: string[];
  };
  app: App;
};

type MatchPreview = { line_number: number; before: string; after: string };
type SearchReplaceDetail = {
  path: string;
  replacements: number;
  preview: MatchPreview[];
};

export async function searchAndReplaceHandler(
  ctx: SearchAndReplaceContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { pattern, replacement } = ctx.arguments;
  const dryRun = (ctx.arguments.dry_run ?? "true") === "true";
  const scope = ctx.arguments.scope;

  // Always inject the global flag.
  const rawFlags = ctx.arguments.flags ?? "g";
  const flags = rawFlags.includes("g") ? rawFlags : `g${rawFlags}`;

  // Validate regex before touching any file.
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("search_and_replace: invalid regex", {
      pattern,
      flags,
      error: msg,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Invalid regex: ${msg}`,
            errorCode: "invalid_regex",
            pattern,
            flags,
          }),
        },
      ],
      isError: true,
    };
  }

  // Reject patterns with nested quantifiers (ReDoS guard — Obsidian runs on main thread, no regex timeout).
  if (
    /\([^)]*[+*][^)]*\)[+*?]/.test(pattern) ||
    /\((?:[^()]*[+*?][^()]*\|)+[^()]+\)[+*?{]/.test(pattern)
  ) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              "Pattern contains nested quantifiers (ReDoS risk). Simplify the pattern.",
            errorCode: "unsafe_regex",
            pattern,
          }),
        },
      ],
      isError: true,
    };
  }

  const inScope = (path: string): boolean => {
    if (!scope || scope.length === 0) return true;
    return scope.some(
      (s) =>
        path === s ||
        path === `${s}.md` ||
        path.startsWith(s.endsWith("/") ? s : `${s}/`),
    );
  };

  const files = ctx.app.vault.getMarkdownFiles().filter((f) => inScope(f.path));

  const details: SearchReplaceDetail[] = [];
  let totalReplacements = 0;

  // Read+scan in sequential batches (parallel reads within a batch,
  // file order preserved) — same shape as searchVaultSimple's
  // READ_BATCH_SIZE loop. Writes stay serial, in file order, below.
  for (let start = 0; start < files.length; start += READ_BATCH_SIZE) {
    const batch = files.slice(start, start + READ_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        const content = await ctx.app.vault.read(file);

        // Per-file regex: files in a batch scan concurrently, so the
        // shared stateful global regex would race on lastIndex.
        const fileRegex = new RegExp(regex.source, regex.flags);

        // Count matches.
        const matchCount = (content.match(fileRegex) ?? []).length;
        if (matchCount === 0) return null;

        // Build preview: split by line, find matching lines.
        const lines = content.split("\n");
        const preview: MatchPreview[] = [];
        for (let i = 0; i < lines.length && preview.length < 5; i++) {
          fileRegex.lastIndex = 0;
          if (!fileRegex.test(lines[i])) continue;
          fileRegex.lastIndex = 0; // reset stateful global regex
          const after = lines[i].replace(fileRegex, replacement);
          fileRegex.lastIndex = 0;
          preview.push({
            line_number: i + 1,
            before: lines[i].slice(0, 200),
            after: after.slice(0, 200),
          });
        }
        fileRegex.lastIndex = 0;

        if (preview.length === 0 && matchCount > 0) {
          preview.push({
            line_number: 0,
            before: "(multi-line match — no per-line preview)",
            after: '(apply with dry_run:"false" to see result)',
          });
        }

        return { file, content, matchCount, preview, fileRegex };
      }),
    );

    for (const r of batchResults) {
      if (r === null) continue;

      let appliedCount = r.matchCount;
      if (!dryRun) {
        // Atomic apply: re-match and replace against the CURRENT content
        // inside vault.process, not against the scan-phase snapshot — a
        // write landing between scan and apply (another MCP request, the
        // editor) is neither clobbered nor double-applied. The reported
        // count is what was actually replaced. Write lock: see
        // vaultWriteLock.ts.
        await withVaultWriteLock(() =>
          ctx.app.vault.process(r.file, (current) => {
            const applyRegex = new RegExp(regex.source, regex.flags);
            appliedCount = (current.match(applyRegex) ?? []).length;
            if (appliedCount === 0) return current;
            applyRegex.lastIndex = 0;
            return current.replace(applyRegex, replacement);
          }),
        );
      }

      totalReplacements += appliedCount;
      details.push({
        path: r.file.path,
        replacements: appliedCount,
        preview: r.preview,
      });
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          dry_run: dryRun,
          pattern,
          flags_used: flags,
          files_matched: details.length,
          total_replacements: totalReplacements,
          details,
        }),
      },
    ],
  };
}
