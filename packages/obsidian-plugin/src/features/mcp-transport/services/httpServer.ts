import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { runMiddleware } from "./middleware";
import { bindWithFallback } from "./port";
import { ERROR_CODES, MAX_REQUEST_BODY_BYTES, PORT_RANGE } from "../constants";

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

export type HttpServerConfig = {
  bearerToken: string;
  requestHandler: RequestHandler;
};

export type RunningServer = {
  server: Server;
  port: number;
};

/**
 * Start an HTTP server bound to 127.0.0.1 on the first available port
 * in PORT_RANGE.
 *
 * The server runs a middleware chain (method/path → origin → bearer auth)
 * before delegating to the caller-provided requestHandler. This keeps auth
 * concerns out of the handler entirely — the handler only sees requests that
 * have already passed all checks.
 *
 * Unhandled handler errors return 500 to the client and rethrow so that the
 * Node uncaughtException handler (wired in Task 12's logger setup) can see
 * them.
 *
 * @param config - Bearer token and the request handler to call on valid requests.
 * @returns A RunningServer with the bound server instance and its port.
 */
export async function startHttpServer(
  config: HttpServerConfig,
): Promise<RunningServer> {
  const server = createServer((req, res) => {
    const check = runMiddleware(
      { method: req.method, url: req.url, headers: req.headers },
      config.bearerToken,
    );

    if (!check.ok) {
      // Middleware rejected the request — return the status and close.
      // No body needed: these are machine-to-machine errors.
      res.writeHead(check.status);
      res.end();
      return;
    }

    // Reject an oversize body up front via the declared Content-Length so
    // the SDK never buffers a huge payload (DoS/OOM in the renderer). We
    // do NOT also attach a streamed req.on('data') byte counter: the SDK
    // consumes this same stream later (hono's Readable.toWeb(req)), and a
    // 'data' listener here would flip the stream to flowing mode and steal
    // bytes from it, breaking every valid request. Content-Length is a
    // partial but safe mitigation; a chunked request with no length still
    // reaches the SDK's own parser.
    const declaredLength = Number(req.headers["content-length"]);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_REQUEST_BODY_BYTES
    ) {
      res.writeHead(ERROR_CODES.PAYLOAD_TOO_LARGE);
      res.end();
      req.destroy();
      return;
    }

    // void prefix: fire-and-forget is intentional. Errors are caught
    // below and logged without rethrowing.
    void config.requestHandler(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
      // TODO(Task 12): replace with logger.error("handler failed", { err })
      // Intentionally NOT rethrowing: inside a .catch() of a void-prefixed
      // promise, throwing creates an unhandled rejection which crashes the
      // Electron renderer under default Node settings.
      // eslint-disable-next-line no-console
      console.error("[mcp-transport] request handler failed:", err);
    });
  });

  let port: number;
  try {
    port = await bindWithFallback(server, [...PORT_RANGE]);
  } catch (err) {
    // Best-effort cleanup; no-op if server never listened.
    try {
      server.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
  return { server, port };
}

/**
 * Gracefully close the HTTP server and release its port.
 *
 * Resolves when the server has fully closed (all connections drained).
 * Rejects only on a genuine close() error — an already-stopped listener
 * counts as success since the port is released either way.
 *
 * @param running - The RunningServer returned by startHttpServer.
 */
export async function stopHttpServer({ server }: RunningServer): Promise<void> {
  // Force-drop keep-alive + in-flight + SSE sockets first: without this an
  // open mcp-remote stream keeps the connection alive and server.close()
  // never resolves on plugin disable/update, so the port "walks".
  // Cast: closeAllConnections is Node >=18.2 (Obsidian's Electron + Bun
  // both have it) but the pinned @types/node@16 predates the typing.
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      // ERR_SERVER_NOT_RUNNING means the listener is already gone, i.e.
      // the port is released — the goal is met. (Bun's closeAllConnections
      // also stops the listener; real Node/Electron does not. Tolerating
      // it here keeps one teardown path correct on both runtimes.)
      if (
        err &&
        (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      ) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
