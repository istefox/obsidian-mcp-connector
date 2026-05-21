export const PORT_RANGE = [27200, 27201, 27202, 27203, 27204, 27205] as const;
export const BIND_HOST = "127.0.0.1" as const;
export const MCP_PATH_PREFIX = "/mcp" as const;
export const TOKEN_BYTE_LENGTH = 32 as const;

// Cap on the request body to bound memory in the Electron renderer (DoS/OOM).
export const MAX_REQUEST_BODY_BYTES = 1_048_576 as const;

export const ALLOWED_ORIGINS_PATTERN =
  /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

export const ERROR_CODES = {
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
  ORIGIN_FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  PAYLOAD_TOO_LARGE: 413,
} as const;
