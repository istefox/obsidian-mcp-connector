import { describe, expect, test } from "bun:test";
import { comparePaths, folderPrefix, trimSlashes } from "./pathUtils";

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

describe("comparePaths", () => {
  test("matches localeCompare with the English variant collation", () => {
    const names = ["b.md", "A.md", "a.md", "é.md", "z/a.md", "B.md"];
    const viaLocale = [...names].sort((a, b) =>
      a.localeCompare(b, "en", { sensitivity: "variant" }),
    );
    expect([...names].sort(comparePaths)).toEqual(viaLocale);
  });
});
