import {
  ERROR_CODES,
  FIRST_MODERN_PROTOCOL_VERSION,
  JSONRPC_ERROR_CODES,
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

/**
 * Read a single header value, lowercasing the name and taking the first
 * occurrence of a multi-valued header. Exported because the deferred half of
 * the protocol-version rung lives in eraRouter.ts and must read the
 * `MCP-Protocol-Version` header exactly the way this rung does — a second
 * copy of the normalization is a place for the two halves to disagree.
 */
export function getHeader(
  headers: RequestHeaders,
  name: string,
): string | undefined {
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

/**
 * Whether a protocol revision belongs to the modern (2026-07-28+) era.
 *
 * Project-owned copy of the SDK's own `isModernProtocolVersion`
 * (`@modelcontextprotocol/server`, `dist/src-CX2iR2pK.mjs:553`), which is
 * package-internal and exported from no public entry point. Revision
 * identifiers are ISO dates, so the SDK orders eras with a lexicographic
 * `>=` against FIRST_MODERN_PROTOCOL_VERSION and so does this copy. If the
 * SDK ever changes the era boundary away from that comparison, this copy
 * goes stale silently (ADR-0016, Consequences).
 *
 * Exported for the era router, which needs the same era test this rung uses.
 */
export function isModernProtocolVersion(version: string): boolean {
  return version >= FIRST_MODERN_PROTOCOL_VERSION;
}

/**
 * The legacy half of the protocol-version rung (ADR-0016 §3).
 *
 * The rung splits by era, and only this half runs inside `runMiddleware`:
 *
 * - Header absent → pass. Absent is legal per spec: the server assumes a
 *   default version. Do not require the header — that would break clients
 *   that never send it.
 * - A revision this server serves → pass.
 * - A PRE-2026 revision it does not serve → 400, from here, in this position
 *   in the chain (before auth), byte-identically to before OMC-008.
 * - A 2026-era revision it does not serve → pass, DEFERRED. Only
 *   classification can tell whether the SDK's validation ladder owns the
 *   answer, and that answer carries `{ supported, requested }` where this
 *   server's `buildProtocolVersionErrorBody` carries neither. Rejecting here
 *   would preempt it.
 *
 * The other half is `applyDeferredVersionRung` in eraRouter.ts: it answers a
 * deferred header that then classifies legacy, so no unsupported-version 400
 * is lost. Exported alongside `isModernProtocolVersion` so both halves of
 * the split rung are reachable from the era router's side.
 */
export function checkProtocolVersion(headers: RequestHeaders): CheckResult {
  const version = getHeader(headers, "mcp-protocol-version");
  if (version === undefined) return { ok: true };
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version))
    return { ok: true };
  return isModernProtocolVersion(version)
    ? { ok: true }
    : { ok: false, status: ERROR_CODES.PROTOCOL_VERSION_UNSUPPORTED };
}

export type JsonRpcErrorBody = {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: string | number | null;
};

/**
 * A value shaped enough like a JSON-RPC request to read `id`/`params` off
 * of. Guards against echoing a response's `id` (responses have no
 * `method`) — same convention the SDK's own `echoableRequestId` uses.
 */
function isJsonRpcRequestShape(
  value: unknown,
): value is { method: string; id?: unknown; params?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

/**
 * `_meta` is present but not an object (a string, number, array, ...).
 * `_meta` is always optional and, per the wire schema every MCP request
 * shares, must be an object when present — this is ordinary JSON-RPC
 * shape validation, not the 2026 stateless lifecycle. An ABSENT `_meta`,
 * or one present as an object missing `protocolVersion`/`clientCapabilities`,
 * is never malformed by this check: requiring those subfields is the 2026
 * per-request envelope and is out of scope here (see checkProtocolVersion's
 * own docs and OMC-008).
 */
function hasMalformedMeta(parsedBody: unknown): boolean {
  if (!isJsonRpcRequestShape(parsedBody)) return false;
  const { params } = parsedBody;
  if (typeof params !== "object" || params === null) return false;
  if (!("_meta" in params)) return false;
  const meta = (params as { _meta?: unknown })._meta;
  return typeof meta !== "object" || meta === null || Array.isArray(meta);
}

/**
 * Build the JSON-RPC error body for the transport's HTTP 400 rejection
 * when `checkProtocolVersion` fails (SEP-2575 `server-stateless`
 * conformance, OMC-018). This server has no per-request `_meta` lifecycle
 * (gated on OMC-008), so there is no separate envelope-validation rung —
 * both spec-defined codes are read off the one already-rejected request:
 *
 * - `_meta` present but not an object → `-32602` (Invalid Params).
 * - Everything else, including an unparseable body → `-32020`, the code
 *   for the version mismatch that made `checkProtocolVersion` reject the
 *   request in the first place.
 *
 * `id` is echoed when the body parsed as a JSON-RPC request with a
 * string/number `id`, `null` otherwise (the suite has a separate check
 * that error responses preserve the request's id). Pure and synchronous:
 * the caller is responsible for reading and JSON-parsing the body
 * (`undefined` when reading/parsing failed).
 */
export function buildProtocolVersionErrorBody(
  parsedBody: unknown,
): JsonRpcErrorBody {
  const malformedMeta = hasMalformedMeta(parsedBody);
  return {
    jsonrpc: "2.0",
    error: {
      code: malformedMeta
        ? JSONRPC_ERROR_CODES.INVALID_PARAMS
        : JSONRPC_ERROR_CODES.PROTOCOL_VERSION_UNSUPPORTED,
      message: malformedMeta
        ? "Invalid params: `_meta` must be an object"
        : "Unsupported MCP-Protocol-Version",
    },
    id:
      isJsonRpcRequestShape(parsedBody) &&
      (typeof parsedBody.id === "string" || typeof parsedBody.id === "number")
        ? parsedBody.id
        : null,
  };
}

/**
 * Run the full validation chain on an incoming HTTP request.
 *
 * Check order — load-bearing for security and observability:
 *   1. Method/path (404 path unknown → 405 method not allowed)
 *   2. Origin (403) — anti-DNS-rebinding, independent of auth
 *   3. MCP-Protocol-Version (400) — absent is legal (assume default); an
 *      unsupported PRE-2026 value is rejected here, an unsupported 2026-era
 *      one is deferred to the era router (see checkProtocolVersion)
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
