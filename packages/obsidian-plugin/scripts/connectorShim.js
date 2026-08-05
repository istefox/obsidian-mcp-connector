#!/usr/bin/env node
"use strict";

/*
 * This script is not part of the Obsidian plugin's own renderer bundle: it
 * is a standalone, zero-dependency Node.js CLI (embedded as a string via
 * assets/connectorShimSource.ts and shipped inside the .mcpb package),
 * launched as its own separate process by Claude Desktop and executed by a
 * plain `node`, never loaded inside Obsidian's sandboxed window. require()
 * of Node built-ins and bare setTimeout/clearTimeout are the correct APIs
 * for that runtime — `window` and `requestUrl` do not exist there. That is
 * also why it lives under scripts/, not src/: it must not be linted against
 * Obsidian plugin (renderer) rules. See
 * docs/architecture/ADR-0013-mcpb-pure-node-shim.md.
 *
 * The HTTP call goes through `node:http` rather than the global fetch():
 * under Claude Desktop's UtilityProcess sandbox an AbortSignal does not
 * reliably cancel an in-flight fetch(), so a stalled request stayed alive
 * behind a watchdog that could only make the *promise* settle. Destroying
 * an http.ClientRequest closes the socket for real. It also matches
 * scripts/obsidian_mcp_bridge.py, which has always used urllib with a
 * timeout, so the two proxies fail the same way. See issue #412.
 */

const fs = require("fs");
const net = require("net");
const http = require("http");

/**
 * @typedef {Object} JsonRpcMessage
 * @property {string} [jsonrpc]
 * @property {string|number|null} [id]
 * @property {string} [method]
 * @property {{ _meta?: { progressToken?: string|number } }} [params]
 * @property {Record<string, unknown> & { protocolVersion?: string }} [result]
 * @property {{ code: number, message: string, data?: unknown }} [error]
 */

/**
 * @typedef {Object} TransportOk
 * @property {number} port
 * @property {string} token
 * @property {undefined} [error]
 * @property {undefined} [fatal] Declared so `.fatal` narrows on the
 *   union, like `error` above. Type-only: nothing ever sets it here, so
 *   a success result stays a bare `{ port, token }` at runtime.
 */

/**
 * @typedef {Object} TransportErr
 * @property {string} error
 * @property {undefined} [port]
 * @property {undefined} [token]
 * @property {boolean} [fatal] Permanent: retrying cannot change it, so
 *   callers must report it immediately and verbatim. Opt-in per error —
 *   absent means "might resolve on the next poll", which is the default
 *   and covers every startup race.
 */

/** @typedef {TransportOk | TransportErr} TransportResult */

/**
 * The seam callers inject a transport reader through. Deliberately wider
 * than `typeof readTransport`: that one became async for #412, while every
 * call site only ever `await`s the result, so a synchronous reader stays
 * just as valid and the suite's plain `() => transport` fakes keep working.
 *
 * @typedef {(
 *   dataPath: string,
 *   options?: { readFile?: typeof fs.promises.readFile },
 *   tokenId?: string,
 * ) => TransportResult | Promise<TransportResult>} ReadTransportLike
 */

/**
 * @typedef {Object} PostJsonRpcResult
 * @property {number} status
 * @property {string} contentType
 * @property {string} rawBody
 */

/**
 * Safely extract a diagnostic message from a caught value. JS lets `throw`
 * raise anything, not just an Error instance.
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * @param {string} remainder
 * @param {string} chunk
 * @returns {{ lines: string[], remainder: string }}
 */
function splitLines(remainder, chunk) {
  const combined = remainder + chunk;
  const parts = combined.split("\n");
  const newRemainder = parts.pop();
  return { lines: parts, remainder: newRemainder ?? "" };
}

/**
 * @param {string} line
 * @returns {
 *   { skip: true, error?: undefined, message?: undefined } |
 *   { error: string, skip?: undefined, message?: undefined } |
 *   { message: JsonRpcMessage, skip?: undefined, error?: undefined }
 * }
 */
function parseJsonRpcLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return { skip: true };
  /** @type {unknown} */
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    return { error: `unparseable stdin line: ${errorMessage(err)}` };
  }
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    return { error: "stdin line is not a JSON-RPC object" };
  }
  return { message: /** @type {JsonRpcMessage} */ (message) };
}

