import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import zlib from "node:zlib";
import {
  createRequestUrl,
  isBlockedAddress,
  type ResolvedAddress,
} from "./requestUrl";

type Seen = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

let server: http.Server;
let port: number;
let seen: Seen[] = [];
let base: string;
let sockets = new Set<Socket>();
let waiters: Array<() => void> = [];

beforeEach(async () => {
  seen = [];
  waiters = [];
  sockets = new Set();
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      route(req, res);
      for (const wake of waiters) wake();
    });
  });
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  switch (url.pathname) {
    case "/json":
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Custom-Header": "Value",
      });
      res.end('{"a":[1,2]}');
      break;
    case "/utf8":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<p>wörld</p>");
      break;
    case "/missing":
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no such page");
      break;
    case "/redirect": {
      const to = url.searchParams.get("to") ?? "/json";
      res.writeHead(Number(url.searchParams.get("code") ?? 302), {
        Location: to.startsWith("/") ? `${base}${to}` : to,
      });
      res.end();
      break;
    }
    case "/loop":
      res.writeHead(302, { Location: "/loop" });
      res.end();
      break;
    case "/drop":
      req.socket.destroy();
      break;
    case "/content-length-over":
      res.writeHead(200, { "Content-Length": "5000" });
      res.flushHeaders();
      break;
    case "/chunked-over":
      // Never ends, so the call can only finish by aborting mid-stream.
      res.writeHead(200);
      res.write(Buffer.alloc(600, 97));
      res.write(Buffer.alloc(600, 97));
      break;
    case "/hang":
      break;
    case "/gzip-bomb": {
      const bomb = zlib.gzipSync(Buffer.alloc(5_000_000, 97));
      res.writeHead(200, {
        "Content-Encoding": "gzip",
        "Content-Length": String(bomb.length),
      });
      res.end(bomb);
      break;
    }
    case "/gzip-huge": {
      // 64 MB of zeros in about 64 KB, small enough to arrive whole.
      const bomb = zlib.gzipSync(Buffer.alloc(64_000_000, 0));
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(bomb);
      break;
    }
    case "/gzip":
    case "/deflate":
    case "/br": {
      const encode = {
        "/gzip": zlib.gzipSync,
        "/deflate": zlib.deflateSync,
        "/br": zlib.brotliCompressSync,
      }[url.pathname];
      res.writeHead(200, {
        "Content-Encoding": url.pathname.slice(1),
        "Content-Type": "text/plain",
      });
      res.end(encode(Buffer.from("compressed hello")));
      break;
    }
    default:
      res.writeHead(200);
      res.end(`${req.method} ${req.url}`);
  }
}

const address = (a: string): ResolvedAddress => ({
  address: a,
  family: a.includes(":") ? 6 : 4,
});

/** A resolver over a fixed table that records each lookup. */
function table(answers: Record<string, string[]>) {
  const calls: string[] = [];
  const resolve = async (hostname: string) => {
    calls.push(hostname);
    const found = answers[hostname];
    if (!found) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    return found.map(address);
  };
  return { resolve, calls };
}

/** A resolver that fails the test if it is ever asked. */
const noDns = async (hostname: string): Promise<ResolvedAddress[]> => {
  throw new Error(`DNS must not be consulted (${hostname})`);
};

const local = () => createRequestUrl({ allowLoopback: true });

