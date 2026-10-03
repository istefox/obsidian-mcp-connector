import { describe, expect, test } from "bun:test";
import { countBacklinks, countBacklinksFor } from "./fileKind";

const links = {
  "a.md": { "t.png": 2, "b.md": 1 },
  "b.md": { "t.png": 1 },
  "c.md": { "t.png": 0, "b.md": 3 },
};

describe("countBacklinksFor", () => {
  test("counts files and references for one target", () => {
    expect(countBacklinksFor(links, "t.png")).toEqual({
      files: 2,
      references: 3,
    });
    expect(countBacklinksFor(links, "b.md")).toEqual({
      files: 2,
      references: 4,
    });
  });

  test("an unreferenced target is zero", () => {
    expect(countBacklinksFor(links, "none.md")).toEqual({
      files: 0,
      references: 0,
    });
  });

  test("agrees with the whole-map count", () => {
    const all = countBacklinks(links);
    for (const target of ["t.png", "b.md", "none.md"]) {
      expect(countBacklinksFor(links, target)).toEqual(
        all.get(target) ?? { files: 0, references: 0 },
      );
    }
  });
});
