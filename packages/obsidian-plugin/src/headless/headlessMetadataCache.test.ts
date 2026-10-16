import { describe, expect, test } from "bun:test";
import { HeadlessMetadataCache } from "./headlessMetadataCache";
import { createLinkResolver } from "./linkResolution";
import { TFile } from "./obsidianShim";

describe("a parse failure", () => {
  test("indexes the file with no metadata and logs a warning", () => {
    const file = new TFile(null, "bad.md", { ctime: 0, mtime: 0, size: 0 });
    const warnings: string[] = [];
    const cache = new HeadlessMetadataCache(
      {
        allPaths: () => ["bad.md"],
        getFileByPath: (p) => (p === "bad.md" ? file : null),
      },
      {
        parse: () => {
          throw new RangeError("Maximum call stack size exceeded");
        },
        warn: (line) => warnings.push(line),
      },
    );
    cache.setContent(file, "anything");
    expect(cache.getFileCache(file)).toEqual({});
    expect(cache.resolvedLinks["bad.md"]).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad.md");
    expect(warnings[0]).toContain("Maximum call stack size exceeded");
  });
});

describe("a file-set change", () => {
  test("resolves each link once per source folder, not once per note", () => {
    // 50 READMEs in their own folders, and 200 notes in 10 folders that
    // each link [[README]] three times.
    const files = new Map<string, TFile>();
    const add = (rel: string) =>
      files.set(rel, new TFile(null, rel, { ctime: 0, mtime: 0, size: 0 }));
    for (let i = 0; i < 50; i++) add(`r${i}/README.md`);
    for (let i = 0; i < 200; i++) add(`n${i % 10}/note${i}.md`);
    let calls = 0;
    const cache = new HeadlessMetadataCache(
      {
        allPaths: () => files.keys(),
        getFileByPath: (p) => files.get(p) ?? null,
      },
      {
        createResolver: (paths) => {
          const inner = createLinkResolver(paths);
          return {
            resolve: (link, source) => {
              calls += 1;
              return inner.resolve(link, source);
            },
          };
        },
      },
    );
    for (const [rel, file] of files) {
      if (!rel.endsWith("README.md")) {
        cache.setContent(file, "[[README]] [[README]] [[README]]", false);
      }
    }

    calls = 0;
    cache.fileSetChanged();
    expect(calls).toBe(10);
    expect(cache.resolvedLinks["n3/note13.md"]).toEqual({ "r0/README.md": 3 });
    expect(cache.resolvedLinks["n9/note199.md"]).toEqual({
      "r0/README.md": 3,
    });
  });
});
