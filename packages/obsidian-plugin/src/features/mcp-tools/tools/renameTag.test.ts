import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
  setMockModifyFail,
} from "$/test-setup";
import {
  isValidTag,
  renameFrontmatterValue,
  renameInline,
  renameOne,
  renameTagHandler,
  renameTagSchema,
} from "./renameTag";

beforeEach(() => resetMockVault());

async function run(args: Record<string, unknown>) {
  const r = await renameTagHandler({
    arguments: args as never,
    app: mockApp(),
  });
  return { r, data: JSON.parse(r.content[0].text) };
}
async function content(path: string) {
  const app = mockApp();
  return app.vault.read(app.vault.getAbstractFileByPath(path) as never);
}
function fm(path: string) {
  const app = mockApp();
  return app.metadataCache.getFileCache(
    app.vault.getAbstractFileByPath(path) as never,
  )?.frontmatter;
}

const A = [
  "---",
  "tags: [project, project/active, other]",
  "---",
  "# Project notes",
  "Work on #project and #Project/Active today.",
  "`#project` in code is not a tag",
  "- #projection is a different tag",
  "- #other #project",
].join("\n");

function seed() {
  setMockFile("a.md", A);
  setMockMetadata("a.md", {
    frontmatter: { tags: ["project", "project/active", "other"] },
    tags: [
      { tag: "#project", line: 4, col: 8 },
      { tag: "#Project/Active", line: 4, col: 21 },
      { tag: "#projection", line: 6, col: 2 },
      { tag: "#other", line: 7, col: 2 },
      { tag: "#project", line: 7, col: 9 },
    ],
  });
  setMockFile("b.md", "---\ntag: project\n---\nnothing inline");
  setMockMetadata("b.md", { frontmatter: { tag: "project" } });
  setMockFile("c.md", "no tags at all");
  setMockMetadata("c.md", {});
  setMockFile("Sub/d.md", "#project here");
  setMockMetadata("Sub/d.md", { tags: [{ tag: "#project", line: 0, col: 0 }] });
}

describe("rename_tag helpers", () => {
  test("isValidTag", () => {
    for (const ok of ["a", "project/active", "año", "x_1-2", "日本語"])
      expect(isValidTag(ok)).toBe(true);
    for (const bad of ["", "123", "a b", "a#b", "/a", "a/", "a//b", "a.b"])
      expect(isValidTag(bad)).toBe(false);
  });

  test("renameOne: exact, nested, case-insensitive prefix, no partial words", () => {
    expect(renameOne("project", "project", "work", true)).toBe("work");
    expect(renameOne("Project/Active", "project", "work", true)).toBe(
      "work/Active",
    );
    expect(renameOne("project/active", "project", "work", false)).toBeNull();
    expect(renameOne("projection", "project", "work", true)).toBeNull();
    expect(renameOne("PROJECT", "project", "work", true)).toBe("work");
  });

  test("renameInline falls back to a line search when the cache has no columns", () => {
    const r = renameInline(
      "x #project y #projection",
      [{ tag: "#project", position: { start: { line: 0 } } }],
      "project",
      "work",
      true,
    );
    expect(r).toEqual({ content: "x #work y #projection", count: 1 });
  });

  test("renameInline skips an entry whose text moved and cannot be found", () => {
    const r = renameInline(
      "no tag here",
      [
        {
          tag: "#project",
          position: { start: { line: 0, col: 3 }, end: { line: 0, col: 11 } },
        },
      ],
      "project",
      "work",
      true,
    );
    expect(r).toEqual({ content: "no tag here", count: 0 });
  });

  test("renameFrontmatterValue: array, string list, with and without #", () => {
    expect(
      renameFrontmatterValue(
        ["project", "#project/x", "other", 3],
        "project",
        "work",
        true,
      ),
    ).toEqual({ value: ["work", "#work/x", "other", 3], count: 2 });
    expect(
      renameFrontmatterValue(
        "project, other project/z",
        "project",
        "work",
        true,
      ),
    ).toEqual({ value: "work, other work/z", count: 2 });
    expect(renameFrontmatterValue(undefined, "project", "work", true)).toEqual({
      value: undefined,
      count: 0,
    });
  });
});