const errorOf = async (promise: Promise<unknown>) =>
  (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as (Error & { status?: number }) | undefined;

describe("responses", () => {
  test("a string is a GET and the response has status, lower-cased headers and bodies", async () => {
    const res = await local()(`${base}/json`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["x-custom-header"]).toBe("Value");
    expect(res.text).toBe('{"a":[1,2]}');
    expect(res.json).toEqual({ a: [1, 2] });
    expect(new TextDecoder().decode(res.arrayBuffer)).toBe('{"a":[1,2]}');
    expect(seen[0].method).toBe("GET");
  });

  test("a body is decoded as UTF-8", async () => {
    const res = await local()({ url: `${base}/utf8` });
    expect(res.text).toBe("<p>wörld</p>");
  });

  test("method, headers, content type and body are sent", async () => {
    const res = await local()({
      url: `${base}/echo`,
      method: "POST",
      contentType: "application/x-test",
      headers: { "X-Probe": "1" },
      body: "payload",
    });
    expect(res.text).toBe("POST /echo");
    expect(seen[0]).toMatchObject({ method: "POST", body: "payload" });
    expect(seen[0].headers["content-type"]).toBe("application/x-test");
    expect(seen[0].headers["x-probe"]).toBe("1");
    expect(seen[0].headers["content-length"]).toBe("7");
  });

  test("a client name, accept and encodings are sent unless the caller chose them", async () => {
    await local()(`${base}/echo`);
    expect(seen[0].headers["user-agent"]).toBe("obsidian-mcp-headless");
    expect(seen[0].headers.accept).toBe("*/*");
    expect(seen[0].headers["accept-encoding"]).toBe("gzip, deflate, br");
    await local()({
      url: `${base}/echo`,
      headers: { "user-agent": "mine", Accept: "text/html" },
    });
    expect(seen[1].headers["user-agent"]).toBe("mine");
    expect(seen[1].headers.accept).toBe("text/html");
  });

  test("an ArrayBuffer body is sent as bytes", async () => {
    await local()({
      url: `${base}/echo`,
      method: "PUT",
      body: new TextEncoder().encode("bytes").buffer as ArrayBuffer,
    });
    expect(seen[0].body).toBe("bytes");
  });

  test("a status of 400 or more throws with status and headers", async () => {
    const err = await errorOf(local()(`${base}/missing`));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe("Request failed, status 404");
    expect(err?.status).toBe(404);
    expect((err as { headers?: Record<string, string> }).headers).toMatchObject(
      { "content-type": "text/plain" },
    );
  });

  test("throw: false returns the response instead", async () => {
    const res = await local()({ url: `${base}/missing`, throw: false });
    expect(res.status).toBe(404);
    expect(res.text).toBe("no such page");
  });

  test("gzip, deflate and br responses are decoded", async () => {
    for (const path of ["/gzip", "/deflate", "/br"]) {
      const res = await local()(`${base}${path}`);
      expect(res.text).toBe("compressed hello");
      expect(res.headers["content-encoding"]).toBeUndefined();
    }
    expect(seen[0].headers["accept-encoding"]).toBe("gzip, deflate, br");
  });

  test("a name is resolved through the injected resolver", async () => {
    const dns = table({ "pages.test": ["127.0.0.1"] });
    const res = await createRequestUrl({
      resolve: dns.resolve,
      allowLoopback: true,
    })(`http://pages.test:${port}/json`);
    expect(res.status).toBe(200);
    expect(seen[0].headers.host).toBe(`pages.test:${port}`);
    expect(dns.calls).toEqual(["pages.test"]);
  });

  test("a dropped connection throws an error with a message", async () => {
    const err = await errorOf(local()(`${base}/drop`));
    expect(err).toBeInstanceOf(Error);
    expect(err?.message.length).toBeGreaterThan(0);
  });

  test("an unusable URL throws", async () => {
    await expect(local()("not a url")).rejects.toThrow("Invalid URL");
  });

  test("a URL with credentials is refused", async () => {
    await expect(local()(`http://user:pw@127.0.0.1:${port}/`)).rejects.toThrow(
      "embedded credentials",
    );
    expect(seen).toHaveLength(0);
  });
});

describe("refused targets", () => {
  const refused = [
    "http://localhost:PORT/",
    "http://LOCALHOST:PORT/",
    "http://localhost.:PORT/",
    "http://x.localhost:PORT/",
    "http://x.localhost.:PORT/",
    "http://[::ffff:127.0.0.1]:PORT/",
    "http://[::ffff:7f00:1]:PORT/",
    "http://127.1:PORT/",
    "http://0x7f.1:PORT/",
    "http://2130706433:PORT/",
    "http://017700000001:PORT/",
    "http://127.0.0.1:PORT/",
    "http://0.0.0.0:PORT/",
    "http://[::1]:PORT/",
    "http://[::]:PORT/",
    "http://[::127.0.0.1]:PORT/",
    "http://[64:ff9b::7f00:1]:PORT/",
    "http://169.254.169.254:PORT/",
  ];

  test.each(refused)(
    "%s is refused before any DNS or connection",
    async (t) => {
      const url = t.replace("PORT", String(port));
      const err = await errorOf(createRequestUrl({ resolve: noDns })(url));
      expect(err?.message).toMatch(/^Refusing to connect to/);
      expect(seen).toHaveLength(0);
    },
  );

  test("the message names the address", async () => {
    const err = await errorOf(createRequestUrl({ resolve: noDns })(base));
    expect(err?.message).toBe(
      "Refusing to connect to a non-public address (127.0.0.1)",
    );
  });

  test("a name that resolves to a private address is refused", async () => {
    const dns = table({ "intranet.test": ["10.1.2.3"] });
    const err = await errorOf(
      createRequestUrl({ resolve: dns.resolve })("http://intranet.test/"),
    );
    expect(err?.message).toBe(
      "Refusing to connect to a non-public address (10.1.2.3)",
    );
  });

  test("a name that resolves to loopback is refused by default", async () => {
    const dns = table({ "sneaky.test": ["127.0.0.1"] });
    const err = await errorOf(
      createRequestUrl({ resolve: dns.resolve })(
        `http://sneaky.test:${port}/json`,
      ),
    );
    expect(err?.message).toMatch(/non-public address \(127\.0\.0\.1\)/);
    expect(seen).toHaveLength(0);
  });

  test("a mapped IPv6 answer for a private address is refused", async () => {
    const dns = table({ "mapped.test": ["::ffff:10.0.0.1"] });
    await expect(
      createRequestUrl({ resolve: dns.resolve })("http://mapped.test/"),
    ).rejects.toThrow("non-public address");
  });

  test("one private address among public ones refuses the name", async () => {
    // The private answer is the one the server listens on, so a client
    // that skipped validation would reach it.
    const dns = table({ "mixed.test": ["93.184.216.34", "127.0.0.1"] });
    const err = await errorOf(
      createRequestUrl({ resolve: dns.resolve })(
        `http://mixed.test:${port}/json`,
      ),
    );
    expect(err?.message).toMatch(/non-public address \(127\.0\.0\.1\)/);
    expect(seen).toHaveLength(0);
  });

  test("a private address is refused even when it comes second with loopback allowed", async () => {
    const dns = table({ "mixed.test": ["127.0.0.1", "10.0.0.1"] });
    const err = await errorOf(
      createRequestUrl({ resolve: dns.resolve, allowLoopback: true })(
        `http://mixed.test:${port}/json`,
      ),
    );
    expect(err?.message).toMatch(/non-public address \(10\.0\.0\.1\)/);
    expect(seen).toHaveLength(0);
  });

  test("a name with no addresses is an error", async () => {
    const dns = table({ "empty.test": [] });
    await expect(
      createRequestUrl({ resolve: dns.resolve })("http://empty.test/"),
    ).rejects.toThrow("ENOTFOUND");
  });

  test("a resolver failure is reported", async () => {
    const dns = table({});
    await expect(
      createRequestUrl({ resolve: dns.resolve })("http://nowhere.test/"),
    ).rejects.toThrow("ENOTFOUND nowhere.test");
  });

  test("non-http schemes are refused", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x"]) {
      await expect(createRequestUrl({ resolve: noDns })(url)).rejects.toThrow(
        "Unsupported URL scheme",
      );
    }
  });
});

