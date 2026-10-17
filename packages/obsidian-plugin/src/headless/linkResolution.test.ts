import { describe, expect, test } from "bun:test";
import {
  createLinkResolver,
  memoizeByFolder,
  resolveSubpath,
  stripHeading,
} from "./linkResolution";
import { parseMetadata } from "./parseMetadata";

const paths = [
  "Home.md",
  "notes/Alpha.md",
  "notes/sub/Beta.md",
  "archive/Alpha.md",
  "deep/er/still/Alpha.md",
  "folder/note.md",
  "other/a/folder/note.md",
  "assets/pic.png",
  "Board.canvas",
  "Case Test.md",
];

/** Resolve one link against a fresh resolver over `list`. */
const resolveOnce = (
  linkpath: string,
  sourcePath: string,
  list: Iterable<string>,
) => createLinkResolver(list).resolve(linkpath, sourcePath);

describe("createLinkResolver", () => {
  test("exact vault path with and without extension", () => {
    expect(resolveOnce("notes/sub/Beta", "Home.md", paths)).toBe(
      "notes/sub/Beta.md",
    );
    expect(resolveOnce("notes/sub/Beta.md", "Home.md", paths)).toBe(
      "notes/sub/Beta.md",
    );
    expect(resolveOnce("assets/pic.png", "Home.md", paths)).toBe(
      "assets/pic.png",
    );
    expect(resolveOnce("Board.canvas", "x/y.md", paths)).toBe("Board.canvas");
  });

  test("accepts any iterable of paths", () => {
    expect(resolveOnce("Home", "x.md", new Set(paths))).toBe("Home.md");
  });

  test("relative to the source folder, including ./ and ../", () => {
    expect(resolveOnce("./sub/Beta", "notes/Alpha.md", paths)).toBe(
      "notes/sub/Beta.md",
    );
    expect(resolveOnce("../Home", "notes/Alpha.md", paths)).toBe("Home.md");
    expect(resolveOnce("../assets/pic.png", "notes/Alpha.md", paths)).toBe(
      "assets/pic.png",
    );
  });

  test("a .. above the vault root does not resolve", () => {
    expect(resolveOnce("../../nope", "a.md", paths)).toBeNull();
  });

  test("basename match", () => {
    expect(resolveOnce("Beta", "Home.md", paths)).toBe("notes/sub/Beta.md");
    expect(resolveOnce("pic.png", "Home.md", paths)).toBe("assets/pic.png");
  });

  test("basename match is case-insensitive", () => {
    expect(resolveOnce("beta", "Home.md", paths)).toBe("notes/sub/Beta.md");
    expect(resolveOnce("CASE TEST", "Home.md", paths)).toBe("Case Test.md");
  });

  test("a case-exact candidate beats a case-insensitive one", () => {
    const list = ["a/Note.md", "b/note.md"];
    expect(resolveOnce("note", "x.md", list)).toBe("b/note.md");
    expect(resolveOnce("Note", "x.md", list)).toBe("a/Note.md");
  });

  test("duplicate basenames prefer the source folder", () => {
    expect(resolveOnce("Alpha", "archive/Other.md", paths)).toBe(
      "archive/Alpha.md",
    );
    expect(resolveOnce("Alpha", "deep/er/still/x.md", paths)).toBe(
      "deep/er/still/Alpha.md",
    );
  });

  test("duplicate basenames otherwise pick the shortest path", () => {
    expect(resolveOnce("Alpha", "Home.md", paths)).toBe("notes/Alpha.md");
  });

  test("equally short duplicates resolve alphabetically", () => {
    expect(resolveOnce("n", "x.md", ["b/n.md", "a/n.md"])).toBe("a/n.md");
  });

  test("path suffix matches deeper folders, shortest wins", () => {
    expect(resolveOnce("a/folder/note", "Home.md", paths)).toBe(
      "other/a/folder/note.md",
    );
    // `folder/note` is an exact path, so it wins over the longer suffix match.
    expect(resolveOnce("folder/note", "Home.md", paths)).toBe("folder/note.md");
    expect(resolveOnce("er/still/alpha", "Home.md", paths)).toBe(
      "deep/er/still/Alpha.md",
    );
  });

  test("empty linkpath resolves to the source itself", () => {
    expect(resolveOnce("", "notes/Alpha.md", paths)).toBe("notes/Alpha.md");
    expect(resolveOnce("#Heading", "notes/Alpha.md", paths)).toBe(
      "notes/Alpha.md",
    );
  });

  test("strips #subpath and |alias defensively", () => {
    expect(resolveOnce("Beta#Heading", "Home.md", paths)).toBe(
      "notes/sub/Beta.md",
    );
    expect(resolveOnce("Beta|shown", "Home.md", paths)).toBe(
      "notes/sub/Beta.md",
    );
  });

  test("missing targets return null", () => {
    expect(resolveOnce("Nope", "Home.md", paths)).toBeNull();
    expect(resolveOnce("x/Nope", "Home.md", paths)).toBeNull();
  });

  test("can be reused across many lookups", () => {
    const resolver = createLinkResolver(paths);
    expect(resolver.resolve("Beta", "Home.md")).toBe("notes/sub/Beta.md");
    expect(resolver.resolve("Alpha", "archive/z.md")).toBe("archive/Alpha.md");
    expect(resolver.resolve("Beta", "Home.md")).toBe("notes/sub/Beta.md");
  });
});

