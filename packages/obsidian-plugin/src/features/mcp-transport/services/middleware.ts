import {
  ERROR_CODES,
  MCP_PATH_PREFIX,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../constants";
import { isOriginAllowed } from "./origin";
import { compareTokens } from "./token";
import type { TokenRecord } from "./tokenStore";

export type MethodPathResult = { ok: true } | { ok: false; status: 404 | 405 };

// GET is intentionally excluded: our stateless per-request architecture never
// sends server-initiated events, so the SSE stream that GET opens is useless.
// Returning 405 causes mcp-remote to operate POST-only (it explicitly handles
// 405 in _startOrAuthSse with a silent return, so no error or fallback fires).
const ALLOWED_METHODS = new Set(["POST"]);

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
 * @returns Result ok=true when path matches /mcp or /mcp/* AND method is POST
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

/**
 * The one result the caller acts on. A pass carries the id of the token
 * that matched, which is the client's identity for everything downstream
 * (ADR-0014 §2); a failure carries a bare status and nothing else — no
 * field on this type may hint at which, or whether any, configured token
 * nearly matched.
 */
export type MiddlewareResult =
  | { ok: true; tokenId: string }
  | { ok: false; status: 400 | 401 | 403 | 404 | 405 };

/** An individual check's verdict. Only auth resolves an identity. */
type CheckResult = { ok: true } | { ok: false; status: 400 | 401 | 403 };

type AuthResult = { ok: true; tokenId: string } | { ok: false; status: 401 };

function getHeader(headers: RequestHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Match the presented bearer against every configured token.
 *
 * The loop deliberately does NOT break on a match: comparing against all
 * N keeps the response time independent of where the matching token sits
 * in the list, so a caller cannot probe its position. Last match wins,
 * which only matters if two entries ever carry the same secret and makes
 * that case deterministic rather than order-dependent.
 *
 * An empty list matches nothing and 401s: auth fails closed, and a
 * transient failure to read the token list must never authenticate
 * anyone.
 */
function checkAuth(
  headers: RequestHeaders,
  tokens: readonly TokenRecord[],
): AuthResult {
  const auth = getHeader(headers, "authorization");
  if (!auth) return { ok: false, status: ERROR_CODES.UNAUTHORIZED };
  const match = /^Bearer\s+(.+)$/.exec(auth);
  if (!match) return { ok: false, status: ERROR_CODES.UNAUTHORIZED };
  const presented = match[1].trim();

  let matched: string | null = null;
  for (const token of tokens) {
    if (compareTokens(presented, token.token)) matched = token.id;
  }
  return matched === null
    ? { ok: false, status: ERROR_CODES.UNAUTHORIZED }
    : { ok: true, tokenId: matched };
}

function checkOrigin(headers: RequestHeaders): CheckResult {
  const origin = getHeader(headers, "origin");
  return isOriginAllowed(origin)
    ? { ok: true }
    : { ok: false, status: ERROR_CODES.ORIGIN_FORBIDDEN };
}

function checkProtocolVersion(headers: RequestHeaders): CheckResult {
  const version = getHeader(headers, "mcp-protocol-version");
  // Absent is legal per spec: the server assumes a default version. Do not
  // require the header — that would break clients that never send it.
  if (version === undefined) return { ok: true };
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)
    ? { ok: true }
    : { ok: false, status: ERROR_CODES.PROTOCOL_VERSION_UNSUPPORTED };
}

/**
 * Run the full validation chain on an incoming HTTP request.
 *
 * Check order — load-bearing for security and observability:
 *   1. Method/path (404 path unknown → 405 method not allowed)
 *   2. Origin (403) — anti-DNS-rebinding, independent of auth
 *   3. MCP-Protocol-Version (400) — absent is legal (assume default);
 *      an unsupported value is rejected
 *   4. Bearer token (401) — constant-time compare via compareTokens
 *
 * Returning 405 before 401 intentionally tells unauthenticated
 * callers which methods the server speaks. This is acceptable for
 * a loopback-only server where no network attacker model applies.
 *
 * @param req - Incoming request (method, url, headers)
 * @param tokens - Every configured bearer token (read per request, so a
 *   revoked one stops working on the next request with nothing to
 *   invalidate). An empty list authenticates nobody.
 * @returns Result ok=true, carrying the matched token's id, when all four
 *   checks pass
 */
export function runMiddleware(
  req: MiddlewareRequest,
  tokens: readonly TokenRecord[],
): MiddlewareResult {
  const methodPath = checkMethodAndPath(req.method, req.url);
  if (!methodPath.ok) return methodPath;

  const origin = checkOrigin(req.headers);
  if (!origin.ok) return origin;

  const protocolVersion = checkProtocolVersion(req.headers);
  if (!protocolVersion.ok) return protocolVersion;

  return checkAuth(req.headers, tokens);
}
