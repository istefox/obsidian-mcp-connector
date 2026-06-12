import { type } from "arktype";
import { errorText } from "../services/responseBuilders";
import type { App } from "obsidian";

export const executeDataviewQuerySchema = type({
  name: '"execute_dataview_query"',
  arguments: {
    query: type("string>0").describe(
      'Dataview DQL query. Supports `TABLE`, `LIST`, `TASK`, and `CALENDAR` query types. Examples: `TABLE file.mtime FROM "Projects"`, `LIST FROM #client`, `TASK WHERE !completed`. For large vaults prefer `LIMIT n` in the query itself — the tool returns the full result with no row cap.',
    ),
    "sourcePath?": type("string>0").describe(
      "Optional vault-relative origin file. Establishes relative-link / `this.*` resolution context for the query (maps to Dataview's `originFile` internally).",
    ),
  },
}).describe(
  'Run a Dataview DQL query against the vault and return the native typed result. In-process via the Dataview plugin API (`app.plugins.plugins.dataview.api.query`) — no Local REST API required. Returns the typed shape per query type: TABLE → `{type:"table", headers, values}`, LIST → `{type:"list", values}`, TASK → `{type:"task", values}`, CALENDAR → `{type:"calendar", values}`. Requires the Dataview community plugin: `errorCode: "dataview_not_installed"` if absent, `dataview_not_ready` if loaded but the index has not finished building (retry shortly — Dataview fires `dataview:index-ready` when done), `dataview_query_failed` if the DQL itself is rejected (the underlying error is surfaced verbatim).',
);

export type ExecuteDataviewQueryContext = {
  arguments: { query: string; sourcePath?: string };
  app: App;
};

// ── Dataview runtime shape ─────────────────────────────────────────────────
//
// Dataview's plugin API is not in our `.d.ts` (it lives in the user's
// installed Dataview plugin at runtime). Same pattern as `listTags.ts:30`
// for `getTags` and the `periodicNotesDetector.ts` cast for the daily-notes
// interface lib's stale .d.ts: declare the runtime shape locally + cast at
// the call site, with a safe-fail fallback when the shape changes.
//
// `api.query(source, originFile?, settings?)` resolves to a Result envelope:
//   { successful: true,  value: QueryResult }
//   { successful: false, error: string }
// We unwrap the envelope and return the inner `value` (or surface `error`).
// The success `value` carries extra fields beyond the documented contract
// (`idMeaning` on table, `primaryMeaning` on list, grouping on task); we
// pass them through verbatim. The load-bearing contract per ADR-0003 is the
// `type` discriminator + the typed `headers`/`values` per shape.

interface DataviewResultSuccess<T> {
  successful: true;
  value: T;
}
interface DataviewResultFailure {
  successful: false;
  error: string;
}
type DataviewResult<T> = DataviewResultSuccess<T> | DataviewResultFailure;

// We don't constrain QueryResult here — its shape varies per `type`, and the
// load-bearing field for callers is the `type` discriminator. Treat it as
// `unknown` and let the JSON serialisation pass the live shape through.
interface DataviewApi {
  query: (
    source: string,
    originFile?: string,
    settings?: unknown,
  ) => Promise<DataviewResult<unknown>>;
}

interface DataviewPlugin {
  api?: DataviewApi;
}

interface AppWithPlugins {
  plugins?: {
    plugins?: Record<string, unknown>;
  };
}

export async function executeDataviewQueryHandler(
  ctx: ExecuteDataviewQueryContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { query, sourcePath } = ctx.arguments;

  // Three-state detection per ADR-0003:
  //   absent              → not installed (permanent until user installs)
  //   present, no `.api`  → not ready    (transient; index still building,
  //                                       Dataview fires `dataview:index-ready`)
  //   `.api` present      → run query
  const pluginsBag = (ctx.app as unknown as AppWithPlugins).plugins?.plugins;
  const plugin = pluginsBag?.["dataview"] as DataviewPlugin | undefined;

  if (!plugin) {
    return errorPayload(
      "The Dataview community plugin is not installed. Install it from Obsidian's community plugins and enable it, then retry.",
      "dataview_not_installed",
      { query },
    );
  }
  if (!plugin.api) {
    // Plugin loaded but the index has not finished building. Distinct from
    // "not installed" because the fix is to wait, not to install. Dataview
    // fires `dataview:index-ready` when the index is ready — the agent
    // can simply retry shortly.
    return errorPayload(
      "Dataview is loaded but its index has not finished building yet. Retry shortly (Dataview fires `dataview:index-ready` when ready).",
      "dataview_not_ready",
      { query },
    );
  }

  let result: DataviewResult<unknown>;
  try {
    result = await plugin.api.query(query, sourcePath);
  } catch (err) {
    // Dataview threw internally (broken index, torn-down plugin, etc.).
    // Convert to a structured isError response rather than an unhandled rejection.
    return errorPayload(
      String(err instanceof Error ? err.message : err),
      "dataview_query_failed",
      { query },
    );
  }

  if (!result.successful) {
    // DQL parse / evaluation error — surface Dataview's own message verbatim
    // so the caller sees exactly what Dataview rejected. DQL validation is
    // Dataview's job, not ours. Use String() in case the real plugin returns
    // an Error object rather than a plain string.
    return errorPayload(String(result.error), "dataview_query_failed", {
      query,
    });
  }

  // Dataview can return rich objects (Link, DateTime, TFile) that contain
  // circular references or non-serialisable values. Catch and surface as a
  // structured error rather than an unhandled rejection.
  let text: string;
  try {
    text = JSON.stringify(result.value);
  } catch {
    return errorPayload(
      "Dataview result contains non-serialisable values (circular reference or BigInt). Add LIMIT or simplify the query to reduce result complexity.",
      "dataview_query_failed",
      { query },
    );
  }

  // Success: serialise the typed result as the standard MCP text payload.
  // No `isError` on success per the property-tools convention.
  return {
    content: [{ type: "text", text }],
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
  return errorText(JSON.stringify({ error: message, errorCode, ...extras }));
}