/**
 * The secret of the token with this id, or undefined when the vault no
 * longer carries it.
 * @param {unknown} tokens
 * @param {string} tokenId
 * @returns {string|undefined}
 */
function findTokenSecret(tokens, tokenId) {
  if (!Array.isArray(tokens)) return undefined;
  for (const entry of tokens) {
    if (
      entry &&
      typeof entry === "object" &&
      entry.id === tokenId &&
      typeof entry.token === "string"
    ) {
      return entry.token;
    }
  }
  return undefined;
}

/**
 * Resolve the port and the secret this bundle presents.
 *
 * `tokenId` is baked into the .mcpb at export time. Omitted — which is
 * every bundle generated before per-token bundles existed, and every
 * bundle exported for the mirror token — it reads the legacy
 * `mcpTransport.bearerToken`, so bundles already in the wild resolve
 * exactly as before. Given, it resolves STRICTLY by id: an id no longer
 * in `tokens[]` is a hard error and never falls back to `bearerToken`,
 * because that fallback would turn revoking a client's token into
 * handing it the default token's surface.
 *
 * @param {string} jsonText
 * @param {string} [tokenId]
 * @returns {TransportResult}
 */
function parseTransportFile(jsonText, tokenId) {
  /** @type {{ mcpTransport?: { livePort?: unknown, bearerToken?: unknown, tokens?: unknown } }} */
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (err) {
    return { error: `data.json is not valid JSON: ${errorMessage(err)}` };
  }
  const transport = (data && data.mcpTransport) || {};
  const port = transport.livePort;
  if (typeof port !== "number") {
    return { error: "data.json mcpTransport.livePort must be a number" };
  }
  if (tokenId) {
    const secret = findTokenSecret(transport.tokens, tokenId);
    if (secret === undefined) {
      // Fatal: `tokens[]` is persisted settings, so a missing id cannot
      // reappear without a user action in Obsidian AND a fresh export.
      // Polling for it would cost the full retry window on every single
      // request and end with a suffix telling the user to check whether
      // Obsidian is open, which it demonstrably is.
      return {
        error: `token '${tokenId}' is no longer configured — re-export the .mcpb from Obsidian settings`,
        fatal: true,
      };
    }
    return { port, token: secret };
  }
  const token = transport.bearerToken;
  if (typeof token !== "string") {
    return { error: "data.json mcpTransport.bearerToken must be a string" };
  }
  return { port, token };
}

/**
 * Every error this shim raises is local to the proxy — it could not read
 * data.json, nothing is listening, the body came back unparseable — and
 * none is defined by the MCP specification.
 *
 * MCP `2026-07-28` partitions the JSON-RPC server-error range: `-32000`
 * to `-32019` is legacy ("new implementations SHOULD NOT use codes from
 * this sub-range at all", and receivers "MUST NOT assume any specific
 * meaning" for them), `-32020` to `-32099` belongs to the specification
 * and may only carry spec-defined meanings. For anything else the rule
 * is to allocate outside the reserved range entirely, which is what this
 * does. `-33000` sits below `-32768`, so it can never collide with a
 * protocol-defined code, present or future.
 *
 * The Python bridge uses the same value for the same reason; the two
 * proxies answer the same client and their failures should not look like
 * different classes of problem.
 */
const LOCAL_ERROR_CODE = -33000;

/**
 * @param {string|number|null|undefined} id
 * @param {string} message
 * @param {unknown} [data]
 * @returns {JsonRpcMessage}
 */
function buildErrorResponse(id, message, data) {
  /** @type {{ code: number, message: string, data?: unknown }} */
  const error = {
    code: LOCAL_ERROR_CODE,
    message: `obsidian-mcp-connector: ${message}`,
  };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/**
 * @param {string|number} progressToken
 * @param {number} progress
 * @param {string} [message]
 * @returns {{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: string|number, progress: number, message?: string } }}
 */
function buildProgressNotification(progressToken, progress, message) {
  return {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken, progress, ...(message ? { message } : {}) },
  };
}

const SSE_LINE_SPLIT = /\r\n|\r|\n/;

/**
 * @param {string} body
 * @returns {JsonRpcMessage[]}
 */