describe("DNS rebinding", () => {
  test("validation and connection use the answer from connect time", async () => {
    // Public (to this test's policy) on the first answer, private after.
    let answers = ["127.0.0.1"];
    const calls: string[] = [];
    const requestUrl = createRequestUrl({
      allowLoopback: true,
      resolve: async (hostname) => {
        calls.push(hostname);
        return answers.map(address);
      },
    });
    const url = `http://rebind.test:${port}/json`;

    // One lookup, made while connecting, and the socket went to its answer.
    const first = await requestUrl(url);
    expect(first.status).toBe(200);
    expect(calls).toEqual(["rebind.test"]);
    expect(seen).toHaveLength(1);

    // The name now answers with a private address. The next call looks it
    // up again, validates the new answer and refuses it.
    answers = ["10.0.0.1"];
    const err = await errorOf(requestUrl(url));
    expect(err?.message).toMatch(/non-public address \(10\.0\.0\.1\)/);
    expect(calls).toEqual(["rebind.test", "rebind.test"]);
    expect(seen).toHaveLength(1);
  });

  test("a redirect to a name that now answers privately is refused", async () => {
    const dns = table({
      "first.test": ["127.0.0.1"],
      "second.test": ["10.0.0.9"],
    });
    const requestUrl = createRequestUrl({
      resolve: dns.resolve,
      allowLoopback: true,
    });
    const err = await errorOf(
      requestUrl(
        `http://first.test:${port}/redirect?to=${encodeURIComponent(`http://second.test:${port}/json`)}`,
      ),
    );
    expect(err?.message).toMatch(/non-public address \(10\.0\.0\.9\)/);
    expect(dns.calls).toEqual(["first.test", "second.test"]);
    expect(seen).toHaveLength(1);
  });
});

