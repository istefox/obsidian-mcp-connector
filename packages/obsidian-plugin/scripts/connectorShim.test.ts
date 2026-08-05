import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  splitLines,
  parseJsonRpcLine,
  parseTransportFile,
  buildErrorResponse,
  buildProgressNotification,
  parseSse,
  routeSseMessages,
  resolveResponseMessages,
  readTransport,
  probePort,
  resolveTransportWithRetry,
  httpFetch,
  postJsonRpc,
  runMain,
  isEntryPoint,
  retryWindowFor,
  postTimeoutFor,
  RETRY_WINDOW_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  WATCHDOG_GRACE_MS,
  MIN_POST_BUDGET_MS,
  MIN_POST_TIMEOUT_MS,
  PROTOCOL_VERSION_FALLBACK,
  LOCAL_ERROR_CODE,
} from "./connectorShim.js";

// connectorShim.js is plain, untyped CommonJS (SPEC hard constraint: no
// TypeScript syntax in the shipped shim). Its exported functions' parameter
// types are inferred by tsc from default-parameter values (e.g.
// `stdin = process.stdin`, `fetchImpl = fetch`), which pins them to real
// Node/DOM types too strict for hand-rolled test doubles to satisfy
// structurally. These aliases plus a double-cast (`as unknown as X`) are the
// test-only seam that bridges the untyped shim to the doubles below, without
// resorting to `any`.
type RunMainOptions = Parameters<typeof runMain>[0];
type PostJsonRpcOptions = Parameters<typeof postJsonRpc>[4];

type FakeFetchInit = {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
};

function invokeRunMain(options: Record<string, unknown>) {
  return runMain(options as unknown as RunMainOptions);
}

function withFetchImpl(fetchImpl: unknown): PostJsonRpcOptions {
  return { fetchImpl } as unknown as PostJsonRpcOptions;
}

describe("splitLines", () => {
  test("one complete line, one chunk", () => {
    expect(splitLines("", '{"a":1}\n')).toEqual({
      lines: ['{"a":1}'],
      remainder: "",
    });
  });

  test("multiple complete lines, one chunk", () => {
    expect(splitLines("", "one\ntwo\nthree\n")).toEqual({
      lines: ["one", "two", "three"],
      remainder: "",
    });
  });

  test("partial line held across two chunks", () => {
    const first = splitLines("", '{"a":');
    expect(first).toEqual({ lines: [], remainder: '{"a":' });
    const second = splitLines(first.remainder, "1}\n");
    expect(second).toEqual({ lines: ['{"a":1}'], remainder: "" });
  });

  test("chunk with no newline at all", () => {
    expect(splitLines("", "no newline yet")).toEqual({
      lines: [],
      remainder: "no newline yet",
    });
  });

  test("blank lines pass through, not filtered here", () => {
    expect(splitLines("", "a\n\nb\n")).toEqual({
      lines: ["a", "", "b"],
      remainder: "",
    });
  });
});

describe("parseJsonRpcLine", () => {
  test("valid JSON-RPC object line", () => {
    expect(
      parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"tools/call"}'),
    ).toEqual({
      message: { jsonrpc: "2.0", id: 1, method: "tools/call" },
    });
  });

  test("blank / whitespace-only line", () => {
    expect(parseJsonRpcLine("")).toEqual({ skip: true });
    expect(parseJsonRpcLine("   ")).toEqual({ skip: true });
  });

  test("unparseable JSON", () => {
    const result = parseJsonRpcLine("{not json");
    expect(typeof result.error).toBe("string");
  });

  test("valid JSON, not an object", () => {
    for (const line of ["5", "[1,2]", "null", '"a string"']) {
      const result = parseJsonRpcLine(line);
      expect(typeof result.error).toBe("string");
    }
  });
});

describe("parseTransportFile", () => {
  test("valid", () => {
    const json = JSON.stringify({
      mcpTransport: { livePort: 27200, bearerToken: "tok" },
    });
    expect(parseTransportFile(json)).toEqual({ port: 27200, token: "tok" });
  });

  test("missing mcpTransport entirely", () => {
    const result = parseTransportFile("{}");
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("mcpTransport");
  });

  test("missing livePort only", () => {
    const json = JSON.stringify({ mcpTransport: { bearerToken: "tok" } });
    const result = parseTransportFile(json);
    expect(typeof result.error).toBe("string");
  });

  test("missing bearerToken only", () => {
    const json = JSON.stringify({ mcpTransport: { livePort: 27200 } });
    const result = parseTransportFile(json);
    expect(typeof result.error).toBe("string");
  });

  test("non-numeric livePort is rejected", () => {
    const json = JSON.stringify({
      mcpTransport: { livePort: "27200", bearerToken: "tok" },
    });
    const result = parseTransportFile(json);
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("mcpTransport");
  });

  test("non-string bearerToken is rejected", () => {
    const json = JSON.stringify({
      mcpTransport: { livePort: 27200, bearerToken: 12345 },
    });
    const result = parseTransportFile(json);
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("mcpTransport");
  });

  test("malformed JSON text", () => {
    const result = parseTransportFile("not json");
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("data.json");
  });
});

describe("parseTransportFile(jsonText, tokenId) — per-token .mcpb bundles (R-17, ADR-0014 §11)", () => {
  function tokensJson() {
    return JSON.stringify({
      mcpTransport: {
        livePort: 27200,
        bearerToken: "mirror-tok",
        tokens: [
          {
            id: "default",
            label: "Default",
            token: "mirror-tok",
            createdAt: 1,
          },
          { id: "tok-2", label: "Second", token: "second-tok", createdAt: 2 },
        ],
      },
    });
  }

  test("no tokenId argument, tokens[] present: still returns mcpTransport.bearerToken — old-bundle regression guard", () => {
    // Every previously generated .mcpb calls parseTransportFile(jsonText)
    // with one argument. The presence of tokens[] must not change that
    // call's result, or every bundle in the wild silently breaks.
    expect(parseTransportFile(tokensJson())).toEqual({
      port: 27200,
      token: "mirror-tok",
    });
  });

  test("tokenId present in tokens[]: returns that token's secret, not the mirror", () => {
    const result = parseTransportFile(tokensJson(), "tok-2");
    expect(result).toEqual({ port: 27200, token: "second-tok" });
  });

  test("tokenId absent from tokens[]: hard error mentioning re-export, never a fallback to bearerToken", () => {
    const result = parseTransportFile(tokensJson(), "ghost-id");
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("re-export");
    // The single most important assertion in this suite: an unknown id
    // must fail closed, never silently resolve to the mirror token — a
    // fallback here would turn a revocation into a privilege grant
    // (ADR-0014 §11).
    expect(result.token).toBeUndefined();
    expect(result).not.toEqual({ port: 27200, token: "mirror-tok" });
  });

  test("tokenId absent from tokens[]: mcpTransport.bearerToken is genuinely never read on this path", () => {
    // A stronger variant of the guard above: even when the mirror token
    // would trivially "work" (matches an existing token's secret by
    // coincidence), an unresolvable id must still error — resolution is
    // by id, never by falling through to the mirror field at all.
    const json = JSON.stringify({
      mcpTransport: {
        livePort: 27200,
        bearerToken: "second-tok",
        tokens: [
          {
            id: "default",
            label: "Default",
            token: "mirror-tok",
            createdAt: 1,
          },
          { id: "tok-2", label: "Second", token: "second-tok", createdAt: 2 },
        ],
      },
    });
    const result = parseTransportFile(json, "ghost-id");
    expect(typeof result.error).toBe("string");
    expect(result.token).toBeUndefined();
  });

  /**
   * `fatal` is opt-in per error, never a blanket flag. Everything else
   * this function can return describes a vault that is mid-write or a
   * server that has not bound yet, and those are exactly what the retry
   * loop exists for — flagging one of them would turn a recoverable
   * startup race into a hard failure.
   */
  test("only the unknown-token error is marked fatal", () => {
    expect(parseTransportFile(tokensJson(), "ghost-id").fatal).toBe(true);

    const transient = [
      ["malformed JSON", "{ not json", undefined],
      ["missing livePort", JSON.stringify({ mcpTransport: {} }), undefined],
      [
        "missing bearerToken",
        JSON.stringify({ mcpTransport: { livePort: 27200 } }),
        undefined,
      ],
    ] as const;
    for (const [label, json, tokenId] of transient) {
      const r = parseTransportFile(json, tokenId);
      expect(typeof r.error, label).toBe("string");
      expect(r.fatal, label).toBeFalsy();
    }
  });
});

