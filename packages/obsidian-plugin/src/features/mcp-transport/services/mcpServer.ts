import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/server";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type App } from "obsidian";
import type McpToolsPlugin from "$/main";
import { logger } from "$/shared";
import type { ToolScope } from "$/shared/types";
import type { ToolRegistry } from "./toolRegistry";
import type { PromptRegistry } from "./promptRegistry";
import {
  ToolLoadingManager,
  META_TOOLS,
} from "$/features/adaptive-tool-loading";
import { readPolicy } from "$/features/adaptive-tool-loading/tokenPolicyStore";
import { resolveToolScope } from "$/features/adaptive-tool-loading/resolveToolScope";
import { SessionPromotions } from "$/features/adaptive-tool-loading/sessionPromotions";
import { composeToolRegistry } from "$/composeToolRegistry";
import { ERROR_CODES, MAX_REQUEST_BODY_BYTES } from "../constants";
import {
  flush as flushEraCounters,
  record as recordEra,
  scheduleFlush as scheduleEraFlush,
} from "./eraCounters";
import { applyDeferredVersionRung, classifyEra } from "./eraRouter";
import {
  bodyTargetsSseNotificationTool,
  readBodyWithCap,
} from "./parseRequestBody";

/**
 * Boundary cast for the two registry handlers wired below.
 *
 * SDK v2 types `setRequestHandler` against the generated wire schema, which
 * describes `inputSchema` and the tool-result union structurally, down to the
 * JSON primitives allowed inside `properties`. Our registries are typed the
 * looser way that ArkType produces (`Record<string, unknown>` for schemas, a
 * plain object for results); the runtime shapes are correct — the wire
 * contract is enforced by `normalizeInputSchema` and `resultSchema` in
 * toolRegistry.ts — but the two type descriptions do not unify.
 *
 * Restating the wire types across the registry propagates the SDK's shape
 * into every caller and test that touches a tool result, so the coupling is
 * kept here, at the one place where our types meet the SDK's. Only the
 * returned value is cast — `request` and `ctx` keep the SDK's own types, so
 * a future change to the request shape still fails the build. Both handlers
 * are covered by toolRegistry's own tests plus the transport smoke tests.
 */
const asListToolsResult = (value: unknown) => value as ListToolsResult;
const asCallToolResult = (value: unknown) => value as CallToolResult;

export type McpServiceConfig = {
  app: App;
  plugin: McpToolsPlugin;
  pluginVersion: string;
  /** Reported as `serverInfo.name` in the MCP `initialize` handshake (see issue #329). */
  serverName: string;
};

export type McpService = {
  registry: ToolRegistry;
  promptRegistry: PromptRegistry;
  handleRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    /** Id of the bearer token this request authenticated with. */
    tokenId: string,
  ) => Promise<void>;
  /**
   * Build the per-request McpServer serving `tokenId`. The single
   * construction site for both protocol eras: the legacy branch calls it
   * directly, the modern branch reaches it through the SDK's
   * McpServerFactory (ADR-0016 §4). Per-token tool surfaces (ADR-0014) and
   * the tools/list stability invariant (ADR-0015) therefore cannot drift
   * between eras — there is no second implementation to drift.
   */
  buildMcpServer: (tokenId: string) => McpServer;
  /**
   * Persist both in-memory counter batches: tool calls (see
   * ToolLoadingManager) and per-era requests (see eraCounters). One entry
   * point rather than two so every existing call site — the tests and
   * `destroyMcpService` — keeps draining everything this service batches.
   */
  flushPendingCalls: () => Promise<void>;
  /**
   * Tear down the modern-era handler: aborts in-flight modern exchanges and
   * closes their per-request instances. The legacy branch needs no
   * equivalent — it closes its own server and transport per request.
   */
  closeModernHandler: () => Promise<void>;
};

/**
 * Create an MCP service whose handler builds a fresh McpServer +
 * StreamableHTTPServerTransport per HTTP request.
 *
 * Why per-request instead of singleton: the SDK's stateless streamable-HTTP
 * transport (`sessionIdGenerator: undefined`) is built to serve a single
 * exchange, not to be shared across independent requests. Reusing one means
 * the second call throws and the HTTP server returns 500. We hit this in
 * the 0.4.0-alpha.2 vault TEST smoke (issue surfaced 2026-04-26).
 *
 * The cost of creating a fresh server+transport per request is on
 * the order of milliseconds and is dominated by the JSON parse;
 * acceptable for a single-user local server.
 *
 * The `ToolRegistry` (with all 29 tool registrations) is created
 * once at setup and shared across requests — registration is idempotent
 * but doing it per request would multiply the per-request cost
 * significantly with no benefit.
 */
