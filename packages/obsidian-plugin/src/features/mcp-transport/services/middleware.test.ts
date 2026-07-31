import { describe, expect, test, spyOn } from "bun:test";
import * as tokenModule from "./token";
import type { TokenRecord } from "./tokenStore";
import { checkMethodAndPath } from "./middleware";

/** Build a minimal TokenRecord for middleware tests — id is the only field the middleware contract surfaces back. */
function tok(token: string, id: string): TokenRecord {
  return { id, label: id, token, createdAt: 0 };
}

describe("checkMethodAndPath", () => {
  test("accepts POST /mcp", () => {
    expect(checkMethodAndPath("POST", "/mcp")).toEqual({ ok: true });
  });

  test("rejects GET /mcp with 405 (stateless server has no SSE to offer)", () => {
    expect(checkMethodAndPath("GET", "/mcp")).toEqual({
      ok: false,
      status: 405,
    });
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
  const tokens = [tok(token, "solo")];

  test("allows POST /mcp with correct Authorization and no Origin, yielding the matched token's id", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token}` },
      },
      tokens,
    );
    expect(result).toEqual({ ok: true, tokenId: "solo" });
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
      tokens,
    );
    expect(result).toEqual({ ok: true, tokenId: "solo" });
  });

  test("rejects missing Authorization with 401", () => {
    const result = runMiddleware(
      { method: "POST", url: "/mcp", headers: {} },
      tokens,
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
      tokens,
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
      tokens,
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
      tokens,
    );
    expect(result).toEqual({ ok: false, status: 403 });
  });

  test("rejects bad method with 405 before auth check", () => {
    const result = runMiddleware(
      { method: "DELETE", url: "/mcp", headers: {} },
      tokens,
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
      [tok("t".repeat(32), "solo")],
    );
    expect(result).toEqual({ ok: false, status: 404 });
  });

  test("allows a request with no MCP-Protocol-Version header (absent is legal)", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: { authorization: `Bearer ${token}` },
      },
      tokens,
    );
    expect(result).toEqual({ ok: true, tokenId: "solo" });
  });

  test("allows a request with a supported MCP-Protocol-Version", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          "mcp-protocol-version": "2025-11-25",
        },
      },
      tokens,
    );
    expect(result).toEqual({ ok: true, tokenId: "solo" });
  });

  test("rejects an unsupported MCP-Protocol-Version with 400", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          "mcp-protocol-version": "1.0.0",
        },
      },
      tokens,
    );
    expect(result).toEqual({ ok: false, status: 400 });
  });

  test("protocol-version check runs after Origin: bad Origin + bad version → 403", () => {
    // Proves check order: Origin (403) short-circuits before the
    // protocol-version check (400) can fire.
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          origin: "http://evil.example.com",
          "mcp-protocol-version": "1.0.0",
        },
      },
      tokens,
    );
    expect(result).toEqual({ ok: false, status: 403 });
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
      [tok(token, "solo")],
    );
    expect(result).toEqual({ ok: true, tokenId: "solo" });
  });

  test("check order is unchanged end to end: 404 → 405 → 403 → 400 → 401", () => {
    // Same request shape (bad path, bad method N/A here since path wins,
    // bad origin, bad version, bad token) probed one violation at a time,
    // confirming each earlier check still wins over every later one.
    const badEverything = {
      method: "DELETE",
      url: "/nope",
      headers: {
        origin: "http://evil.example.com",
        "mcp-protocol-version": "1.0.0",
        authorization: "Bearer wrong",
      },
    };
    expect(runMiddleware(badEverything, tokens)).toEqual({
      ok: false,
      status: 404,
    });

    const badMethodOnwards = { ...badEverything, url: "/mcp" };
    expect(runMiddleware(badMethodOnwards, tokens)).toEqual({
      ok: false,
      status: 405,
    });

    const badOriginOnwards = { ...badMethodOnwards, method: "POST" };
    expect(runMiddleware(badOriginOnwards, tokens)).toEqual({
      ok: false,
      status: 403,
    });

    const badVersionOnwards = {
      ...badOriginOnwards,
      headers: { ...badOriginOnwards.headers, origin: undefined },
    };
    expect(runMiddleware(badVersionOnwards, tokens)).toEqual({
      ok: false,
      status: 400,
    });

    const badAuthOnly = {
      ...badVersionOnwards,
      headers: {
        ...badVersionOnwards.headers,
        "mcp-protocol-version": undefined,
      },
    };
    expect(runMiddleware(badAuthOnly, tokens)).toEqual({
      ok: false,
      status: 401,
    });
  });
});

describe("runMiddleware — N-token bearer matching (issue #348, ADR-0014 §2)", () => {
  const tokens: TokenRecord[] = [
    tok("token-at-position-0-aaaaaaaaaaaaaaaaaa", "id-0"),
    tok("token-at-position-1-bbbbbbbbbbbbbbbbbb", "id-1"),
    tok("token-at-position-2-cccccccccccccccccc", "id-2"),
    tok("token-at-position-3-dddddddddddddddddd", "id-3"),
    tok("token-at-position-4-eeeeeeeeeeeeeeeeee", "id-4"),
  ];

  test.each([
    [0, "id-0"],
    [2, "id-2"],
    [4, "id-4"],
  ])(
    "a token at position %i in a 5-token list authenticates and yields its OWN id, not the first entry's (R-01)",
    (position, expectedId) => {
      const presented = tokens[position]!.token;
      const result = runMiddleware(
        {
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${presented}` },
        },
        tokens,
      );
      expect(result).toEqual({ ok: true, tokenId: expectedId });
    },
  );

  test("an unknown token 401s with no field naming any configured token (R-01)", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: "Bearer totally-unknown-token-ffffffffffffffff",
        },
      },
      tokens,
    );
    expect(result).toEqual({ ok: false, status: 401 });
    // No hint of which — or whether any — configured token nearly matched.
    expect("tokenId" in result).toBe(false);
  });

  test("an empty token list 401s every request (fail closed)", () => {
    const result = runMiddleware(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${tokens[0]!.token}`,
        },
      },
      [],
    );
    expect(result).toEqual({ ok: false, status: 401 });
  });

  test("the matching loop has no early exit: all N tokens are compared even for a first-position match (R-02)", () => {
    const spy = spyOn(tokenModule, "compareTokens");
    try {
      const result = runMiddleware(
        {
          method: "POST",
          url: "/mcp",
          headers: { authorization: `Bearer ${tokens[0]!.token}` },
        },
        tokens,
      );
      expect(result).toEqual({ ok: true, tokenId: "id-0" });
      // A short-circuiting `for...of` with `break` on first match would
      // stop at 1 call. The ADR mandates comparing against every
      // configured token regardless of where the match lands, so response
      // time does not leak the matched token's position.
      expect(spy).toHaveBeenCalledTimes(tokens.length);
    } finally {
      spy.mockRestore();
    }
  });
});