describe("redirects", () => {
  test("a redirect is followed", async () => {
    const res = await local()(`${base}/redirect?to=/utf8`);
    expect(res.text).toBe("<p>wörld</p>");
    expect(seen.map((s) => s.url)).toEqual(["/redirect?to=/utf8", "/utf8"]);
  });

  test("a relative Location is resolved against the current URL", async () => {
    const res = await local()(`${base}/redirect?to=/echo%3Fa%3D1`);
    expect(res.text).toBe("GET /echo?a=1");
  });

  test.each([
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::ffff:10.0.0.1]/",
    "http://[::ffff:a00:1]/",
    "http://192.168.1.1/",
    "http://localhost/",
    "http://x.localhost./",
  ])(
    "a redirect to %s is refused although the first hop is allowed",
    async (target) => {
      const err = await errorOf(
        local()(`${base}/redirect?to=${encodeURIComponent(target)}`),
      );
      expect(err?.message).toMatch(/^Refusing to connect to/);
      expect(seen).toHaveLength(1);
    },
  );

  test.each([
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com/",
  ])("a redirect to %s is refused", async (target) => {
    const err = await errorOf(
      local()(`${base}/redirect?to=${encodeURIComponent(target)}`),
    );
    expect(err?.message).toMatch(/Unsupported URL scheme/);
    expect(seen).toHaveLength(1);
  });

  test("more than 5 redirects is an error", async () => {
    const err = await errorOf(local()(`${base}/loop`));
    expect(err?.message).toBe("Too many redirects (more than 5)");
    // The first request and five followed redirects.
    expect(seen).toHaveLength(6);
  });

  test("a redirect without a Location is returned as the response", async () => {
    const res = await local()({
      url: `${base}/redirect?to=&code=302`,
      throw: false,
    });
    expect(res.status).toBe(302);
  });

  test("303 after POST becomes a GET without the body", async () => {
    await local()({
      url: `${base}/redirect?code=303&to=/echo`,
      method: "POST",
      contentType: "text/plain",
      body: "payload",
    });
    expect(seen[0]).toMatchObject({ method: "POST", body: "payload" });
    expect(seen[1]).toMatchObject({ method: "GET", url: "/echo", body: "" });
    expect(seen[1].headers["content-type"]).toBeUndefined();
    expect(seen[1].headers["content-length"]).toBeUndefined();
  });

  test.each([301, 302])("%d after POST becomes a GET", async (code) => {
    await local()({
      url: `${base}/redirect?code=${code}&to=/echo`,
      method: "POST",
      body: "payload",
    });
    expect(seen[1]).toMatchObject({ method: "GET", body: "" });
  });

  test.each([307, 308])("%d keeps the method and body", async (code) => {
    await local()({
      url: `${base}/redirect?code=${code}&to=/echo`,
      method: "POST",
      contentType: "text/plain",
      body: "payload",
    });
    expect(seen[1]).toMatchObject({
      method: "POST",
      url: "/echo",
      body: "payload",
    });
    expect(seen[1].headers["content-type"]).toBe("text/plain");
  });

  test("301 keeps a PUT", async () => {
    await local()({
      url: `${base}/redirect?code=301&to=/echo`,
      method: "PUT",
      body: "payload",
    });
    expect(seen[1]).toMatchObject({ method: "PUT", body: "payload" });
  });

  test("Authorization is stripped on a cross-origin redirect only", async () => {
    const dns = table({
      "a.test": ["127.0.0.1"],
      "b.test": ["127.0.0.1"],
    });
    const requestUrl = createRequestUrl({
      resolve: dns.resolve,
      allowLoopback: true,
    });
    const headers = { Authorization: "Bearer secret", Cookie: "s=1" };

    await requestUrl({
      url: `http://a.test:${port}/redirect?to=${encodeURIComponent(`http://b.test:${port}/echo`)}`,
      headers,
    });
    expect(seen[0].headers.authorization).toBe("Bearer secret");
    expect(seen[1].headers.host).toBe(`b.test:${port}`);
    expect(seen[1].headers.authorization).toBeUndefined();
    expect(seen[1].headers.cookie).toBeUndefined();

    seen = [];
    await requestUrl({
      url: `http://a.test:${port}/redirect?to=${encodeURIComponent(`http://a.test:${port}/echo`)}`,
      headers,
    });
    expect(seen[1].headers.authorization).toBe("Bearer secret");
  });
});

