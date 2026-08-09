export const PORT_RANGE = [27200, 27201, 27202, 27203, 27204, 27205] as const;
export const BIND_HOST = "127.0.0.1" as const;
export const MCP_PATH_PREFIX = "/mcp" as const;
export const TOKEN_BYTE_LENGTH = 32 as const;

// Upper bound on configured bearer tokens. Every request compares the
// presented credential against ALL of them (no early exit, so position
// leaks nothing), so the list length is on the auth hot path; ten named
// clients is well past any realistic single-vault setup.
export const MAX_TOKENS = 10 as const;

// Cap on the request body to bound memory in the Electron renderer (DoS/OOM).
export const MAX_REQUEST_BODY_BYTES = 1_048_576 as const;

export const ALLOWED_ORIGINS_PATTERN =
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

// MCP protocol versions this server speaks. Project-owned copy of the
// @modelcontextprotocol/core's internal SUPPORTED_PROTOCOL_VERSIONS list
// (node_modules/@modelcontextprotocol/core/dist/internal.mjs, the package's
// "./internal" subpath export), kept here so it is visible and testable in
// this project's own suite. Newest first.
//
// This list spans BOTH eras, unlike the SDK's, which keeps its modern
// revisions in a separate SUPPORTED_MODERN_PROTOCOL_VERSIONS so a modern
// string can never leak into a 2025-era handshake. The distinction does not
// apply here: this list is only ever read by the MCP-Protocol-Version header
// rung (middleware.ts), never to build an `initialize` reply — that offer is
// the SDK's own LATEST_PROTOCOL_VERSION (2025-11-25) and is untouched by
// this entry. The 2026 era is reached by probing `server/discover`, never by
// the handshake (ADR-0016).
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

// The first protocol revision of the modern era. Project-owned copy of the
// SDK's FIRST_MODERN_PROTOCOL_VERSION
// (node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs:544),
// copied for the same reason as the version list above: it lives in
// core-internal and is exported from no public entry point. Revision
// identifiers are ISO dates, so the SDK orders eras with a lexicographic
// comparison against this value (`isModernProtocolVersion`, :553) and so
// does middleware.ts. If the SDK ever moves the era boundary off that
// comparison, both copies go stale silently (ADR-0016, Consequences).
export const FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28" as const;

export const ERROR_CODES = {
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
  PROTOCOL_VERSION_UNSUPPORTED: 400,
  ORIGIN_FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  PAYLOAD_TOO_LARGE: 413,
} as const;

// JSON-RPC `error.code` values that accompany the transport's 400 rejection
// for an unsupported/malformed MCP-Protocol-Version request (SEP-2575
// `server-stateless` conformance, OMC-018). Distinct from ERROR_CODES
// (HTTP statuses, all positive): these sit in the JSON-RPC body alongside
// the same HTTP 400. -32020 is the spec's HeaderMismatch /
// unsupported-protocol-version code; -32602 is the standard JSON-RPC
// Invalid Params code, reused here when the request's own `_meta` is
// present but not an object. Neither is the local-error convention
// (`-33000`, see ADR-0012/ADR-0013) — those are proxy-local failures with
// no protocol meaning, these two are spec-defined wire codes.
export const JSONRPC_ERROR_CODES = {
  INVALID_PARAMS: -32602,
  PROTOCOL_VERSION_UNSUPPORTED: -32020,
} as const;
