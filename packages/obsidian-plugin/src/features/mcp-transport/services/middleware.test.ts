import { describe, expect, test } from "bun:test";
import { checkMethodAndPath } from "./middleware";

describe("checkMethodAndPath", () => {
  test("accepts POST /mcp", () => {
    expect(checkMethodAndPath("POST", "/mcp")).toEqual({ ok: true });
  });

  test("accepts GET /mcp", () => {
    expect(checkMethodAndPath("GET", "/mcp")).toEqual({ ok: true });
  });

  test("accepts /mcp/ with trailing slash", () => {
    expect(checkMethodAndPath("POST", "/mcp/")).toEqual({ ok: true });
  });

  test("accepts /mcp/session-id subpaths", () => {
    expect(checkMethodAndPath("POST", "/mcp/abc123")).toEqual({ ok: true });
  });

  test("rejects PUT /mcp with 405", () => {
    expect(checkMethodAndPath("PUT", "/mcp")).toEqual({
      ok: false,
      status: 405,
    });
  });

  test("rejects POST /other with 404", () => {
    expect(checkMethodAndPath("POST", "/other")).toEqual({
      ok: false,
      status: 404,
    });
  });

  test("rejects POST / with 404", () => {
    expect(checkMethodAndPath("POST", "/")).toEqual({ ok: false, status: 404 });
  });

  test("strips query string before path check", () => {
    expect(checkMethodAndPath("POST", "/mcp?foo=bar")).toEqual({ ok: true });
  });

  test("strips query string on a rejected path too", () => {
    expect(checkMethodAndPath("POST", "/other?foo=bar")).toEqual({
      ok: false,
      status: 404,
    });
  });

  test("treats undefined method as disallowed (405) on valid path", () => {
    expect(checkMethodAndPath(undefined, "/mcp")).toEqual({
      ok: false,
      status: 405,
    });
  });

  test("treats undefined url as 404", () => {
    expect(checkMethodAndPath("POST", undefined)).toEqual({
      ok: false,
      status: 404,
    });
  });
});

import { runMiddleware } from "./middleware";

describe("runMiddleware", () => {
  const token = "test-token-12345678901234567890abcd";

  test("allows POST /mcp with correct Authorization and no Origin", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token}` },
      },
      token,
    );
    expect(result).toEqual({ ok: true });
  });

  test("allows POST /mcp with localhost Origin", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          origin: "http://localhost:3000",
        },
      },
      token,
    );
    expect(result).toEqual({ ok: true });
  });

  test("rejects missing Authorization with 401", () => {
    const result = runMiddleware(
      { method: "POST", url: "/mcp", headers: {} },
      token,
    );
    expect(result).toEqual({ ok: false, status: 401 });
  });

  test("rejects wrong bearer with 401", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: "Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxxxx",
        },
      },
      token,
    );
    expect(result).toEqual({ ok: false, status: 401 });
  });

  test("rejects malformed Authorization header with 401", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: { authorization: token },
      },
      token,
    );
    expect(result).toEqual({ ok: false, status: 401 });
  });

  test("rejects disallowed Origin with 403", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          origin: "http://evil.example.com",
        },
      },
      token,
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  test("rejects bad method with 405 before auth check", () => {
    const result = runMiddleware(
      { method: "DELETE", url: "/mcp", headers: {} },
      token,
    );
    expect(result).toEqual({ ok: false, status: 405 });
  });

  test("rejects unknown path with 404 before origin/auth checks", () => {
    // Unauthorized request with disallowed origin on wrong path: still 404.
    // Proves path check short-circuits before origin (403) and auth (401).
    const result = runMiddleware(
      {
        method: "POST",
        url: "/other",
        headers: { origin: "http://evil.example.com" },
      },
      "t".repeat(32),
    );
    expect(result).toEqual({ ok: false, status: 404 });
  });

  test("uses first occurrence when Authorization header is multi-valued", () => {
    // HTTP forbids duplicate Authorization per RFC 7230 §3.2.2 (singleton
    // field), but if a pathological client sends two, we accept the first
    // and reject the second silently. A valid first + invalid second → ok.
    const token = "t".repeat(32);
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: { authorization: [`Bearer ${token}`, "Bearer invalid"] },
      },
      token,
    );
    expect(result).toEqual({ ok: true });
  });
});
