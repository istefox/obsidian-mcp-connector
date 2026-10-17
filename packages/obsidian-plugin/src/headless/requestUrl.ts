/**
 * Obsidian's `requestUrl` over node:http and node:https, for the `fetch` tool.
 *
 * It keeps the parts of the contract the tool depends on: the response has
 * `status`, lower-cased `headers`, `arrayBuffer`, and `text` and `json`
 * decoded from the body, and a status of 400 or more throws an error
 * carrying `status` unless the request says `throw: false`.
 *
 * The tool only checks the URL string, so this module enforces the network
 * policy itself, on the connection:
 *
 * - `localhost` names and non-public addresses are refused, for literals and
 *   for every address a name resolves to (see `isBlockedAddress`).
 * - The check runs inside the socket's `lookup`, so the address that was
 *   validated is the address that gets connected to. A second lookup cannot
 *   swap in a different answer (DNS rebinding).
 * - Redirects are followed by hand, at most 5, and each hop goes through the
 *   same checks.
 * - The body is capped at 10 MB, on the wire and after decompression, and the
 *   whole call has a 40 second budget.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

export type RequestUrlParam = {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  /** Throw on a status of 400 or more. Default true. */
  throw?: boolean;
};

export type RequestUrlResponse = {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  readonly text: string;
  readonly json: unknown;
};

export type ResolvedAddress = { address: string; family: number };

export type RequestUrlDeps = {
  /** Resolves a host name to all of its addresses. Defaults to node:dns. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Largest body accepted, in bytes. Default 10 MB. */
  maxResponseBytes?: number;
  /** Budget for the whole call, all hops and the body. Default 40 s. */
  timeoutMs?: number;
  /** Timer functions, so tests can fire the timeout without waiting. */
  timers?: {
    setTimeout: (callback: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /** Lets loopback addresses through. For tests that talk to a local server. */
  allowLoopback?: boolean;
};

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 40_000;
const MAX_REDIRECTS = 5;

// IPv4 ranges that are not public, as [first address, prefix length].
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // shared address space (CGNAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const BLOCKED_IPV4_RANGES = BLOCKED_IPV4.map(([base, bits]) => {
  const size = 2 ** (32 - bits);
  const start = parseIPv4(base) as number;
  return { start, end: start + size - 1 };
});

function isBlockedIPv4(value: number): boolean {
  return BLOCKED_IPV4_RANGES.some(
    ({ start, end }) => value >= start && value <= end,
  );
}

