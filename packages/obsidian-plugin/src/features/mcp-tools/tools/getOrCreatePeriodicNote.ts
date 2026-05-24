import { type } from "arktype";
import type { App, TFile } from "obsidian";
import {
  DATE_REGEX_BY_PERIOD,
  describeFormat,
  isValidPeriodicDate,
  type PeriodType,
  resolvePeriodicNote,
} from "$/features/mcp-tools/services/periodicNotesDetector";

export const getOrCreatePeriodicNoteSchema = type({
  name: '"get_or_create_periodic_note"',
  arguments: {
    period: type('"daily"|"weekly"|"monthly"|"quarterly"|"yearly"').describe(
      "Period granularity. `daily` is also reachable via `get_or_create_daily_note` (zero-friction shortcut for the common case).",
    ),
    "date?": type("string").describe(
      "Period-specific ISO date. Formats: daily `YYYY-MM-DD`, weekly `YYYY-Www` (ISO week), monthly `YYYY-MM`, quarterly `YYYY-QN` (N=1-4), yearly `YYYY`. Default: the period instance containing today in the plugin process timezone (the user's machine TZ in the in-process / desktop deployment).",
    ),
  },
}).describe(
  "Reads the periodic note for the given `period` (and optional `date`), creating it if missing. Returns `{path, content, created}`. When the Daily Notes core plugin or the community Periodic Notes plugin covers the period, the note is created via the plugin's API so the configured template + interpolations run; otherwise it is created as an empty file at the ISO path under the vault root. **Structured writes to the resolved note** (set a frontmatter field, replace under a heading, edit a block) compose: get the path, then `set_note_property` (Module D) or `patch_vault_file` — there is no dedicated `patch_periodic_note` (ADR-0002 Alt #7).",
);

export type GetOrCreatePeriodicNoteContext = {
  arguments: { period: PeriodType; date?: string };
  app: App;
};

export async function getOrCreatePeriodicNoteHandler(
  ctx: GetOrCreatePeriodicNoteContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { period, date } = ctx.arguments;

  if (date !== undefined) {
    if (!DATE_REGEX_BY_PERIOD[period].test(date)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Invalid date format for period '${period}' — expected ${describeFormat(period)}.`,
                errorCode: "invalid_date_for_period",
                period,
                date,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    if (!isValidPeriodicDate(period, date)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "Date is well-shaped but not a real calendar value (e.g. month 13, Feb 30, ISO-week 99).",
                errorCode: "invalid_date_for_period",
                period,
                date,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
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
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error:
                "Internal: periodic note resolved but not retrievable after create.",
              errorCode: "internal_error",
              period,
              path: resolved.path,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  const tfile = file as TFile;
  const content = await ctx.app.vault.cachedRead(tfile);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { period, path: resolved.path, content, created },
          null,
          2,
        ),
      },
    ],
  };
}
