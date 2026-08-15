import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mockApp, mockPlugin, resetMockVault } from "$/test-setup";
import {
  createMcpService,
  destroyMcpService,
  type McpService,
} from "./mcpServer";
import { staticTokenProvider } from "./tokenStore";
import type { RunningServer } from "./httpServer";

/**
 * TDD RED phase for OMC-008 Task 4 (`docs/architecture/ADR-0016-...md`,
 * `docs/superpowers/plans/2026-08-08-omc-008-adopt-mcp-spec-2026-07-28.md`).
 *
 * `mcpServer.ts`'s modern branch today only `logger.warn`s and falls through
 * to the legacy transport (Task 2's own acceptance criterion) — the strict
 * modern handler (`createMcpHandler(factory, { legacy: 'reject' })` wrapped by
 * `toNodeHandler`) is not wired yet. Every assertion below states the WIRED
 * behaviour Task 4 must produce, verified against the installed SDK
 * (`node_modules/@modelcontextprotocol/server@2.0.0`), not summarised from
 * the plan.
 *
 * Measured (not assumed) RED reason for every test below that carries an
 * `MCP-Protocol-Version: 2026-07-28` (or `2027-05-01`) header: the fallback's
 * `NodeStreamableHTTPServerTransport` runs its OWN header-vs-supported-list
 * check against the hand-built `McpServer`'s `_supportedProtocolVersions`
 * (the SDK's default legacy list, topping at `2025-11-25` —
 * `installModernOnlyHandlers` is never called on this instance because it is
 * only invoked inside `createMcpHandler`'s `serveModern`, not on the
 * fallback). That check fires before dispatch and answers
 * `{"error":{"code":-32000,"message":"Bad Request: Unsupported protocol
 * version: ..."}}` at HTTP 400 for EVERY request in this file that names a
 * 2026-era header — this is the exact `-32000` the task briefing already
 * named in `eraRouter.test.ts`'s own untouched RED ("still answers 400 with
 * the -32020 unsupported-version code"), reached here from request bodies
 * that carry a full `_meta` envelope instead of a claim-less one. It is not
 * the `-32602`/`-32022` ladder this file asserts, and not the `server/discover`
 * Method Not Found a bare read of the plan might suggest either — both are
 * still true statements about what the WIRED handler must answer, and both
 * are still unmet today, just via this one shared proximate cause rather
 * than two different ones. Once Task 4 routes a modern-classified request to
 * the real `createMcpHandler` handler instead of this fallback, none of
 * these requests reach `NodeStreamableHTTPServerTransport` at all — the
 * SDK's own body-classification ladder (`server/dist/src-CX2iR2pK.mjs:5101`)
 * owns the answer instead, which is what every assertion below states.
 *
 * Only ONE thing in this file is a true regression pin, already true with no
 * change: an `initialize` POST carries no `MCP-Protocol-Version` header here,
 * so it never reaches the check above and answers exactly as it does today
 * (R-01). Every other test, including both R-09 tests, is genuinely red
 * today for the shared reason above — the tools/list-set equivalence test is
 * NOT a coincidental pin here, because a modern-envelope `tools/list` in
 * this file always carries the header too. The R-09 describe block also
 * separately asserts the one thing only the real 2026-era encode seam
 * produces, once Task 4 does land and the header check above no longer
 * applies: `_meta['io.modelcontextprotocol/serverInfo']` stamped onto the
 * result (`rev2026Codec.encodeResult` calls `stampServerInfoMeta`;
 * `rev2025Codec.encodeResult` never does, `server/dist/src-CX2iR2pK.mjs:4115`
 * vs `:2390`) — that is the assertion that would catch a future regression
 * where the equivalence holds again by coincidence (e.g. a modern route that
 * silently re-delegates to the legacy encode path) rather than through the
 * real per-token `ToolScope` resolution shared by both eras (ADR-0016 §4).
 */

const TOKEN = "t".repeat(32);
const MODERN_HEADER = { "mcp-protocol-version": "2026-07-28" } as const;