describe("names with # and %", () => {
  const list = ["a#b/old.md", "100%.md", "Notes/q?x.md", "y.md"];
  const at = (linkpath: string) => resolveOnce(linkpath, "Home.md", list);

  test("%23 and %25 in a link's file part spell # and %", () => {
    expect(at("a%23b/old.md")).toBe("a#b/old.md");
    expect(at("a%23b/old")).toBe("a#b/old.md");
    expect(at("100%25.md")).toBe("100%.md");
    expect(at("100%25")).toBe("100%.md");
    expect(at("q?x")).toBe("Notes/q?x.md");
  });

  test("a literal # still ends the file part", () => {
    expect(at("y#Heading")).toBe("y.md");
    expect(at("a#b/old.md")).toBeNull();
  });

  test("a name that really contains the escape is found as it is, first", () => {
    const real = ["50%23.md", "50#.md"];
    expect(resolveOnce("50%23", "Home.md", real)).toBe("50%23.md");
    expect(resolveOnce("50%2523", "Home.md", real)).toBe("50%23.md");
    expect(resolveOnce("50%23", "Home.md", ["50#.md"])).toBe("50#.md");
  });

  test("a parsed markdown link resolves to the file it names", () => {
    const links = parseMetadata("[x](a%23b/old.md#H) [y](100%25.md)\n").links!;
    const resolver = createLinkResolver(list);
    expect(links.map((l) => resolver.resolve(l.link, "Home.md"))).toEqual([
      "a#b/old.md",
      "100%.md",
    ]);
  });
});

describe("stripHeading", () => {
  test("replaces punctuation, collapses whitespace and lowercases", () => {
    expect(stripHeading("  Hello,   World! ")).toBe("hello world");
    expect(stripHeading("A: B | C / D")).toBe("a b c d");
    expect(stripHeading("[Link] #1 ^x")).toBe("link 1 x");
  });

  test("keeps hyphens, underscores, apostrophes and unicode", () => {
    expect(stripHeading("Don't-stop_now Über")).toBe("don't-stop_now über");
  });
});

describe("resolveSubpath", () => {
  const cache = parseMetadata(
    [
      "# Top", // 0
      "", // 1
      "## Alpha", // 2
      "text", // 3
      "### Deep", // 4
      "## Beta", // 5
      "### Deep", // 6
      "tail", // 7
      "# Other", // 8
      "## Alpha", // 9
      "", // 10
      "para ^blk", // 11
      "", // 12
      "- item ^li", // 13
      "",
    ].join("\n"),
  );

  test("single heading, case and punctuation insensitive", () => {
    const r = resolveSubpath(cache, "#top");
    expect(r?.type).toBe("heading");
    if (r?.type !== "heading") throw new Error("expected heading");
    expect(r.current.heading).toBe("Top");
    expect(r.start.line).toBe(0);
    // The next heading of the same or higher level is `# Other`.
    expect(r.next?.heading).toBe("Other");
    expect(r.end?.line).toBe(8);
  });

  test("a missing leading # is tolerated", () => {
    expect(resolveSubpath(cache, "Top")?.type).toBe("heading");
  });

  test("the last section has end null and next null", () => {
    const r = resolveSubpath(cache, "#Other#Alpha");
    if (r?.type !== "heading") throw new Error("expected heading");
    expect(r.start.line).toBe(9);
    expect(r.next).toBeNull();
    expect(r.end).toBeNull();
  });

  test("nested path stays inside the previous region", () => {
    const r = resolveSubpath(cache, "#Top#Beta#Deep");
    if (r?.type !== "heading") throw new Error("expected heading");
    expect(r.start.line).toBe(6);
    const first = resolveSubpath(cache, "#Top#Alpha#Deep");
    if (first?.type !== "heading") throw new Error("expected heading");
    expect(first.start.line).toBe(4);
    expect(first.end?.line).toBe(5);
  });

  test("nested heading outside the previous region does not match", () => {
    // `## Alpha` under `# Other` is not inside `## Beta`.
    expect(resolveSubpath(cache, "#Beta#Alpha")).toBeNull();
    expect(resolveSubpath(cache, "#Other#Beta")).toBeNull();
  });

  test("block ids are case-sensitive", () => {
    const r = resolveSubpath(cache, "#^blk");
    expect(r?.type).toBe("block");
    if (r?.type !== "block") throw new Error("expected block");
    expect(r.block.id).toBe("blk");
    expect(r.start.line).toBe(11);
    expect(r.list).toBeUndefined();
    expect(resolveSubpath(cache, "#^BLK")).toBeNull();
  });

  test("a list item block carries its list item", () => {
    const r = resolveSubpath(cache, "#^li");
    if (r?.type !== "block") throw new Error("expected block");
    expect(r.list?.id).toBe("li");
  });

  test("missing and empty subpaths return null", () => {
    expect(resolveSubpath(cache, "")).toBeNull();
    expect(resolveSubpath(cache, "#")).toBeNull();
    expect(resolveSubpath(cache, "#Nope")).toBeNull();
    expect(resolveSubpath(cache, "#^nope")).toBeNull();
    expect(resolveSubpath(cache, "#^constructor")).toBeNull();
    expect(resolveSubpath({}, "#Top")).toBeNull();
  });
});