describe("limits", () => {
  test("a Content-Length over the cap is refused up front", async () => {
    // The server never sends a body, so only the header can decide this.
    const err = await errorOf(
      createRequestUrl({ allowLoopback: true, maxResponseBytes: 1000 })(
        `${base}/content-length-over`,
      ),
    );
    expect(err?.message).toBe(
      "Response is too large (Content-Length is 5000, limit is 1000 bytes)",
    );
  });

  test("a chunked response over the cap is aborted mid-stream", async () => {
    const err = await errorOf(
      createRequestUrl({ allowLoopback: true, maxResponseBytes: 1000 })(
        `${base}/chunked-over`,
      ),
    );
    expect(err?.message).toMatch(/^Response is too large/);
  });

  test("a body at the cap is accepted", async () => {
    const res = await createRequestUrl({
      allowLoopback: true,
      maxResponseBytes: 11,
    })(`${base}/json`);
    expect(res.text).toBe('{"a":[1,2]}');
  });

  test("a gzip bomb is aborted by the decompressed cap", async () => {
    const err = await errorOf(
      createRequestUrl({ allowLoopback: true, maxResponseBytes: 100_000 })(
        `${base}/gzip-bomb`,
      ),
    );
    expect(err?.message).toBe(
      "Response is too large (more than the limit after decompression, limit is 100000 bytes)",
    );
  });

  test("a rejected response stops being inflated", async () => {
    // Watch the decoder the call creates.
    const made: zlib.Gunzip[] = [];
    const create = zlib.createGunzip;
    let emitted = 0;
    zlib.createGunzip = ((...args: Parameters<typeof create>) => {
      const decoder = create(...args);
      decoder.on("data", (chunk: Buffer) => (emitted += chunk.length));
      made.push(decoder);
      return decoder;
    }) as typeof create;
    try {
      const err = await errorOf(
        createRequestUrl({ allowLoopback: true, maxResponseBytes: 100_000 })(
          `${base}/gzip-huge`,
        ),
      );
      expect(err?.message).toContain("after decompression");
      expect(made).toHaveLength(1);
      // Destroyed by the time the call has rejected, not left to finish.
      expect(made[0].destroyed).toBe(true);
      const atRejection = emitted;
      // Give anything still running every chance to run.
      for (let turn = 0; turn < 5; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(emitted).toBe(atRejection);
      // Far less than the 64 MB the body would have become.
      expect(emitted).toBeLessThan(8_000_000);
    } finally {
      zlib.createGunzip = create;
    }
  });

  test("a response that was cut off on the wire is released too", async () => {
    const made: zlib.Gunzip[] = [];
    const create = zlib.createGunzip;
    zlib.createGunzip = ((...args: Parameters<typeof create>) => {
      const decoder = create(...args);
      made.push(decoder);
      return decoder;
    }) as typeof create;
    try {
      const err = await errorOf(
        createRequestUrl({ allowLoopback: true, maxResponseBytes: 1_000 })(
          `${base}/gzip-huge`,
        ),
      );
      expect(err?.message).toContain("too large");
      expect(made[0].destroyed).toBe(true);
    } finally {
      zlib.createGunzip = create;
    }
  });

  test("the default cap is 10 MB, so a 5 MB body passes", async () => {
    const err = await errorOf(local()({ url: `${base}/gzip-bomb` }));
    // 5 MB decompressed fits under the default cap.
    expect(err).toBeUndefined();
  });
});

describe("the total timeout", () => {
  function fakeTimers() {
    const pending = new Map<number, { callback: () => void; ms: number }>();
    let next = 1;
    return {
      pending,
      timers: {
        setTimeout: (callback: () => void, ms: number) => {
          pending.set(next, { callback, ms });
          return next++;
        },
        clearTimeout: (handle: unknown) => {
          pending.delete(handle as number);
        },
      },
      fire: () => {
        for (const timer of [...pending.values()]) timer.callback();
      },
    };
  }

  /** Resolves once the server has received `count` requests. */
  const requestsSeen = (count: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (seen.length >= count) resolve();
      };
      waiters.push(check);
      check();
    });

  test("the default budget is 40 seconds and the timer is cleared", async () => {
    const fake = fakeTimers();
    await createRequestUrl({ allowLoopback: true, timers: fake.timers })(
      `${base}/json`,
    );
    expect(fake.pending.size).toBe(0);

    const hung = createRequestUrl({ allowLoopback: true, timers: fake.timers })(
      `${base}/hang`,
    );
    expect([...fake.pending.values()].map((t) => t.ms)).toEqual([40_000]);
    await requestsSeen(2);
    fake.fire();
    await errorOf(hung);
  });

  test("firing the timer aborts a request that never answers", async () => {
    const fake = fakeTimers();
    const call = createRequestUrl({
      allowLoopback: true,
      timeoutMs: 1234,
      timers: fake.timers,
    })(`${base}/hang`);
    await requestsSeen(1);
    fake.fire();
    const err = await errorOf(call);
    expect(err?.message).toBe("Request timed out after 1234 ms");
    expect(fake.pending.size).toBe(0);
  });

  test("firing the timer aborts a body that never finishes", async () => {
    const fake = fakeTimers();
    const call = createRequestUrl({
      allowLoopback: true,
      timers: fake.timers,
    })(`${base}/chunked-over`);
    await requestsSeen(1);
    fake.fire();
    const err = await errorOf(call);
    expect(err?.message).toMatch(/timed out/);
  });

  test("the budget covers every hop", async () => {
    const fake = fakeTimers();
    const call = createRequestUrl({
      allowLoopback: true,
      timers: fake.timers,
    })(`${base}/redirect?to=/hang`);
    await requestsSeen(2);
    expect(fake.pending.size).toBe(1);
    fake.fire();
    await expect(call).rejects.toThrow("timed out");
  });
});