/**
 * SEP-2243 makes `Mcp-Method` mandatory on every modern-era request; the
 * installed SDK's `validateStandardRequestHeaders` (run by `serveModern`
 * ahead of dispatch) rejects with -32020 when it is absent, naming the
 * value it read from the header as "(missing)" regardless of what the body
 * says. `Mcp-Name` is only required for `tools/call`, `prompts/get` and
 * `resources/read` (`MCP_NAME_HEADER_SOURCE`); none of those methods appear
 * in this file, so no request here needs it.
 *
 * The R-04 cases send a deliberately malformed or absent `_meta` envelope
 * and must keep failing for that reason alone, so they still build their
 * headers from the bare `MODERN_HEADER` above rather than this helper.
 */
function modernHeaders(method: string): Record<string, string> {
  return { ...MODERN_HEADER, "mcp-method": method };
}
const VALID_ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

beforeEach(() => resetMockVault());

const active: McpService[] = [];
const runningServers: RunningServer[] = [];
afterEach(async () => {
  for (const s of active.splice(0)) await destroyMcpService(s);
  for (const s of runningServers.splice(0)) {
    // Kill live sockets before waiting on close(). `startHttpServer` takes
    // the first free port in PORT_RANGE rather than a random one, so the next
    // server booted in this process — in this file or any other — is likely
    // to land on the same port, and `fetch`'s keep-alive pool will happily
    // hand it a socket still wired to THIS server. On Linux that surfaced as
    // unrelated suites receiving 406 from an MCP endpoint they never booted;
    // macOS never showed it. close() alone does not settle it: it stops new
    // connections and waits for existing ones, which is the opposite of what
    // a lingering pooled socket needs.
    //
    // Cast because the installed `@types/node` for this workspace does not
    // declare `closeAllConnections` (Node 18.2+, present in the runtime that
    // actually serves these tests). Optional-called rather than assumed, so a
    // runtime without it degrades to today's behaviour instead of throwing.
    (
      s.server as unknown as { closeAllConnections?: () => void }
    ).closeAllConnections?.();
    await new Promise<void>((r) => s.server.close(() => r()));
  }
});

/** Boot a service + HTTP server behind a single static token, the same
 * idiom `mcpServer.test.ts` and `eraRouter.test.ts` use. */
async function startService(): Promise<RunningServer> {
  const { startHttpServer } = await import("./httpServer");
  const svc = await createMcpService({
    app: mockApp(),
    plugin: mockPlugin(),
    pluginVersion: "0.4.0-alpha.1",
    serverName: "mcp-connector",
  });
  active.push(svc);
  const server = await startHttpServer({
    resolveTokens: staticTokenProvider(TOKEN),
    requestHandler: svc.handleRequest,
  });
  runningServers.push(server);
  return server;
}

async function postMcp(
  port: number,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
  /** Only the long-lived subscription streams pass one — see `openListen`. */
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Split an SSE response body into its `data:` JSON payloads, in arrival
 * order. Every server-sent frame this process can produce — the modern
 * `PerRequestHTTPServerTransport` (`@modelcontextprotocol/server`'s
 * `index.mjs`, `writeMessageFrame`) and the legacy
 * `NodeStreamableHTTPServerTransport` it wraps — writes the same
 * `event: message\ndata: <json>\n\n` shape, so one parser covers both
 * eras without pulling in an SSE client for a stream this server writes
 * itself. Reads the whole body rather than incrementally, which is fine
 * here: every exchange below closes its stream after the terminal result,
 * so there is nothing left open to await.
 */
async function readSseFrames(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data:"));
      if (dataLine === undefined) {
        throw new Error(`SSE frame carried no data line: ${frame}`);
      }
      return JSON.parse(dataLine.slice("data:".length).trim());
    });
}

