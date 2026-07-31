import { randomBytes, timingSafeEqual } from "node:crypto";
import { TOKEN_BYTE_LENGTH } from "../constants";

/**
 * Generate a random bearer token using cryptographically secure random bytes.
 *
 * Converts 32 bytes of random data to base64url encoding for use in HTTP
 * Authorization headers.
 *
 * Returns:
 *   A base64url-encoded string of at least 32 characters.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTE_LENGTH).toString("base64url");
}

/**
 * Bytes of entropy behind a token record's id. The id is an opaque join
 * key (it addresses `toolLoading.profiles[<id>]`), never a credential,
 * so it only has to be collision-free and never reused — 9 bytes give
 * 12 padding-free base64url characters, short enough to read in
 * `data.json` while leaving collisions out of reach at MAX_TOKENS.
 */
const TOKEN_ID_BYTE_LENGTH = 9;

/**
 * Generate an id for a token record.
 *
 * Returns:
 *   A 12-character base64url string.
 */
export function generateTokenId(): string {
  return randomBytes(TOKEN_ID_BYTE_LENGTH).toString("base64url");
}

/**
 * Compare two bearer tokens using constant-time comparison.
 *
 * Uses crypto.timingSafeEqual to prevent timing attacks. Both inputs are
 * converted to UTF-8 buffers first; their byte lengths are compared before
 * the constant-time check, because String.prototype.length counts UTF-16
 * code units and diverges from Buffer byteLength for multi-byte characters.
 *
 * Args:
 *   a: First token string to compare.
 *   b: Second token string to compare.
 *
 * Returns:
 *   true if both tokens are identical, false otherwise.
 *
 * Raises:
 *   None (safe to call with arbitrary inputs, including multi-byte strings).
 */
export function compareTokens(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  return timingSafeEqual(aBuf, bBuf);
}
