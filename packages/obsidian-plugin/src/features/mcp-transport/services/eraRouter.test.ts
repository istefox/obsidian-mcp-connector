import { describe, expect, test, afterEach, beforeEach, spyOn } from "bun:test";
import { mockApp, mockPlugin, resetMockVault } from "$/test-setup";
import {
  createMcpService,
  destroyMcpService,
  type McpService,
} from "./mcpServer";
import { staticTokenProvider } from "./tokenStore";
import * as parseRequestBody from "./parseRequestBody";

/**
 * Era classification for OMC-008 (`docs/architecture/ADR-0016-...md`).
 *
 * This file drives the real `startHttpServer` + `createMcpService` surface
 * (the same idiom `mcpServer.test.ts` uses) rather than importing
 * `eraRouter.ts` directly, so a failure here is an assertion mismatch about
 * observable behaviour rather than a statement about internal structure.
 *
 * Most of the assertions below are REGRESSION PINS: they describe behaviour
 * that was already true before the classifier existed and MUST stay true now
 * that `mcpServer.ts` calls `classifyEra` / `applyDeferredVersionRung` on
 * every request. Each test says which kind it is.
 *
 * These docstrings were written during the TDD red phase and described a
 * half-built system; they are kept current deliberately. A comment that
 * narrates a phase the code has left is worse than no comment, because it
 * sends the next reader looking for a code path that no longer exists.
 */

const TOKEN = "t".repeat(32);

beforeEach(() => resetMockVault());

const active: McpService[] = [];
afterEach(async () => {
  for (const s of active.splice(0)) await destroyMcpService(s);
});

describe("eraRouter (Task 2) — the legacy path stays byte-identical (R-01)", () => {
  test("a claim-less initialize POST is answered with exactly today's bytes — full-body pin, must survive the classifier being wired in", async () => {
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

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.0" },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Full-body equality, not a subset check: a request carrying no
      // `params._meta` envelope claim must classify legacy and answer
      // with exactly these bytes, both before eraRouter exists and after
      // it is wired into mcpServer.ts.
      //
      // `prompts.listChanged` READ `true` HERE UNTIL 2.0, and this is the
      // record of what moved it. OMC-008's Invariant 1 forbade touching
      // these bytes, so the unhonoured claim survived that work on purpose
      // (OMC-023). ADR-0017 is the decision that retired it: this era has
      // no server-initiated stream, so a vault event has no way to reach a
      // client, so advertising the capability was a promise the transport
      // could not keep. The modern era declares `true` and honours it —
      // see the `server/discover` assertion in modernEra.test.ts, which is
      // deliberately the opposite value and pins the other half.
      expect(body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {
            tools: { listChanged: true },
            prompts: { listChanged: false },
          },
          serverInfo: { name: "mcp-connector", version: "0.4.0-alpha.1" },
        },
      });
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });
});

describe("eraRouter — a modern-envelope request is classified separately from a claim-less one", () => {
  test("params._meta carrying the 2026 envelope is served by the modern handler; a claim-less request is served by the legacy transport", async () => {
    // The discriminator is the `serverInfo` stamp, not a log line. Only the
    // 2026 encode seam writes `_meta['io.modelcontextprotocol/serverInfo']`
    // onto a result, so its presence proves which era served the request —
    // the same signal modernEra.test.ts uses.
    //
    // An earlier version of this test spied on `logger.warn` instead, back
    // when a modern-classified request fell through to the legacy transport
    // after warning. That fall-through is gone: the strict handler is wired
    // now. The spy kept passing anyway, because a modern request missing its
    // `Mcp-Method` header makes the SDK's own `onerror` warn — same signal,
    // different cause. A test that passes for a reason other than the one it
    // names can keep passing while the thing it names breaks.
    //
    // Deliberately no MCP-Protocol-Version header here: the point under
    // test is the classifier alone, decoupled from the header rung
    // (covered separately in middleware.test.ts). `Mcp-Method` is not the
    // header rung — SEP-2243 makes it mandatory on every 2026-era request,
    // so the modern leg carries it to be well-formed at all.
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

    try {
      const legacyRes = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(legacyRes.status).toBe(200);
      const legacyBody = await legacyRes.json();
      expect(
        legacyBody.result?._meta?.["io.modelcontextprotocol/serverInfo"],
      ).toBeUndefined();

      const modernRes = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      expect(modernRes.status).toBe(200);
      const modernBody = await modernRes.json();
      expect(
        modernBody.result?._meta?.["io.modelcontextprotocol/serverInfo"],
      ).toEqual({ name: "mcp-connector", version: "0.4.0-alpha.1" });
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });
});

describe("eraRouter — an unparseable body is classified legacy without constructing a Request", () => {
  test("malformed JSON still answers the SDK's own -32700 Parse error, no crash surfaces", async () => {
    // Regression pin: reproduces the SDK's existing parse-error behaviour
    // (no MCP-Protocol-Version header, so this reaches mcpServer.ts's
    // handleRequest rather than httpServer.ts's OMC-018 -32020 shortcut).
    // classifyEra's documented job (plan Task 2 sub-step 2) is to
    // short-circuit to "legacy" on an unparseable body WITHOUT calling
    // toWebRequest/isLegacyRequest — this pins the answer that guarantee
    // must keep producing.
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

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: "{not valid json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid JSON" },
        id: null,
      });
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });

  test("a chunked over-cap body still answers 413 and destroys the socket (existing behaviour, mcpServer.test.ts:92)", async () => {
    // Duplicated here deliberately (plan Task 2 sub-step 1 names this
    // exact existing test): the 413 short-circuit in mcpServer.ts must
    // fire BEFORE classifyEra ever sees the body, and this file is where a
    // future change to that ordering would be caught.
    const { startHttpServer } = await import("./httpServer");
    const { request } = await import("node:http");
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

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: server.port,
            path: "/mcp",
            method: "POST",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "transfer-encoding": "chunked",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        let settled = false;
        req.on("response", () => {
          settled = true;
        });
        req.on("error", (err) => {
          if (!settled) reject(err);
        });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        for (let sent = 0; sent <= 1_048_576; sent += chunk.length) {
          req.write(chunk);
        }
        req.end();
      });
      expect(status).toBe(413);
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });
});

