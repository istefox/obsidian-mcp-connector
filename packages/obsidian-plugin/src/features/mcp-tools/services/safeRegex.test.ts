import { describe, expect, test } from "bun:test";
import { compileSafeRegex, makeScopeFilter } from "./safeRegex";

describe("compileSafeRegex", () => {
  test("compiles a sane pattern with the given flags", () => {
    const r = compileSafeRegex("fo+", "gi");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.regex.flags).toBe("gi");
  });

  test("refuses a pattern that does not compile", () => {
    const r = compileSafeRegex("(", "g");
    expect(r).toMatchObject({ ok: false, errorCode: "invalid_regex" });
  });

  test("refuses nested quantifiers", () => {
    expect(compileSafeRegex("(a+)+", "g")).toMatchObject({
      ok: false,
      errorCode: "unsafe_regex",
    });
    expect(compileSafeRegex("(a*|b)+", "g")).toMatchObject({
      ok: false,
      errorCode: "unsafe_regex",
    });
  });
});

describe("makeScopeFilter", () => {
  test("empty scope matches everything", () => {
    expect(makeScopeFilter(undefined)("a/b.md")).toBe(true);
    expect(makeScopeFilter([])("a/b.md")).toBe(true);
  });

  test("matches exact paths, `.md`-less paths and folder prefixes", () => {
    const f = makeScopeFilter(["Notes", "x.md", "y"]);
    expect(f("Notes/a.md")).toBe(true);
    expect(f("Notes/sub/a.md")).toBe(true);
    expect(f("NotesX/a.md")).toBe(false);
    expect(f("x.md")).toBe(true);
    expect(f("y.md")).toBe(true);
    expect(f("z.md")).toBe(false);
  });
});
