import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { logger } from "$/shared";
import { buildProtocolVersionErrorBody, runMiddleware } from "./middleware";
import { readBodyWithCap } from "./parseRequestBody";
import type { TokenRecord } from "./tokenStore";
import { bindWithFallback } from "./port";
import { ERROR_CODES, MAX_REQUEST_BODY_BYTES, PORT_RANGE } from "../constants";

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  /** Id of the bearer token this request authenticated with. */
  tokenId: string,
) => Promise<void>;

export type HttpServerConfig = {
  /**
   * The configured bearer tokens, resolved once per request. There is
   * deliberately no in-memory cache: a token added, regenerated or
   * revoked in settings takes effect on the next request with nothing to
   * invalidate, and a missed invalidation here would be an authentication
   * bug (a revoked token that keeps working). See ADR-0014 §2 and
   * Alternative C.
   */
  resolveTokens: () => Promise<readonly TokenRecord[]>;
  requestHandler: RequestHandler;
  /** Ports to try, in order. Defaults to PORT_RANGE. */
  ports?: readonly number[];
};

export type RunningServer = {
  server: Server;
  port: number;
};

/**
 * Start an HTTP server bound to 127.0.0.1 on the first available port
 * in `config.ports` (defaults to PORT_RANGE). A single-element `ports`
 * list (a fixed port configured by the user) throws instead of falling
 * back elsewhere — see resolvePorts in port.ts.
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
 * @param config - Token provider and the request handler to call on valid requests.
 * @returns A RunningServer with the bound server instance and its port.
 */
export async function startHttpServer(
  config: HttpServerConfig,
): Promise<RunningServer> {
  const server = createServer((req, res) => {
    // The callback body is async because the token list is read per
    // request. The await sits between the socket being accepted and the
    // body being touched, which is safe: no 'data' listener is attached
    // yet, so the IncomingMessage stays paused and no bytes are lost. The
    // cost is that a slow loadData() delays every request (ADR-0014,
    // Consequences).
    //
    // void prefix: fire-and-forget is intentional. Errors are caught
    // below and logged without rethrowing.
    void (async () => {
      let tokens: readonly TokenRecord[] = [];
      try {
        tokens = await config.resolveTokens();
      } catch (error) {
        // Fail closed. A transient read failure must 401 rather than
        // authenticate anyone, and it must leave a trail: from the
        // client's side this is indistinguishable from a revoked token.
        logger.error("[mcp-transport] reading the token list failed", {
          error,
        });
      }

      const check = runMiddleware(
        { method: req.method, url: req.url, headers: req.headers },
        tokens,
      );

      if (!check.ok) {
        // Most rejections (401/403/404/405) are machine-to-machine errors
        // with no body. The protocol-version 400 is the one the spec wants
        // to carry a JSON-RPC error body (SEP-2575 `server-stateless`
        // conformance, OMC-018): read the body (capped, best-effort — an
        // unparseable or over-cap body just falls back to a null id and
        // the version-mismatch code) so the error can echo the request's
        // id and, when `_meta` is malformed, name that instead.
        if (check.status === ERROR_CODES.PROTOCOL_VERSION_UNSUPPORTED) {
          const rawBody = await readBodyWithCap(
            req,
            MAX_REQUEST_BODY_BYTES,
          ).catch(() => null);
          let parsedBody: unknown;
          try {
            parsedBody = rawBody === null ? undefined : JSON.parse(rawBody);
          } catch {
            parsedBody = undefined;
          }
          res.writeHead(check.status, { "content-type": "application/json" });
          res.end(JSON.stringify(buildProtocolVersionErrorBody(parsedBody)));
          if (rawBody === null) req.destroy();
          return;
        }
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

      await config.requestHandler(req, res, check.tokenId);
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
      // Intentionally NOT rethrowing: inside a .catch() of a void-prefixed
      // promise, throwing creates an unhandled rejection which crashes the
      // Electron renderer under default Node settings.
      logger.error("[mcp-transport] request handler failed", { error: err });
    });
  });

  let port: number;
  try {
    port = await bindWithFallback(server, [...(config.ports ?? PORT_RANGE)]);
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
