import { describe, expect, test } from "bun:test";
import {
  comparePaths,
  folderPrefix,
  parentPath,
  pathName,
  trimSlashes,
} from "./pathUtils";

describe("trimSlashes", () => {
  test("strips leading and trailing slashes only", () => {
    expect(trimSlashes("/a/b/")).toBe("a/b");
    expect(trimSlashes("a//")).toBe("a");
    expect(trimSlashes("a/b")).toBe("a/b");
    expect(trimSlashes("/")).toBe("");
  });
});

describe("folderPrefix", () => {
  test("a folder in any slash spelling gives one prefix", () => {
    for (const folder of ["Home", "/Home", "Home/", "/Home/"]) {
      expect(folderPrefix(folder)).toBe("Home/");
    }
  });

  test("an absent argument and the vault root mean no filter", () => {
    expect(folderPrefix(undefined)).toBeNull();
    expect(folderPrefix("/")).toBeNull();
    expect(folderPrefix("")).toBeNull();
  });
});

describe("parentPath", () => {
  test("returns the containing folder, or the root marker", () => {
    expect(parentPath("Projects/2026/Q2")).toBe("Projects/2026");
    expect(parentPath("Projects")).toBe("");
    expect(parentPath("")).toBe("");
  });
});

describe("pathName", () => {
  test("returns the last path segment", () => {
    expect(pathName("Projects/2026/Q2")).toBe("Q2");
    expect(pathName("Projects")).toBe("Projects");
    expect(pathName("")).toBe("");
  });
});

describe("comparePaths", () => {
  test("matches localeCompare with the English variant collation", () => {
    const names = ["b.md", "A.md", "a.md", "é.md", "z/a.md", "B.md"];
    const viaLocale = [...names].sort((a, b) =>
      a.localeCompare(b, "en", { sensitivity: "variant" }),
    );
    expect([...names].sort(comparePaths)).toEqual(viaLocale);
  });
});
