import { gzipSync, strToU8 } from "fflate";

/**
 * Gzip and base64 the generated page for the source module (#629). The
 * gzip header's mtime is pinned to 0 so the same page always encodes to
 * the same bytes, and a regeneration with no change leaves no diff. Kept
 * out of `src/` so the compressor never reaches the plugin bundle; only
 * the decoder does.
 */
export function encodeAppHtml(html: string): string {
  const bytes = gzipSync(strToU8(html), { level: 9, mtime: 0 });
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
