import { type } from "arktype";
import { errorText } from "../services/responseBuilders";
import { TFile, type App } from "obsidian";
import {
  DATE_REGEX_BY_PERIOD,
  describeFormat,
  isValidPeriodicDate,
  type PeriodType,
  resolvePeriodicNote,
} from "$/features/mcp-tools/services/periodicNotesDetector";
import {
  findHeadingSectionEnd,
  findLeafHeadingLine,
  normalizeAppendBody,
  resolveHeadingPath,
} from "$/features/mcp-tools/services/patchHelpers";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";

export const appendToPeriodicNoteSchema = type({
  name: '"append_to_periodic_note"',
  arguments: {
    "period?": type('"daily"|"weekly"|"monthly"|"quarterly"|"yearly"').describe(
      "Period granularity. Default `daily`.",
    ),
    content: type("string").describe("Markdown content to append."),
    "date?": type("string").describe(
      "Period-specific ISO date. Formats: daily `YYYY-MM-DD`, weekly `YYYY-Www`, monthly `YYYY-MM`, quarterly `YYYY-QN`, yearly `YYYY`. Default: the period instance containing today in the plugin process timezone.",
    ),
    "underHeading?": type("string>0").describe(
      'Appends inside this heading\'s section (exact leaf name or `Parent::Child` path). If the heading is missing the call fails with `errorCode: "heading_not_found"` but the auto-created note is kept; add the heading via `patch_vault_file` and retry.',
    ),
  },
}).describe(
  "Appends to a periodic note (daily by default), auto-creating it like `get_or_create_periodic_note`. With `underHeading`, inserts inside that section; otherwise appends at end of file.",
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

  const normalized = normalizeAppendBody(content, "append");

  // The whole exists-check → auto-create → append pipeline runs under
  // the vault write lock: two concurrent appends to a missing note
  // would otherwise both take the create branch (TOCTOU), and the
  // append itself is a read-modify-write (see vaultWriteLock.ts).
  return withVaultWriteLock(async () => {
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
    if (!(file instanceof TFile)) {
      return errorPayload(
        "Internal: periodic note resolved to a folder, not a file.",
        "internal_error",
        { period, path: resolved.path },
      );
    }
    const tfile = file;

    if (underHeading !== undefined) {
      // The heading lookup + splice is pure and synchronous, so it runs
      // inside vault.process: the section boundaries are computed from
      // the exact content that is written back — no interleaving writer
      // can invalidate the line numbers in between. The not-found abort
      // is signalled via a flag; the callback returns the input
      // unchanged (content no-op).
      let headingFound = true;
      await ctx.app.vault.process(tfile, (raw) => {
        const lines = raw.split("\n");

        // Resolve partial leaf name to full hierarchical path (same as
        // patch_vault_file): so `underHeading: "Highlights"` matches a nested
        // `## Weekly review > ## Highlights` without the caller knowing the path.
        let resolvedTarget = underHeading;
        if (!underHeading.includes(HEADING_DELIMITER)) {
          const fullPath = resolveHeadingPath(
            raw,
            underHeading,
            HEADING_DELIMITER,
          );
          if (fullPath) resolvedTarget = fullPath;
        }
        const targetParts = resolvedTarget.split(HEADING_DELIMITER);
        const leafHeading = targetParts[targetParts.length - 1];

        const found = findLeafHeadingLine(lines, leafHeading);

        if (found === null) {
          headingFound = false;
          return raw;
        }

        const { line: headingLine, level: headingLevel } = found;
        const sectionEnd = findHeadingSectionEnd(
          lines,
          headingLine,
          headingLevel,
        );
        return [
          ...lines.slice(0, sectionEnd),
          normalized,
          ...lines.slice(sectionEnd),
        ].join("\n");
      });

      if (!headingFound) {
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
    } else {
      await ctx.app.vault.process(tfile, (existing) => existing + normalized);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            period,
            path: resolved.path,
            appended: true,
            created,
          }),
        },
      ],
    };
  });
}

function errorPayload(
  message: string,
  errorCode: string,
  extras: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return errorText(JSON.stringify({ error: message, errorCode, ...extras }));
}
