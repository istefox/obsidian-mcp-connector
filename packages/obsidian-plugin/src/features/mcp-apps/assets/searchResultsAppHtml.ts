import { gunzipSync, strFromU8 } from "fflate";
import { SEARCH_RESULTS_APP_HTML_GZIP_BASE64 } from "./searchResultsAppSource";

/**
 * The page ships gzipped and base64-encoded (#629): about 137 KB in the
 * bundle instead of 420 KB. It is decoded on the first `ui://` read, not
 * at load, and kept for the rest of the session.
 */
let cached: string | undefined;

export function searchResultsAppHtml(): string {
  cached ??= decodeAppHtml(SEARCH_RESULTS_APP_HTML_GZIP_BASE64);
  return cached;
}

/** Inverse of `encodeAppHtml` in scripts/mcp-apps/encodeAppHtml.ts. */
export function decodeAppHtml(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return strFromU8(gunzipSync(bytes));
}
