import { describe, expect, test, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  startHttpServer,
  stopHttpServer,
  type RunningServer,
} from "./httpServer";
import { staticTokenProvider } from "./tokenStore";
import { MAX_REQUEST_BODY_BYTES } from "../constants";

const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await stopHttpServer(s);
});

// Bind to port 0 to let the OS assign a free ephemeral port, then
// release it immediately so it can be reused as a fixed `ports`
// override below. Small TOCTOU window, acceptable for a unit test
// (same approach as port.test.ts's occupyFreePort).
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe("startHttpServer", () => {
  test("binds to a port in range and exposes it", async () => {
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("test-token-12345678901234567890abcd"),
      requestHandler: async (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      },
    });
    running.push(server);
    expect(server.port).toBeGreaterThanOrEqual(27200);
    expect(server.port).toBeLessThanOrEqual(27205);
  });

  test("honors a custom ports override instead of PORT_RANGE (#337)", async () => {
    const port = await freePort();
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("test-token-12345678901234567890abcd"),
      requestHandler: async (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      },
      ports: [port],
    });
    running.push(server);
    expect(server.port).toBe(port);
  });

  test("rejects POST /mcp without auth (401)", async () => {
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("test-token-12345678901234567890abcd"),
      requestHandler: async (_req, res) => {
        res.writeHead(200);
        res.end("should-not-reach");
      },
    });
    running.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("rejects /other with 404", async () => {
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: async (_req, res) => {
        res.end();
      },
    });
    running.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(res.status).toBe(404);
  });

  test("rejects PUT /mcp with 405", async () => {
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: async (_req, res) => {
        res.end();
      },
    });
    running.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "PUT",
    });
    expect(res.status).toBe(405);
  });

  test("hands off authed request to the handler", async () => {
    let handlerCalled = false;
    const token = "t".repeat(32);
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider(token),
      requestHandler: async (_req, res) => {
        handlerCalled = true;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      },
    });
    running.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(handlerCalled).toBe(true);
  });

  test("returns 500 when the request handler throws", async () => {
    const token = "t".repeat(32);
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider(token),
      requestHandler: async () => {
        throw new Error("synthetic handler failure");
      },
    });
    running.push(server);

    // Silence the expected console.error from the handler-error path.
    // Without this the test output becomes noisy.
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(500);
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe("MCP-Protocol-Version 400 carries a JSON-RPC body (SEP-2575 server-stateless, OMC-018)", () => {
  const token = "t".repeat(32);

  test("an unsupported version answers 400 with a -32020 JSON-RPC error, echoing the request id", async () => {
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider(token),
      requestHandler: async () => {
        throw new Error("should not reach the handler");
      },
    });
    running.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-protocol-version": "1.0.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "initialize",
        params: {},
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32020, message: "Unsupported MCP-Protocol-Version" },
      id: 42,
    });
  });

  test("a malformed `_meta` (present but not an object) answers 400 with -32602 Invalid Params", async () => {
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider(token),
      requestHandler: async () => {
        throw new Error("should not reach the handler");
      },
    });
    running.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // Must stay a PRE-2026 unsupported value (OMC-008 Task 1). This
        // body's -32602 comes from buildProtocolVersionErrorBody, which
        // httpServer.ts only calls after checkProtocolVersion has already
        // rejected the request with 400. A 2026-era value (e.g.
        // "2026-07-28" or "2027-05-01") is deferred by the version rung
        // instead of rejected, so it would reach requestHandler here and
        // this test's throwing stub would 500 instead of asserting
        // -32602. Do not "modernise" this back to a 2026-era date.
        "mcp-protocol-version": "2023-01-01",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "initialize",
        params: { _meta: "not-an-object" },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32602,
        message: "Invalid params: `_meta` must be an object",
      },
      id: "req-1",
    });
  });

  test("an unparseable body still 400s with -32020 and a null id, not a crash", async () => {
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider(token),
      requestHandler: async () => {
        throw new Error("should not reach the handler");
      },
    });
    running.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-protocol-version": "1.0.0",
      },
      body: "{not valid json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32020, message: "Unsupported MCP-Protocol-Version" },
      id: null,
    });
  });

  test("an absent MCP-Protocol-Version header is still legal and reaches the handler unchanged", async () => {
    let handlerCalled = false;
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider(token),
      requestHandler: async (_req, res) => {
        handlerCalled = true;
        res.writeHead(200);
        res.end("ok");
      },
    });
    running.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(handlerCalled).toBe(true);
  });
});

