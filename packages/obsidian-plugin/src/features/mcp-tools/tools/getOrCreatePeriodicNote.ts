import { type } from "arktype";
import { TFile, type App } from "obsidian";
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
      "Period granularity. For daily, `get_or_create_daily_note` is a shortcut.",
    ),
    "date?": type("string").describe(
      "Period-specific ISO date: daily `YYYY-MM-DD`, weekly `YYYY-Www`, monthly `YYYY-MM`, quarterly `YYYY-QN`, yearly `YYYY`. Default: the period containing today, host machine timezone.",
    ),
  },
}).describe(
  "Reads the periodic note for `period` (and optional `date`), creating it if missing. Returns `{path, content, created}`. Uses the Daily Notes / Periodic Notes plugin API when available (so configured templates run); otherwise creates an empty file at the ISO path. For structured edits, take the returned path and use `set_note_property` or `patch_vault_file`.",
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
            text: JSON.stringify({
              error: `Invalid date format for period '${period}' — expected ${describeFormat(period)}.`,
              errorCode: "invalid_date_for_period",
              period,
              date,
            }),
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
            text: JSON.stringify({
              error:
                "Date is well-shaped but not a real calendar value (e.g. month 13, Feb 30, ISO-week 99).",
              errorCode: "invalid_date_for_period",
              period,
              date,
            }),
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
          text: JSON.stringify({
            error:
              "Internal: periodic note resolved but not retrievable after create.",
            errorCode: "internal_error",
            period,
            path: resolved.path,
          }),
        },
      ],
      isError: true,
    };
  }
  if (!(file instanceof TFile)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Internal: periodic note resolved to a folder, not a file.",
            errorCode: "internal_error",
            period,
            path: resolved.path,
          }),
        },
      ],
      isError: true,
    };
  }
  const tfile = file;
  const content = await ctx.app.vault.cachedRead(tfile);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ period, path: resolved.path, content, created }),
      },
    ],
  };
}