describe("isBlockedAddress", () => {
  const blocked = [
    // 0.0.0.0/8
    "0.0.0.0",
    "0.255.255.255",
    // 10/8
    "10.0.0.0",
    "10.255.255.255",
    // 100.64/10
    "100.64.0.0",
    "100.127.255.255",
    // 127/8
    "127.0.0.1",
    "127.255.255.255",
    // 169.254/16
    "169.254.0.0",
    "169.254.169.254",
    // 172.16/12
    "172.16.0.0",
    "172.31.255.255",
    // 192.0.0/24, 192.0.2/24, 192.88.99/24
    "192.0.0.0",
    "192.0.0.255",
    "192.0.2.1",
    "192.88.99.1",
    // 192.168/16
    "192.168.0.0",
    "192.168.255.255",
    // 198.18/15
    "198.18.0.0",
    "198.19.255.255",
    // documentation
    "198.51.100.7",
    "203.0.113.7",
    // multicast, reserved, broadcast
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.0",
    "255.255.255.254",
    "255.255.255.255",
    // IPv6
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "fc00::",
    "fd12:3456:789a::1",
    "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "ff00::",
    "ff02::1",
    "2001:db8::",
    "2001:db8:ffff::1",
    // 6to4 and Teredo carry an IPv4 address in a tunnel
    "2002::",
    "2002:7f00:1::1",
    "2002:c0a8:101::",
    "2001::",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "[::1]",
    // IPv4-mapped, dotted and hex
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::ffff:192.168.1.1",
    "::ffff:c0a8:101",
    "::ffff:100.64.0.1",
    "::ffff:0.0.0.0",
    "::ffff:255.255.255.255",
    "::ffff:ffff:ffff",
    "0:0:0:0:0:ffff:7f00:1",
    // IPv4-mapped without the leading zeros collapsed
    "::FFFF:7F00:1",
    // IPv4-translated
    "::ffff:0:127.0.0.1",
    // IPv4-compatible
    "::127.0.0.1",
    "::7f00:1",
    "::10.0.0.1",
    "::a9fe:a9fe",
    "::192.168.0.1",
    // NAT64
    "64:ff9b::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::c0a8:1",
    "64:ff9b:1::1",
    // not an address at all
    "",
    "localhost",
    "example.com",
    "1.2.3",
    "999.1.1.1",
    "127.1",
  ];

  const open = [
    "8.8.8.8",
    "1.1.1.1",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.1",
    "126.255.255.255",
    "128.0.0.1",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.1",
    "192.0.1.1",
    "192.0.3.1",
    "192.88.98.1",
    "192.88.100.1",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "198.51.99.255",
    "198.51.101.0",
    "203.0.112.255",
    "203.0.114.0",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2001:db9::1",
    "2001:db7:ffff::1",
    "fbff::1",
    "fec0::1",
    "feff::1",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "::8.8.8.8",
    "64:ff9b::8.8.8.8",
    "64:ff9b::808:808",
    "2a00:1450:4001::1",
    "2003::1",
    "2001:1::1",
  ];

  test.each(blocked)("%p is blocked", (a) => {
    expect(isBlockedAddress(a)).toBe(true);
  });

  test.each(open)("%p is allowed", (a) => {
    expect(isBlockedAddress(a)).toBe(false);
  });
});