export async function createMcpService(
  config: McpServiceConfig,
): Promise<McpService> {
  // The fan-out for issue #419. Counters are vault-wide (ADR-0014), so a
  // promotion triggered by one client's traffic widens every adaptive token's
  // list — including clients that made no request and would otherwise serve a
  // stale `tools/list` until they happened to re-list. `notify.toolsChanged()`
  // publishes onto the 2026-era handler's bus, and its listen router delivers
  // to every open `subscriptions/listen` stream that opted in.
  //
  // A thunk, not a direct reference: `modernHandler` is constructed further
  // down. It can only fire from inside a request, long after both exist.
  //
  // 2025-era clients get nothing from this — no listen stream exists on that
  // wire, and the endpoint is POST-only by design. #419 is repaired for the
  // era that provides the mechanism, not for the one that never had it.
  const toolLoadingManager = new ToolLoadingManager({
    onToolsPromoted: () => modernHandler.notify.toolsChanged(),
  });
  // `activate_tool`'s default (persist: false) promotions, per token.
  // Owned here because it must outlive the request that created it and
  // die with the service; composeToolRegistry only wires the meta-tools
  // to it (ADR-0014 §5).
  const session = new SessionPromotions();
  // The populated registry is composed outside the transport (policy
  // lives in $/composeToolRegistry); this layer only serves it.
  const { toolRegistry: registry, promptRegistry } = await composeToolRegistry({
    ...config,
    session,
  });

  const resolveScope = async (tokenId: string): Promise<ToolScope> => {
    const policy = await readPolicy(config.plugin, tokenId);
    const allNames = registry.listAll().map((entry) => entry.name);
    return resolveToolScope(tokenId, policy, allNames, session.get(tokenId));
  };

  /**
   * The per-request McpServer, built once per serving unit and shared by
   * both eras. It closes nothing: the legacy branch tears its instance down
   * in its own `finally`, and on the modern branch the SDK's serving entry
   * owns the lifecycle.
   */
  const buildMcpServer = (tokenId: string): McpServer => {
    // Resolving a scope costs a settings read, and only tools/* needs
    // one: `initialize`, `prompts/*` and malformed requests must pay
    // nothing. Memoizing the PROMISE (not the value) also collapses the
    // tools/list + tools/call pair of a batched POST into one read. The
    // memo lives as long as the instance, which is one request on either
    // era, so its lifetime is unchanged by the extraction.
    let scopePromise: Promise<ToolScope> | undefined;
    const getScope = (): Promise<ToolScope> =>
      (scopePromise ??= resolveScope(tokenId));

    const server = new McpServer(
      {
        name: config.serverName,
        version: config.pluginVersion,
      },
      {
        capabilities: {
          // Declare tools capability so the SDK allows tools/list and
          // tools/call request handler registration. Without this the
          // SDK throws "Server does not support tools" at
          // setRequestHandler time.
          // listChanged: true signals support for notifications/tools/list_changed
          // (MCP spec 2025-06-18), emitted by activate_tool.
          tools: { listChanged: true },
          prompts: {},
        },
      },
    );

    // Wire the ArkType-based registry against the underlying SDK
    // Server so tools/list and tools/call go through our boolean
    // coercion + error formatting + adaptive/user disable-state support.
    server.server.setRequestHandler("tools/list", async () =>
      asListToolsResult(registry.list(await getScope())),
    );
    server.server.setRequestHandler("tools/call", async (request, ctx) => {
      const scope = await getScope();
      // Read the outcome classification against the same scope dispatch()
      // will read, and synchronously with it: the await above is the only
      // suspension point, and dispatch()'s own branch check runs
      // synchronously before its first await — so no interleaving is
      // possible between this check and dispatch()'s internal one. See
      // ADR-0011.
      const isInactive = registry.isInactive(request.params.name, scope);
      // Pass the SDK's request-scoped sendNotification down to the
      // handler. activate_tool uses it so its tools/list_changed carries
      // this call's relatedRequestId and is flushed on the POST response
      // stream (which is SSE for activate_tool — see below).
      const result = await registry.dispatch(request.params, {
        server,
        sendNotification: ctx.mcpReq.notify,
        scope,
      });
      // Record the call for frequency-based promotion (meta-tools and
      // adaptive-inactive calls are excluded — the latter did not
      // execute, see ADR-0011).
      if (
        !isInactive &&
        !(META_TOOLS as string[]).includes(request.params.name)
      ) {
        toolLoadingManager
          .recordCall(request.params.name, config.plugin)
          .catch((error: unknown) => {
            // Fire-and-forget by design, but a persistent settings
            // write failure (disk full, corrupted data.json) must
            // leave a diagnostic trail.
            logger.warn("[mcp] recordCall failed", {
              tool: request.params.name,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return asCallToolResult(result);
    });
    server.server.setRequestHandler("prompts/list", promptRegistry.list);
    server.server.setRequestHandler("prompts/get", (req) =>
      promptRegistry.dispatch(req.params),
    );

    return server;
  };

  // The 2026-07-28 leg. Built once per service and wrapped once: the entry
  // allocates an event bus, so one per request would be waste (ADR-0016 §2).
  //
  // `legacy: "reject"` is deliberate and is NOT the same decision as strict
  // mode on the endpoint. `classifyEra` has already separated the traffic, so
  // a legacy-classified request arriving here is a routing bug: rejecting it
  // makes that bug loud instead of silently double-serving 2025 requests
  // through a second, differently-configured stateless transport. The
  // endpoint itself stays permissive because the legacy branch sits in front
  // of this handler.
  const modernHandler = createMcpHandler(
    (ctx) => buildMcpServer(ctx.authInfo?.clientId ?? ""),
    {
      legacy: "reject",
      responseMode: "auto",
      onerror: (error) =>
        logger.warn("[mcp] modern-era request rejected", {
          error: error.message,
        }),
    },
  );
  const modern = toNodeHandler(modernHandler, {
    onerror: (error) =>
      logger.error("[mcp] modern-era handler failed", { error: error.message }),
  });

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    tokenId: string,
  ): Promise<void> => {
    // Inspect the body before choosing the response mode. The GET SSE
    // stream is blocked (POST-only transport), so a server-initiated
    // notification has nowhere to go — EXCEPT the response stream of the
    // request that triggers it. Tools in SSE_NOTIFICATION_TOOLS must
    // therefore answer with SSE so a notification their handler emits
    // (activate_tool's tools/list_changed, search_vault_smart's
    // notifications/progress while indexing, #344) is flushed on this
    // call's stream. Every other request keeps the default JSON response
    // (Windows/mcp-remote path unchanged).
    const rawBody = await readBodyWithCap(req, MAX_REQUEST_BODY_BYTES);
    if (rawBody === null) {
      // Chunked body (no Content-Length) exceeded the cap. Falling through
      // with parsedBody=undefined would make the SDK re-read the stream we
      // already partially drained and answer -32700 instead of 413. Mirror
      // httpServer.ts's declared-length rejection: respond, then destroy
      // the socket so the oversized payload stops arriving.
      res.writeHead(ERROR_CODES.PAYLOAD_TOO_LARGE);
      res.end();
      req.destroy();
      return;
    }
    let parsedBody: unknown;
    let needsSseResponse = false;
    try {
      parsedBody = JSON.parse(rawBody);
      needsSseResponse = bodyTargetsSseNotificationTool(parsedBody);
    } catch {
      // Malformed JSON: leave parsedBody undefined and let the SDK emit
      // the standard -32700 parse error over the JSON response path.
      parsedBody = undefined;
    }

    // Route by protocol era, from that single read (ADR-0016 §1). Routing
    // lives here rather than in httpServer.ts because this is where the body
    // is already read: classifying earlier would mean widening RequestHandler
    // to carry a parsed body, for no behavioural gain.
    const era = await classifyEra(req, parsedBody);

    // Counted at the point of classification: every request that reaches
    // here counts for the era it classified as, however it is subsequently
    // answered — the deferred version rung's 400 below included, since that
    // request classified legacy. A request short-circuited BEFORE this line
    // (the 413 over-cap path above, and anything runMiddleware rejected)
    // counts for neither era.
    //
    // The counter answers one question and only one: is anyone still
    // reaching this server on the legacy era. ADR-0016 §8 makes the
    // `legacy: 'reject'` trigger depend on that answer, so a request whose
    // era was never determined has no era to attribute, and inventing one
    // would corrupt exactly the signal that decision rests on. Counting a
    // rejected-but-classified request is correct for the same reason: the
    // client reached us on that era, and that is what the trigger measures.
    recordEra(era);
    scheduleEraFlush(config.plugin);

    if (era === "modern") {
      // The token id reaches the factory as pass-through AuthInfo, read back
      // as `ctx.authInfo?.clientId`. The bearer SECRET deliberately does not
      // travel with it: downstream of auth the identity is the token id and
      // never the string (ADR-0014 §2, ADR-0016 §4), so a future handler that
      // logged its own context cannot leak a credential. `token` is a
      // pass-through field the SDK never inspects, left empty for that
      // reason.
      (req as IncomingMessage & { auth?: AuthInfo }).auth = {
        token: "",
        clientId: tokenId,
        scopes: [],
      };
      // Pass the pre-parsed body: `readBodyWithCap` drained the stream, and
      // the entry classifies from the value rather than re-reading it.
      await modern(req, res, parsedBody);
      return;
    }

    // Everything below is the legacy branch, and this line is what keeps it
    // honest. After the `return` above, TypeScript narrows `era` to whatever
    // is left of the union — today exactly "legacy", so this compiles. Add a
    // third era and it narrows to `"legacy" | "third"`, this assignment stops
    // compiling, and whoever added it is forced to decide which transport
    // serves it. Without this line a new era would silently fall through and
    // be served by the 2025 transport. The SDK added one era in two releases,
    // so a third is a when, not an if.
    const eraIsLegacy: "legacy" = era;
    void eraIsLegacy;

    // The other half of the split protocol-version rung: a 2026-era header
    // the middleware deferred, on a request that turned out to be legacy,
    // has no downstream owner and is answered here (ADR-0016 §3).
    const deferred = applyDeferredVersionRung(req.headers, parsedBody);
    if (deferred !== null) {
      res.writeHead(deferred.status, { "content-type": "application/json" });
      res.end(JSON.stringify(deferred.body));
      return;
    }

    const server = buildMcpServer(tokenId);
    // Stateless mode (no sessionIdGenerator). Per-request transport — see
    // file header for the SDK constraint. JSON response by default; SSE
    // only for SSE_NOTIFICATION_TOOLS so their notification can be delivered.
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: !needsSseResponse,
    });

    try {
      await server.connect(transport);
      // Pass the pre-parsed body so the SDK does not re-read the drained
      // stream (readBodyWithCap already consumed it).
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      // Best-effort cleanup. If close() throws (e.g. transport
      // already closed by the SDK), log and swallow so the next
      // request still works.
      try {
        await transport.close();
      } catch (closeError) {
        logger.error("[mcp] transport.close failed", { error: closeError });
      }
      try {
        await server.close();
      } catch (closeError) {
        logger.error("[mcp] server.close failed", { error: closeError });
      }
    }
  };

  return {
    registry,
    promptRegistry,
    handleRequest,
    buildMcpServer,
    flushPendingCalls: async () => {
      // Both batches drain, independently. Chaining them with bare awaits
      // meant a rejected first flush skipped the second entirely, which is
      // the opposite of what this field's own contract promises above: one
      // entry point so every call site drains EVERYTHING this service
      // batches. Neither write is more important than the other, and the
      // transient failure they share a cause with — a contended
      // `SettingsStore.updateSlice` — is exactly when both need attempting.
      const results = await Promise.allSettled([
        toolLoadingManager.flushPendingCalls(config.plugin),
        flushEraCounters(config.plugin),
      ]);
      // Rethrow the first rejection so the caller still learns a flush
      // failed. `destroyMcpService` logs it; the batches restore themselves
      // for the next attempt either way.
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
    closeModernHandler: () => modernHandler.close(),
  };
}

/**
 * Service-level teardown. The legacy branch needs nothing here — every
 * request already cleans up after itself in its `finally` block. Two pieces
 * of service state do: the in-memory counter batches (tool calls and per-era
 * requests), flushed first so an unload does not drop them, and the
 * modern-era handler, whose in-flight exchanges and their per-request
 * instances are the SDK's to abort.
 */
export async function destroyMcpService(svc: McpService): Promise<void> {
  try {
    await svc.flushPendingCalls();
  } catch (error) {
    logger.warn("[mcp] flushing pending counters on teardown failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await svc.closeModernHandler();
  } catch (error) {
    logger.warn("[mcp] closing the modern-era handler on teardown failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