describe("modern path — server/discover (R-02, R-03)", () => {
  test("a valid envelope reaches server/discover: supportedVersions, capabilities including tools and prompts, and this server's identity under _meta", async () => {
    const server = await startService();
    const res = await postMcp(
      server.port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: VALID_ENVELOPE },
      },
      modernHeaders("server/discover"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result?.supportedVersions).toEqual(["2026-07-28"]);
    // `prompts.listChanged` is `true` here because this era CAN deliver
    // the notification and does: the prompts feature compares the
    // discovered list after a vault event and calls
    // `notifyPromptsChanged()`, which publishes onto every open
    // `subscriptions/listen` stream (ADR-0017).
    //
    // The value is now deliberate rather than inherited. It used to be the
    // SDK's doing — `setPromptRequestHandlers()` rewrites a declared
    // `prompts` capability to `{ listChanged: … ?? true }`
    // (mcp-DXXb3Vv3.mjs:1550), so the old bare `prompts: {}` advertised a
    // capability nothing honoured, on both eras. `mcpServer.ts` now passes
    // the bit explicitly, and the legacy half is pinned to the opposite
    // value in `eraRouter.test.ts` — that pair is the whole decision.
    // `resources` and `extensions` are the ADR-0018 addition, and unlike
    // `prompts.listChanged` they do NOT differ by era: the `ui://` set is
    // static on both, so `resources.listChanged` stays `false` here too,
    // and `extensions` is what tells a host this server's resource is an
    // application view rather than plain content. This assertion is the
    // modern half of a pair — the legacy half is `eraRouter.test.ts`'s
    // full-body `initialize` pin — and together they are the proof that
    // one declaration in `buildMcpServer` reaches both eras (ADR-0018 D1,
    // D2).
    expect(body.result?.capabilities).toEqual({
      tools: { listChanged: true },
      prompts: { listChanged: true },
      resources: { subscribe: false, listChanged: false },
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    });
    expect(body.result?._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "mcp-connector",
      version: "0.4.0-alpha.1",
    });
  });

  test("every capability server/discover advertises is honoured: tools/list and prompts/list both answer over the modern path", async () => {
    const server = await startService();

    const toolsRes = await postMcp(
      server.port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: VALID_ENVELOPE },
      },
      modernHeaders("tools/list"),
    );
    expect(toolsRes.status).toBe(200);
    const toolsBody = await toolsRes.json();
    expect(toolsBody.error).toBeUndefined();
    expect(Array.isArray(toolsBody.result?.tools)).toBe(true);

    const promptsRes = await postMcp(
      server.port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "prompts/list",
        params: { _meta: VALID_ENVELOPE },
      },
      modernHeaders("prompts/list"),
    );
    expect(promptsRes.status).toBe(200);
    const promptsBody = await promptsRes.json();
    expect(promptsBody.error).toBeUndefined();
    expect(Array.isArray(promptsBody.result?.prompts)).toBe(true);
  });
});

/**
 * ADR-0018 (OMC-016). The `resources` capability declared above must be
 * backed by a real `resources/list` and `resources/read` on the modern
 * path too — D1/D2 name `buildMcpServer` as the single declaration site,
 * and this is the modern half of the proof; `mcpAppResources.test.ts`
 * covers the same two methods over the legacy transport.
 *
 * A hand-written `resources/read` needs BOTH `Mcp-Method` and `Mcp-Name`
 * mirroring `params.uri` (CLAUDE.md gotcha, verified at
 * `src-CX2iR2pK.mjs:4990`, `:5041` per ADR-0018) — omitting either is
 * rejected before the handler runs and would read as a handler bug
 * rather than the header it actually is.
 */