describe("eraRouter — the deferred version rung still fires on the legacy branch (R-01, OMC-018 regression guard)", () => {
  test("still answers 400 with the -32020 unsupported-version code (body owned by the SDK ladder)", async () => {
    // A claim-less initialize with a modern MCP-Protocol-Version header does
    // NOT classify legacy. classifyRequestBody routes it to the
    // "initialize-with-modern-header" cross-check, a rejection, so this
    // never reaches applyDeferredVersionRung and the body it answers with is
    // not buildProtocolVersionErrorBody's. What the design still guarantees
    // is the pair the `unsupported-version-400` conformance check cares
    // about: HTTP 400 and error code -32020. The message text, `data`
    // payload and echoed id belong to the SDK's own ladder, not to this
    // code, so they are deliberately left unasserted here. Task 4 wires the
    // strict modern handler and is where `data.supported`, `data.requested`
    // and `data.mismatch` get their own assertions.
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

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2027-05-01",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "initialize",
          params: {},
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error.code).toBe(-32020);
    } finally {
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });
});

describe("eraRouter — the request body is read exactly once per request (R-08)", () => {
  test("readBodyWithCap is called exactly once for a normal request", async () => {
    // Regression guard for the SDK fact ADR-0016 §1 records: isLegacyRequest
    // requires the already-read parsedBody to be passed through explicitly,
    // because its internal clone throws on a stream already drained. This
    // pins today's single-read behaviour so a future classifyEra wiring
    // that forgets to pass parsedBody (and re-reads the stream) is caught
    // here instead of surfacing as a hang or a parse error in production.
    const spy = spyOn(parseRequestBody, "readBodyWithCap");
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

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });
});

/**
 * OMC-024. The per-token split is decided in eraCounters.ts and covered
 * there; what only a wired request can prove is that `mcpServer.handleRequest`
 * hands its `tokenId` to `record`. A unit test cannot see that argument go
 * missing — the counters would still add up, against the vault, with every
 * bucket empty.
 */
describe("eraRouter — each era is attributed to the token that authenticated it (OMC-024)", () => {
  const TOK_LEGACY = {
    id: "tok_legacy",
    label: "Legacy client",
    token: "l".repeat(32),
    createdAt: 1,
  };
  const TOK_MODERN = {
    id: "tok_modern",
    label: "Modern client",
    token: "m".repeat(32),
    createdAt: 2,
  };

  test("a claim-less request on one token and a 2026-envelope request on another land in different buckets", async () => {
    const { startHttpServer } = await import("./httpServer");
    let store: Record<string, unknown> = {
      mcpTransport: { tokens: [TOK_LEGACY, TOK_MODERN] },
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
      resolveTokens: async () => [TOK_LEGACY, TOK_MODERN],
      requestHandler: svc.handleRequest,
    });

    const post = async (token: string, body: unknown, extra = {}) => {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...extra,
        },
        body: JSON.stringify(body),
      });
      // Drain: an unread body leaves the socket to the keep-alive pool, and
      // startHttpServer takes the first free port in PORT_RANGE rather than a
      // random one, so the next server booted in this process inherits it.
      await res.text();
      return res;
    };

    try {
      await post(TOK_LEGACY.token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      await post(
        TOK_MODERN.token,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
        { "mcp-method": "tools/list" },
      );

      await svc.flushPendingCalls();

      const slice = store.mcpTransport as Record<string, unknown>;
      expect(slice.eraCountersByToken).toEqual({
        tok_legacy: { legacy: 1, modern: 0 },
        tok_modern: { legacy: 0, modern: 1 },
      });
      // The vault total still counts both, unchanged in meaning: it is what
      // ADR-0016 §8's trigger reads.
      expect(slice.eraCounters).toEqual({ legacy: 1, modern: 1 });
    } finally {
      (
        server.server as unknown as { closeAllConnections?: () => void }
      ).closeAllConnections?.();
      await new Promise<void>((r) => server.server.close(() => r()));
    }
  });
});