function parseSse(body) {
  /** @type {JsonRpcMessage[]} */
  const messages = [];
  /** @type {string[]} */
  let dataLines = [];
  const dispatch = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    dataLines = [];
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      messages.push(/** @type {JsonRpcMessage} */ (parsed));
    }
  };
  for (const line of body.split(SSE_LINE_SPLIT)) {
    if (line === "") {
      dispatch();
    } else if (line.startsWith(":")) {
      continue;
    } else if (line.startsWith("data:")) {
      let value = line.slice("data:".length);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
    }
    // else: event:, id:, retry:, or unknown field — ignored.
  }
  dispatch();
  return messages;
}

/**
 * @param {JsonRpcMessage[]} messages
 * @param {string|number|null|undefined} requestId
 * @returns {{ notifications: JsonRpcMessage[], response: JsonRpcMessage | null }}
 */
function routeSseMessages(messages, requestId) {
  /** @type {JsonRpcMessage[]} */
  const notifications = [];
  /** @type {JsonRpcMessage | null} */
  let response = null;
  for (const msg of messages) {
    if (
      response === null &&
      Object.prototype.hasOwnProperty.call(msg, "id") &&
      msg.id === requestId
    ) {
      response = msg;
    } else {
      notifications.push(msg);
    }
  }
  return { notifications, response };
}

/**
 * @param {string} contentType
 * @param {string} rawBody
 * @param {string|number|null|undefined} requestId
 * @param {number} status
 * @returns {JsonRpcMessage[]}
 */
function resolveResponseMessages(contentType, rawBody, requestId, status) {
  if (status === 401) {
    return [
      buildErrorResponse(
        requestId,
        `unauthorized (HTTP 401) — bearer token may be stale; re-export the .mcpb or check Settings > Access Control`,
        { status },
      ),
    ];
  }
  if (status >= 400) {
    return [
      buildErrorResponse(requestId, `server error (HTTP ${status})`, {
        status,
      }),
    ];
  }
  if (!rawBody) {
    return [buildErrorResponse(requestId, `empty response (HTTP ${status})`)];
  }

  const mediaType = (contentType || "").split(";")[0].trim().toLowerCase();

  if (mediaType === "text/event-stream") {
    const { notifications, response } = routeSseMessages(
      parseSse(rawBody),
      requestId,
    );
    if (response === null) {
      return [
        ...notifications,
        buildErrorResponse(requestId, `non-JSON response (HTTP ${status})`),
      ];
    }
    return [...notifications, response];
  }

  try {
    return [/** @type {JsonRpcMessage} */ (JSON.parse(rawBody))];
  } catch {
    return [
      buildErrorResponse(requestId, `non-JSON response (HTTP ${status})`),
    ];
  }
}

/**
 * Asynchronous on purpose. `readFileSync` blocks the event loop, and a
 * vault on iCloud Drive or any network mount can make a single read take
 * seconds — during which no timer fires, so neither the per-request
 * deadline nor the watchdog below can save the request and the shim goes
 * completely silent until the client gives up (issue #412). Reading on the
 * threadpool keeps the timers alive.
 *
 * @param {string} dataPath
 * @param {{ readFile?: typeof fs.promises.readFile }} [options]
 * @param {string} [tokenId]
 * @returns {Promise<TransportResult>}
 */
async function readTransport(
  dataPath,
  { readFile = fs.promises.readFile } = {},
  tokenId,
) {
  /** @type {string} */
  let text;
  try {
    text = /** @type {string} */ (await readFile(dataPath, "utf8"));
  } catch (err) {
    return { error: `could not read ${dataPath}: ${errorMessage(err)}` };
  }
  return parseTransportFile(text, tokenId);
}

/**
 * @param {number} port
 * @param {{ createConnection?: typeof net.createConnection }} [options]
 * @returns {Promise<boolean>}
 */