describe("modern path — resources/list and resources/read serve the ui:// application resource (R-02, R-03)", () => {
  const RESOURCE_URI = "ui://mcp-connector/search-results";
  const MIME_TYPE = "text/html;profile=mcp-app";

  test("resources/list carries the search-results entry at exactly text/html;profile=mcp-app", async () => {
    const server = await startService();
    const res = await postMcp(
      server.port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/list",
        params: { _meta: VALID_ENVELOPE },
      },
      modernHeaders("resources/list"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    const resources = (body.result?.resources ?? []) as Array<{
      uri: string;
      mimeType?: string;
    }>;
    const entry = resources.find((r) => r.uri === RESOURCE_URI);
    expect(entry).toBeDefined();
    expect(entry?.mimeType).toBe(MIME_TYPE);
  });

  test("resources/read on the declared URI returns the generated HTML at exactly text/html;profile=mcp-app", async () => {
    const server = await startService();
    // Imported inside the test (not at module top level) so a module that
    // does not exist yet fails only this assertion, not every test in the
    // file — the placeholder ships in Task 1 step 3, this test does not
    // depend on its content beyond byte-equality with what the feature
    // actually serves.
    const { SEARCH_RESULTS_APP_HTML } =
      await import("$/features/mcp-apps/assets/searchResultsAppSource");
    const res = await postMcp(
      server.port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "resources/read",
        params: { uri: RESOURCE_URI, _meta: VALID_ENVELOPE },
      },
      { ...modernHeaders("resources/read"), "mcp-name": RESOURCE_URI },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    const content = body.result?.contents?.[0];
    expect(content?.uri).toBe(RESOURCE_URI);
    expect(content?.mimeType).toBe(MIME_TYPE);
    expect(content?.text).toBe(SEARCH_RESULTS_APP_HTML);
  });

  test("resources/templates/list answers an empty template list — SDK-owned once `resources` is declared, not registered by this project", async () => {
    const server = await startService();
    const res = await postMcp(
      server.port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/templates/list",
        params: { _meta: VALID_ENVELOPE },
      },
      modernHeaders("resources/templates/list"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result).toEqual({ resourceTemplates: [] });
  });
});

describe("modern path — a missing or incomplete _meta envelope is rejected (R-04)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["_meta absent entirely", {}],
    [
      "_meta present but missing protocolVersion",
      {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    ],
    [
      "_meta present but missing clientCapabilities",
      {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
      },
    ],
  ];

  for (const [label, params] of cases) {
    test(`${label} ⇒ -32602 and HTTP 400`, async () => {
      const server = await startService();
      const res = await postMcp(
        server.port,
        TOKEN,
        { jsonrpc: "2.0", id: 1, method: "tools/list", params },
        MODERN_HEADER,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error?.code).toBe(-32602);
    });
  }
});

describe("modern path — _meta without clientInfo is served normally; clientInfo is never required (R-05)", () => {
  test("a valid envelope missing clientInfo still answers tools/list", async () => {
    const server = await startService();
    const res = await postMcp(
      server.port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: VALID_ENVELOPE },
      },
      modernHeaders("tools/list"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.result?.tools)).toBe(true);
  });
});