describe("rename_tag", () => {
  test("schema declares the tool name and the string[] scope", () => {
    expect(renameTagSchema.get("name").toString()).toContain("rename_tag");
    expect(() =>
      renameTagSchema
        .get("arguments")
        .assert({ tag: "a", newTag: "b", scope: "x" }),
    ).toThrow();
  });

  test("dry run (default) reports per-file counts and writes nothing", async () => {
    seed();
    const { r, data } = await run({ tag: "#project", newTag: "work" });
    expect(r.isError).toBeUndefined();
    expect(data.dry_run).toBe(true);
    expect(data.tag).toBe("#project");
    expect(data.newTag).toBe("#work");
    expect(data.files_matched).toBe(3);
    expect(data.inline_replacements).toBe(4);
    expect(data.frontmatter_replacements).toBe(3);
    expect(data.details).toEqual([
      { path: "a.md", inline: 3, frontmatter: 2 },
      { path: "b.md", inline: 0, frontmatter: 1 },
      { path: "Sub/d.md", inline: 1, frontmatter: 0 },
    ]);
    expect(await content("a.md")).toBe(A);
  });

  test("apply rewrites inline tags by cache position, leaves code and other tags alone, and fixes frontmatter", async () => {
    seed();
    const { data } = await run({
      tag: "project",
      newTag: "work",
      dry_run: false,
    });
    expect(data.dry_run).toBe(false);
    expect(await content("a.md")).toBe(
      [
        "---",
        "tags: [project, project/active, other]",
        "---",
        "# Project notes",
        "Work on #work and #work/Active today.",
        "`#project` in code is not a tag",
        "- #projection is a different tag",
        "- #other #work",
      ].join("\n"),
    );
    expect(fm("a.md")).toEqual({ tags: ["work", "work/active", "other"] });
    expect(fm("b.md")).toEqual({ tag: "work" });
    expect(await content("Sub/d.md")).toBe("#work here");
  });

  test("includeNested false leaves nested tags", async () => {
    seed();
    const { data } = await run({
      tag: "project",
      newTag: "work",
      includeNested: false,
      dry_run: false,
    });
    expect(data.inline_replacements).toBe(3);
    expect(data.frontmatter_replacements).toBe(2);
    expect(await content("a.md")).toContain("#work and #Project/Active");
    expect(fm("a.md")).toEqual({ tags: ["work", "project/active", "other"] });
  });

  test("scope restricts to a folder or a file", async () => {
    seed();
    expect(
      (
        await run({ tag: "project", newTag: "work", scope: ["Sub"] })
      ).data.details.map((d: { path: string }) => d.path),
    ).toEqual(["Sub/d.md"]);
    expect(
      (
        await run({ tag: "project", newTag: "work", scope: ["b.md"] })
      ).data.details.map((d: { path: string }) => d.path),
    ).toEqual(["b.md"]);
  });

  test("invalid tags, identical tags", async () => {
    seed();
    expect((await run({ tag: "###", newTag: "work" })).data.errorCode).toBe(
      "invalid_tag",
    );
    expect(
      (await run({ tag: "project", newTag: "no spaces" })).data.errorCode,
    ).toBe("invalid_tag");
    expect((await run({ tag: "project", newTag: "123" })).data.errorCode).toBe(
      "invalid_tag",
    );
    expect(
      (await run({ tag: "project", newTag: "#PROJECT" })).data.errorCode,
    ).toBe("invalid_params");
  });

  test("a failing write is reported as partial_failure with the other files done", async () => {
    seed();
    setMockModifyFail("a.md");
    const { r, data } = await run({
      tag: "project",
      newTag: "work",
      dry_run: false,
    });
    expect(r.isError).toBe(true);
    expect(data.errorCode).toBe("partial_failure");
    expect(data.failedFiles.map((f: { path: string }) => f.path)).toEqual([
      "a.md",
    ]);
    expect(data.details.map((d: { path: string }) => d.path)).toEqual([
      "b.md",
      "Sub/d.md",
    ]);
    expect(await content("Sub/d.md")).toBe("#work here");
    expect(await content("a.md")).toBe(A);
  });
});