describe("buildErrorResponse", () => {
  test("without data", () => {
    expect(buildErrorResponse(5, "boom")).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: {
        code: LOCAL_ERROR_CODE,
        message: "obsidian-mcp-connector: boom",
      },
    });
  });

  test("with data", () => {
    expect(buildErrorResponse(5, "boom", { port: 27200 })).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: expect.objectContaining({
        code: LOCAL_ERROR_CODE,
        message: "obsidian-mcp-connector: boom",
        data: { port: 27200 },
      }),
    });
  });

  /**
   * The property, not the literal. Every error this shim raises is local
   * to the proxy and none is defined by MCP, so the code must sit outside
   * the JSON-RPC reserved range entirely — `-32000`..`-32019` is legacy
   * that new implementations must not use, and `-32020`..`-32099` may
   * only carry meanings the specification defines. Asserting the range
   * rather than the number keeps this true if the value is ever changed
   * for an unrelated reason (MCP 2026-07-28, Base Protocol, Error Codes).
   */
  test("the local error code is outside the JSON-RPC reserved range", () => {
    expect(LOCAL_ERROR_CODE).toBeLessThan(-32768);
    // Sanity: still a plain integer a client can render.
    expect(Number.isSafeInteger(LOCAL_ERROR_CODE)).toBe(true);
  });
});

describe("buildProgressNotification", () => {
  test("without message", () => {
    expect(buildProgressNotification("tok-1", 3)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "tok-1", progress: 3 },
    });
  });

  test("with message", () => {
    expect(buildProgressNotification("tok-1", 3, "still waiting")).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "tok-1",
        progress: 3,
        message: "still waiting",
      },
    });
  });
});

describe("parseSse", () => {
  test("response-only body", () => {
    const body = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\n\n`;
    expect(parseSse(body)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
    ]);
  });

  test("notification then response, one body, order preserved", () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    };
    const response = { jsonrpc: "2.0", id: 1, result: {} };
    const body = `data: ${JSON.stringify(notification)}\n\ndata: ${JSON.stringify(response)}\n\n`;
    expect(parseSse(body)).toEqual([notification, response]);
  });

  test("multi-line data: continuation", () => {
    const body = 'data: {"jsonrpc":"2.0","id":1,\ndata: "result":{}}\n\n';
    expect(parseSse(body)).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  test("CRLF line endings", () => {
    const body = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\r\n\r\n`;
    expect(parseSse(body)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
    ]);
  });

  test("comment lines and event: fields are ignored, not folded into the payload", () => {
    const body =
      ": this is a comment\r\n" +
      "event: message\r\n" +
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })}\r\n\r\n`;
    expect(parseSse(body)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
    ]);
  });

  test("malformed body (no valid data: JSON) drops the bad event, does not throw", () => {
    expect(parseSse("data: not-json-at-all\n\n")).toEqual([]);
  });

  test("no trailing blank line still dispatches", () => {
    const body = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}`;
    expect(parseSse(body)).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });
});

describe("routeSseMessages", () => {
  test("notification + response, matched by id", () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    };
    const response = { jsonrpc: "2.0", id: 7, result: {} };
    const { notifications, response: matched } = routeSseMessages(
      [notification, response],
      7,
    );
    expect(notifications).toEqual([notification]);
    expect(matched).toEqual(response);
  });

  test("order preserved, notification first", () => {
    const n1 = { jsonrpc: "2.0", method: "a" };
    const n2 = { jsonrpc: "2.0", method: "b" };
    const response = { jsonrpc: "2.0", id: 7, result: {} };
    const { notifications } = routeSseMessages([n1, n2, response], 7);
    expect(notifications).toEqual([n1, n2]);
  });

  test("no matching response — all messages are notifications", () => {
    const n1 = { jsonrpc: "2.0", method: "a" };
    const n2 = { jsonrpc: "2.0", method: "b" };
    const { notifications, response } = routeSseMessages([n1, n2], 7);
    expect(response).toBeNull();
    expect(notifications).toEqual([n1, n2]);
  });

  test("no matching response — empty list", () => {
    const { notifications, response } = routeSseMessages([], 7);
    expect(response).toBeNull();
    expect(notifications).toEqual([]);
  });

  test("a message with a different id is not the response", () => {
    const other = { jsonrpc: "2.0", id: 99, result: {} };
    const { notifications, response } = routeSseMessages([other], 7);
    expect(response).toBeNull();
    expect(notifications).toEqual([other]);
  });
});

describe("resolveResponseMessages", () => {
  test("application/json, well-formed", () => {
    const message = { jsonrpc: "2.0", id: 1, result: {} };
    expect(
      resolveResponseMessages(
        "application/json",
        JSON.stringify(message),
        1,
        200,
      ),
    ).toEqual([message]);
  });

  test("application/json; charset=utf-8", () => {
    const message = { jsonrpc: "2.0", id: 1, result: {} };
    expect(
      resolveResponseMessages(
        "application/json; charset=utf-8",
        JSON.stringify(message),
        1,
        200,
      ),
    ).toEqual([message]);
  });

  test("text/event-stream, response only", () => {
    const message = { jsonrpc: "2.0", id: 1, result: {} };
    const body = `data: ${JSON.stringify(message)}\n\n`;
    expect(resolveResponseMessages("text/event-stream", body, 1, 200)).toEqual([
      message,
    ]);
  });

  test("text/event-stream, notification then response", () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    };
    const response = { jsonrpc: "2.0", id: 1, result: {} };
    const body = `data: ${JSON.stringify(notification)}\n\ndata: ${JSON.stringify(response)}\n\n`;
    expect(resolveResponseMessages("text/event-stream", body, 1, 200)).toEqual([
      notification,
      response,
    ]);
  });

  function errorMatching(id: number, substring: string) {
    return {
      jsonrpc: "2.0",
      id,
      error: expect.objectContaining({
        code: LOCAL_ERROR_CODE,
        message: expect.stringContaining(substring),
      }),
    };
  }

  test("text/event-stream, malformed (no data: JSON at all)", () => {
    const result = resolveResponseMessages(
      "text/event-stream",
      "data: not-json\n\n",
      1,
      200,
    );
    expect(result).toEqual([errorMatching(1, "HTTP 200")]);
  });

  test("text/event-stream, well-formed events but none carries the request's id", () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    };
    const body = `data: ${JSON.stringify(notification)}\n\n`;
    const result = resolveResponseMessages("text/event-stream", body, 1, 200);
    expect(result).toEqual([notification, errorMatching(1, "HTTP 200")]);
  });

  test("malformed application/json body", () => {
    const result = resolveResponseMessages(
      "application/json",
      "not json",
      1,
      200,
    );
    expect(result).toEqual([errorMatching(1, "HTTP 200")]);
  });

  test("empty body", () => {
    const result = resolveResponseMessages("application/json", "", 1, 202);
    expect(result).toEqual([errorMatching(1, "HTTP 202")]);
  });

  test("status 401", () => {
    const result = resolveResponseMessages("application/json", "", 1, 401);
    expect(result).toHaveLength(1);
    expect(result[0].error!.message).toContain("401");
    expect(result[0].error!.message).toMatch(/token/i);
  });

  test("status 500", () => {
    const result = resolveResponseMessages("application/json", "", 1, 500);
    expect(result).toHaveLength(1);
    expect(result[0].error!.message).toContain("500");
  });
});