describe("modern path — an unsupported 2026-era revision answers the SDK's own error (R-06, modern-branch verification)", () => {
  test("MCP-Protocol-Version: 2027-05-01 with a valid, matching envelope ⇒ unsupported-version error naming this server's supported versions", async () => {
    const server = await startService();
    const res = await postMcp(
      server.port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2027-05-01",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      { "mcp-protocol-version": "2027-05-01", "mcp-method": "tools/list" },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.data?.supported ?? []).toContain("2026-07-28");
    expect(body.error?.data?.requested).toBe("2027-05-01");
  });
});

describe("the legacy handshake is untouched by the modern path (R-01)", () => {
  test("an initialize POST still reaches the legacy path and answers 2025-11-25", async () => {
    const server = await startService();
    const res = await postMcp(server.port, TOKEN, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result?.protocolVersion).toBe("2025-11-25");
  });
});

describe("modern path — per-token tool surfaces match the legacy path (R-09)", () => {
  const TOKEN_ALL = {
    id: "tok-all",
    label: "All",
    token: "a".repeat(32),
    createdAt: 1,
  };
  const TOKEN_CORE = {
    id: "tok-core",
    label: "Core",
    token: "c".repeat(32),
    createdAt: 2,
  };

  function makeScopedPlugin() {
    let store: Record<string, unknown> = {
      mcpTransport: {
        bearerToken: TOKEN_ALL.token,
        tokens: [TOKEN_ALL, TOKEN_CORE],
      },
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: {
          [TOKEN_ALL.id]: { profile: "all", promoted: [], allowed: null },
          [TOKEN_CORE.id]: { profile: "core", promoted: [], allowed: null },
        },
      },
    };
    return mockPlugin({
      loadData: async () => ({ ...store }),
      saveData: async (d: unknown) => {
        store = { ...(d as Record<string, unknown>) };
      },
    });
  }

  async function bootScopedServer(): Promise<RunningServer> {
    const { startHttpServer } = await import("./httpServer");
    const plugin = makeScopedPlugin();
    const svc = await createMcpService({
      app: mockApp(),
      plugin,
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);
    const server = await startHttpServer({
      resolveTokens: async () => [TOKEN_ALL, TOKEN_CORE],
      requestHandler: svc.handleRequest,
    });
    runningServers.push(server);
    return server;
  }

  test("token A's tools/list set is identical across both eras, and token core's is narrower", async () => {
    const server = await bootScopedServer();

    const namesOf = async (
      token: string,
      params: Record<string, unknown>,
      headers: Record<string, string> = {},
    ): Promise<string[]> => {
      const res = await postMcp(
        server.port,
        token,
        { jsonrpc: "2.0", id: 1, method: "tools/list", params },
        headers,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      return ((body?.result?.tools ?? []) as Array<{ name: string }>).map(
        (t) => t.name,
      );
    };

    const legacyA = await namesOf(TOKEN_ALL.token, {});
    const modernA = await namesOf(
      TOKEN_ALL.token,
      { _meta: VALID_ENVELOPE },
      modernHeaders("tools/list"),
    );
    const modernCore = await namesOf(
      TOKEN_CORE.token,
      { _meta: VALID_ENVELOPE },
      modernHeaders("tools/list"),
    );

    expect([...modernA].sort()).toEqual([...legacyA].sort());
    expect(modernCore).not.toEqual(modernA);
    expect(modernCore).toContain("get_active_file");
    expect(modernCore).not.toContain("find_broken_links");
  });

  test("the modern-path tools/list result carries this server's identity in _meta, proving it went through the real 2026 encode seam and not the legacy fallback", async () => {
    const server = await bootScopedServer();
    const res = await postMcp(
      server.port,
      TOKEN_ALL.token,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: VALID_ENVELOPE },
      },
      modernHeaders("tools/list"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result?._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "mcp-connector",
      version: "0.4.0-alpha.1",
    });
  });
});

