import { type } from "arktype";
import type { Server } from "node:http";
import { logger } from "$/shared";
import { BIND_HOST, PORT_RANGE } from "../constants";
import { PortNumber } from "../types";

/**
 * Resolve the port list to try when starting the HTTP server: a single
 * user-configured port when valid, else the default range. A configured
 * port is deliberately never combined with the range — falling back to
 * the range on a busy configured port would reintroduce the same
 * cross-session drift a fixed port is meant to fix (see issue #337).
 * Invalid/corrupt persisted data (not a valid port at all) is a
 * different failure mode and safely falls back to the range, logging a
 * warning, same as SettingsStore.loadSlice does for other settings.
 */
export function resolvePorts(configured: unknown): readonly number[] {
  if (configured === undefined) return PORT_RANGE;
  const validated = PortNumber(configured);
  if (validated instanceof type.errors) {
    logger.warn("configured mcp port is invalid, using default range", {
      configured,
      summary: validated.summary,
    });
    return PORT_RANGE;
  }
  return [validated];
}

/**
 * Bind an HTTP server to the first available port in the given range.
 *
 * Iterates `ports` in order. On EADDRINUSE, tries the next port.
 * Any other error (e.g., EACCES, EADDRNOTAVAIL) is rethrown immediately.
 *
 * Precondition: `server` must be a freshly created, not-yet-listening
 * http.Server. Calling listen() on a server in 'closing' or 'listening'
 * state would throw ERR_SERVER_NOT_RUNNING / ERR_SERVER_ALREADY_LISTEN.
 *
 * @throws {Error} when all ports in the range are taken.
 */
export async function bindWithFallback(
  server: Server,
  ports: readonly number[],
): Promise<number> {
  for (const port of ports) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        // Register both handlers BEFORE calling listen() to avoid
        // missing events on fast-failing ports
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, BIND_HOST);
      });
      return port;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      // Port is taken — try the next one in the range
    }
  }
  throw new Error(`No free port in range: ${ports.join(", ")}`);
}
