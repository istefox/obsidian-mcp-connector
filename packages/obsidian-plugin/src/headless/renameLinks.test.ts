import { describe, expect, test } from "bun:test";
import { createLinkResolver } from "./linkResolution";
import { createLinkRewriter, isLinkableName } from "./renameLinks";
import { parseMetadata } from "./parseMetadata";
import { normalizeVaultPath } from "./vaultFs";

type Files = Record<string, string>;

/**
 * Rewrite `note` (named by its path before the move) as the move of
 * `moves` (old path to new path) would. Every file exists before the move.
 */
function rewrite(files: Files, moves: Record<string, string>, note: string) {
  const rewriter = createLinkRewriter(
    Object.keys(files),
    new Map(Object.entries(moves)),
  );
  return rewriter.rewrite(files[note], null, note).content;
}

/** A vault of empty notes plus one note holding `body`. */
function body(
  body: string,
  moves: Record<string, string>,
  others: string[] = [],
  note = "A.md",
): string {
  const files: Files = { [note]: body };
  for (const p of [...Object.keys(moves), ...others]) files[p] ??= "";
  return rewrite(files, moves, note);
}

const NOTE_MOVE = { "Notes/old.md": "Notes/new.md" };

describe("wikilinks", () => {
  test.each([
    ["[[old]]", "[[new]]"],
    ["[[old|alias]]", "[[new|alias]]"],
    ["[[old#Heading]]", "[[new#Heading]]"],
    ["[[old#A#B]]", "[[new#A#B]]"],
    ["[[old#^block-1]]", "[[new#^block-1]]"],
    ["[[old#^block-1|shown]]", "[[new#^block-1|shown]]"],
    ["![[old]]", "![[new]]"],
    ["![[old#Heading]]", "![[new#Heading]]"],
    ["[[old.md]]", "[[new.md]]"],
    ["[[Notes/old]]", "[[Notes/new]]"],
    ["[[Notes/old.md#H|x]]", "[[Notes/new.md#H|x]]"],
    ["[[/Notes/old]]", "[[/Notes/new]]"],
    ["[[ old ]]", "[[ new ]]"],
    ["[[OLD]]", "[[new]]"],
    ["| [[old\\|alias]] |", "| [[new\\|alias]] |"],
  ])("%s", (before, after) => {
    expect(body(before, NOTE_MOVE)).toBe(after);
  });

  test("several links on one line and across lines", () => {
    expect(
      body(
        "a [[old]] b [[old|x]] c ![[old]] d [[other]]\n- [[old#H]]\n",
        NOTE_MOVE,
        ["other.md"],
      ),
    ).toBe("a [[new]] b [[new|x]] c ![[new]] d [[other]]\n- [[new#H]]\n");
  });

  test("links to other files, unresolved links and code are untouched", () => {
    const text =
      "[[other]] [[missing]] `[[old]]`\n```\n[[old]]\n```\n[w](https://x.com/old.md)\n";
    expect(body(text, NOTE_MOVE, ["other.md"])).toBe(text);
  });

  test("quoted and block-quoted links keep their position", () => {
    expect(body("> quote [[old]]\n> > deeper [[old]]\n", NOTE_MOVE)).toBe(
      "> quote [[new]]\n> > deeper [[new]]\n",
    );
  });

  test("a note with a BOM and CRLF line endings", () => {
    expect(body("﻿# T\r\n\r\n[[old]]\r\n[[old|x]]\r\n", NOTE_MOVE)).toBe(
      "﻿# T\r\n\r\n[[new]]\r\n[[new|x]]\r\n",
    );
  });
});