function probePort(port, { createConnection = net.createConnection } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    /** @param {boolean} ok */
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

const RETRY_WINDOW_MS = 20000;
const RETRY_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 25000;
// Grace period added on top of the AbortController-based timeout. Guards against
// environments (observed: Claude Desktop's UtilityProcess sandbox on macOS) where
// AbortController.abort() does not reliably cancel an in-flight fetch().
const WATCHDOG_GRACE_MS = 2000;

/**
 * Hard ceiling on one request, start to answer, whichever internal path it
 * takes. Bounding the phases individually was not enough: the retry path
 * runs the retry window and the POST twice, which sums to ~94s — past the
 * MCP client's 60000ms default request timeout, so the client cancelled
 * while the shim was still working and the failure left no trace anywhere
 * (issue #412). Every phase below is clamped to what is left of this, and
 * a guard timer answers if something outside those phases still stalls.
 */
const REQUEST_DEADLINE_MS = 45000;
// Never let the retry window eat the budget the POST after it needs.
const MIN_POST_BUDGET_MS = 3000;
// A POST is always given at least this much, even at the very end of the
// budget: a timeout of ~0ms would report a timeout it never really tried.
const MIN_POST_TIMEOUT_MS = 1000;
// Below this, re-resolving and posting a second time cannot finish, so the
// error already in hand is reported instead of being replaced by a deadline.
const MIN_RETRY_PASS_MS = 5000;
// Above this, a phase is slow enough to be worth a line in the client log.
const SLOW_PHASE_LOG_MS = 1000;
// Echoed back in the MCP-Protocol-Version header when the initialize response
// omits protocolVersion. Mirrors the Python bridge's PROTOCOL_VERSION_FALLBACK.
const PROTOCOL_VERSION_FALLBACK = "2025-06-18";

/**
 * Milliseconds left before `deadline`, never negative.
 * @param {number} deadline
 * @returns {number}
 */
function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

/**
 * @param {number} remaining
 * @returns {number}
 */
function retryWindowFor(remaining) {
  return Math.max(0, Math.min(RETRY_WINDOW_MS, remaining - MIN_POST_BUDGET_MS));
}

/**
 * @param {number} remaining
 * @returns {number}
 */
function postTimeoutFor(remaining) {
  return Math.max(
    MIN_POST_TIMEOUT_MS,
    Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remaining - WATCHDOG_GRACE_MS),
  );
}

/**
 * @param {string} dataPath
 * @param {{
 *   readTransportImpl?: ReadTransportLike,
 *   probePortImpl?: typeof probePort,
 *   nowImpl?: () => number,
 *   sleepMsImpl?: (ms: number) => Promise<void>,
 *   windowMs?: number,
 *   intervalMs?: number,
 *   onAttempt?: () => void,
 *   tokenId?: string,
 * }} [options]
 * @returns {Promise<TransportResult>}
 */
async function resolveTransportWithRetry(
  dataPath,
  {
    readTransportImpl = readTransport,
    probePortImpl = probePort,
    nowImpl = Date.now,
    sleepMsImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
    windowMs = RETRY_WINDOW_MS,
    intervalMs = RETRY_INTERVAL_MS,
    onAttempt = () => {},
    tokenId,
  } = {},
) {
  const deadline = nowImpl() + windowMs;
  let lastError = "timed out waiting for the MCP server";
  while (nowImpl() < deadline) {
    const resolved = await readTransportImpl(dataPath, {}, tokenId);
    // Returned verbatim, before onAttempt and before the sleep: the
    // suffix below is written for a transient timeout and is actively
    // wrong on a permanent failure, where it would contradict the
    // instruction it lands next to.
    if (resolved.fatal) return resolved;
    if (resolved.error) {
      lastError = resolved.error;
    } else if (await probePortImpl(resolved.port)) {
      return resolved;
    } else {
      lastError = `port ${resolved.port} is not accepting connections yet`;
    }
    onAttempt();
    await sleepMsImpl(intervalMs);
  }
  return { error: `${lastError} — is Obsidian open with the vault loaded?` };
}

/**
 * An Error whose `name` makes {@link isAbortError} recognise it, so a
 * cancelled request reports as a timeout rather than as a socket error.
 * @param {string} message
 * @returns {Error}
 */