describe("readTransport", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-shim-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("valid file", async () => {
    const dataPath = path.join(dir, "data.json");
    fs.writeFileSync(
      dataPath,
      JSON.stringify({ mcpTransport: { livePort: 27200, bearerToken: "tok" } }),
    );
    expect(await readTransport(dataPath)).toEqual({
      port: 27200,
      token: "tok",
    });
  });

  test("missing file", async () => {
    const dataPath = path.join(dir, "nonexistent", "data.json");
    const result = await readTransport(dataPath);
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain(dataPath);
  });

  test("malformed JSON on disk", async () => {
    const dataPath = path.join(dir, "data.json");
    fs.writeFileSync(dataPath, "not json");
    const result = await readTransport(dataPath);
    expect(typeof result.error).toBe("string");
  });
});

describe("readTransport(dataPath, options, tokenId) — per-token .mcpb bundles (R-17, ADR-0014 §11)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-shim-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeTokensFixture(dataPath: string) {
    fs.writeFileSync(
      dataPath,
      JSON.stringify({
        mcpTransport: {
          livePort: 27200,
          bearerToken: "mirror-tok",
          tokens: [
            {
              id: "default",
              label: "Default",
              token: "mirror-tok",
              createdAt: 1,
            },
            { id: "tok-2", label: "Second", token: "second-tok", createdAt: 2 },
          ],
        },
      }),
    );
  }

  test("no tokenId argument, tokens[] on disk: still returns mcpTransport.bearerToken — old-bundle regression guard", async () => {
    const dataPath = path.join(dir, "data.json");
    writeTokensFixture(dataPath);
    expect(await readTransport(dataPath)).toEqual({
      port: 27200,
      token: "mirror-tok",
    });
  });

  test("tokenId threaded through and present in tokens[]: returns that token's secret, not the mirror", async () => {
    const dataPath = path.join(dir, "data.json");
    writeTokensFixture(dataPath);
    expect(await readTransport(dataPath, {}, "tok-2")).toEqual({
      port: 27200,
      token: "second-tok",
    });
  });

  test("tokenId threaded through and absent from tokens[]: hard error mentioning re-export, never a fallback to bearerToken", async () => {
    const dataPath = path.join(dir, "data.json");
    writeTokensFixture(dataPath);
    const result = await readTransport(dataPath, {}, "ghost-id");
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("re-export");
    expect(result.token).toBeUndefined();
    expect(result).not.toEqual({ port: 27200, token: "mirror-tok" });
  });
});

describe("probePort", () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) {
      const toClose = server;
      await new Promise<void>((resolve) => toClose.close(() => resolve()));
      server = undefined;
    }
  });

  function listeningPort(s: net.Server): number {
    const address = s.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected an AddressInfo, got " + String(address));
    }
    return address.port;
  }

  test("open port", async () => {
    server = net.createServer();
    const s = server;
    await new Promise<void>((resolve) => s.listen(0, () => resolve()));
    const port = listeningPort(s);
    expect(await probePort(port)).toBe(true);
  });

  test("closed port", async () => {
    server = net.createServer();
    const s = server;
    await new Promise<void>((resolve) => s.listen(0, () => resolve()));
    const port = listeningPort(s);
    await new Promise<void>((resolve) => s.close(() => resolve()));
    server = undefined;
    expect(await probePort(port)).toBe(false);
  });
});

describe("resolveTransportWithRetry", () => {
  test("RETRY_WINDOW_MS + DEFAULT_REQUEST_TIMEOUT_MS stays under the MCP client's 60000ms default request timeout", () => {
    expect(RETRY_WINDOW_MS + DEFAULT_REQUEST_TIMEOUT_MS).toBeLessThan(60000);
  });

  function fakeClock() {
    let clock = 0;
    return {
      nowImpl: (): number => clock,
      sleepMsImpl: async (ms: number): Promise<void> => {
        clock += ms;
      },
    };
  }

  test("succeeds on first attempt", async () => {
    const { nowImpl, sleepMsImpl } = fakeClock();
    let sleepCalls = 0;
    const result = await resolveTransportWithRetry("/fake/data.json", {
      readTransportImpl: () => ({ port: 27200, token: "tok" }),
      probePortImpl: async () => true,
      nowImpl,
      sleepMsImpl: async (ms: number) => {
        sleepCalls++;
        await sleepMsImpl(ms);
      },
    });
    expect(result).toEqual({ port: 27200, token: "tok" });
    expect(sleepCalls).toBe(0);
  });

  test("succeeds after N failed probes", async () => {
    const { nowImpl, sleepMsImpl } = fakeClock();
    let probeCalls = 0;
    let sleepCalls = 0;
    const result = await resolveTransportWithRetry("/fake/data.json", {
      readTransportImpl: () => ({ port: 27200, token: "tok" }),
      probePortImpl: async () => {
        probeCalls++;
        return probeCalls > 2;
      },
      nowImpl,
      sleepMsImpl: async (ms: number) => {
        sleepCalls++;
        await sleepMsImpl(ms);
      },
    });
    expect(result).toEqual({ port: 27200, token: "tok" });
    expect(sleepCalls).toBeGreaterThan(0);
  });

  test("exhausts the window", async () => {
    const { nowImpl, sleepMsImpl } = fakeClock();
    const result = await resolveTransportWithRetry("/fake/data.json", {
      readTransportImpl: () => ({ port: 27200, token: "tok" }),
      probePortImpl: async () => false,
      nowImpl,
      sleepMsImpl,
      windowMs: 30000,
      intervalMs: 1000,
    });
    expect(result.error).toBeDefined();
  });

  test("readTransportImpl itself keeps erroring", async () => {
    const { nowImpl, sleepMsImpl } = fakeClock();
    let readCalls = 0;
    const result = await resolveTransportWithRetry("/fake/data.json", {
      readTransportImpl: () => {
        readCalls++;
        return { error: "vault not loaded" };
      },
      probePortImpl: async () => true,
      nowImpl,
      sleepMsImpl,
      windowMs: 30000,
      intervalMs: 1000,
    });
    expect(readCalls).toBeGreaterThan(1);
    expect(result.error).toBeDefined();
  });

  /**
   * A revoked token id is permanent: `tokens[]` is persisted settings and
   * the id cannot reappear without a user action in Obsidian AND a fresh
   * export. Polling it for the full window costs ~20s per request and
   * ends by appending "is Obsidian open with the vault loaded?", which is
   * false and buries the one instruction that helps.
   */
  test("a fatal error returns at once, verbatim, without polling", async () => {
    const { nowImpl, sleepMsImpl } = fakeClock();
    const FATAL =
      "token 'tok-2' is no longer configured — re-export the .mcpb from Obsidian settings";
    let readCalls = 0;
    let sleepCalls = 0;
    const result = await resolveTransportWithRetry("/fake/data.json", {
      readTransportImpl: () => {
        readCalls++;
        return { error: FATAL, fatal: true };
      },
      probePortImpl: async () => true,
      nowImpl,
      sleepMsImpl: async (ms: number) => {
        sleepCalls++;
        await sleepMsImpl(ms);
      },
      windowMs: 30000,
      intervalMs: 1000,
    });
    expect(readCalls).toBe(1);
    expect(sleepCalls).toBe(0);
    // Byte-identical is the load-bearing assertion: it pins that the
    // "is Obsidian open…" suffix is NOT appended to a permanent failure.
    expect(result.error).toBe(FATAL);
  });

  test("onAttempt fires once per retry iteration, not on the successful iteration", async () => {
    const { nowImpl, sleepMsImpl } = fakeClock();
    let attempts = 0;
    let probeCalls = 0;
    const result = await resolveTransportWithRetry("/fake/data.json", {
      readTransportImpl: () => ({ port: 27200, token: "tok" }),
      probePortImpl: async () => {
        probeCalls++;
        // Fail the first 3 probes, succeed on the 4th.
        return probeCalls > 3;
      },
      nowImpl,
      sleepMsImpl,
      onAttempt: () => {
        attempts++;
      },
    });
    expect(result).toEqual({ port: 27200, token: "tok" });
    // 3 failing iterations each fire onAttempt before sleeping; the 4th
    // returns before reaching onAttempt/sleep.
    expect(attempts).toBe(3);
  });
});