/** Parses a valid IPv6 address into its eight 16-bit groups. */
function parseIPv6(address: string): number[] | null {
  let text = address.split("%")[0];
  if (text.includes(".")) {
    const cut = text.lastIndexOf(":") + 1;
    const v4 = parseIPv4(text.slice(cut));
    if (v4 === null) return null;
    text = `${text.slice(0, cut)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const words = [
    ...head,
    ...Array<string>(fill > 0 ? fill : 0).fill("0"),
    ...tail,
  ];
  const groups = words.map((word) =>
    /^[0-9a-f]{1,4}$/i.test(word) ? parseInt(word, 16) : NaN,
  );
  return groups.some(Number.isNaN) ? null : groups;
}

function isBlockedIPv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embedded = g6 * 65536 + g7;
  const zeroTo = (end: number) => groups.slice(0, end).every((g) => g === 0);

  if (zeroTo(5) && g5 === 0xffff) return isBlockedIPv4(embedded); // ::ffff:a.b.c.d
  if (zeroTo(4) && g4 === 0xffff && g5 === 0) return isBlockedIPv4(embedded); // ::ffff:0:a.b.c.d
  if (zeroTo(6)) return isBlockedIPv4(embedded); // ::a.b.c.d, also :: and ::1
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
      return isBlockedIPv4(embedded); // 64:ff9b::/96
    if (g2 === 1) return true; // 64:ff9b:1::/48, local-use NAT64
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  // Both carry an IPv4 address in the tunnel they stand for. Neither is a
  // public destination for a web page, so they are refused whole.
  if (g0 === 0x2002) return true; // 2002::/16 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // 2001::/32 Teredo
  return false;
}

/**
 * True when the address is not a public unicast address. Anything that is
 * not a valid IP literal counts as blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const text = address.replace(/^\[|\]$/g, "");
  switch (net.isIP(text)) {
    case 4:
      return isBlockedIPv4(parseIPv4(text) as number);
    case 6: {
      const groups = parseIPv6(text);
      return groups === null || isBlockedIPv6(groups);
    }
    default:
      return true;
  }
}

function isLoopback(address: string): boolean {
  const text = address.replace(/^\[|\]$/g, "");
  return text === "::1" || (net.isIPv4(text) && text.startsWith("127."));
}

/** An error raised by this module's own checks, shown to the caller as is. */
class RequestPolicyError extends Error {}

function describeFailure(err: unknown): string {
  if (err instanceof RequestPolicyError) return err.message;
  if (!(err instanceof Error)) return String(err);
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors[0] instanceof Error) {
    return describeFailure(errors[0]);
  }
  const code = (err as { code?: unknown }).code;
  const message =
    err.message || (typeof code === "string" ? code : "Request failed");
  const cause = err.cause;
  return cause instanceof Error && cause.message
    ? `${message}: ${cause.message}`
    : message;
}

function refuseAddress(address: string): RequestPolicyError {
  return new RequestPolicyError(
    `Refusing to connect to a non-public address (${address})`,
  );
}

function refuseHostName(hostname: string): RequestPolicyError {
  return new RequestPolicyError(`Refusing to connect to host "${hostname}"`);
}

const defaultResolve = async (hostname: string): Promise<ResolvedAddress[]> =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

type Hop = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** Set instead of a body when the response is a redirect to follow. */
  location?: string;
};

type Context = {
  deps: Required<Omit<RequestUrlDeps, "timers" | "allowLoopback">> & {
    isBlocked: (address: string) => boolean;
  };
  /** Set when the time budget ran out. */
  expired?: Error;
  /** Aborts the hop in flight. */
  cancel?: (err: Error) => void;
};

function createDecoder(
  encoding: string | undefined,
): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | undefined {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return undefined;
  }
}

function sameOrigin(a: URL, b: URL): boolean {
  return (
    a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
  );
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** Refuses a URL by scheme and host name. Addresses are checked on connect. */
function checkTarget(url: URL, ctx: Context): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RequestPolicyError(
      `Unsupported URL scheme "${url.protocol}". Only http: and https: are allowed.`,
    );
  }
  if (url.username || url.password) {
    throw new RequestPolicyError(
      "URLs with embedded credentials are not supported",
    );
  }
  const host = hostOf(url).toLowerCase();
  if (net.isIP(host)) {
    if (ctx.deps.isBlocked(host)) throw refuseAddress(host);
    return;
  }
  const name = host.replace(/\.+$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) {
    throw refuseHostName(host);
  }
  // WHATWG URL turns every numeric form into dotted decimal, so a numeric
  // last label that survives here is not a name to resolve.
  const lastLabel = name.slice(name.lastIndexOf(".") + 1);
  if (/^(\d+|0x[0-9a-f]*)$/i.test(lastLabel)) throw refuseHostName(host);
}

/**
 * A `lookup` for node:net that resolves every address, refuses the whole
 * answer if any address is non-public, and hands back only validated ones.
 */
function createLookup(ctx: Context) {
  return (
    hostname: string,
    options: { all?: boolean },
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | ResolvedAddress[],
      family?: number,
    ) => void,
  ): void => {
    ctx.deps.resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(
            Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
              code: "ENOTFOUND",
            }),
            "",
          );
          return;
        }
        for (const { address } of addresses) {
          if (ctx.deps.isBlocked(address)) {
            callback(refuseAddress(address), "");
            return;
          }
        }
        if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      },
      (err: unknown) => {
        callback(err instanceof Error ? err : new Error(String(err)), "");
      },
    );
  };
}

function responseHeaders(
  raw: http.IncomingHttpHeaders,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers[key.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : value;
  }
  return headers;
}

function tooLarge(limit: number, detail: string): RequestPolicyError {
  return new RequestPolicyError(
    `Response is too large (${detail}, limit is ${limit} bytes)`,
  );
}

function sendHop(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  ctx: Context,
): Promise<Hop> {
  const limit = ctx.deps.maxResponseBytes;
  return new Promise<Hop>((resolve, reject) => {
    let done = false;
    // What to tear down once the call has an outcome: the response and its
    // decoder. Destroying only the request leaves a decoder to inflate what
    // it already holds, which for a small compressed body is a great deal.
    const release: Array<() => void> = [];
    const settle = () => {
      done = true;
      for (const stop of release) stop();
    };
    const fail = (err: unknown) => {
      if (done) return;
      settle();
      req.destroy();
      reject(
        err instanceof RequestPolicyError
          ? err
          : new Error(describeFailure(err)),
      );
    };
    const succeed = (hop: Hop) => {
      if (done) return;
      settle();
      resolve(hop);
    };

    const host = hostOf(url);
    const options: https.RequestOptions = {
      method,
      host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers: body
        ? { ...headers, "Content-Length": String(body.length) }
        : headers,
      agent: false,
    };
    // Literals are validated up front and never reach `lookup`. Names are
    // validated and pinned inside it.
    if (!net.isIP(host)) {
      options.lookup = createLookup(
        ctx,
      ) as unknown as https.RequestOptions["lookup"];
    }

    const req = (url.protocol === "https:" ? https : http).request(
      options,
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.destroy();
          succeed({
            status,
            headers: res.headers,
            body: Buffer.alloc(0),
            location,
          });
          return;
        }

        const declared = Number(res.headers["content-length"]);
        const hasBody = method !== "HEAD" && status !== 204 && status !== 304;
        if (hasBody && declared > limit) {
          fail(tooLarge(limit, `Content-Length is ${declared}`));
          return;
        }

        const decoder = createDecoder(res.headers["content-encoding"]);
        const headersOut = { ...res.headers };
        if (decoder) {
          // The body below is already decoded.
          delete headersOut["content-encoding"];
          delete headersOut["content-length"];
        }

        release.push(() => {
          res.unpipe();
          decoder?.destroy();
          res.destroy();
        });
        let wire = 0;
        let decoded = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          if (done) return;
          wire += chunk.length;
          if (wire > limit)
            fail(tooLarge(limit, "more than the limit was received"));
        });
        res.on("error", fail);
        res.on("close", () => {
          if (!res.complete)
            fail(
              new Error("The connection closed before the response finished"),
            );
        });

        const sink: NodeJS.ReadableStream = decoder ? res.pipe(decoder) : res;
        decoder?.on("error", fail);
        sink.on("data", (chunk: Buffer | string) => {
          if (done) return;
          const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          decoded += piece.length;
          if (decoded > limit) {
            fail(tooLarge(limit, "more than the limit after decompression"));
            return;
          }
          chunks.push(piece);
        });
        sink.on("end", () =>
          succeed({ status, headers: headersOut, body: Buffer.concat(chunks) }),
        );
      },
    );

    req.on("error", fail);
    ctx.cancel = fail;
    req.end(body);
  });
}

function toBuffer(body: string | ArrayBuffer | undefined): Buffer | undefined {
  if (body === undefined) return undefined;
  return typeof body === "string"
    ? Buffer.from(body, "utf8")
    : Buffer.from(body);
}

function dropHeaders(
  headers: Record<string, string>,
  drop: (name: string) => boolean,
) {
  for (const key of Object.keys(headers)) {
    if (drop(key.toLowerCase())) delete headers[key];
  }
}

async function run(
  params: RequestUrlParam,
  ctx: Context,
): Promise<RequestUrlResponse> {
  let url: URL;
  try {
    url = new URL(params.url);
  } catch {
    throw new RequestPolicyError("Invalid URL");
  }

  let method = (params.method ?? "GET").toUpperCase();
  let body = toBuffer(params.body);
  const headers: Record<string, string> = { ...params.headers };
  dropHeaders(headers, (name) => name === "host" || name === "content-length");
  if (params.contentType) headers["Content-Type"] = params.contentType;
  // What a browser-like client sends by default. Many sites turn away a
  // request that names no client.
  const fallback = (name: string, value: string) => {
    if (!Object.keys(headers).some((k) => k.toLowerCase() === name)) {
      headers[
        name.replace(/(^|-)([a-z])/g, (_, dash, c) => dash + c.toUpperCase())
      ] = value;
    }
  };
  fallback("accept", "*/*");
  fallback("accept-encoding", "gzip, deflate, br");
  fallback("user-agent", "obsidian-mcp-headless");

  for (let redirects = 0; ; redirects++) {
    if (ctx.expired) throw ctx.expired;
    checkTarget(url, ctx);
    const hop = await sendHop(url, method, headers, body, ctx);
    if (hop.location === undefined) {
      return buildResponse(hop, params);
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new RequestPolicyError(
        `Too many redirects (more than ${MAX_REDIRECTS})`,
      );
    }

    let next: URL;
    try {
      next = new URL(hop.location, url);
    } catch {
      throw new RequestPolicyError("Invalid redirect location");
    }
    // Fetch semantics: 303, and 301 or 302 after POST, become a GET.
    const toGet =
      (hop.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((hop.status === 301 || hop.status === 302) && method === "POST");
    if (toGet) {
      method = "GET";
      body = undefined;
      dropHeaders(headers, (name) => name.startsWith("content-"));
    }
    if (!sameOrigin(url, next)) {
      dropHeaders(
        headers,
        (name) =>
          name === "authorization" ||
          name === "proxy-authorization" ||
          name === "cookie",
      );
    }
    url = next;
  }
}

function buildResponse(hop: Hop, params: RequestUrlParam): RequestUrlResponse {
  const headers = responseHeaders(hop.headers);
  const buffer = hop.body.buffer.slice(
    hop.body.byteOffset,
    hop.body.byteOffset + hop.body.byteLength,
  ) as ArrayBuffer;
  const response: RequestUrlResponse = {
    status: hop.status,
    headers,
    arrayBuffer: buffer,
    get text() {
      return new TextDecoder().decode(buffer);
    },
    get json() {
      return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
    },
  };
  if (hop.status >= 400 && params.throw !== false) {
    throw Object.assign(new Error(`Request failed, status ${hop.status}`), {
      status: hop.status,
      headers,
    });
  }
  return response;
}

/** Builds a `requestUrl` with its dependencies replaced, for tests. */
export function createRequestUrl(deps: RequestUrlDeps = {}) {
  const timers = deps.timers ?? {
    setTimeout: (callback: () => void, ms: number): unknown =>
      globalThis.setTimeout(callback, ms),
    clearTimeout: (handle: unknown) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolved: Context["deps"] = {
    resolve: deps.resolve ?? defaultResolve,
    maxResponseBytes: deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    timeoutMs,
    isBlocked: deps.allowLoopback
      ? (address) => isBlockedAddress(address) && !isLoopback(address)
      : isBlockedAddress,
  };

  return async function requestUrl(
    request: RequestUrlParam | string,
  ): Promise<RequestUrlResponse> {
    const params = typeof request === "string" ? { url: request } : request;
    const ctx: Context = { deps: resolved };
    const handle = timers.setTimeout(() => {
      ctx.expired = new Error(`Request timed out after ${timeoutMs} ms`);
      ctx.cancel?.(ctx.expired);
    }, timeoutMs);
    try {
      return await run(params, ctx);
    } catch (err) {
      if (
        err instanceof RequestPolicyError ||
        (err as { status?: unknown }).status
      ) {
        throw err;
      }
      throw new Error(describeFailure(err));
    } finally {
      timers.clearTimeout(handle);
    }
  };
}

export const requestUrl = createRequestUrl();