describe("activate_tool's notifications/tools/list_changed rides the calling request's own stream on both eras (R-10)", () => {
  // A token scoped to the "core" profile, the same shape as R-09's
  // TOKEN_CORE, so `find_broken_links` starts inactive for it and
  // activating it is a real state change — not the "already active"
  // early return, which never calls sendNotification.
  const CORE_TOKEN = {
    id: "tok-core-r10",
    label: "Core",
    token: "d".repeat(32),
    createdAt: 3,
  };

  function makeCoreScopedPlugin() {
    let store: Record<string, unknown> = {
      mcpTransport: {
        bearerToken: CORE_TOKEN.token,
        tokens: [CORE_TOKEN],
      },
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: {},
        profiles: {
          [CORE_TOKEN.id]: { profile: "core", promoted: [], allowed: null },
        },
      },
    };
    return mockPlugin({
      loadData: async () => ({ ...store }),
      saveData: async (d: unknown) => {
        store = { ...(d as Record<string, unknown>) };
      },
    });
  }

  async function bootCoreServer(): Promise<RunningServer> {
    const { startHttpServer } = await import("./httpServer");
    const plugin = makeCoreScopedPlugin();
    const svc = await createMcpService({
      app: mockApp(),
      plugin,
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);
    const server = await startHttpServer({
      resolveTokens: async () => [CORE_TOKEN],
      requestHandler: svc.handleRequest,
    });
    runningServers.push(server);
    return server;
  }

  test("modern path: the response upgrades to text/event-stream and the notification frame precedes the terminal result", async () => {
    const server = await bootCoreServer();
    const res = await postMcp(
      server.port,
      CORE_TOKEN.token,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "activate_tool",
          arguments: { name: "find_broken_links" },
          _meta: VALID_ENVELOPE,
        },
      },
      { ...modernHeaders("tools/call"), "mcp-name": "activate_tool" },
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = (await readSseFrames(res)) as Array<{
      method?: string;
      id?: number;
      result?: { _meta?: Record<string, unknown> };
    }>;
    const notificationIndex = frames.findIndex(
      (f) => f.method === "notifications/tools/list_changed",
    );
    const resultIndex = frames.findIndex(
      (f) => f.id === 7 && f.result !== undefined,
    );
    expect(notificationIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(notificationIndex);
    // Rules out the reading where this "upgraded to SSE" is actually the
    // LEGACY transport's own SSE path (bodyTargetsSseNotificationTool
    // also flags activate_tool) misclassified as modern: only the 2026
    // encode seam stamps serverInfo onto a result's _meta (R-09's own
    // discriminator, reused here for tools/call).
    expect(
      frames[resultIndex]?.result?._meta?.[
        "io.modelcontextprotocol/serverInfo"
      ],
    ).toEqual({ name: "mcp-connector", version: "0.4.0-alpha.1" });
  });

  test("legacy path (regression pin): the same activation still answers over SSE with the notification ahead of the result", async () => {
    const server = await bootCoreServer();
    const res = await postMcp(server.port, CORE_TOKEN.token, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "activate_tool",
        arguments: { name: "find_broken_links" },
      },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = (await readSseFrames(res)) as Array<{
      method?: string;
      id?: number;
      result?: { _meta?: Record<string, unknown> };
    }>;
    const notificationIndex = frames.findIndex(
      (f) => f.method === "notifications/tools/list_changed",
    );
    const resultIndex = frames.findIndex(
      (f) => f.id === 8 && f.result !== undefined,
    );
    expect(notificationIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(notificationIndex);
    // The mirror image of the modern test's discriminator above: the
    // handshake-era codec never stamps serverInfo onto a result, so its
    // absence here confirms this pin is genuinely exercising the legacy
    // encode path rather than coincidentally matching the modern one.
    expect(
      frames[resultIndex]?.result?._meta?.[
        "io.modelcontextprotocol/serverInfo"
      ],
    ).toBeUndefined();
  });
});

describe("search_vault_smart's notifications/progress rides the modern path's own stream while the index builds (R-11)", () => {
  // Mirrors searchVaultSmart.test.ts's own `buildingPlugin()` fixture
  // (#344): `nativeIndexBuildInProgress: true` is the sole gate the
  // handler checks before it computes a progress percentage and pushes
  // it, independent of provider.isReady().
  function buildingSemanticPlugin() {
    return mockPlugin({
      semanticSearchState: {
        provider: { isReady: () => true, search: async () => [] },
        settings: { provider: "native", indexingMode: "live" },
        startIndexerIfNeeded: () => {},
        nativeIndexBuildInProgress: true,
        nativeIndexBuildStartedAt: Date.now() - 1_000,
      },
    } as never);
  }

  async function bootBuildingServer(): Promise<RunningServer> {
    const { startHttpServer } = await import("./httpServer");
    const plugin = buildingSemanticPlugin();
    const svc = await createMcpService({
      app: mockApp(),
      plugin,
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider(TOKEN),
      requestHandler: svc.handleRequest,
    });
    runningServers.push(server);
    return server;
  }

  test("at least one notifications/progress frame carrying the caller's progressToken arrives before the terminal (error) result", async () => {
    const server = await bootBuildingServer();
    const res = await postMcp(
      server.port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "search_vault_smart",
          arguments: { query: "test" },
          _meta: { ...VALID_ENVELOPE, progressToken: "tok-r11" },
        },
      },
      { ...modernHeaders("tools/call"), "mcp-name": "search_vault_smart" },
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = (await readSseFrames(res)) as Array<{
      method?: string;
      id?: number;
      result?: { _meta?: Record<string, unknown> };
      params?: { progressToken?: string };
    }>;
    const progressFrames = frames.filter(
      (f) => f.method === "notifications/progress",
    );
    const resultIndex = frames.findIndex(
      (f) => f.id === 9 && f.result !== undefined,
    );
    expect(progressFrames.length).toBeGreaterThanOrEqual(1);
    expect(progressFrames[0]?.params?.progressToken).toBe("tok-r11");
    const firstProgressIndex = frames.indexOf(progressFrames[0]!);
    expect(resultIndex).toBeGreaterThan(firstProgressIndex);
    // Same discriminator as R-10: only the modern encode seam stamps
    // serverInfo onto a result, so its presence here proves this ran
    // through the real 2026 codec rather than the legacy SSE path
    // (search_vault_smart is also in SSE_NOTIFICATION_TOOLS, so a
    // routing bug here would silently "pass" over legacy transport too).
    expect(
      frames[resultIndex]?.result?._meta?.[
        "io.modelcontextprotocol/serverInfo"
      ],
    ).toEqual({ name: "mcp-connector", version: "0.4.0-alpha.1" });
  });
});