function makeResponse(status: number, contentType: string, rawBody: string) {
  return {
    status,
    headers: new Map([["content-type", contentType]]),
    text: async () => rawBody,
  };
}

function connectionRefusedError() {
  return Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });
}

describe("postJsonRpc", () => {
  test("success", async () => {
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(
        200,
        "application/json",
        '{"jsonrpc":"2.0","id":1,"result":{}}',
      ),
    );
    const result = await postJsonRpc(
      "http://127.0.0.1:27200/mcp",
      "tok",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      1000,
      withFetchImpl(fetchImpl),
    );
    expect(result).toEqual({
      status: 200,
      contentType: "application/json",
      rawBody: '{"jsonrpc":"2.0","id":1,"result":{}}',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, options] = fetchImpl.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer tok");
    expect(options.body).toBe(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
  });

  test("timeout", async () => {
    const fetchImpl = (_url: string, options: FakeFetchInit) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    await expect(
      postJsonRpc(
        "http://127.0.0.1:27200/mcp",
        "tok",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        20,
        withFetchImpl(fetchImpl),
      ),
    ).rejects.toHaveProperty("name", "AbortError");
  });

  test("sends MCP-Protocol-Version header when protocolVersion is provided", async () => {
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(
        200,
        "application/json",
        '{"jsonrpc":"2.0","id":1,"result":{}}',
      ),
    );
    await postJsonRpc(
      "http://127.0.0.1:27200/mcp",
      "tok",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      1000,
      {
        fetchImpl,
        protocolVersion: "2025-06-18",
      } as unknown as PostJsonRpcOptions,
    );
    const [, options] = fetchImpl.mock.calls[0];
    expect(options.headers["MCP-Protocol-Version"]).toBe("2025-06-18");
  });

  test("omits MCP-Protocol-Version header when protocolVersion is absent", async () => {
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(
        200,
        "application/json",
        '{"jsonrpc":"2.0","id":1,"result":{}}',
      ),
    );
    await postJsonRpc(
      "http://127.0.0.1:27200/mcp",
      "tok",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      1000,
      withFetchImpl(fetchImpl),
    );
    const [, options] = fetchImpl.mock.calls[0];
    expect("MCP-Protocol-Version" in options.headers).toBe(false);
  });

  test("RETRY_WINDOW_MS + DEFAULT_REQUEST_TIMEOUT_MS + WATCHDOG_GRACE_MS stays under the MCP client's 60000ms default request timeout", () => {
    expect(
      RETRY_WINDOW_MS + DEFAULT_REQUEST_TIMEOUT_MS + WATCHDOG_GRACE_MS,
    ).toBeLessThan(60000);
  });

  test("watchdog rejects with AbortError when fetch hangs and never honors the abort signal", async () => {
    // Simulates the observed Claude Desktop UtilityProcess sandbox bug: the
    // fetch promise ignores controller.abort() entirely and never settles.
    const fetchImpl = () => new Promise(() => {});
    await expect(
      postJsonRpc(
        "http://127.0.0.1:27200/mcp",
        "tok",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        20,
        { fetchImpl, watchdogGraceMs: 10 } as unknown as PostJsonRpcOptions,
      ),
    ).rejects.toHaveProperty("name", "AbortError");
  });

  test("watchdog does not mask a working AbortController", async () => {
    const fetchImpl = (_url: string, options: FakeFetchInit) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    await expect(
      postJsonRpc(
        "http://127.0.0.1:27200/mcp",
        "tok",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        20,
        {
          fetchImpl,
          watchdogGraceMs: 500,
        } as unknown as PostJsonRpcOptions,
      ),
    ).rejects.toHaveProperty("message", "aborted");
  });

  test("an abandoned attempt that settles after the watchdog wins does not surface as an unhandled rejection", async () => {
    const fetchImpl = () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("late failure")), 60);
      });
    await expect(
      postJsonRpc(
        "http://127.0.0.1:27200/mcp",
        "tok",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        20,
        { fetchImpl, watchdogGraceMs: 10 } as unknown as PostJsonRpcOptions,
      ),
    ).rejects.toHaveProperty("name", "AbortError");
    // Give the abandoned fetch time to reject on its own; a missing .catch()
    // on the loser promise would surface here as an unhandled rejection and
    // fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

