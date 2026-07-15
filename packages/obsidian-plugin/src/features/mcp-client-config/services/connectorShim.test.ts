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
  postJsonRpc,
  runMain,
  RETRY_WINDOW_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION_FALLBACK,
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

describe("buildErrorResponse", () => {
  test("without data", () => {
    expect(buildErrorResponse(5, "boom")).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32000, message: "obsidian-mcp-connector: boom" },
    });
  });

  test("with data", () => {
    expect(buildErrorResponse(5, "boom", { port: 27200 })).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: expect.objectContaining({
        code: -32000,
        message: "obsidian-mcp-connector: boom",
        data: { port: 27200 },
      }),
    });
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
        code: -32000,
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
    expect(result[0].error.message).toContain("401");
    expect(result[0].error.message).toMatch(/token/i);
  });

  test("status 500", () => {
    const result = resolveResponseMessages("application/json", "", 1, 500);
    expect(result).toHaveLength(1);
    expect(result[0].error.message).toContain("500");
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

  test("valid file", () => {
    const dataPath = path.join(dir, "data.json");
    fs.writeFileSync(
      dataPath,
      JSON.stringify({ mcpTransport: { livePort: 27200, bearerToken: "tok" } }),
    );
    expect(readTransport(dataPath)).toEqual({ port: 27200, token: "tok" });
  });

  test("missing file", () => {
    const dataPath = path.join(dir, "nonexistent", "data.json");
    const result = readTransport(dataPath);
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain(dataPath);
  });

  test("malformed JSON on disk", () => {
    const dataPath = path.join(dir, "data.json");
    fs.writeFileSync(dataPath, "not json");
    const result = readTransport(dataPath);
    expect(typeof result.error).toBe("string");
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
    expect(written.error.code).toBe(-32000);
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

  test("OBSIDIAN_MCP_DEBUG / debug option gates per-request tracing, never logs payloads", async () => {
    const marker = "PAYLOAD_MARKER_XYZ";
    async function runWithDebug(debug: boolean) {
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
        debug,
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
      return { writeChunk, log };
    }

    const withoutDebug = await runWithDebug(false);
    const withDebug = await runWithDebug(true);

    expect(withDebug.log.mock.calls.length).toBeGreaterThan(
      withoutDebug.log.mock.calls.length,
    );

    for (const { writeChunk, log } of [withoutDebug, withDebug]) {
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
    expect(written.error.code).toBe(-32000);
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

  test("debug logs the first-attempt failure before retrying; quiet mode does not", async () => {
    async function run(debug: boolean) {
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
        debug,
      });
      stdin.emit(
        "data",
        Buffer.from(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) +
            "\n",
        ),
      );
      stdin.emit("end");
      await promise;
      return log;
    }
    const debugLog = await run(true);
    const quietLog = await run(false);
    const retries = (l: typeof debugLog) =>
      l.mock.calls.filter((c) => String(c[0]).includes("retrying once"));
    expect(retries(debugLog)).toHaveLength(1);
    expect(retries(quietLog)).toHaveLength(0);
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
