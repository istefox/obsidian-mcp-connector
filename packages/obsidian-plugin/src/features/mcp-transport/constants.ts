export const PORT_RANGE = [27200, 27201, 27202, 27203, 27204, 27205] as const;
export const BIND_HOST = "127.0.0.1" as const;
export const MCP_PATH_PREFIX = "/mcp" as const;
export const TOKEN_BYTE_LENGTH = 32 as const;

// Cap on the request body to bound memory in the Electron renderer (DoS/OOM).
export const MAX_REQUEST_BODY_BYTES = 1_048_576 as const;

export const ALLOWED_ORIGINS_PATTERN =
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

// MCP protocol versions this server speaks. Project-owned copy of the
// @modelcontextprotocol/sdk's internal SUPPORTED_PROTOCOL_VERSIONS list
// (node_modules/@modelcontextprotocol/sdk/dist/esm/types.js), kept here so
// it is visible and testable in this project's own suite. Newest first.
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

export const ERROR_CODES = {
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
  PROTOCOL_VERSION_UNSUPPORTED: 400,
  ORIGIN_FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  PAYLOAD_TOO_LARGE: 413,
} as const;