describe("runMain", () => {
  // Models process.stdin: honors setEncoding("utf8") by decoding emitted
  // Buffer chunks through a StringDecoder that buffers incomplete multi-byte
  // sequences across chunk boundaries, exactly like a real Node stream.
  function fakeStdin() {
    const emitter = new EventEmitter();
    const rawEmit = emitter.emit.bind(emitter);
    let decoder: StringDecoder | null = null;
    (
      emitter as EventEmitter & {
        setEncoding(enc: BufferEncoding): unknown;
      }
    ).setEncoding = (enc: BufferEncoding) => {
      decoder = new StringDecoder(enc);
      return emitter;
    };
    emitter.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event === "data" && decoder && Buffer.isBuffer(args[0])) {
        return rawEmit("data", decoder.write(args[0]));
      }
      return rawEmit(event, ...args);
    }) as typeof emitter.emit;
    return emitter;
  }

  const successTransport = { port: 27200, token: "tok" };

  /**
   * The bundle's token id has to reach every resolution site, on both
   * the request and the notification path. Dropping it anywhere makes
   * that read fall through to `mcpTransport.bearerToken` — a silent
   * fallback to whichever token is first, which is exactly what
   * ADR-0014 §11 forbids. Every other `runMain` test stubs
   * `readTransportImpl` without inspecting its arguments, so this
   * plumbing was previously unexercised.
   */
  test("threads the bundle's token id into every transport read", async () => {
    const stdin = fakeStdin();
    const seen: (string | undefined)[] = [];
    const promise = invokeRunMain({
      stdin,
      writeChunk: mock((_s: string) => {}),
      log: mock((_msg: string) => {}),
      fetchImpl: mock(async (_url: string, _init: FakeFetchInit) =>
        makeResponse(200, "application/json", "{}"),
      ),
      dataPath: "/fake/data.json",
      tokenId: "tok-2",
      readTransportImpl: (
        _p: string,
        _o: Record<string, unknown>,
        id?: string,
      ) => {
        seen.push(id);
        return successTransport;
      },
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n",
      ),
    );
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/ping" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    // toEqual, not toContain: a path that silently passes `undefined`
    // on the notification branch has to fail too.
    expect(seen).toEqual(["tok-2", "tok-2"]);
  });

  /**
   * The user-visible bug, end to end: a bundle whose token was revoked
   * used to poll for the full RETRY_WINDOW_MS on EVERY request before
   * answering, and then answered with the retry path's suffix appended,
   * which contradicts the re-export instruction it lands next to.
   *
   * Deliberately uses the REAL `resolveTransportWithRetry` — stubbing it
   * would hide the very behaviour under test. Without the fatal
   * short-circuit this test does not merely fail, it exceeds the test
   * timeout, because the real loop sleeps for 20 real seconds.
   */
  test("a revoked token id is reported at once, with no misleading suffix", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const FATAL =
      "token 'tok-2' is no longer configured — re-export the .mcpb from Obsidian settings";
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log: mock((_msg: string) => {}),
      fetchImpl: mock(async (_url: string, _init: FakeFetchInit) =>
        makeResponse(200, "application/json", "{}"),
      ),
      dataPath: "/fake/data.json",
      tokenId: "tok-2",
      readTransportImpl: () => ({ error: FATAL, fatal: true }),
      // resolveTransportWithRetryImpl intentionally NOT stubbed.
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          // A progressToken would make the retry loop emit a progress
          // notification per poll; none may appear if it never polls.
          params: { _meta: { progressToken: "p1" } },
        }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;

    const written = writeChunk.mock.calls.map((c) => c[0]).join("");
    expect(writeChunk).toHaveBeenCalledTimes(1);
    expect(written).toContain("re-export");
    expect(written).not.toContain("is Obsidian open");
    expect(written).not.toContain("notifications/progress");
  });

  test("threads the token id into the retry path too", async () => {
    const stdin = fakeStdin();
    let seen: string | undefined = "NOT CALLED";
    const promise = invokeRunMain({
      stdin,
      writeChunk: mock((_s: string) => {}),
      log: mock((_msg: string) => {}),
      fetchImpl: mock(async (_url: string, _init: FakeFetchInit) =>
        makeResponse(200, "application/json", "{}"),
      ),
      dataPath: "/fake/data.json",
      tokenId: "tok-2",
      // First read fails, so resolution escalates to the retry path.
      readTransportImpl: () => ({ error: "not ready yet" }),
      resolveTransportWithRetryImpl: (
        _p: string,
        opts: { tokenId?: string },
      ) => {
        seen = opts.tokenId;
        return successTransport;
      },
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    // A transient read failure must not become a mirror-token fallback.
    expect(seen).toBe("tok-2");
  });

  /**
   * Reported as #412: `initialize` goes in, the client cancels, the
   * transport closes, and the Claude Desktop log carries no reason at
   * all. The reason existed — it just went to stdout, where a client
   * that has already cancelled discards it — while `handleNotification`
   * logged the identical class of failure to stderr unconditionally.
   *
   * stderr is the only channel that survives a cancelled request, and
   * for an installed .mcpb it is the ONLY channel a user can read at all.
   * #412 removed the `debug` flag that used to gate part of this: the
   * generated manifest carries no `env` (`user_config?: never` in
   * mcpbGenerator.ts), so it could never be set for an installed
   * extension anyway.
   */
  test("a resolution failure on the request path is logged to stderr", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl: mock(async (_url: string, _init: FakeFetchInit) =>
        makeResponse(200, "application/json", "{}"),
      ),
      dataPath: "/fake/data.json",
      readTransportImpl: () => ({ error: "could not read /fake/data.json" }),
      resolveTransportWithRetryImpl: () => ({
        error:
          "port 27200 is not accepting connections yet — is Obsidian open with the vault loaded?",
      }),
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;

    const logged = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toContain("port 27200 is not accepting connections");
    // The method matters: a failing `initialize` and a failing
    // `tools/call` need different remedies, and the log line is all the
    // reporter can send us.
    expect(logged).toContain("initialize");
  });

  test("the failure is logged AND still answered — a channel added, not moved", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl: mock(async (_url: string, _init: FakeFetchInit) =>
        makeResponse(200, "application/json", "{}"),
      ),
      dataPath: "/fake/data.json",
      readTransportImpl: () => ({ error: "boom" }),
      resolveTransportWithRetryImpl: () => ({ error: "boom" }),
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;

    // A client that has NOT cancelled still owes a response with that id.
    const written = writeChunk.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain('"id":8');
    expect(written).toContain("boom");
    expect(log.mock.calls.length).toBeGreaterThan(0);
  });

  test("a fatal resolution failure is logged too, without the retry path", async () => {
    const stdin = fakeStdin();
    const log = mock((_msg: string) => {});
    const FATAL =
      "token 'tok-2' is no longer configured — re-export the .mcpb from Obsidian settings";
    const promise = invokeRunMain({
      stdin,
      writeChunk: mock((_s: string) => {}),
      log,
      fetchImpl: mock(async (_url: string, _init: FakeFetchInit) =>
        makeResponse(200, "application/json", "{}"),
      ),
      dataPath: "/fake/data.json",
      tokenId: "tok-2",
      readTransportImpl: () => ({ error: FATAL, fatal: true }),
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;

    expect(log.mock.calls.map((c) => c[0]).join("\n")).toContain("re-export");
  });

  test("notification (no id) never writes to stdout", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(200, "application/json", "{}"),
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/ping" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(writeChunk).not.toHaveBeenCalled();
  });

  test("multi-byte UTF-8 char split across two data events is reconstructed, not corrupted", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    let sentBody: string | undefined;
    const fetchImpl = mock(async (_url: string, init: FakeFetchInit) => {
      sentBody = init.body as string;
      return makeResponse(200, "application/json", "{}");
    });
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
    });
    // "€" is 3 bytes in UTF-8 (E2 82 AC); split it across two Buffers.
    const full = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/pay",
        params: { amount: "10€" },
      }) + "\n",
      "utf8",
    );
    const cut = full.indexOf(0xac); // last byte of the € sequence
    stdin.emit("data", full.subarray(0, cut));
    stdin.emit("data", full.subarray(cut));
    stdin.emit("end");
    await promise;
    expect(sentBody).toBeDefined();
    expect(JSON.parse(sentBody as string).params.amount).toBe("10€");
    expect(sentBody as string).not.toContain("�");
  });

  test("notification (no id), fetch rejects: still zero writeChunk calls, failure logged to stderr", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) => {
      throw connectionRefusedError();
    });
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/ping" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(writeChunk).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  test("request success, single line write", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const expected = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(200, "application/json", JSON.stringify(expected)),
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(writeChunk).toHaveBeenCalledTimes(1);
    const written = writeChunk.mock.calls[0][0];
    expect(JSON.parse(written.trimEnd())).toEqual(expected);
  });

  test("SSE notification-before-response batches into one writeChunk call, two lines", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    };
    const response = { jsonrpc: "2.0", id: 1, result: {} };
    const body = `data: ${JSON.stringify(notification)}\n\ndata: ${JSON.stringify(response)}\n\n`;
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(200, "text/event-stream", body),
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(writeChunk).toHaveBeenCalledTimes(1);
    const written = writeChunk.mock.calls[0][0];
    const lines = written.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(notification);
    expect(JSON.parse(lines[1])).toEqual(response);
  });

  test("connection-refused then retry succeeds", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const expected = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    let callCount = 0;
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) => {
      callCount++;
      if (callCount === 1) throw connectionRefusedError();
      return makeResponse(200, "application/json", JSON.stringify(expected));
    });
    const resolveTransportWithRetryImpl = mock(async () => successTransport);
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
      resolveTransportWithRetryImpl,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(writeChunk).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeChunk.mock.calls[0][0].trimEnd())).toEqual(expected);
  });

  test("connection-refused, retry also exhausted", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) => {
      throw connectionRefusedError();
    });
    const resolveTransportWithRetryImpl = mock(async () => ({
      error: "timed out waiting for the MCP server",
    }));
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
      resolveTransportWithRetryImpl,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await expect(promise).resolves.toBeUndefined();
    expect(writeChunk).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeChunk.mock.calls[0][0].trimEnd());
    expect(written.id).toBe(1);
    expect(written.error.code).toBe(LOCAL_ERROR_CODE);
  });

  test("per-request timeout", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const fetchImpl = (_url: string, options: FakeFetchInit) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
      requestTimeoutMs: 20,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(writeChunk).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeChunk.mock.calls[0][0].trimEnd());
    expect(written.error.message).toMatch(/timed out|timeout/i);
  });

  test("connection-refused then retried POST times out: reports timeout wording", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    let call = 0;
    const fetchImpl = (_url: string, options: FakeFetchInit) => {
      call += 1;
      if (call === 1) {
        return Promise.reject(connectionRefusedError());
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    };
    const resolveTransportWithRetryImpl = mock(async () => successTransport);
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
      resolveTransportWithRetryImpl,
      requestTimeoutMs: 20,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(writeChunk).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeChunk.mock.calls[0][0].trimEnd());
    expect(written.id).toBe(1);
    expect(written.error.message).toContain("request timed out after 20ms");
    expect(written.error.message).not.toContain("request failed");
  });

  test("stdin end waits for in-flight work", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const expected = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    const fetchImpl = mock(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                makeResponse(200, "application/json", JSON.stringify(expected)),
              ),
            5,
          );
        }),
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(writeChunk.mock.calls.length).toBe(1);
  });

  /**
   * Was "OBSIDIAN_MCP_DEBUG / debug option gates per-request tracing" until
   * #412 removed the flag: an installed .mcpb has no way to set it, so
   * gating the one line that proves the shim received a request made that
   * proof unobtainable for the only people who needed it. Tracing is now
   * unconditional. The payload half of the guarantee is unchanged and is
   * the half that actually protects the user.
   */
  test("per-request tracing is unconditional and never logs payloads", async () => {
    const marker = "PAYLOAD_MARKER_XYZ";
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(
        200,
        "application/json",
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
      ),
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { marker },
        }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;

    expect(
      log.mock.calls.filter((c) => String(c[0]).includes("-> tools/call")),
    ).toHaveLength(1);

    {
      for (const call of [...writeChunk.mock.calls, ...log.mock.calls]) {
        expect(String(call[0])).not.toContain(marker);
      }
    }
  });

  test("unparseable stdin line is logged and ignored, not fatal", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const expected = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(200, "application/json", JSON.stringify(expected)),
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
    });
    stdin.emit("data", Buffer.from("{not json\n"));
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(log).toHaveBeenCalled();
    expect(writeChunk).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeChunk.mock.calls[0][0].trimEnd())).toEqual(expected);
  });

  test("id-bearing request whose handler throws unexpectedly still gets a JSON-RPC error, never hangs", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(200, "application/json", "{}"),
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      // A bug elsewhere in the request path: throws instead of returning.
      readTransportImpl: () => {
        throw new Error("boom");
      },
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(writeChunk).toHaveBeenCalledTimes(1);
    const written = JSON.parse(writeChunk.mock.calls[0][0].trimEnd());
    expect(written.id).toBe(42);
    expect(written.error.code).toBe(LOCAL_ERROR_CODE);
    expect(written.error.message).toContain("unexpected error");
    expect(log).toHaveBeenCalled();
  });

  test("notification whose handler throws unexpectedly is logged only, never writes a response", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(200, "application/json", "{}"),
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => {
        throw new Error("boom");
      },
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/ping" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(writeChunk).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  /**
   * Was "debug logs the first-attempt failure before retrying; quiet mode
   * does not" until #412. The flag it gated on could not be set from an
   * installed .mcpb (no `env` in the generated manifest), so the line was
   * unreachable for exactly the people hitting the bug. It is now
   * unconditional, and this pins that it stays so.
   */
  test("the first-attempt failure is logged before retrying, with no flag to set", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    let callCount = 0;
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) => {
      callCount++;
      if (callCount === 1) throw connectionRefusedError();
      return makeResponse(
        200,
        "application/json",
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      );
    });
    const resolveTransportWithRetryImpl = mock(async () => successTransport);
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
      resolveTransportWithRetryImpl,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    expect(
      log.mock.calls.filter((c) => String(c[0]).includes("retrying once")),
    ).toHaveLength(1);
  });

  // ── MCP-Protocol-Version echo (items 1 & 4) ────────────────────────────────

  // Drives initialize then a follow-up request through runMain the way a real
  // client does: initialize completes (its response is written) before the
  // next request is sent. Returns the fetchImpl mock for header assertions.
  async function runInitializeThen(
    followUpMethod: string,
    initializeResult: Record<string, unknown>,
  ) {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const fetchImpl = mock(async (_url: string, init: FakeFetchInit) => {
      const body = JSON.parse(init.body as string);
      const result = body.method === "initialize" ? initializeResult : {};
      return makeResponse(
        200,
        "application/json",
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      );
    });
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => successTransport,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n",
      ),
    );
    // Let the initialize round-trip finish (and set the negotiated version)
    // before the follow-up request is sent, matching real client ordering.
    await new Promise((r) => setTimeout(r, 5));
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: followUpMethod }) +
          "\n",
      ),
    );
    stdin.emit("end");
    await promise;
    return fetchImpl;
  }

  function callForMethod(
    fetchImpl: ReturnType<typeof mock>,
    method: string,
  ): FakeFetchInit | undefined {
    const call = fetchImpl.mock.calls.find(
      (c) =>
        JSON.parse((c[1] as FakeFetchInit).body as string).method === method,
    );
    return call?.[1] as FakeFetchInit | undefined;
  }

  test("after initialize, the next request's POST echoes the negotiated MCP-Protocol-Version", async () => {
    const fetchImpl = await runInitializeThen("tools/list", {
      protocolVersion: "2025-03-26",
    });
    const followUp = callForMethod(fetchImpl, "tools/list");
    expect(followUp?.headers["MCP-Protocol-Version"]).toBe("2025-03-26");
  });

  test("the initialize POST itself carries no MCP-Protocol-Version header (not yet negotiated)", async () => {
    const fetchImpl = await runInitializeThen("tools/list", {
      protocolVersion: "2025-03-26",
    });
    const init = callForMethod(fetchImpl, "initialize");
    expect(init && "MCP-Protocol-Version" in init.headers).toBe(false);
  });

  test("initialize response without result.protocolVersion falls back to PROTOCOL_VERSION_FALLBACK", async () => {
    const fetchImpl = await runInitializeThen("tools/list", {});
    const followUp = callForMethod(fetchImpl, "tools/list");
    expect(followUp?.headers["MCP-Protocol-Version"]).toBe(
      PROTOCOL_VERSION_FALLBACK,
    );
  });

  // ── Progress notifications during retry (item 4) ───────────────────────────

  test("progressToken + transport retry emits notifications/progress before the response", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const expected = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(200, "application/json", JSON.stringify(expected)),
    );
    // Force the retry path (readTransport errors) and fire onAttempt twice.
    const resolveTransportWithRetryImpl = mock(
      async (_dataPath: string, opts: { onAttempt?: () => void }) => {
        opts.onAttempt?.();
        opts.onAttempt?.();
        return successTransport;
      },
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => ({ error: "not ready yet" }),
      resolveTransportWithRetryImpl,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { _meta: { progressToken: "p-42" } },
        }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;

    const written = writeChunk.mock.calls.map((c) => c[0] as string);
    const progressWrites = written.filter((s) =>
      s.includes("notifications/progress"),
    );
    expect(progressWrites.length).toBeGreaterThanOrEqual(1);
    const first = JSON.parse(progressWrites[0].trim());
    expect(first.method).toBe("notifications/progress");
    expect(first.params.progressToken).toBe("p-42");

    // Progress must be written BEFORE the final response.
    const firstProgressIdx = written.findIndex((s) =>
      s.includes("notifications/progress"),
    );
    const responseIdx = written.findIndex((s) => s.includes('"result"'));
    expect(firstProgressIdx).toBeLessThan(responseIdx);
  });

  test("no progressToken → never writes notifications/progress, even when the transport retries", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const expected = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    const fetchImpl = mock(async (_url: string, _init: FakeFetchInit) =>
      makeResponse(200, "application/json", JSON.stringify(expected)),
    );
    const resolveTransportWithRetryImpl = mock(
      async (_dataPath: string, opts: { onAttempt?: () => void }) => {
        // Even if the retry impl invokes the callback, the default no-op
        // must apply (handleRequest passes no progress callback here).
        opts.onAttempt?.();
        opts.onAttempt?.();
        return successTransport;
      },
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      fetchImpl,
      dataPath: "/fake/data.json",
      readTransportImpl: () => ({ error: "not ready yet" }),
      resolveTransportWithRetryImpl,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;

    const written = writeChunk.mock.calls.map((c) => c[0] as string);
    expect(written.some((s) => s.includes("notifications/progress"))).toBe(
      false,
    );
    // The real response is still delivered.
    expect(written.some((s) => s.includes('"result"'))).toBe(true);
  });
});

