import { type } from "arktype";
import { TFile, type App } from "obsidian";
import {
  DATE_REGEX_BY_PERIOD,
  isValidPeriodicDate,
  resolvePeriodicNote,
} from "$/features/mcp-tools/services/periodicNotesDetector";
import { resolveHeadingForUri } from "../services/anchorTargets";
import {
  buildObsidianUri,
  headingNotFoundError,
} from "../services/buildObsidianUri";
import { errorJson } from "../services/responseBuilders";

export const getOrCreateDailyNoteSchema = type({
  name: '"get_or_create_daily_note"',
  arguments: {
    "date?": type("string").describe(
      "ISO date `YYYY-MM-DD`. Default: today in the plugin process timezone (the user's machine TZ in the in-process / desktop deployment, which is the 99% case). For headless or multi-host setups where the MCP server runs on a different host than the Obsidian client, pass an explicit `date` to avoid TZ-driven off-by-one resolution.",
    ),
    "heading?": type("string>0").describe(
      "A heading in the note. When present, the returned obsidian:// URI navigates directly to it. Use get_note_outline to discover a note's headings.",
    ),
  },
}).describe(
  "Reads today's daily note (or the one at `date`), creating it if missing. Returns `{path, content, created}`. With the Daily Notes or Periodic Notes plugin enabled, creation runs the configured template; otherwise the note is created empty at the ISO path under the vault root. For weekly/monthly/quarterly/yearly notes use `get_or_create_periodic_note`.",
);

export type GetOrCreateDailyNoteContext = {
  arguments: { date?: string; heading?: string };
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
      return errorJson(
        "Invalid date format for period 'daily' — expected `YYYY-MM-DD`.",
        "invalid_date_for_period",
        { period: "daily", date },
      );
    }
    if (!isValidPeriodicDate("daily", date)) {
      return errorJson(
        "Date is well-shaped but not a real calendar date (e.g. month 13, Feb 30).",
        "invalid_date_for_period",
        { period: "daily", date },
      );
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
    return errorJson(
      "Internal: daily note resolved but not retrievable after create.",
      "internal_error",
      { path: resolved.path },
    );
  }
  if (!(file instanceof TFile)) {
    return errorJson("Path is not a file", "not_a_file", {
      path: resolved.path,
    });
  }
  const content = await ctx.app.vault.cachedRead(file);

  const vaultName = ctx.app.vault.getName();
  let uri: string;
  if (ctx.arguments.heading) {
    const cache = ctx.app.metadataCache.getFileCache(file);
    const resolution = resolveHeadingForUri(
      cache,
      content.split("\n"),
      ctx.arguments.heading,
    );
    if (!resolution.ok) {
      return headingNotFoundError(ctx.arguments.heading, resolved.path);
    }
    uri = buildObsidianUri(vaultName, resolved.path, resolution.heading);
  } else {
    uri = buildObsidianUri(vaultName, resolved.path);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ path: resolved.path, content, created, uri }),
      },
    ],
  };
}
