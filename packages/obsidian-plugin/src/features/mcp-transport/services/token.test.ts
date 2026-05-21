import { describe, expect, test } from "bun:test";
import { generateToken, compareTokens } from "./token";

describe("generateToken", () => {
  test("produces a base64url string of at least 32 characters", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  test("produces distinct tokens across calls", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) tokens.add(generateToken());
    expect(tokens.size).toBe(100);
  });
});

describe("compareTokens", () => {
  test("returns true for identical tokens", () => {
    const token = generateToken();
    expect(compareTokens(token, token)).toBe(true);
  });

  test("returns false for distinct tokens", () => {
    expect(compareTokens(generateToken(), generateToken())).toBe(false);
  });

  test("returns false for tokens of different lengths without throwing", () => {
    expect(compareTokens("abc", "abcd")).toBe(false);
  });

  test("returns false for empty vs nonempty", () => {
    expect(compareTokens("", generateToken())).toBe(false);
  });

  test("returns false for inputs with different byte lengths but equal String.length (UTF-8 regression)", () => {
    // 'é' is 2 bytes in UTF-8 but 1 char in JS String.length.
    // Both inputs have String.length === 4, but byte lengths 5 and 4.
    // Regression: earlier implementation compared String.length, which let
    // this case through the guard and crashed in timingSafeEqual.
    const a = "é" + "a".repeat(3); // 4 chars, 5 bytes
    const b = "a".repeat(4); // 4 chars, 4 bytes
    expect(a.length).toBe(b.length);
    expect(compareTokens(a, b)).toBe(false);
  });
});