// ── Per-request deadline (issue #412) ────────────────────────────────────────

/**
 * Bounding each phase separately was not enough. On the retry path
 * `handleRequest` ran the retry window and the POST twice — 20s + 27s +
 * 20s + 27s ≈ 94s — while the file asserted in a comment that the sum
 * stayed under the MCP client's 60000ms default request timeout. It did
 * not, so the client cancelled while the shim was still working and the
 * failure left no trace on any channel. That is #412's log exactly:
 * initialize, sixty seconds of nothing, notifications/cancelled.
 */
describe("phase budgets", () => {
  test("retryWindowFor never spends what the POST after it needs", () => {
    // Plenty of budget: the normal window, unchanged.
    expect(retryWindowFor(60_000)).toBe(RETRY_WINDOW_MS);
    // Tight budget: reserves MIN_POST_BUDGET_MS for the POST.
    expect(retryWindowFor(5_000)).toBe(5_000 - MIN_POST_BUDGET_MS);
    // Nothing left over: no window at all rather than a negative one.
    expect(retryWindowFor(MIN_POST_BUDGET_MS)).toBe(0);
    expect(retryWindowFor(0)).toBe(0);
  });

  test("postTimeoutFor clamps down but never below a usable floor", () => {
    expect(postTimeoutFor(60_000)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(postTimeoutFor(10_000)).toBe(10_000 - WATCHDOG_GRACE_MS);
    // A ~0ms timeout would report a timeout on a request it never tried.
    expect(postTimeoutFor(0)).toBe(MIN_POST_TIMEOUT_MS);
    expect(postTimeoutFor(500)).toBe(MIN_POST_TIMEOUT_MS);
  });
});

describe("runMain — per-request deadline", () => {
  function fakeStdin() {
    const emitter = new EventEmitter();
    const rawEmit = emitter.emit.bind(emitter);
    let decoder: StringDecoder | null = null;
    (
      emitter as EventEmitter & { setEncoding(enc: BufferEncoding): unknown }
    ).setEncoding = (enc: BufferEncoding) => {
      decoder = new StringDecoder(enc);
      return emitter;
    };
    emitter.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event === "data" && decoder && Buffer.isBuffer(args[0])) {
        return rawEmit("data", decoder.write(args[0]));
      }
      return rawEmit(event as string, ...args);
    }) as typeof emitter.emit;
    return emitter;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * The whole point of the guard: an answer arrives even when the work
   * behind it does not. Here the transport read alone outlives the
   * deadline, which is the shape a vault on iCloud Drive produces.
   */
  test("answers within the deadline even when every phase overruns it", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const log = mock((_msg: string) => {});
    const startedAt = Date.now();
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log,
      dataPath: "/fake/data.json",
      requestDeadlineMs: 120,
      // Outlives the deadline by a wide margin, and resolves rather than
      // hanging so the run can still finish and be asserted on.
      readTransportImpl: async () => {
        await sleep(400);
        return { port: 27200, token: "tok" };
      },
      fetchImpl: mock(async (_url: string, _init: FakeFetchInit) =>
        makeResponse(
          200,
          "application/json",
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
        ),
      ),
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n",
      ),
    );

    // Long enough for the guard to fire, far short of the slow read.
    await sleep(200);
    expect(writeChunk).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(400);
    const answer = JSON.parse(writeChunk.mock.calls[0][0] as string);
    expect(answer.id).toBe(1);
    expect(answer.error.code).toBe(LOCAL_ERROR_CODE);
    expect(answer.error.message).toContain("120ms");
    // stderr too: a client that already gave up discards the response, so
    // stdout alone would leave the failure with no trace anywhere.
    expect(
      log.mock.calls.filter((c) => String(c[0]).includes("deadline")),
    ).toHaveLength(1);

    stdin.emit("end");
    await promise;
  });

  /**
   * Write-once, and this is what makes the guard safe to have at all: the
   * slow path below completes normally after the deadline has already been
   * answered, and must not put a second response for the same id on stdout.
   */
  test("a late-completing request never answers twice", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log: mock((_msg: string) => {}),
      dataPath: "/fake/data.json",
      requestDeadlineMs: 60,
      readTransportImpl: async () => {
        await sleep(150);
        return { port: 27200, token: "tok" };
      },
      fetchImpl: mock(async (_url: string, _init: FakeFetchInit) =>
        makeResponse(
          200,
          "application/json",
          JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }),
        ),
      ),
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;

    expect(writeChunk).toHaveBeenCalledTimes(1);
    const answer = JSON.parse(writeChunk.mock.calls[0][0] as string);
    expect(answer.error).toBeDefined();
    expect(answer.result).toBeUndefined();
  });

  /**
   * A retry window is a promise to keep polling for that long. Entered near
   * the end of the budget it cannot keep that promise, so it must be told
   * how long it really has instead of starting its full 20s.
   */
  test("the retry window is clamped to what is left of the budget", async () => {
    const stdin = fakeStdin();
    const seenWindows: unknown[] = [];
    const resolveTransportWithRetryImpl = mock(
      async (_p: string, options: { windowMs?: number }) => {
        seenWindows.push(options.windowMs);
        return { port: 27200, token: "tok" };
      },
    );
    const promise = invokeRunMain({
      stdin,
      writeChunk: mock((_s: string) => {}),
      log: mock((_msg: string) => {}),
      dataPath: "/fake/data.json",
      requestDeadlineMs: 5_000,
      readTransportImpl: () => ({ error: "not ready yet" }),
      resolveTransportWithRetryImpl,
      fetchImpl: mock(async (_url: string, _init: FakeFetchInit) =>
        makeResponse(
          200,
          "application/json",
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
        ),
      ),
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;

    expect(seenWindows).toHaveLength(1);
    const windowMs = seenWindows[0] as number;
    expect(windowMs).toBeLessThanOrEqual(5_000 - MIN_POST_BUDGET_MS);
    expect(windowMs).toBeGreaterThan(0);
    expect(windowMs).toBeLessThan(RETRY_WINDOW_MS);
  });

  /**
   * With almost none of the budget left, re-resolving and posting a second
   * time can only end in the deadline — which would replace a named cause
   * ("connection refused") with a generic timeout. Report what is known.
   */
  test("skips the second pass when the budget cannot cover it", async () => {
    const stdin = fakeStdin();
    const writeChunk = mock((_s: string) => {});
    const resolveTransportWithRetryImpl = mock(async () => ({
      port: 27200,
      token: "tok",
    }));
    const promise = invokeRunMain({
      stdin,
      writeChunk,
      log: mock((_msg: string) => {}),
      dataPath: "/fake/data.json",
      // Below MIN_RETRY_PASS_MS from the very first millisecond.
      requestDeadlineMs: 1_000,
      readTransportImpl: () => ({ port: 27200, token: "tok" }),
      fetchImpl: mock(async (_url: string, _init: FakeFetchInit) => {
        throw connectionRefusedError();
      }),
      resolveTransportWithRetryImpl,
    });
    stdin.emit(
      "data",
      Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
      ),
    );
    stdin.emit("end");
    await promise;

    expect(resolveTransportWithRetryImpl).toHaveBeenCalledTimes(0);
    const answer = JSON.parse(writeChunk.mock.calls[0][0] as string);
    expect(answer.error.message).toContain("fetch failed");
  });
});

