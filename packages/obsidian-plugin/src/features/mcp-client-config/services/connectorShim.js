#!/usr/bin/env node
"use strict";

/* eslint-disable no-nodejs-modules, obsidianmd/no-nodejs-modules, @typescript-eslint/no-require-imports, prefer-window-timers, obsidianmd/prefer-window-timers, no-fetch, obsidianmd/no-fetch --
 * This script is not part of the Obsidian plugin's own renderer bundle: it
 * is a standalone, zero-dependency Node.js CLI (embedded as a string via
 * assets/connectorShimSource.ts and shipped inside the .mcpb package),
 * launched as its own separate process by Claude Desktop and executed by a
 * plain `node`, never loaded inside Obsidian's sandboxed window. require()
 * of Node built-ins, the global fetch(), and bare setTimeout/clearTimeout
 * are the correct APIs for that runtime — `window` and `requestUrl` do not
 * exist there. See docs/architecture/ADR-0013-mcpb-pure-node-shim.md.
 */

const fs = require("fs");
const net = require("net");

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
 */

/**
 * @typedef {Object} TransportErr
 * @property {string} error
 * @property {undefined} [port]
 * @property {undefined} [token]
 */

/** @typedef {TransportOk | TransportErr} TransportResult */

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
 * @param {string} jsonText
 * @returns {TransportResult}
 */
function parseTransportFile(jsonText) {
  /** @type {{ mcpTransport?: { livePort?: unknown, bearerToken?: unknown } }} */
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (err) {
    return { error: `data.json is not valid JSON: ${errorMessage(err)}` };
  }
  const transport = (data && data.mcpTransport) || {};
  const port = transport.livePort;
  const token = transport.bearerToken;
  if (typeof port !== "number" || typeof token !== "string") {
    return {
      error:
        "data.json mcpTransport.livePort must be a number and mcpTransport.bearerToken must be a string",
    };
  }
  return { port, token };
}

/**
 * @param {string|number|null|undefined} id
 * @param {string} message
 * @param {unknown} [data]
 * @returns {JsonRpcMessage}
 */
