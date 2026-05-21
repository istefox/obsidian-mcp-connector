import { ERROR_CODES, MCP_PATH_PREFIX } from "../constants";
import { isOriginAllowed } from "./origin";
import { compareTokens } from "./token";

export type MethodPathResult = { ok: true } | { ok: false; status: 404 | 405 };

const ALLOWED_METHODS = new Set(["GET", "POST"]);

/**
 * Validate HTTP method and request path.
 *
 * Path check (404) precedes method check (405) so that "/other"
 * returns 404 regardless of method — matches the principle that
 * an unknown path is more informative than a method restriction
 * on a path the server doesn't recognize at all.
 *
 * Query strings are stripped before comparison.
 *
 * @param method - HTTP method from req.method (may be undefined)
 * @param url - Request URL from req.url (may be undefined)
 * @returns Result ok=true when path matches /mcp or /mcp/* AND method is GET or POST
 */
export function checkMethodAndPath(
  method: string | undefined,
  url: string | undefined,
): MethodPathResult {
  const path = (url ?? "").split("?")[0];

  // Path check runs before method check: 404 on unknown path is more
  // informative than 405 on a path we don't serve at all. Deliberate
  // inversion of the design doc's listed order.
  if (path !== MCP_PATH_PREFIX && !path.startsWith(`${MCP_PATH_PREFIX}/`)) {
    return { ok: false, status: ERROR_CODES.NOT_FOUND };
  }

  // Check method second: only if path is valid
  if (!ALLOWED_METHODS.has((method ?? "").toUpperCase())) {
    return { ok: false, status: ERROR_CODES.METHOD_NOT_ALLOWED };
  }

  return { ok: true };
}

export type RequestHeaders = Record<string, string | string[] | undefined>;

export type MiddlewareRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: RequestHeaders;
};

export type MiddlewareResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404 | 405 };

function getHeader(headers: RequestHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function checkAuth(
  headers: RequestHeaders,
  expectedToken: string,
): MiddlewareResult {
  const auth = getHeader(headers, "authorization");
  if (!auth) return { ok: false, status: ERROR_CODES.UNAUTHORIZED };
  const match = /^Bearer\s+(.+)$/.exec(auth);
  if (!match) return { ok: false, status: ERROR_CODES.UNAUTHORIZED };
  const token = match[1].trim();
  if (!compareTokens(token, expectedToken)) {
    return { ok: false, status: ERROR_CODES.UNAUTHORIZED };
  }
  return { ok: true };
}

function checkOrigin(headers: RequestHeaders): MiddlewareResult {
  const origin = getHeader(headers, "origin");
  return isOriginAllowed(origin)
    ? { ok: true }
    : { ok: false, status: ERROR_CODES.ORIGIN_FORBIDDEN };
}

/**
 * Run the full validation chain on an incoming HTTP request.
 *
 * Check order — load-bearing for security and observability:
 *   1. Method/path (404 path unknown → 405 method not allowed)
 *   2. Origin (403) — anti-DNS-rebinding, independent of auth
 *   3. Bearer token (401) — constant-time compare via compareTokens
 *
 * Returning 405 before 401 intentionally tells unauthenticated
 * callers which methods the server speaks. This is acceptable for
 * a loopback-only server where no network attacker model applies.
 *
 * @param req - Incoming request (method, url, headers)
 * @param bearerToken - The server's expected Bearer token (from data.json)
 * @returns Result ok=true when all three checks pass
 */
export function runMiddleware(
  req: MiddlewareRequest,
  bearerToken: string,
): MiddlewareResult {
  const methodPath = checkMethodAndPath(req.method, req.url);
  if (!methodPath.ok) return methodPath;

  const origin = checkOrigin(req.headers);
  if (!origin.ok) return origin;

  const auth = checkAuth(req.headers, bearerToken);
  if (!auth.ok) return auth;

  return { ok: true };
}