function abortError(message) {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/**
 * The slice of the fetch() surface {@link postJsonRpc} actually consumes:
 * `status`, `headers.get()` and `text()`. Nothing else is implemented,
 * because nothing else is used — this is a transport, not a polyfill.
 *
 * @typedef {Object} MinimalResponse
 * @property {number} status
 * @property {{ get: (name: string) => string | null }} headers
 * @property {() => Promise<string>} text
 */

/**
 * @typedef {(url: string, init?: {
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: string,
 *   signal?: AbortSignal,
 * }) => Promise<MinimalResponse>} FetchLike
 */

/**
 * `fetch`-shaped POST over `node:http`. Kept signature-compatible with the
 * global fetch() so it can stay the default of the `fetchImpl` seam every
 * test already injects through.
 *
 * Unlike fetch() under Claude Desktop's UtilityProcess sandbox, aborting
 * here destroys the socket, so a stalled request stops consuming the
 * request's remaining budget instead of merely losing its promise race.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }} [init]
 * @returns {Promise<MinimalResponse>}
 */
function httpFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    /** @type {URL} */
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method || "GET",
        headers: init.headers,
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("error", reject);
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              get: (name) => {
                const value = res.headers[String(name).toLowerCase()];
                if (value === undefined) return null;
                return Array.isArray(value) ? value.join(", ") : value;
              },
            },
            text: async () => body,
          });
        });
      },
    );
    req.on("error", reject);
    const { signal } = init;
    if (signal) {
      // Reject here rather than leaving it to the `error` event that
      // destroy() may or may not emit. Node and Bun disagree on that —
      // under Bun an aborted in-flight request emitted nothing at all and
      // the promise stayed pending forever, which is the very failure mode
      // this transport exists to remove. Cancelling is our decision, so we
      // report it ourselves and destroy the socket to make it real.
      const cancel = () => {
        req.destroy();
        reject(abortError("request aborted"));
      };
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener("abort", cancel, { once: true });
    }
    req.end(init.body);
  });
}

/**
 * @param {string} url
 * @param {string} token
 * @param {JsonRpcMessage} message
 * @param {number} timeoutMs
 * @param {{
 *   fetchImpl?: FetchLike,
 *   protocolVersion?: string | null,
 *   watchdogGraceMs?: number,
 * }} [options]
 * @returns {Promise<PostJsonRpcResult>}
 */
async function postJsonRpc(
  url,
  token,
  message,
  timeoutMs,
  {
    fetchImpl = httpFetch,
    protocolVersion,
    watchdogGraceMs = WATCHDOG_GRACE_MS,
  } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  // Only echo the negotiated version once initialize has completed; before
  // that protocolVersion is falsy and the header is omitted.
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;

  const attempt = (async () => {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const rawBody = await res.text();
      return {
        status: res.status,
        contentType: res.headers.get("content-type") || "",
        rawBody,
      };
    } finally {
      clearTimeout(timer);
    }
  })();
  // If the watchdog below wins the race, `attempt` is abandoned but may still
  // settle later on its own. Swallow that so it never surfaces as an
  // unhandled rejection.
  attempt.catch(() => {});

  // Redundant now that the default transport is node:http, where destroying
  // the request really does cancel it — but `fetchImpl` is an injection seam
  // and this is a distributed artefact, so the last line of defence stays.
  // Guarantees postJsonRpc settles even if a fetchImpl ignores the signal.
  const watchdog = new Promise((_resolve, reject) => {
    setTimeout(
      () =>
        reject(
          abortError(
            `watchdog: no response within ${timeoutMs + watchdogGraceMs}ms (AbortController may not be honored in this environment)`,
          ),
        ),
      timeoutMs + watchdogGraceMs,
    );
  });

  return /** @type {Promise<PostJsonRpcResult>} */ (
    Promise.race([attempt, watchdog])
  );
}

/**
 * @param {{
 *   stdin?: NodeJS.ReadStream,
 *   writeChunk?: (s: string) => void,
 *   fetchImpl?: FetchLike,
 *   dataPath: string,
 *   log?: (msg: string) => void,
 *   requestTimeoutMs?: number,
 *   requestDeadlineMs?: number,
 *   resolveTransportWithRetryImpl?: typeof resolveTransportWithRetry,
 *   readTransportImpl?: ReadTransportLike,
 *   tokenId?: string,
 * }} options
 * @returns {Promise<void>}
 */