function buildErrorResponse(id, message, data) {
  /** @type {{ code: number, message: string, data?: unknown }} */
  const error = { code: -32000, message: `obsidian-mcp-connector: ${message}` };
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
 * @param {string} dataPath
 * @param {{ readFileSync?: typeof fs.readFileSync }} [options]
 * @returns {TransportResult}
 */
function readTransport(dataPath, { readFileSync = fs.readFileSync } = {}) {
  /** @type {string} */
  let text;
  try {
    text = /** @type {string} */ (readFileSync(dataPath, "utf8"));
  } catch (err) {
    return { error: `could not read ${dataPath}: ${errorMessage(err)}` };
  }
  return parseTransportFile(text);
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
// Sum with RETRY_WINDOW_MS must stay under the MCP client's 60000ms default request timeout.
const DEFAULT_REQUEST_TIMEOUT_MS = 25000;
// Grace period added on top of the AbortController-based timeout. Guards against
// environments (observed: Claude Desktop's UtilityProcess sandbox on macOS) where
// AbortController.abort() does not reliably cancel an in-flight fetch(). Sum of
// RETRY_WINDOW_MS + DEFAULT_REQUEST_TIMEOUT_MS + WATCHDOG_GRACE_MS must stay under
// the MCP client's 60000ms default request timeout.
const WATCHDOG_GRACE_MS = 2000;
// Echoed back in the MCP-Protocol-Version header when the initialize response
// omits protocolVersion. Mirrors the Python bridge's PROTOCOL_VERSION_FALLBACK.
const PROTOCOL_VERSION_FALLBACK = "2025-06-18";

/**
 * @param {string} dataPath
 * @param {{
 *   readTransportImpl?: typeof readTransport,
 *   probePortImpl?: typeof probePort,
 *   nowImpl?: () => number,
 *   sleepMsImpl?: (ms: number) => Promise<void>,
 *   windowMs?: number,
 *   intervalMs?: number,
 *   onAttempt?: () => void,
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
  } = {},
) {
  const deadline = nowImpl() + windowMs;
  let lastError = "timed out waiting for the MCP server";
  while (nowImpl() < deadline) {
    const resolved = readTransportImpl(dataPath);
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
 * @param {string} url
 * @param {string} token
 * @param {JsonRpcMessage} message
 * @param {number} timeoutMs
 * @param {{
 *   fetchImpl?: typeof fetch,
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
    fetchImpl = fetch,
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

  // Independent of controller.abort() actually cancelling the fetch: some
  // environments (Claude Desktop's UtilityProcess sandbox, observed on macOS)
  // do not honor AbortSignal on an in-flight fetch, leaving `attempt` pending
  // forever. This plain timer guarantees postJsonRpc always settles.
  const watchdog = new Promise((_resolve, reject) => {
    setTimeout(() => {
      const err = new Error(
        `watchdog: no response within ${timeoutMs + watchdogGraceMs}ms (AbortController may not be honored in this environment)`,
      );
      err.name = "AbortError";
      reject(err);
    }, timeoutMs + watchdogGraceMs);
  });

  return /** @type {Promise<PostJsonRpcResult>} */ (
    Promise.race([attempt, watchdog])
  );
}

/**
 * @param {{
 *   stdin?: NodeJS.ReadStream,
 *   writeChunk?: (s: string) => void,
 *   fetchImpl?: typeof fetch,
 *   dataPath: string,
 *   log?: (msg: string) => void,
 *   debug?: boolean,
 *   requestTimeoutMs?: number,
 *   resolveTransportWithRetryImpl?: typeof resolveTransportWithRetry,
 *   readTransportImpl?: typeof readTransport,
 * }} options
 * @returns {Promise<void>}
 */
function runMain({
  stdin = process.stdin,
  writeChunk = (s) => process.stdout.write(s),
  fetchImpl = fetch,
  dataPath,
  log = (msg) => process.stderr.write(`obsidian-mcp-connector: ${msg}\n`),
  debug = process.env.OBSIDIAN_MCP_DEBUG === "1",
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  resolveTransportWithRetryImpl = resolveTransportWithRetry,
  readTransportImpl = readTransport,
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
    if (debug) log(`-> ${message.method} (id=${id})`);
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
    let transport = readTransportImpl(dataPath);
    if (transport.error) {
      transport = await resolveTransportWithRetryImpl(dataPath, { onAttempt });
    }
    if (transport.error) {
      writeChunk(
        JSON.stringify(buildErrorResponse(id, transport.error)) + "\n",
      );
      return;
    }
    const url = `http://127.0.0.1:${transport.port}/mcp`;
    /** @type {PostJsonRpcResult} */
    let result;
    try {
      result = await postJsonRpc(
        url,
        transport.token,
        message,
        requestTimeoutMs,
        { fetchImpl, protocolVersion: negotiatedProtocolVersion },
      );
    } catch (err) {
      if (isAbortError(err)) {
        writeChunk(
          JSON.stringify(
            buildErrorResponse(
              id,
              `request timed out after ${requestTimeoutMs}ms`,
            ),
          ) + "\n",
        );
        return;
      }
      // Connection error: re-resolve once and retry once.
      if (debug) log(`request failed, retrying once: ${errorMessage(err)}`);
      const retried = await resolveTransportWithRetryImpl(dataPath, {
        onAttempt,
      });
      if (retried.error) {
        writeChunk(
          JSON.stringify(buildErrorResponse(id, retried.error)) + "\n",
        );
        return;
      }
      try {
        result = await postJsonRpc(
          `http://127.0.0.1:${retried.port}/mcp`,
          retried.token,
          message,
          requestTimeoutMs,
          { fetchImpl, protocolVersion: negotiatedProtocolVersion },
        );
      } catch (err2) {
        const message2 = isAbortError(err2)
          ? `request timed out after ${requestTimeoutMs}ms`
          : `request failed: ${errorMessage(err2)}`;
        writeChunk(JSON.stringify(buildErrorResponse(id, message2)) + "\n");
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
    // before writeChunk so the variable is ready before any later request runs.
    if (message.method === "initialize") {
      const responseMessage = messages.find(
        (m) =>
          m && Object.prototype.hasOwnProperty.call(m, "result") && m.id === id,
      );
      if (responseMessage) {
        negotiatedProtocolVersion =
          (responseMessage.result && responseMessage.result.protocolVersion) ||
          PROTOCOL_VERSION_FALLBACK;
      }
    }
    writeChunk(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }

  /**
   * @param {JsonRpcMessage} message
   */
  async function handleNotification(message) {
    let transport = readTransportImpl(dataPath);
    if (transport.error)
      transport = await resolveTransportWithRetryImpl(dataPath);
    if (transport.error) {
      log(`dropped notification: ${transport.error}`);
      return;
    }
    try {
      await postJsonRpc(
        `http://127.0.0.1:${transport.port}/mcp`,
        transport.token,
        message,
        requestTimeoutMs,
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
const path = require("path");
// prettier-ignore
const shimDataPath = path.join(vaultPath, configDir, "plugins", "mcp-tools-istefox", "data.json");

function main() {
  process.stderr.write(`obsidian-mcp-connector: started, vault=${vaultPath}\n`);
  runMain({ dataPath: shimDataPath }).then(() => process.exit(0));
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
  postJsonRpc,
  runMain,
  RETRY_WINDOW_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  WATCHDOG_GRACE_MS,
  PROTOCOL_VERSION_FALLBACK,
};

if (require.main === module) {
  main();
}
