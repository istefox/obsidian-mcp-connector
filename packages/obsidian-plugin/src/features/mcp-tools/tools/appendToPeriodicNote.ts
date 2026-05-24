import { type } from "arktype";
import type { App, TFile } from "obsidian";
import {
  DATE_REGEX_BY_PERIOD,
  describeFormat,
  isValidPeriodicDate,
  type PeriodType,
  resolvePeriodicNote,
} from "$/features/mcp-tools/services/periodicNotesDetector";
import {
  findHeadingSectionEnd,
  normalizeAppendBody,
  resolveHeadingPath,
} from "$/features/mcp-tools/services/patchHelpers";

export const appendToPeriodicNoteSchema = type({
  name: '"append_to_periodic_note"',
  arguments: {
    "period?": type('"daily"|"weekly"|"monthly"|"quarterly"|"yearly"').describe(
      "Period granularity. Defaults to `daily` so the common case is one positional `content` away.",
    ),
    content: type("string").describe("Markdown content to append."),
    "date?": type("string").describe(
      "Period-specific ISO date. Formats: daily `YYYY-MM-DD`, weekly `YYYY-Www`, monthly `YYYY-MM`, quarterly `YYYY-QN`, yearly `YYYY`. Default: the period instance containing today in the plugin process timezone.",
    ),
    "underHeading?": type("string>0").describe(
      "If provided, appends inside this heading's section (matched by exact leaf name, or by a `Parent::Child` path with `::` as the delimiter). Without it, appends at end-of-file. If the heading is not found, the call fails with `errorCode: \"heading_not_found\"` — and an auto-created note is left in place (the file's existence is the right end state; add the heading via `patch_vault_file` and retry).",
    ),
  },
}).describe(
  "Appends content to a periodic note (daily by default). Auto-creates the note if it doesn't exist via the same path as `get_or_create_periodic_note` (plugin API when enabled, ISO fallback otherwise). `underHeading` targets a section via the shared heading walker (same fence-aware semantics as `patch_vault_file`); without it, content is appended at EOF.",
);

export type AppendToPeriodicNoteContext = {
  arguments: {
    period?: PeriodType;
    content: string;
    date?: string;
    underHeading?: string;
  };
  app: App;
};

const HEADING_DELIMITER = "::";

export async function appendToPeriodicNoteHandler(
  ctx: AppendToPeriodicNoteContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { period = "daily", content, date, underHeading } = ctx.arguments;

  if (date !== undefined) {
    if (!DATE_REGEX_BY_PERIOD[period].test(date)) {
      return errorPayload(
        `Invalid date format for period '${period}' — expected ${describeFormat(period)}.`,
        "invalid_date_for_period",
        { period, date },
      );
    }
    if (!isValidPeriodicDate(period, date)) {
      return errorPayload(
        "Date is well-shaped but not a real calendar value (e.g. month 13, Feb 30, ISO-week 99).",
        "invalid_date_for_period",
        { period, date },
      );
    }
  }

  const resolved = resolvePeriodicNote(ctx.app, period, date);
  let created = false;
  let file = ctx.app.vault.getAbstractFileByPath(resolved.path);
  if (!resolved.exists) {
    file = await resolved.create();
    created = true;
  }
  if (!file) {
    return errorPayload(
      "Internal: periodic note resolved but not retrievable after create.",
      "internal_error",
      { period, path: resolved.path },
    );
  }
  const tfile = file as TFile;
  const normalized = normalizeAppendBody(content, "append");

  if (underHeading !== undefined) {
    const raw = await ctx.app.vault.read(tfile);
    const lines = raw.split("\n");

    // Resolve partial leaf name to full hierarchical path (same as
    // patch_vault_file): so `underHeading: "Highlights"` matches a nested
    // `## Weekly review > ## Highlights` without the caller knowing the path.
    let resolvedTarget = underHeading;
    if (!underHeading.includes(HEADING_DELIMITER)) {
      const fullPath = resolveHeadingPath(raw, underHeading, HEADING_DELIMITER);
      if (fullPath) resolvedTarget = fullPath;
    }
    const targetParts = resolvedTarget.split(HEADING_DELIMITER);
    const leafHeading = targetParts[targetParts.length - 1];

    let headingLine = -1;
    let headingLevel = 1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
      if (m && m[2].trim() === leafHeading) {
        headingLine = i;
        headingLevel = m[1].length;
        break;
      }
    }

    if (headingLine === -1) {
      // Strict-by-default: do NOT silently fall back to EOF, do NOT
      // rollback an auto-created file (the file's existence is the
      // right end state regardless of this single append — see ADR-0002
      // Negatives + spec). Caller adds the heading and retries.
      return errorPayload(
        `Heading not found in periodic note: "${underHeading}".`,
        "heading_not_found",
        {
          period,
          path: resolved.path,
          created,
          underHeading,
        },
      );
    }

    const sectionEnd = findHeadingSectionEnd(lines, headingLine, headingLevel);
    const newLines = [
      ...lines.slice(0, sectionEnd),
      normalized,
      ...lines.slice(sectionEnd),
    ];
    await ctx.app.vault.modify(tfile, newLines.join("\n"));
  } else {
    const existing = await ctx.app.vault.read(tfile);
    await ctx.app.vault.modify(tfile, existing + normalized);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            period,
            path: resolved.path,
            appended: true,
            created,
          },
          null,
          2,
        ),
      },
    ],
  };
}

function errorPayload(
  message: string,
  errorCode: string,
  extras: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, errorCode, ...extras }, null, 2),
      },
    ],
    isError: true,
  };
}
