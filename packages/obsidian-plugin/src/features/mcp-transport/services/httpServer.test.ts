import { describe, expect, test, afterEach } from "bun:test";
import type { Server } from "node:http";
import {
  startHttpServer,
  stopHttpServer,
  type RunningServer,
} from "./httpServer";
import { MAX_REQUEST_BODY_BYTES } from "../constants";

const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await stopHttpServer(s);
});

describe("startHttpServer", () => {
  test("binds to a port in range and exposes it", async () => {
    const server = await startHttpServer({
      bearerToken: "test-token-12345678901234567890abcd",
      requestHandler: async (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      },
    });
    running.push(server);
    expect(server.port).toBeGreaterThanOrEqual(27200);
    expect(server.port).toBeLessThanOrEqual(27205);
  });

  test("rejects POST /mcp without auth (401)", async () => {
    const server = await startHttpServer({
      bearerToken: "test-token-12345678901234567890abcd",
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
      bearerToken: "t".repeat(32),
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
      bearerToken: "t".repeat(32),
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
      bearerToken: token,
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
      bearerToken: token,
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
      bearerToken: token,
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
      bearerToken: token,
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
      bearerToken: "t".repeat(32),
      requestHandler: async (_req, res) => {
        res.end();
      },
    });
    await stopHttpServer(server);

    // Bind a new server to the same port — would fail if the first is still listening
    const server2 = await startHttpServer({
      bearerToken: "t".repeat(32),
      requestHandler: async (_req, res) => {
        res.end();
      },
    });
    running.push(server2);
    expect(server2.port).toBe(server.port);
  });
});