function runMain({
  stdin = process.stdin,
  writeChunk = (s) => process.stdout.write(s),
  fetchImpl = httpFetch,
  dataPath,
  // No `debug` flag any more. Everything worth logging is logged
  // unconditionally: an installed .mcpb cannot set OBSIDIAN_MCP_DEBUG,
  // because the generated manifest carries no `env` (`user_config?: never`
  // in mcpbGenerator.ts), so a gated line is a line the only people who
  // hit the bug can never produce. What is left is one line per request
  // plus failures — never payloads, which the suite pins.
  log = (msg) => process.stderr.write(`obsidian-mcp-connector: ${msg}\n`),
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  requestDeadlineMs = REQUEST_DEADLINE_MS,
  resolveTransportWithRetryImpl = resolveTransportWithRetry,
  readTransportImpl = readTransport,
  tokenId,
} = {}) {
  /** @type {Promise<void>[]} */
  const pending = [];
  let remainder = "";
  /** @type {string | null} */
  let negotiatedProtocolVersion = null;

  /**
   * @param {JsonRpcMessage} message
   */
  async function handleRequest(message) {
    const id = message.id;
    const startedAt = Date.now();
    const deadline = startedAt + requestDeadlineMs;
    // Unconditional: this is the only proof the shim received anything at
    // all, which is exactly what #412's log could not show.
    log(`-> ${message.method} (id=${id})`);

    // Write-once channel. Every exit below goes through it, so the guard
    // timer can answer a stalled request without any risk of a second
    // response for the same id arriving later if the slow path completes.
    let answered = false;
    /** @param {JsonRpcMessage[]} messages */
    const answer = (messages) => {
      if (answered) return;
      answered = true;
      writeChunk(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    };
    const guard = setTimeout(() => {
      log(
        `${message.method} (id=${id}) hit the ${requestDeadlineMs}ms deadline with no response`,
      );
      answer([
        buildErrorResponse(
          id,
          `no response within ${requestDeadlineMs}ms — is Obsidian open with the vault loaded?`,
        ),
      ]);
    }, requestDeadlineMs);

    // The caller's own timeout is a ceiling the budget may lower but never
    // raise, so a test injecting a small requestTimeoutMs still gets it.
    const postBudget = () =>
      Math.min(requestTimeoutMs, postTimeoutFor(remainingMs(deadline)));

    try {
      // A client requesting progress sets params._meta.progressToken; while the
      // transport is being re-resolved (server still booting), emit a
      // notifications/progress per poll iteration so the client sees liveness.
      const progressToken =
        message.params && message.params._meta
          ? message.params._meta.progressToken
          : undefined;
      let progressCount = 0;
      const onAttempt = progressToken
        ? () => {
            progressCount += 1;
            writeChunk(
              JSON.stringify(
                buildProgressNotification(progressToken, progressCount),
              ) + "\n",
            );
          }
        : undefined;
      const readStartedAt = Date.now();
      let transport = await readTransportImpl(dataPath, {}, tokenId);
      const readMs = Date.now() - readStartedAt;
      // A vault on iCloud Drive or a network mount can make this read the
      // whole story. Naming its cost turns that from a theory into a fact
      // the next report carries by itself.
      if (readMs > SLOW_PHASE_LOG_MS)
        log(`reading ${dataPath} took ${readMs}ms`);
      // A permanent failure is never escalated to the retry loop.
      if (transport.error && !transport.fatal) {
        transport = await resolveTransportWithRetryImpl(dataPath, {
          onAttempt,
          tokenId,
          windowMs: retryWindowFor(remainingMs(deadline)),
        });
      }
      if (transport.error) {
        // stderr as well as stdout. A client that has already timed out
        // this request discards the response below, so stdout alone means
        // the failure leaves no trace anywhere — which is how #412 arrived
        // with a log containing no reason. stderr is also the only channel
        // an installed .mcpb has at all. Matches handleNotification below,
        // which has always logged this.
        log(`${message.method} (id=${id}) failed: ${transport.error}`);
        answer([buildErrorResponse(id, transport.error)]);
        return;
      }
      const url = `http://127.0.0.1:${transport.port}/mcp`;
      /** @type {PostJsonRpcResult} */
      let result;
      let attemptTimeoutMs = postBudget();
      try {
        result = await postJsonRpc(
          url,
          transport.token,
          message,
          attemptTimeoutMs,
          { fetchImpl, protocolVersion: negotiatedProtocolVersion },
        );
      } catch (err) {
        if (isAbortError(err)) {
          answer([
            buildErrorResponse(
              id,
              `request timed out after ${attemptTimeoutMs}ms`,
            ),
          ]);
          return;
        }
        // Not enough of the budget left to re-resolve and post again: report
        // the error already in hand rather than start a phase that can only
        // end in the deadline, which would replace a named cause with a
        // generic timeout.
        if (remainingMs(deadline) < MIN_RETRY_PASS_MS) {
          log(
            `${message.method} (id=${id}) failed with too little time left to retry: ${errorMessage(err)}`,
          );
          answer([
            buildErrorResponse(id, `request failed: ${errorMessage(err)}`),
          ]);
          return;
        }
        // Connection error: re-resolve once and retry once.
        log(`request failed, retrying once: ${errorMessage(err)}`);
        const retried = await resolveTransportWithRetryImpl(dataPath, {
          onAttempt,
          tokenId,
          windowMs: retryWindowFor(remainingMs(deadline)),
        });
        if (retried.error) {
          // The path a stale `mcpTransport.livePort` takes: the file reads
          // fine, so the first resolution succeeds, and only the POST
          // discovers nothing is listening. Same reasoning as above.
          log(
            `${message.method} (id=${id}) failed after re-resolving: ${retried.error}`,
          );
          answer([buildErrorResponse(id, retried.error)]);
          return;
        }
        attemptTimeoutMs = postBudget();
        try {
          result = await postJsonRpc(
            `http://127.0.0.1:${retried.port}/mcp`,
            retried.token,
            message,
            attemptTimeoutMs,
            { fetchImpl, protocolVersion: negotiatedProtocolVersion },
          );
        } catch (err2) {
          const message2 = isAbortError(err2)
            ? `request timed out after ${attemptTimeoutMs}ms`
            : `request failed: ${errorMessage(err2)}`;
          log(`${message.method} (id=${id}) failed: ${message2}`);
          answer([buildErrorResponse(id, message2)]);
          return;
        }
      }
      const messages = resolveResponseMessages(
        result.contentType,
        result.rawBody,
        id,
        result.status,
      );
      // Record the negotiated protocol version from a successful initialize so
      // every later request can echo it in the MCP-Protocol-Version header. Set
      // before the write so the variable is ready before any later request runs.
      if (message.method === "initialize") {
        const responseMessage = messages.find(
          (m) =>
            m &&
            Object.prototype.hasOwnProperty.call(m, "result") &&
            m.id === id,
        );
        if (responseMessage) {
          negotiatedProtocolVersion =
            (responseMessage.result &&
              responseMessage.result.protocolVersion) ||
            PROTOCOL_VERSION_FALLBACK;
        }
      }
      answer(messages);
      const elapsed = Date.now() - startedAt;
      if (elapsed > SLOW_PHASE_LOG_MS) {
        log(`<- ${message.method} (id=${id}) answered in ${elapsed}ms`);
      }
    } finally {
      clearTimeout(guard);
    }
  }

  /**
   * @param {JsonRpcMessage} message
   */
  async function handleNotification(message) {
    // No guard timer and no deadline error: a notification owes no
    // response, so there is nothing to answer with. It gets the same budget
    // only so a stuck one cannot outlive its usefulness holding a slot in
    // `pending`.
    const deadline = Date.now() + requestDeadlineMs;
    let transport = await readTransportImpl(dataPath, {}, tokenId);
    // Same rule as the request path: a revoked token must not cost the
    // full retry window on every notification too.
    if (transport.error && !transport.fatal)
      transport = await resolveTransportWithRetryImpl(dataPath, {
        tokenId,
        windowMs: retryWindowFor(remainingMs(deadline)),
      });
    if (transport.error) {
      log(`dropped notification: ${transport.error}`);
      return;
    }
    try {
      await postJsonRpc(
        `http://127.0.0.1:${transport.port}/mcp`,
        transport.token,
        message,
        Math.min(requestTimeoutMs, postTimeoutFor(remainingMs(deadline))),
        {
          fetchImpl,
          protocolVersion: negotiatedProtocolVersion,
        },
      );
    } catch (err) {
      log(`notification POST failed: ${errorMessage(err)}`);
    }
  }

  return new Promise((resolve) => {
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      const { lines, remainder: rem } = splitLines(remainder, chunk);
      remainder = rem;
      for (const line of lines) {
        const parsed = parseJsonRpcLine(line);
        if (parsed.skip) continue;
        if (parsed.error) {
          log(parsed.error);
          continue;
        }
        const msg = parsed.message;
        const hasId =
          Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== null;
        const p = (hasId ? handleRequest(msg) : handleNotification(msg)).catch(
          (err) => {
            log(`unexpected error: ${errorMessage(err)}`);
            // For a request (has id) the client is blocked waiting on a
            // response with that id; without one it would hang forever, so
            // emit a JSON-RPC error. Notifications owe no response.
            if (hasId) {
              try {
                writeChunk(
                  JSON.stringify(
                    buildErrorResponse(
                      msg.id,
                      `unexpected error: ${errorMessage(err)}`,
                    ),
                  ) + "\n",
                );
              } catch (writeErr) {
                log(
                  `failed to write error response: ${errorMessage(writeErr)}`,
                );
              }
            }
          },
        );
        pending.push(p);
      }
    });
    stdin.on("end", async () => {
      await Promise.allSettled(pending);
      resolve();
    });
  });
}