describe("shortest form", () => {
  test("a bare name stays a bare name when it is unique", () => {
    expect(body("[[old]]", { "Notes/old.md": "Archive/deep/old.md" })).toBe(
      "[[old]]",
    );
    expect(body("[[old]]", { "Notes/old.md": "Archive/deep/fresh.md" })).toBe(
      "[[fresh]]",
    );
  });

  test("a bare name becomes a full path when the new name is ambiguous", () => {
    expect(
      body("[[old]]", { "Notes/old.md": "Notes/note.md" }, ["Other/note.md"]),
    ).toBe("[[Notes/note]]");
    expect(
      body("[[old.md]]", { "Notes/old.md": "Notes/note.md" }, [
        "Other/note.md",
      ]),
    ).toBe("[[Notes/note.md]]");
  });

  test("a link that still resolves to the moved file is left alone", () => {
    expect(body("[[old]]", { "Notes/old.md": "Archive/old.md" })).toBe(
      "[[old]]",
    );
    expect(
      body("[[old]]", {
        "Notes/old.md": "Notes/old.md".replace("Notes", "Moved"),
      }),
    ).toBe("[[old]]");
  });

  test("a partial path is rewritten to the shortest form", () => {
    expect(
      body("[[Notes/old]]", { "Deep/Notes/old.md": "Deep/Notes/new.md" }, []),
    ).toBe("[[new]]");
  });

  test("a full path stays a full path", () => {
    expect(body("[[Notes/old]]", { "Notes/old.md": "Archive/old.md" })).toBe(
      "[[Archive/old]]",
    );
  });
});