describe("stopHttpServer — connection draining", () => {
  test("force-drops keep-alive/SSE sockets before close()", async () => {
    const order: string[] = [];
    const fakeServer = {
      closeAllConnections: () => {
        order.push("closeAllConnections");
      },
      close: (cb: (err?: Error) => void) => {
        order.push("close");
        cb();
      },
    } as unknown as Server;

    await stopHttpServer({ server: fakeServer, port: 0 });

    // closeAllConnections MUST run first — otherwise an open mcp-remote
    // stream keeps close() from ever resolving.
    expect(order).toEqual(["closeAllConnections", "close"]);
  });
});

describe("request body size cap", () => {
  test("rejects an oversize Content-Length with 413 before the handler runs", async () => {
    let handlerCalled = false;
    const token = "t".repeat(32);
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider(token),
      requestHandler: async (_req, res) => {
        handlerCalled = true;
        res.writeHead(200);
        res.end("ok");
      },
    });
    running.push(server);

    // fetch derives Content-Length from the body, so send a real
    // oversize payload — the server reads the declared length and
    // rejects before the handler is ever invoked.
    const oversize = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: oversize,
    });
    expect(res.status).toBe(413);
    expect(handlerCalled).toBe(false);
  });

  test("an under-limit request still reaches the handler with its body", async () => {
    let received = "";
    const token = "t".repeat(32);
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider(token),
      requestHandler: async (req, res) => {
        for await (const chunk of req) received += chunk;
        res.writeHead(200);
        res.end("ok");
      },
    });
    running.push(server);

    const payload = JSON.stringify({ hello: "world" });
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    // The body must still flow to the handler untouched on the happy path.
    expect(received).toBe(payload);
  });
});

describe("stopHttpServer", () => {
  test("closes the server so the port is free again", async () => {
    const server = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: async (_req, res) => {
        res.end();
      },
    });
    await stopHttpServer(server);

    // Bind a new server to the same port — would fail if the first is still listening
    const server2 = await startHttpServer({
      resolveTokens: staticTokenProvider("t".repeat(32)),
      requestHandler: async (_req, res) => {
        res.end();
      },
    });
    running.push(server2);
    expect(server2.port).toBe(server.port);
  });
});

describe("startHttpServer — multi-token resolveTokens (issue #348, ADR-0014)", () => {
  test("two tokens on one server route to different handler invocations with different tokenId", async () => {
    const seenTokenIds: string[] = [];
    const tokenA = { id: "a", label: "A", token: "a".repeat(32), createdAt: 0 };
    const tokenB = { id: "b", label: "B", token: "b".repeat(32), createdAt: 0 };
    const server = await startHttpServer({
      resolveTokens: async () => [tokenA, tokenB],
      requestHandler: async (_req, res, tokenId) => {
        seenTokenIds.push(tokenId);
        res.writeHead(200);
        res.end("ok");
      },
    });
    running.push(server);

    const resA = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA.token}` },
    });
    const resB = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB.token}` },
    });

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(seenTokenIds).toEqual(["a", "b"]);
  });

  test("a rejected resolveTokens is logged and treated as an empty list — the request 401s, the handler never runs", async () => {
    let handlerCalled = false;
    const server = await startHttpServer({
      resolveTokens: async () => {
        throw new Error("synthetic loadData() failure");
      },
      requestHandler: async (_req, res) => {
        handlerCalled = true;
        res.writeHead(200);
        res.end("should-not-reach");
      },
    });
    running.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${"t".repeat(32)}` },
    });

    expect(res.status).toBe(401);
    expect(handlerCalled).toBe(false);
  });
});