describe("memoizeByFolder", () => {
  test("answers exactly like the resolver it wraps", () => {
    const plain = createLinkResolver(paths);
    const memo = memoizeByFolder(createLinkResolver(paths));
    const links = [
      "",
      "#Heading",
      "Alpha",
      "alpha",
      "Beta",
      "./sub/Beta",
      "../Home",
      "../../nope",
      "a/folder/note",
      "folder/note",
      "pic.png",
      "Nope",
      "x/Nope",
      "Home",
    ];
    const sources = [
      "Home.md",
      "x.md",
      "notes/Alpha.md",
      "notes/Other.md",
      "archive/Alpha.md",
      "archive/z.md",
      "deep/er/still/x.md",
    ];
    // Twice over, so the second round answers from the memo.
    for (let round = 0; round < 2; round++) {
      for (const source of sources) {
        for (const link of links) {
          expect(memo.resolve(link, source)).toBe(plain.resolve(link, source));
        }
      }
    }
  });

  test("resolves each link once per source folder", () => {
    const inner = createLinkResolver(paths);
    let calls = 0;
    const memo = memoizeByFolder({
      resolve: (link, source) => {
        calls += 1;
        return inner.resolve(link, source);
      },
    });
    for (const source of ["notes/a.md", "notes/b.md", "notes/c.md"]) {
      expect(memo.resolve("Alpha", source)).toBe("notes/Alpha.md");
      expect(memo.resolve("Nope", source)).toBeNull();
    }
    expect(memo.resolve("Alpha", "archive/a.md")).toBe("archive/Alpha.md");
    expect(calls).toBe(3);
  });

  test("a link to the note itself is never shared with its neighbours", () => {
    const memo = memoizeByFolder(createLinkResolver(paths));
    expect(memo.resolve("", "notes/Alpha.md")).toBe("notes/Alpha.md");
    expect(memo.resolve("", "notes/Other.md")).toBe("notes/Other.md");
  });
});

describe("explicitly relative linkpaths", () => {
  const twins = ["A.md", "sub/A.md", "sub/S.md", "Only.md", "sub/Mine.md"];

  test("./ resolves in the source folder even when the root has the name", () => {
    expect(resolveOnce("./A.md", "sub/S.md", twins)).toBe("sub/A.md");
    expect(resolveOnce("./A", "sub/S.md", twins)).toBe("sub/A.md");
    expect(resolveOnce("../A.md", "sub/S.md", twins)).toBe("A.md");
  });

  test("never falls back to the vault root or a basename match", () => {
    expect(resolveOnce("./Only.md", "sub/S.md", twins)).toBeNull();
    expect(resolveOnce("../Mine.md", "sub/S.md", twins)).toBeNull();
    expect(resolveOnce("../../A.md", "sub/S.md", twins)).toBeNull();
  });

  test("a heading link from the subfolder counts against the sibling", () => {
    const resolver = createLinkResolver(twins);
    const link = parseMetadata("[x](./A.md#Old)").links?.[0].link ?? "";
    expect(resolver.resolve(link, "sub/S.md")).toBe("sub/A.md");
  });
});
