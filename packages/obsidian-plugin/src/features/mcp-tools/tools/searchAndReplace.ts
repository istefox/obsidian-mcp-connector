import { type } from "arktype";
import type { App } from "obsidian";
import { logger } from "$/shared/logger";

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
  'Regex find-and-replace across the vault or a scoped file list. Safe by default: `dry_run` is `true` — no files are modified unless you explicitly pass `dry_run:"false"`. Validates the regex before any file access. Returns files_matched, total_replacements, and per-file preview (max 5 match contexts). In preview entries, `line_number: 0` is a sentinel for multi-line matches where no per-line preview is available (consistent with `find_broken_links` frontmatter sentinel). JavaScript regex semantics apply; `g` flag is always active. Patterns with nested quantifiers (e.g. `(a+)+`) are rejected to protect the Obsidian main thread.',
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
          text: JSON.stringify(
            {
              error: `Invalid regex: ${msg}`,
              errorCode: "invalid_regex",
              pattern,
              flags,
            },
            null,
            2,
          ),
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
          text: JSON.stringify(
            {
              error:
                "Pattern contains nested quantifiers (ReDoS risk). Simplify the pattern.",
              errorCode: "unsafe_regex",
              pattern,
            },
            null,
            2,
          ),
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

  for (const file of files) {
    const content = await ctx.app.vault.read(file);

    // Count matches.
    const matchCount = (content.match(regex) ?? []).length;
    if (matchCount === 0) continue;

    // Build preview: split by line, find matching lines.
    const lines = content.split("\n");
    const preview: MatchPreview[] = [];
    for (let i = 0; i < lines.length && preview.length < 5; i++) {
      regex.lastIndex = 0;
      if (!regex.test(lines[i])) continue;
      regex.lastIndex = 0; // reset stateful global regex
      const after = lines[i].replace(regex, replacement);
      regex.lastIndex = 0;
      preview.push({
        line_number: i + 1,
        before: lines[i].slice(0, 200),
        after: after.slice(0, 200),
      });
    }
    regex.lastIndex = 0;

    if (preview.length === 0 && matchCount > 0) {
      preview.push({
        line_number: 0,
        before: "(multi-line match — no per-line preview)",
        after: '(apply with dry_run:"false" to see result)',
      });
    }

    if (!dryRun) {
      const newContent = content.replace(regex, replacement);
      regex.lastIndex = 0;
      await ctx.app.vault.modify(file, newContent);
    }

    totalReplacements += matchCount;
    details.push({ path: file.path, replacements: matchCount, preview });
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            dry_run: dryRun,
            pattern,
            flags_used: flags,
            files_matched: details.length,
            total_replacements: totalReplacements,
            details,
          },
          null,
          2,
        ),
      },
    ],
  };
}
