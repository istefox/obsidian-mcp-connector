import { type } from "arktype";
import { requestUrl } from "obsidian";
import TurndownService from "turndown";

const DEFAULT_MAX_LENGTH = 5000;

// Hard ceiling on returned characters: an unbounded `maxLength` lets an
// MCP client request a multi-MB slice and OOM the renderer.
const MAX_LENGTH_CEILING = 500_000;

// `requestUrl` has no native timeout option; race it against this so a
// hung host cannot pin the handler indefinitely.
const REQUEST_TIMEOUT_MS = 30_000;

// Loopback / link-local / RFC-1918 ranges that an MCP client (semi-
// untrusted in this project's threat model) must not be able to reach
// via `requestUrl`, which on desktop resolves internal hosts.
function isPrivateOrLoopbackHost(hostname: string): boolean {
  // Strip IPv6 brackets if present (URL.hostname keeps them for literals).
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1"
  ) {
    return true;
  }

  // IPv4 literal.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    return false;
  }

  // IPv6 literal: ::1 handled above; fc00::/7 = unique-local (fc/fd prefix).
  if (host.includes(":")) {
    if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
  }

  return false;
}

// Validate the URL before any request is made. Blocks the non-http(s)
// schemes (file:/data:/blob: — the local-file-read vector) and
// internal/loopback/RFC-1918 hosts (SSRF). DNS resolution is out of
// scope, so DNS-rebinding to a private IP is NOT covered here.
function validateFetchUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Invalid URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Unsupported URL scheme "${parsed.protocol}". Only http: and https: are allowed.`;
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return `Refusing to fetch internal/loopback host "${parsed.hostname}".`;
  }
  return null;
}

/**
 * Schema for the fetch MCP tool.
 *
 * Fetches a URL and returns the body as Markdown (default, via Turndown)
 * or raw HTML, with pagination support for long pages.
 */
export const fetchSchema = type({
  name: '"fetch"',
  arguments: {
    // ArkType `string.url` uses the `isParsableUrl` predicate, which is not
    // convertible to JSON Schema and would crash `tools/list`. URL validity
    // + scheme/host SSRF guard is enforced at runtime in the handler
    // (`validateFetchUrl`).
    url: type("string").describe("URL to fetch."),
    "format?": type('"markdown"|"html"').describe(
      "Response format. Default markdown (HTML→MD via Turndown).",
    ),
    "maxLength?": type("number.integer>=1").describe(
      "Maximum characters to return. Default 5000.",
    ),
    "startIndex?": type("number.integer>=0").describe(
      "Starting character offset. Default 0.",
    ),
  },
}).describe(
  "Fetches a URL and returns the body as Markdown (default) or raw HTML, with pagination support for long pages.",
);

/**
 * Context object passed to the fetchHandler function.
 */
export type FetchContext = {
  arguments: {
    url: string;
    format?: "markdown" | "html";
    maxLength?: number;
    startIndex?: number;
  };
};

/**
 * Handles the fetch MCP tool request.
 *
 * Fetches the given URL using Obsidian's requestUrl API, converts HTML to
 * Markdown using Turndown (unless format="html"), and applies pagination
 * logic (startIndex and maxLength).
 *
 * Returns:
 *   - MCP-formatted response with one text content block
 *   - If content exceeds maxLength, includes a truncation hint with instructions
 *     for fetching the next chunk via startIndex
 *
 * Args:
 *   ctx: Context containing url, format, maxLength, startIndex
 *
 * Returns:
 *   MCP tool result with content array
 */
export async function fetchHandler(ctx: FetchContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const format = ctx.arguments.format ?? "markdown";
  const maxLength = Math.min(
    ctx.arguments.maxLength ?? DEFAULT_MAX_LENGTH,
    MAX_LENGTH_CEILING,
  );
  const startIndex = ctx.arguments.startIndex ?? 0;

  const urlError = validateFetchUrl(ctx.arguments.url);
  if (urlError) {
    return {
      content: [{ type: "text", text: `Fetch rejected: ${urlError}` }],
      isError: true,
    };
  }

  let response;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("__FETCH_TIMEOUT__")),
        REQUEST_TIMEOUT_MS,
      );
    });
    try {
      response = await Promise.race([
        requestUrl({ url: ctx.arguments.url }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "__FETCH_TIMEOUT__") {
      return {
        content: [
          {
            type: "text",
            text: `Fetch failed: request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `Fetch failed: ${message}`,
        },
      ],
      isError: true,
    };
  }

  let body = response.text;

  // Convert HTML to Markdown if format is "markdown"
  if (format === "markdown") {
    const td = new TurndownService({
      headingStyle: "atx",
      hr: "---",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
    });
    body = td.turndown(body);
  }

  // Apply pagination: slice from startIndex to startIndex + maxLength
  const sliced = body.slice(startIndex, startIndex + maxLength);
  const totalLength = body.length;
  const isTruncated = totalLength > startIndex + maxLength;

  // Add truncation hint if content was truncated
  const truncationNote = isTruncated
    ? `\n\n[Content truncated. ${totalLength - startIndex - maxLength} characters remaining; resume with startIndex=${startIndex + maxLength}.]`
    : "";

  return {
    content: [{ type: "text", text: sliced + truncationNote }],
  };
}