const vaultPath = "__OBSIDIAN_MCP_VAULT_PATH__";
const configDir = "__OBSIDIAN_MCP_CONFIG_DIR__";
// Substituted with the id of the token this bundle was exported for, or
// with null when it was exported for the vault's first token — which is
// what `mcpTransport.bearerToken` mirrors, so the resolution stays the
// one every bundle generated before per-token export already uses.
/** @type {string|null} */
const shimTokenId = "__OBSIDIAN_MCP_TOKEN_ID__";
const path = require("path");
// prettier-ignore
const shimDataPath = path.join(vaultPath, configDir, "plugins", "mcp-tools-istefox", "data.json");

function main() {
  // The resolved data.json path, not just the vault: "the bundle is
  // looking somewhere that no longer exists" is a real failure mode, and
  // without this line a reporter has to reconstruct the path by hand
  // from the vault root and the config dir before anyone can check it.
  //
  // `node` too: Claude Desktop logs "Using built-in Node.js", which names
  // neither the version nor the binary, and #412 turned on whether the
  // shim behaved differently there than under the system node a reporter
  // can run by hand. This settles that question in the client's own log.
  process.stderr.write(
    `obsidian-mcp-connector: started, vault=${vaultPath}, data=${shimDataPath}, node=${process.version}, exec=${process.execPath}, pid=${process.pid}\n`,
  );
  runMain({ dataPath: shimDataPath, tokenId: shimTokenId ?? undefined }).then(
    () => process.exit(0),
  );
}

