import { type } from "arktype";
import { TFile, type App } from "obsidian";
import {
  DATE_REGEX_BY_PERIOD,
  isValidPeriodicDate,
  resolvePeriodicNote,
} from "$/features/mcp-tools/services/periodicNotesDetector";

export const getOrCreateDailyNoteSchema = type({
  name: '"get_or_create_daily_note"',
  arguments: {
    "date?": type("string").describe(
      "ISO date `YYYY-MM-DD`. Default: today in the plugin process timezone (the user's machine TZ in the in-process / desktop deployment, which is the 99% case). For headless or multi-host setups where the MCP server runs on a different host than the Obsidian client, pass an explicit `date` to avoid TZ-driven off-by-one resolution.",
    ),
  },
}).describe(
  "Reads today's daily note (or the one at `date`), creating it if missing. Returns `{path, content, created}`. When the Daily Notes core plugin or the community Periodic Notes plugin is enabled, the note is created via the plugin's API so the configured template + `{{date}}`/`{{title}}` interpolations run; otherwise it is created as an empty file at the ISO path under the vault root. For weekly/monthly/quarterly/yearly notes use `get_or_create_periodic_note`.",
);

export type GetOrCreateDailyNoteContext = {
  arguments: { date?: string };
  app: App;
};

export async function getOrCreateDailyNoteHandler(
  ctx: GetOrCreateDailyNoteContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { date } = ctx.arguments;

  if (date !== undefined) {
    if (!DATE_REGEX_BY_PERIOD.daily.test(date)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "Invalid date format for period 'daily' — expected `YYYY-MM-DD`.",
                errorCode: "invalid_date_for_period",
                period: "daily",
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
    if (!isValidPeriodicDate("daily", date)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error:
                  "Date is well-shaped but not a real calendar date (e.g. month 13, Feb 30).",
                errorCode: "invalid_date_for_period",
                period: "daily",
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

  const resolved = resolvePeriodicNote(ctx.app, "daily", date);
  let created = false;
  let file = ctx.app.vault.getAbstractFileByPath(resolved.path);
  if (!resolved.exists) {
    file = await resolved.create();
    created = true;
  }
  // Read content from the (now-existing) file. The detector's `create()`
  // returns a TFile that is also reachable via the vault API; either is
  // fine — we re-read via `getAbstractFileByPath` so the same path the
  // tool returns is the path we read, no drift.
  if (!file) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error:
                "Internal: daily note resolved but not retrievable after create.",
              errorCode: "internal_error",
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
  if (!(file instanceof TFile)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "Path is not a file",
              errorCode: "not_a_file",
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
  const content = await ctx.app.vault.cachedRead(file);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { path: resolved.path, content, created },
          null,
          2,
        ),
      },
    ],
  };
}