/**
 * OMC-007 / issue #419: a vault-wide auto-promotion reaches a client that
 * made no request of its own.
 *
 * This is the half nothing else covers. `toolLoadingManager.test.ts` proves
 * the manager decides to signal at the right moments; this proves the signal
 * survives the whole path — `notify.toolsChanged()` → the SDK's bus → the
 * listen router's per-stream filter → an SSE frame on a POST response that
 * was opened by an EARLIER request and is still hanging.
 *
 * The stream is genuinely long-lived, so `readSseFrames` above cannot be
 * reused: it reads to completion and would hang here forever. `collectFrames`
 * reads incrementally and gives up on a deadline instead.
 */
describe("modern path — tools/list_changed fans out to an open subscriptions/listen stream (OMC-007)", () => {
  /**
   * Read SSE frames off a still-open response until `count` have arrived or
   * the deadline passes. Keep-alive frames (`: keepalive`) carry no `data:`
   * line and are skipped rather than counted.
   */
  async function collectFrames(
    res: Response,
    count: number,
    timeoutMs = 5_000,
  ): Promise<Array<Record<string, unknown>>> {
    const body = res.body;
    if (body === null) throw new Error("response carried no body to read");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const frames: Array<Record<string, unknown>> = [];
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out after ${timeoutMs}ms with ${frames.length}/${count} frame(s)`,
            ),
          ),
        timeoutMs,
      );
    });
    const loop = (async () => {
      while (frames.length < count) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const dataLine = raw
            .split("\n")
            .find((line) => line.startsWith("data:"));
          if (dataLine !== undefined) {
            frames.push(JSON.parse(dataLine.slice("data:".length).trim()));
          }
          end = buffer.indexOf("\n\n");
        }
      }
      return frames;
    })();
    try {
      return await Promise.race([loop, timeout]);
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => undefined);
    }
  }

  /**
   * A single-token vault on the adaptive profile, one call short of promoting
   * a CORE tool.
   *
   * Core rather than a random name on purpose: in `adaptive` a non-core tool
   * is inactive, and `mcpServer.ts` skips `recordCall` for an inactive tool
   * (ADR-0011), so it could never reach the threshold by being called. A core
   * tool executes, counts, and is still absent from `promoted` — so crossing
   * the threshold genuinely widens the list, which is what the fan-out is
   * gated on.
   */
  async function bootAdaptiveService(): Promise<{
    server: RunningServer;
    svc: McpService;
  }> {
    const { startHttpServer } = await import("./httpServer");
    let store: Record<string, unknown> = {
      toolLoading: {
        profile: "adaptive",
        promoted: [],
        counters: { get_server_info: 2 },
        profiles: {},
      },
    };
    const plugin = mockPlugin({
      loadData: async () => ({ ...store }),
      saveData: async (d: unknown) => {
        store = { ...(d as Record<string, unknown>) };
      },
    });
    const svc = await createMcpService({
      app: mockApp(),
      plugin,
      pluginVersion: "0.4.0-alpha.1",
      serverName: "mcp-connector",
    });
    active.push(svc);
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider(TOKEN),
      requestHandler: svc.handleRequest,
    });
    runningServers.push(server);
    return { server, svc };
  }

  /**
   * Open a `subscriptions/listen` stream and assert it was accepted.
   *
   * Carries its own `AbortController` because this is the only request in the
   * file that stays open: aborting it tears the socket down on the client
   * side deterministically, where cancelling the body reader alone leaves it
   * for the keep-alive pool to reuse against whatever binds the port next.
   */
  const listenAborts: AbortController[] = [];
  async function openListen(
    port: number,
    id: number,
    notifications: Record<string, unknown>,
  ): Promise<Response> {
    const controller = new AbortController();
    listenAborts.push(controller);
    const res = await postMcp(
      port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id,
        method: "subscriptions/listen",
        params: { _meta: VALID_ENVELOPE, notifications },
      },
      modernHeaders("subscriptions/listen"),
      controller.signal,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    return res;
  }

  /**
   * Both subscribers live on ONE service, on purpose, and not only for speed.
   *
   * Two of them side by side is the stronger claim: the same published event
   * has to reach the stream that opted in and miss the one that did not, in
   * the same instant, on the same bus. Two separate tests could each pass
   * against a fan-out that ignored the filter and simply notified nobody, or
   * everybody, depending on which one you read.
   *
   * It also avoids a real hazard. `startHttpServer` takes the first free port
   * in `PORT_RANGE`, not a random one, so two servers booted in sequence get
   * the SAME port — and `fetch`'s keep-alive pool then hands the second test a
   * socket still attached to the first test's (already closed) handler. That
   * produced an intermittent 500, "This MCP handler has been closed", roughly
   * one run in six. One service, one port, no reuse.
   */
  test("the promotion reaches the stream that opted in, and only that one", async () => {
    const { server, svc } = await bootAdaptiveService();

    // Open both subscriptions BEFORE anything changes: a compliant server
    // only notifies streams that were already open at the time of the change.
    const subscribed = await openListen(server.port, 100, {
      toolsListChanged: true,
    });
    const bystander = await openListen(server.port, 200, {
      resourcesListChanged: true,
    });

    const subscribedFrames = collectFrames(subscribed, 2);
    // Asking the bystander for two frames when only its ack can legitimately
    // arrive makes the timeout the assertion: it rejects on time if the
    // filter holds, and resolves — failing the test — the moment a second
    // frame shows up. Reading "whatever is there" would pass either way.
    const bystanderFrames = collectFrames(bystander, 2, 2_000);

    // One call crosses the threshold: `get_server_info` is seeded at 2 and
    // PROMOTION_THRESHOLD is 3.
    const call = await postMcp(
      server.port,
      TOKEN,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          _meta: VALID_ENVELOPE,
          name: "get_server_info",
          arguments: {},
        },
      },
      { ...modernHeaders("tools/call"), "mcp-name": "get_server_info" },
    );
    expect(call.status).toBe(200);
    // Drain the response so the socket is not left half-read behind us.
    await call.text();

    // Counter writes are debounced by 2s in production; draining keeps this
    // test off the clock. The flush is what applies the promotion and, with
    // it, publishes onto the bus.
    await svc.flushPendingCalls();

    const frames = await subscribedFrames;
    // The ack is mandated to be the stream's first message.
    expect(frames[0]?.method).toBe("notifications/subscriptions/acknowledged");
    const changed = frames.find(
      (f) => f.method === "notifications/tools/list_changed",
    );
    expect(changed).toBeDefined();
    // Every frame carries the id of the request that opened its stream, so a
    // client multiplexing subscriptions can tell them apart.
    expect(
      (changed?.params as Record<string, unknown> | undefined)?._meta,
    ).toMatchObject({
      "io.modelcontextprotocol/subscriptionId": 100,
    });

    await expect(bystanderFrames).rejects.toThrow(/timed out/);

    // Both subscriptions are long-lived by construction, so nothing else in
    // this process closes them. Leaving them to the shared afterEach was
    // enough on macOS and not on Linux.
    for (const c of listenAborts.splice(0)) c.abort();
  });
});