/**
 * Is this file the process's entry point?
 *
 * `require.main === module` alone is not enough, and that gap is #412.
 * With "Use Built-in Node.js for MCP" on, Claude Desktop does not run
 * `node server/index.js`: it forks its own host script into an Electron
 * utilityProcess and loads the bundle with
 * `import(pathToFileURL(entryPoint))`. Through the ESM loader `require.main`
 * is the *host's* module, never this one, so the guard was false and
 * `main()` never ran — no banner, no stdin reader, no response, and the
 * client cancelled sixty seconds later with nothing in its log to explain
 * why. The host sets `process.argv = ["node", entryPoint, ...]` right
 * before that import, so argv is the one signal that survives both loaders.
 *
 * Both arms stay: argv alone would break anyone launching the shim through
 * a wrapper, and require.main alone is the bug above.
 *
 * @param {NodeJS.Module|undefined} mainModule `require.main`
 * @param {NodeJS.Module} thisModule `module`
 * @param {string|undefined} argv1 `process.argv[1]`
 * @param {string} filename `__filename`
 * @returns {boolean}
 */
function isEntryPoint(mainModule, thisModule, argv1, filename) {
  if (mainModule !== undefined && mainModule === thisModule) {
    return true;
  }
  if (typeof argv1 !== "string" || argv1 === "") {
    return false;
  }
  if (typeof filename !== "string" || filename === "") {
    return false;
  }
  return path.resolve(argv1) === path.resolve(filename);
}

module.exports = {
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
  remainingMs,
  retryWindowFor,
  postTimeoutFor,
  RETRY_WINDOW_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  WATCHDOG_GRACE_MS,
  REQUEST_DEADLINE_MS,
  MIN_POST_BUDGET_MS,
  MIN_POST_TIMEOUT_MS,
  MIN_RETRY_PASS_MS,
  PROTOCOL_VERSION_FALLBACK,
  LOCAL_ERROR_CODE,
};

if (isEntryPoint(require.main, module, process.argv[1], __filename)) {
  main();
}