// ── httpFetch: the node:http transport (issue #412) ──────────────────────────

/**
 * Exercised against a real server on a real socket. The reason this
 * replaced the global fetch() is environmental — under Claude Desktop's
 * UtilityProcess sandbox an AbortSignal did not cancel an in-flight
 * fetch() — and a fake would assert nothing about that.
 */
describe("httpFetch", () => {
  let server: import("http").Server;
  let port: number;
  /** Set per test to decide how the next request is answered. */
  let respond: (
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
  ) => void;

  beforeEach(async () => {
    const http = await import("http");
    respond = (_req, res) => res.end();
    server = http.createServer((req, res) => respond(req, res));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterEach(async () => {
    // The abort test deliberately leaves a request the server never
    // answered, and close() alone waits for it. Cast because the @types
    // in use predate the method; the optional call keeps it safe if the
    // runtime predates it too.
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("posts a body and reads back status, content-type and text", async () => {
    let seenBody = "";
    let seenAuth: string | undefined;
    respond = (req, res) => {
      req.setEncoding("utf8");
      req.on("data", (c: string) => {
        seenBody += c;
      });
      req.on("end", () => {
        seenAuth = req.headers.authorization;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      });
    };

    const res = await httpFetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      body: '{"id":1}',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(seenBody).toBe('{"id":1}');
    expect(seenAuth).toBe("Bearer tok");
  });

  /**
   * An activation call answers with SSE so a tools/list_changed can ride
   * the same response. The body must arrive whole; parseSse handles it
   * afterwards.
   */
  test("reads a text/event-stream body to completion", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n');
      res.end();
    };

    const res = await httpFetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      body: "{}",
    });

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(parseSse(await res.text())).toEqual([{ jsonrpc: "2.0", id: 1 }]);
  });

  test("reports a non-2xx status rather than throwing", async () => {
    respond = (_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"error":"nope"}');
    };

    const res = await httpFetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("a header the response does not carry reads as null", async () => {
    respond = (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    };
    const res = await httpFetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      body: "{}",
    });
    expect(res.headers.get("x-not-sent")).toBeNull();
  });

  /**
   * The defect this whole transport swap exists for: aborting must really
   * end the request, not merely stop waiting on it. Rejecting as an
   * AbortError is what makes the caller report a timeout instead of a
   * socket error.
   */
  test("aborting a stalled request rejects as an AbortError", async () => {
    respond = () => {
      /* never answers */
    };
    const controller = new AbortController();
    const pending = httpFetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("an already-aborted signal never reaches the network", async () => {
    let hits = 0;
    respond = (_req, res) => {
      hits += 1;
      res.end("ok");
    };
    const controller = new AbortController();
    controller.abort();

    await expect(
      httpFetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(hits).toBe(0);
  });
});

describe("isEntryPoint — the shim must start under both loaders (#412)", () => {
  // Same double-cast seam as the rest of this file: the shim is untyped
  // CommonJS, so tsc infers `NodeJS.Module` here and a plain object literal
  // cannot satisfy it structurally.
  type ThisModule = Parameters<typeof isEntryPoint>[1];
  const fakeModule = (id: string) => ({ id }) as unknown as ThisModule;

  const SHIM = "/Applications/ext/server/index.js";

  test("plain `node server/index.js`: require.main is this module", () => {
    const self = fakeModule("shim");
    expect(isEntryPoint(self, self, SHIM, SHIM)).toBe(true);
  });

  test("Claude Desktop's built-in Node: require.main is the host, argv still points here", () => {
    // The regression. nodeHost.js imports the bundle through the ESM loader
    // and sets process.argv = ["node", entryPoint, ...] just before, so
    // require.main is the host's module and only argv identifies us.
    expect(
      isEntryPoint(fakeModule("nodeHost"), fakeModule("shim"), SHIM, SHIM),
    ).toBe(true);
  });

  test("argv1 given relatively still resolves to the same file", () => {
    const cwd = process.cwd();
    expect(
      isEntryPoint(
        fakeModule("nodeHost"),
        fakeModule("shim"),
        "./index.js",
        `${cwd}/index.js`,
      ),
    ).toBe(true);
  });

  test("required from a test: neither arm matches, so main() stays put", () => {
    // What keeps importing this file from starting a real server — argv1 is
    // the test runner's entry, not the shim.
    expect(
      isEntryPoint(
        fakeModule("bun-test"),
        fakeModule("shim"),
        "/repo/scripts/connectorShim.test.ts",
        SHIM,
      ),
    ).toBe(false);
  });

  test("no require.main and no argv1: no evidence, so no", () => {
    expect(isEntryPoint(undefined, fakeModule("shim"), undefined, SHIM)).toBe(
      false,
    );
    expect(isEntryPoint(undefined, fakeModule("shim"), "", SHIM)).toBe(false);
  });
});
