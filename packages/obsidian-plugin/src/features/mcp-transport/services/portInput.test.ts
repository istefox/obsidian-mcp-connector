import { describe, expect, test } from "bun:test";
import { parsePortInput } from "./portInput";

describe("parsePortInput", () => {
  test("null → ok with port undefined (blank field = automatic range)", () => {
    expect(parsePortInput(null)).toEqual({ ok: true, port: undefined });
  });

  test.each([1024, 8080, 27200, 65535])(
    "valid port %i → ok with the same value",
    (input) => {
      const r = parsePortInput(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.port).toBe(input);
    },
  );

  test.each([
    [1023, "just below the minimum"],
    [65536, "just above the maximum"],
    [0, "zero"],
    [-1, "negative"],
    [80, "well-known privileged port"],
    [70000, "well past the maximum"],
  ])("out-of-range port %i (%s) → ok:false", (input) => {
    const r = parsePortInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/1024.*65535/);
  });

  test.each([27200.5, 5.5, 27200.1])(
    "non-integer port %s → ok:false",
    (input) => {
      const r = parsePortInput(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/1024.*65535/);
    },
  );

  test("regression #358 — the caller's binding is `number | null`, no string coercion", () => {
    // The types make it impossible to accidentally pass a string from
    // the Svelte number-input binding (which produces `number | null`);
    // this test-suite pins that contract so a future refactor that
    // reintroduces string parsing would fail typechecking against these
    // call sites.
    const nullResult = parsePortInput(null);
    expect(nullResult.ok).toBe(true);
    if (nullResult.ok) expect(nullResult.port).toBeUndefined();

    const numberResult = parsePortInput(27200);
    expect(numberResult.ok).toBe(true);
    if (numberResult.ok) expect(numberResult.port).toBe(27200);
  });
});