describe("markdown links", () => {
  test.each([
    ["[t](old.md)", "[t](new.md)"],
    ["[t](Notes/old.md)", "[t](Notes/new.md)"],
    ["[t](old)", "[t](new)"],
    ["[old](old.md)", "[new](new.md)"],
    ["[old.md](old.md)", "[new.md](new.md)"],
    ["[t](old.md#Some%20Heading)", "[t](new.md#Some%20Heading)"],
    ["[t](old.md#^block)", "[t](new.md#^block)"],
    ['[t](old.md "a title")', '[t](new.md "a title")'],
    ["[t]( old.md )", "[t]( new.md )"],
    ["![e](old.md)", "![e](new.md)"],
    ["a [x](old.md) b [y](old.md)", "a [x](new.md) b [y](new.md)"],
  ])("%s", (before, after) => {
    expect(body(before, NOTE_MOVE)).toBe(after);
  });

  test("a destination in a different folder from the source note", () => {
    expect(
      body("[t](Notes/old.md)", { "Notes/old.md": "Archive/old.md" }),
    ).toBe("[t](Archive/old.md)");
  });

  test("URL-encoded paths stay encoded", () => {
    expect(body("[t](My%20Old.md)", { "My Old.md": "My New.md" })).toBe(
      "[t](My%20New.md)",
    );
    expect(body("[t](My%20Old.md)", { "My Old.md": "A (b).md" })).toBe(
      "[t](A%20%28b%29.md)",
    );
    expect(body("[t](caf%C3%A9.md)", { "café.md": "thé.md" })).toBe(
      "[t](th%C3%A9.md)",
    );
  });

  test("a plain destination gets the characters it cannot hold escaped", () => {
    expect(body("[t](old.md)", { "Notes/old.md": "Notes/a b (1).md" })).toBe(
      "[t](a%20b%20%281%29.md)",
    );
  });

  test("angle-bracket destinations keep their brackets and raw spaces", () => {
    expect(body("[t](<My Old.md>)", { "My Old.md": "My New (1).md" })).toBe(
      "[t](<My New %281%29.md>)",
    );
    expect(body("[t](<My Old.md#Head ing>)", { "My Old.md": "New.md" })).toBe(
      "[t](<New.md#Head ing>)",
    );
  });

  test.each([
    ["[t](<old.md>)", "old.md", "100%20.md"],
    ["[t](old.md)", "old.md", "100%20.md"],
    ["[t](<old.md#H>)", "old.md", "a>b (x) 50%.md"],
    ["[t](old.md#H)", "old.md", "a>b (x) 50%.md"],
    ["[t](caf%C3%A9.md)", "café.md", "d\u00e9j\u00e0 100%.md"],
  ])("%s keeps resolving to the renamed file %p -> %p", (link, from, to) => {
    const out = body(link, { [from]: to });
    const dest = /\]\(<?(.*?)(?:#.*?)?>?\)$/.exec(out)![1];
    const resolver = createLinkResolver(["A.md", to]);
    expect(resolver.resolve(decodeURIComponent(dest), "A.md")).toBe(to);
  });

  test.each([
    ["[See](old.md)", "[See](RFC%3A%20Auth.md)"],
    ["[See](<old.md>)", "[See](<RFC%3A Auth.md>)"],
  ])("%s gets its colon escaped so it is not read as a URL", (link, after) => {
    const out = body(link, { "old.md": "RFC: Auth.md" });
    expect(out).toBe(after);
    const links = parseMetadata(out).links ?? [];
    expect(links).toHaveLength(1);
    const resolver = createLinkResolver(["A.md", "RFC: Auth.md"]);
    expect(resolver.resolve(links[0].link, "A.md")).toBe("RFC: Auth.md");
  });

  test("external URLs and unresolved destinations are untouched", () => {
    const text = "[a](https://example.com/old.md) [b](nope.md) [c](#local)";
    expect(body(text, NOTE_MOVE)).toBe(text);
  });

  test("an attachment move rewrites embeds in both syntaxes", () => {
    const moves = { "assets/pic.png": "assets/photo.png" };
    expect(
      body("![[pic.png]] ![[pic.png|200]] ![](assets/pic.png)", moves),
    ).toBe("![[photo.png]] ![[photo.png|200]] ![](assets/photo.png)");
  });

  test("a non-markdown target always keeps its extension", () => {
    expect(body("[[doc.pdf]]", { "doc.pdf": "docs/paper.pdf" })).toBe(
      "[[paper.pdf]]",
    );
  });

  test("a note renamed to another extension gains it in the link", () => {
    expect(body("[[old]]", { "Notes/old.md": "Notes/old.txt" })).toBe(
      "[[old.txt]]",
    );
  });
});

describe("relative links", () => {
  test("a relative link to a moved file stays relative to the note holding it", () => {
    const files = {
      "Sub/B.md": "[t](../Notes/old.md) [[../Notes/old]] [u](./sibling.md)",
      "Notes/old.md": "",
      "Sub/sibling.md": "",
    };
    expect(
      rewrite(files, { "Notes/old.md": "Archive/new.md" }, "Sub/B.md"),
    ).toBe("[t](../Archive/new.md) [[../Archive/new]] [u](./sibling.md)");
  });

  test("a relative link into a deeper folder starts with ./", () => {
    const files = { "B.md": "[t](./old.md)", "old.md": "" };
    expect(rewrite(files, { "old.md": "sub/deep/old.md" }, "B.md")).toBe(
      "[t](./sub/deep/old.md)",
    );
  });
});

describe("frontmatter links", () => {
  test("quoted values, lists and nested values are rewritten", () => {
    const text = [
      "---",
      'up: "[[old]]"',
      "related:",
      '  - "[[old|alias]]"',
      '  - "[[other]]"',
      "nested:",
      '  deep: "see [[old#H]] and [[old]]"',
      "title: old",
      "---",
      "Body [[old]]",
      "",
    ].join("\n");
    expect(body(text, NOTE_MOVE, ["other.md"])).toBe(
      text
        .replace('"[[old]]"', '"[[new]]"')
        .replace("[[old|alias]]", "[[new|alias]]")
        .replace("[[old#H]] and [[old]]", "[[new#H]] and [[new]]")
        .replace("Body [[old]]", "Body [[new]]"),
    );
  });

  test("a bare [[old]] value is a nested list in YAML, not a link, and stays", () => {
    const text = "---\nup: [[old]]\n---\n";
    expect(body(text, NOTE_MOVE)).toBe(text);
  });
});

describe("frontmatter values keep valid YAML", () => {
  const fm = (yaml: string, moves: Record<string, string> = NOTE_MOVE) =>
    body(`---\n${yaml}\n---\nBody\n`, moves).replace(
      /^---\n|\n---\nBody\n$/g,
      "",
    );
  const APOS = { "Notes/old.md": "Notes/O'Brien.md" };
  const QUOTE = { "Notes/old.md": 'Notes/say "hi" \\ x.md' };

  test("a single-quoted value doubles an apostrophe", () => {
    expect(fm("related: '[[old]]'", APOS)).toBe("related: '[[O''Brien]]'");
  });

  test("a double-quoted value escapes quotes and backslashes", () => {
    expect(fm('related: "[[old]]"', QUOTE)).toBe(
      'related: "[[say \\"hi\\" \\\\ x]]"',
    );
  });

  test("a single-quoted value with a double quote stays single-quoted", () => {
    expect(fm("related: '[[old]]'", QUOTE)).toBe(
      "related: '[[say \"hi\" \\ x]]'",
    );
  });

  test("a plain scalar that can no longer be plain is quoted", () => {
    expect(fm("related: see [[old]] ok")).toBe("related: see [[new]] ok");
    expect(
      fm("related: see [[old]] ok", { "Notes/old.md": "Notes/a: b.md" }),
    ).toBe("related: 'see [[a: b]] ok'");
  });

  test("block lists, flow lists and block scalars are rewritten in place", () => {
    expect(fm("l:\n  - '[[old]]'\n  - \"[[old|x]]\" # note\n  - other")).toBe(
      "l:\n  - '[[new]]'\n  - \"[[new|x]]\" # note\n  - other",
    );
    expect(fm("l: [\"[[old]]\", '[[old]]', plain]")).toBe(
      "l: [\"[[new]]\", '[[new]]', plain]",
    );
    expect(fm("t: |\n  see [[old]]\n  and [[old|x]]\nk: v")).toBe(
      "t: |\n  see [[new]]\n  and [[new|x]]\nk: v",
    );
  });

  test("anchors, tags and trailing comments stay", () => {
    expect(fm("a: &x \"[[old]]\" # c\nb: !!str '[[old]]'")).toBe(
      "a: &x \"[[new]]\" # c\nb: !!str '[[new]]'",
    );
  });

  test("a nested flow list is not a link, even beside a real link", () => {
    expect(fm('related: "[[old]]"\nliteral: [[old]]')).toBe(
      'related: "[[new]]"\nliteral: [[old]]',
    );
  });

  test("a key that spells a link is not changed", () => {
    expect(fm('"[[old]]": 1\nb: "[[old]]"')).toBe('"[[old]]": 1\nb: "[[new]]"');
  });

  test("a complex mapping key is a key, whatever it holds", () => {
    expect(fm('? ["[[old]]"]\n: keep\nb: "[[old]]"')).toBe(
      '? ["[[old]]"]\n: keep\nb: "[[new]]"',
    );
  });

  test("a flow scalar that needs quotes in a flow list is quoted", () => {
    expect(fm('l: ["[[old]]"]', { "Notes/old.md": "Notes/a, b.md" })).toBe(
      'l: ["[[a, b]]"]',
    );
  });

  test("comments and layout elsewhere are byte for byte unchanged", () => {
    const yaml = "# top\n\nup:   '[[old]]'   # why\n\nother:    [ 1,2 ]\n";
    expect(fm(yaml)).toBe(yaml.replace("[[old]]", "[[new]]"));
  });
});

describe("overlapping links", () => {
  test("a wikilink in a markdown link's title is not edited on its own", () => {
    const moves = { "Notes/old.md": "Notes/much-longer-name.md" };
    expect(body('[t](old.md "[[old]]") END', moves)).toBe(
      '[t](much-longer-name.md "[[old]]") END',
    );
  });

  test("edits whose spans overlap throw instead of corrupting the note", () => {
    const rewriter = createLinkRewriter(
      ["A.md", "old.md"],
      new Map([["old.md", "much-longer-name.md"]]),
    );
    const content = "[[old]] tail";
    const link = (start: number, end: number) => ({
      link: "old",
      original: "[[old]]",
      displayText: "old",
      position: {
        start: { line: 0, col: start, offset: start },
        end: { line: 0, col: end, offset: end },
      },
    });
    const cache = { links: [link(0, 7), link(4, 10)] };
    expect(() => rewriter.rewrite(content, cache, "A.md")).toThrow(
      "Link edits overlap",
    );
  });
});

describe("the moved note itself", () => {
  test("self links follow the new name, same-note subpaths stay", () => {
    const files = {
      "old.md": "[[old]] [[old#H]] [[#H]] [t](old.md) [[#^b]]",
      "A.md": "",
    };
    expect(rewrite(files, { "old.md": "new.md" }, "old.md")).toBe(
      "[[new]] [[new#H]] [[#H]] [t](new.md) [[#^b]]",
    );
  });

  test("relative links keep pointing at the same files", () => {
    const files = {
      "a/old.md": "[x](./sib.md) [y](../top.md) [z](sub/in.md) [[./sib]]",
      "a/sib.md": "",
      "top.md": "",
      "a/sub/in.md": "",
    };
    expect(rewrite(files, { "a/old.md": "b/c/old.md" }, "a/old.md")).toBe(
      "[x](../../a/sib.md) [y](../../top.md) [z](sub/in.md) [[../../a/sib]]",
    );
  });

  test("a move within the same folder tree can drop the ../", () => {
    const files = { "a/b/old.md": "[y](../../top.md)", "top.md": "" };
    expect(rewrite(files, { "a/b/old.md": "old.md" }, "a/b/old.md")).toBe(
      "[y](./top.md)",
    );
  });

  test("wikilinks that still resolve are kept, even across folders", () => {
    const files = {
      "a/old.md": "[[sib]] [[top]]",
      "a/sib.md": "",
      "top.md": "",
    };
    expect(rewrite(files, { "a/old.md": "b/old.md" }, "a/old.md")).toBe(
      "[[sib]] [[top]]",
    );
  });

  test("a wikilink that would now resolve elsewhere becomes a full path", () => {
    const files = {
      "z/old.md": "[[sib]]",
      "z/sib.md": "",
      "a/sib.md": "",
      "b/sib.md": "",
    };
    // From z/ the sibling wins. From the move target, a/sib.md would.
    expect(rewrite(files, { "z/old.md": "c/old.md" }, "z/old.md")).toBe(
      "[[z/sib]]",
    );
  });

  test("links to files that move along with it are updated, those between them stay valid", () => {
    const files = { "dir/a.md": "[[dir/b]] [x](./b.md) [[b]]", "dir/b.md": "" };
    const moves = { "dir/a.md": "new/a.md", "dir/b.md": "new/b.md" };
    expect(rewrite(files, moves, "dir/a.md")).toBe(
      "[[new/b]] [x](./b.md) [[b]]",
    );
  });
});

describe("folder moves", () => {
  const files: Files = {
    "X.md":
      "[[Proj/a]] [[b]] [t](Proj/sub/b.md) [u](Proj/a.md#H) ![[Proj/img.png]]",
    "Proj/a.md": "",
    "Proj/sub/b.md": "",
    "Proj/img.png": "",
  };
  const moves = {
    "Proj/a.md": "Work/a.md",
    "Proj/sub/b.md": "Work/sub/b.md",
    "Proj/img.png": "Work/img.png",
  };

  test("every link into the folder is rewritten in one pass", () => {
    expect(rewrite(files, moves, "X.md")).toBe(
      "[[Work/a]] [[b]] [t](Work/sub/b.md) [u](Work/a.md#H) ![[Work/img.png]]",
    );
  });
});

describe("cache and stale text", () => {
  test("uses a supplied cache for the positions", () => {
    const content = "x [[old]] y [[old|z]]";
    const rewriter = createLinkRewriter(
      ["A.md", "old.md"],
      new Map([["old.md", "new.md"]]),
    );
    expect(
      rewriter.rewrite(content, parseMetadata(content), "A.md").content,
    ).toBe("x [[new]] y [[new|z]]");
  });

  test("is a no-op for a note without links", () => {
    expect(body("plain text\n", NOTE_MOVE)).toBe("plain text\n");
  });
});

describe("every name a rename accepts round-trips through the parser", () => {
  // ASCII punctuation, the space, Unicode whitespace, letters of several
  // scripts, a combining mark, emoji and a joined emoji sequence.
  const POOL = [
    ..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ ",
    " ",
    ..."           ",
    "　",
    ..."éßЖ中ع",
    "é",
    "🙂",
    "👩‍💻",
  ];
  // Every pool entry alone and at each end of a name, and every ordered
  // pair inside one.
  const NAMES = [
    ...POOL.flatMap((c) => [c, `a${c}`, `${c}b`, `a${c}b`]),
    ...POOL.flatMap((c) => POOL.map((d) => `a${c}${d}b`)),
  ];

  /** What the rename refuses before any link is written. */
  const accepted = (to: string): boolean => {
    try {
      return (
        normalizeVaultPath(to) === to && to.split("/").every(isLinkableName)
      );
    } catch {
      return false;
    }
  };

  const SOURCE = "Other/S.md";
  /** Every link form, to `old.md` in the folder `dir` (`""` or `x/`). */
  const note = (dir: string) =>
    [
      "---",
      'up: "[[old]]"',
      "---",
      `[[old]] [[old|alias]] ![[old]] [[old#H|x]] [[${dir}old]] [[old.md]]`,
      `[t](${dir}old.md) [t](<${dir}old.md>) [t](../${dir}old.md)`,
      `[t](${dir}old.md#H) ![e](<${dir}old.md#H>) [old](${dir}old.md)`,
      "",
    ].join("\n");
  const BODY_LINKS = 12;

  test("every link form reads back as a link to the new path", () => {
    const names = NAMES.filter((n) => accepted(`Notes/${n}.md`));
    // The refusals stay narrow: Unicode whitespace inside a name and
    // characters a markdown destination has to escape are accepted.
    expect(names.length).toBeGreaterThan(2000);
    for (const n of ["a\u00a0b", "a\u3000b", "a%b", "a:b", "a<b", "a(b"]) {
      expect(names).toContain(n);
    }

    // The final name varies in the vault root and in a folder, and the
    // folder a note moves into varies too.
    const moves = [
      ...["", "Notes/"].flatMap((dir) =>
        names.map((name) => ({ dir, target: `${dir}${name}.md` })),
      ),
      ...NAMES.map((name) => ({ dir: "Notes/", target: `${name}/new.md` })),
    ].filter(({ target }) => accepted(target));

    const failures: Array<{ name: string; out: string }> = [];
    for (const { dir, target } of moves) {
      const rewriter = createLinkRewriter(
        [SOURCE, `${dir}old.md`],
        new Map([[`${dir}old.md`, target]]),
      );
      const { content: out, unwritable } = rewriter.rewrite(
        note(dir),
        null,
        SOURCE,
      );
      const meta = parseMetadata(out);
      const body = [...(meta.links ?? []), ...(meta.embeds ?? [])];
      const refs = [...body, ...(meta.frontmatterLinks ?? [])];
      const resolver = createLinkResolver([SOURCE, target]);
      const ok =
        body.length === BODY_LINKS &&
        refs.length === BODY_LINKS + 1 &&
        refs.every((r) => resolver.resolve(r.link, SOURCE) === target) &&
        unwritable.length === 0;
      if (!ok) failures.push({ name: target, out });
    }
    expect(failures).toEqual([]);
  });

  test("a link to a file in any folder reads back or is reported", () => {
    // The target stays in a folder of any name, and the note that links to
    // it relatively moves out of that folder.
    const folders = NAMES.filter((f) => {
      try {
        return normalizeVaultPath(`${f}/kept.md`) === `${f}/kept.md`;
      } catch {
        return false;
      }
    });
    expect(folders.length).toBeGreaterThan(2000);
    const links = [
      "[[./kept]]",
      "[[./kept|alias]]",
      "![[./kept]]",
      "[[./kept#H|x]]",
      "[[./kept.md]]",
      "[t](./kept.md)",
      "[t](<./kept.md>)",
      "[t](./kept.md#H)",
      "[kept](./kept.md)",
    ];
    // A link out of the folder that can always be rewritten.
    const farLink = (f: string) =>
      `[[${"../".repeat(f.split("/").length)}far]]`;
    const note = (f: string) =>
      ["---", 'up: "[[./kept]]"', "---", [...links, farLink(f)].join(" ")]
        .join("\n")
        .concat("\n");

    const failures: Array<{ folder: string; out: string; left: string[] }> = [];
    for (const f of folders) {
      const source = `Other/${f}/S.md`;
      const target = `Other/${f}/kept.md`;
      const far = "Other/far.md";
      const rewriter = createLinkRewriter(
        [source, target, far],
        new Map([[source, "Notes/S.md"]]),
      );
      const { content: out, unwritable } = rewriter.rewrite(
        note(f),
        null,
        source,
      );
      const meta = parseMetadata(out);
      const body = [...(meta.links ?? []), ...(meta.embeds ?? [])];
      const refs = [...body, ...(meta.frontmatterLinks ?? [])];
      const resolver = createLinkResolver(["Notes/S.md", target, far]);
      // A written link reads back to its target. One that is not stays as
      // it was and is reported, and only names a link cannot spell have
      // such links.
      const ok =
        body.length === links.length + 1 &&
        refs.length === links.length + 2 &&
        out.includes("[[../Other/far]]") &&
        refs.every(
          (r) =>
            [target, far].includes(resolver.resolve(r.link, "Notes/S.md")!) ||
            unwritable.includes(r.original),
        ) &&
        unwritable.every((u) => links.includes(u)) &&
        unwritable.length > 0 === /[[\]|#`]/.test(f);
      if (!ok) failures.push({ folder: f, out, left: unwritable });
    }
    expect(failures).toEqual([]);
  });

  test("names that cannot be written in a wikilink are refused", () => {
    for (const name of ["a[b", "a]b", "a|b", "a#b", "a^b", "a`b"]) {
      expect(isLinkableName(`${name}.md`)).toBe(false);
    }
    for (const name of [" a.md", "a.md ", " a.md", "a.md　"]) {
      expect(isLinkableName(name)).toBe(false);
    }
  });
});

describe("names with #, % and ?", () => {
  test.each([
    ["[See old](a%23b/old.md)", "[See old](a%23b/new.md)"],
    [
      "[See old](a%23b/old.md#Head%20One)",
      "[See old](a%23b/new.md#Head%20One)",
    ],
    ["![img](a%23b/old.md)", "![img](a%23b/new.md)"],
    ["[x](<a%23b/old.md>)", "[x](<a%23b/new.md>)"],
  ])("a file renamed inside a # folder: %s", (before, after) => {
    expect(body(before, { "a#b/old.md": "a#b/new.md" }, [], "Home.md")).toBe(
      after,
    );
  });

  test("a file moved out of a # folder", () => {
    expect(
      body("[x](a%23b/old.md)", { "a#b/old.md": "c/old.md" }, [], "Home.md"),
    ).toBe("[x](c/old.md)");
  });

  test("a folder with # in its name renamed", () => {
    expect(
      body(
        "[x](a%23b/old.md) [y](a%23b/sub/z.md)",
        { "a#b/old.md": "Work/old.md", "a#b/sub/z.md": "Work/sub/z.md" },
        [],
        "Home.md",
      ),
    ).toBe("[x](Work/old.md) [y](Work/sub/z.md)");
  });

  test("a file moved into a # folder is written with %23", () => {
    expect(
      body(
        "[x](Notes/old.md)",
        { "Notes/old.md": "a#b/old.md" },
        [],
        "Home.md",
      ),
    ).toBe("[x](a%23b/old.md)");
  });

  test("a % in a name is escaped once and found again", () => {
    expect(
      body("[x](100%25/old.md)", { "100%/old.md": "Z/old.md" }, [], "Home.md"),
    ).toBe("[x](Z/old.md)");
    expect(
      body("[x](Z/old.md)", { "Z/old.md": "100%/old.md" }, [], "Home.md"),
    ).toBe("[x](100%25/old.md)");
  });

  test("a ? in a name needs no escape", () => {
    expect(
      body("[x](q%3Fx/old.md)", { "q?x/old.md": "Z/old.md" }, [], "Home.md"),
    ).toBe("[x](Z/old.md)");
  });

  test("a wikilink to a file under a name with % keeps working", () => {
    expect(
      body("[[100%/old]]", { "100%/old.md": "100%/new.md" }, [], "Home.md"),
    ).toBe("[[100%/new]]");
  });

  test("a link that really is a fragment is left alone", () => {
    expect(
      body(
        "[x](Notes/old.md#H)",
        { "Notes/old.md": "Notes/new.md" },
        [],
        "Home.md",
      ),
    ).toBe("[x](Notes/new.md#H)");
  });
});
