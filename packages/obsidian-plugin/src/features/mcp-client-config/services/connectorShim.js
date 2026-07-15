#!/usr/bin/env node
"use strict";

const fs = require("fs");
const net = require("net");

function splitLines(remainder, chunk) {
  const combined = remainder + chunk;
  const parts = combined.split("\n");
  const newRemainder = parts.pop();
  return { lines: parts, remainder: newRemainder };
}

function parseJsonRpcLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return { skip: true };
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    return { error: `unparseable stdin line: ${err.message}` };
  }
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    return { error: "stdin line is not a JSON-RPC object" };
  }
  return { message };
}

function parseTransportFile(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (err) {
    return { error: `data.json is not valid JSON: ${err.message}` };
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

function buildErrorResponse(id, message, data) {
  const error = { code: -32000, message: `obsidian-mcp-connector: ${message}` };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

const SSE_LINE_SPLIT = /\r\n|\r|\n/;

function parseSse(body) {
  const messages = [];
  let dataLines = [];
  const dispatch = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    dataLines = [];
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
      messages.push(parsed);
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

function routeSseMessages(messages, requestId) {
  const notifications = [];
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
    return [JSON.parse(rawBody)];
  } catch {
    return [
      buildErrorResponse(requestId, `non-JSON response (HTTP ${status})`),
    ];
  }
}

function readTransport(dataPath, { readFileSync = fs.readFileSync } = {}) {
  let text;
  try {
    text = readFileSync(dataPath, "utf8");
  } catch (err) {
    return { error: `could not read ${dataPath}: ${err.message}` };
  }
  return parseTransportFile(text);
}

function probePort(port, { createConnection = net.createConnection } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
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

const RETRY_WINDOW_MS = 30000;
const RETRY_INTERVAL_MS = 1000;

async function resolveTransportWithRetry(
  dataPath,
  {
    readTransportImpl = readTransport,
    probePortImpl = probePort,
    nowImpl = Date.now,
    sleepMsImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
    windowMs = RETRY_WINDOW_MS,
    intervalMs = RETRY_INTERVAL_MS,
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
    await sleepMsImpl(intervalMs);
  }
  return { error: `${lastError} — is Obsidian open with the vault loaded?` };
}

async function postJsonRpc(
  url,
  token,
  message,
  timeoutMs,
  { fetchImpl = fetch } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
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
}

function runMain({
  stdin = process.stdin,
  writeChunk = (s) => process.stdout.write(s),
  fetchImpl = fetch,
  dataPath,
  log = (msg) => process.stderr.write(`obsidian-mcp-connector: ${msg}\n`),
  debug = process.env.OBSIDIAN_MCP_DEBUG === "1",
  requestTimeoutMs = 60000,
  resolveTransportWithRetryImpl = resolveTransportWithRetry,
  readTransportImpl = readTransport,
} = {}) {
  const pending = [];
  let remainder = "";

  async function handleRequest(message) {
    const id = message.id;
    if (debug) log(`-> ${message.method} (id=${id})`);
    let transport = readTransportImpl(dataPath);
    if (transport.error) {
      transport = await resolveTransportWithRetryImpl(dataPath);
    }
    if (transport.error) {
      writeChunk(
        JSON.stringify(buildErrorResponse(id, transport.error)) + "\n",
      );
      return;
    }
    const url = `http://127.0.0.1:${transport.port}/mcp`;
    let result;
    try {
      result = await postJsonRpc(
        url,
        transport.token,
        message,
        requestTimeoutMs,
        { fetchImpl },
      );
    } catch (err) {
      if (err.name === "AbortError") {
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
      if (debug) log(`request failed, retrying once: ${err.message}`);
      const retried = await resolveTransportWithRetryImpl(dataPath);
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
          { fetchImpl },
        );
      } catch (err2) {
        const message2 =
          err2.name === "AbortError"
            ? `request timed out after ${requestTimeoutMs}ms`
            : `request failed: ${err2.message}`;
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
    writeChunk(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  }

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
        },
      );
    } catch (err) {
      log(`notification POST failed: ${err.message}`);
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
            log(`unexpected error: ${err.message}`);
            // For a request (has id) the client is blocked waiting on a
            // response with that id; without one it would hang forever, so
            // emit a JSON-RPC error. Notifications owe no response.
            if (hasId) {
              try {
                writeChunk(
                  JSON.stringify(
                    buildErrorResponse(
                      msg.id,
                      `unexpected error: ${err.message}`,
                    ),
                  ) + "\n",
                );
              } catch (writeErr) {
                log(`failed to write error response: ${writeErr.message}`);
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
const path = require("path");
// prettier-ignore
const shimDataPath = path.join(vaultPath, ".obsidian", "plugins", "mcp-tools-istefox", "data.json");

function main() {
  process.stderr.write(`obsidian-mcp-connector: started, vault=${vaultPath}\n`);
  runMain({ dataPath: shimDataPath }).then(() => process.exit(0));
}

module.exports = {
  splitLines,
  parseJsonRpcLine,
  parseTransportFile,
  buildErrorResponse,
  parseSse,
  routeSseMessages,
  resolveResponseMessages,
  readTransport,
  probePort,
  resolveTransportWithRetry,
  postJsonRpc,
  runMain,
};

if (require.main === module) {
  main();
}
