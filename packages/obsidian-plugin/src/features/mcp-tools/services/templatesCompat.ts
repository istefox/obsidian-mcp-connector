import { type } from "arktype";
import type { Request, Response } from "express";
import { LocalRestAPI } from "shared";
import type McpToolsPlugin from "$/main";
import { logger } from "$/shared";
import { executeTemplateHandler } from "../tools/executeTemplate";

/**
 * Backward-compatibility shim for the legacy `POST /templates/execute`
 * Local REST API route.
 *
 * Why this exists: 0.3.x shipped a standalone `mcp-server` binary that
 * called back into the plugin via three LRA-mounted endpoints, including
 * `/templates/execute`. The 0.4.0 pivot moved tool execution in-process
 * and de-registered those routes (they were dead code from the in-process
 * server's perspective). However, users who upgrade silently — keeping
 * a pre-existing custom-id MCP server entry in `claude_desktop_config.json`
 * that still spawns the 0.3.x binary — get an HTTP 404 on every
 * `execute_template` call. The migration only cleans up the canonical
 * legacy config key and rewrites `mcp-tools-istefox`; it does not
 * touch arbitrary custom ids.
 *
 * This shim re-registers the route as a thin proxy onto the in-process
 * `executeTemplateHandler`, so 0.3.x binary callers keep working without
 * a code path of their own. Once the 0.4.1 migration learns to detect
 * and remove residual binary entries, this shim becomes a pure safety
 * net and could in principle be removed — but the cost of keeping it is
 * negligible (one route, one proxy function), so the plan is to leave
 * it indefinitely as a compatibility commitment.
 *
 * Reported by @folotp on issue #73 (2026-05-01) during 0.4.0-beta.2 soak.
 */

/**
 * Discriminated result type for the compat handler. Status code is part
 * of the contract — the route handler maps it directly to `res.status()`.
 */
export type TemplatesCompatResult =
  | {
      status: 200;
      payload: {
        message: string;
        content: string;
        // Optional `path` echo for callers that chain off it (Issue #20
        // pattern). Not part of the original 0.3.x response shape, but
        // added as an additional field; legacy clients ignore unknown
        // properties.
        path?: string;
      };
    }
  | {
      status: 400 | 404 | 500 | 503;
      payload: {
        error: string;
        body?: unknown;
        summary?: string;
      };
    };

/**
 * Pure logic for the `/templates/execute` compat endpoint, isolated from
 * the Express req/res wiring so it can be unit-tested without spinning up
 * a route registration. Maps the LRA request shape to the in-process
 * `executeTemplateHandler` arguments and translates the tool's
 * `isError`-flagged result back into appropriate HTTP status codes.
 */
export async function handleTemplatesExecuteCompat(
  plugin: McpToolsPlugin,
  body: unknown,
): Promise<TemplatesCompatResult> {
  // Validate body using the same ArkType schema 0.3.x used. Keeps the
  // wire contract stable for legacy clients.
  const params = LocalRestAPI.ApiTemplateExecutionParams(body);
  if (params instanceof type.errors) {
    return {
      status: 400,
      payload: {
        error: "Invalid request body",
        body,
        summary: params.summary,
      },
    };
  }

  // Map LRA shape (`name`, `createFile` boolean) to the in-process tool
  // shape (`templatePath`, `createFile` as `"true"`/`"false"` string). The
  // string-typed boolean on the in-process side is a belt-and-suspenders
  // workaround for older MCP clients that serialize booleans as strings;
  // here we always pass the canonical string form.
  const result = await executeTemplateHandler({
    arguments: {
      templatePath: params.name,
      targetPath: params.targetPath,
      createFile: params.createFile === true ? "true" : "false",
      arguments: params.arguments,
    },
    app: plugin.app,
    plugin,
  });

  const errorText = result.content[0]?.text ?? "Unknown error";

  if (result.isError === true) {
    // The in-process handler signals error categories through specific
    // message prefixes. Map them to the HTTP status codes the legacy
    // 0.3.x handler used, so binary callers see identical envelopes.
    if (errorText.startsWith("Templater plugin is not installed")) {
      return { status: 503, payload: { error: errorText } };
    }
    if (errorText.startsWith("Template not found:")) {
      return { status: 404, payload: { error: errorText } };
    }
    // Default: 500 for "Template execution failed: …" and any other
    // surfaced error. Matches the 0.3.x behaviour for runtime failures.
    return { status: 500, payload: { error: errorText } };
  }

  // Success path: the in-process handler returns its payload as
  // JSON.stringify'd text inside `content[0].text`. Parse it back to a
  // structured object to expose `message`/`content`/`path` as fields on
  // the LRA response (matching `LocalRestAPI.ApiTemplateExecutionResponse`).
  let parsed: { message?: string; content?: string; path?: string };
  try {
    parsed = JSON.parse(errorText) as typeof parsed;
  } catch (parseError) {
    logger.error("Templates compat — failed to parse handler payload", {
      payload: errorText,
      error:
        parseError instanceof Error ? parseError.message : String(parseError),
    });
    return {
      status: 500,
      payload: {
        error: "Internal error: handler returned malformed payload",
      },
    };
  }

  return {
    status: 200,
    payload: {
      message: parsed.message ?? "",
      content: parsed.content ?? "",
      ...(parsed.path !== undefined ? { path: parsed.path } : {}),
    },
  };
}

/**
 * Mounts the compat route onto the Local REST API plugin. Idempotent
 * relative to a single plugin lifecycle: LRA's `addRoute` does not
 * deduplicate, so callers must invoke this exactly once per `setup()`.
 *
 * Skips cleanly if LRA is not installed; the in-process MCP server
 * still serves `execute_template` over HTTP/27200 to MCP-aware clients.
 */
export function registerTemplatesCompatRoute(plugin: McpToolsPlugin): void {
  const api = plugin.localRestApi.api;
  if (!api) {
    logger.debug(
      "Templates compat route skipped — Local REST API not available",
    );
    return;
  }

  api
    .addRoute("/templates/execute")
    .post(async (req: Request, res: Response) => {
      try {
        const result = await handleTemplatesExecuteCompat(plugin, req.body);
        res.status(result.status).json(result.payload);
      } catch (error: unknown) {
        // Defensive: any unexpected throw past the pure handler escapes
        // here. The pure handler already wraps its own errors, so this
        // only fires on programming errors (e.g. Express middleware
        // failure). Log + 500 to keep the connection healthy.
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Templates compat route — unexpected error", {
          error: message,
        });
        res.status(500).json({
          error: `Internal error: ${message}`,
        });
      }
    });

  logger.info(
    "Templates compat route registered: POST /templates/execute → in-process executeTemplateHandler",
  );
}
