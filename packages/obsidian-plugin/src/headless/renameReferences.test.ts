import { describe, expect, test } from "bun:test";
import { createLinkRewriter } from "./renameLinks";
import {
  mentionsOldPath,
  baseRefersToRename,
  rewriteCanvas,
} from "./renameReferences";
import { withRenameWarnings } from "./renameWarnings";

/** The rewriter for a move of `moves` over a vault that holds `paths`. */
function rewriterFor(paths: string[], moves: Record<string, string>) {
  const all = [...new Set([...paths, ...Object.keys(moves)])];
  const map = new Map(Object.entries(moves));
  return { rewriter: createLinkRewriter(all, map), moves: map };
}

const FILE_MOVE = { "Notes/old.md": "Notes/new.md" };
const FOLDER_MOVE = {
  "Proj/a.md": "Work/a.md",
  "Proj/img/p.png": "Work/img/p.png",
};

const canvas = (nodes: unknown[], indent: string | number = "\t"): string =>
  `${JSON.stringify({ nodes, edges: [] }, null, indent)}\n`;

const box = { x: 0, y: 0, width: 100, height: 100 };

describe("rewriteCanvas", () => {
  test("a file node follows a renamed file", () => {
    const { rewriter, moves } = rewriterFor(["Other.md"], FILE_MOVE);
    const before = canvas([
      { id: "1", type: "file", file: "Notes/old.md", ...box },
      { id: "2", type: "file", file: "Other.md", ...box },
    ]);
    const out = rewriteCanvas(before, rewriter, moves, "C.canvas");
    expect(out.content).toBe(
      canvas([
        { id: "1", type: "file", file: "Notes/new.md", ...box },
        { id: "2", type: "file", file: "Other.md", ...box },
      ]),
    );
    expect(out.unwritable).toEqual([]);
  });

  test("a file node under a renamed folder follows it, whatever the file type", () => {
    const { rewriter, moves } = rewriterFor(["Other.md"], FOLDER_MOVE);
    const before = canvas([
      { id: "1", type: "file", file: "Proj/a.md", ...box },
      { id: "2", type: "file", file: "Proj/img/p.png", ...box },
      { id: "3", type: "file", file: "Projector/a.md", ...box },
    ]);
    const out = rewriteCanvas(before, rewriter, moves, "C.canvas");
    expect(
      JSON.parse(out.content).nodes.map((n: { file: string }) => n.file),
    ).toEqual(["Work/a.md", "Work/img/p.png", "Projector/a.md"]);
  });

  test("a file node keeps its subpath and every other field", () => {
    const { rewriter, moves } = rewriterFor([], FILE_MOVE);
    const before = canvas([
      {
        id: "1",
        type: "file",
        file: "Notes/old.md",
        subpath: "#Heading",
        color: "3",
        ...box,
      },
    ]);
    const out = JSON.parse(
      rewriteCanvas(before, rewriter, moves, "C.canvas").content,
    );
    expect(out.nodes[0]).toEqual({
      id: "1",
      type: "file",
      file: "Notes/new.md",
      subpath: "#Heading",
      color: "3",
      ...box,
    });
  });

  test("links in a text node are rewritten like a note's", () => {
    const { rewriter, moves } = rewriterFor(["Other.md"], FILE_MOVE);
    const before = canvas([
      {
        id: "1",
        type: "text",
        text: "see [[old]] and [x](Notes/old.md) and [[Other]]\n```\n[[old]]\n```",
        ...box,
      },
    ]);
    const out = JSON.parse(
      rewriteCanvas(before, rewriter, moves, "C.canvas").content,
    );
    expect(out.nodes[0].text).toBe(
      "see [[new]] and [x](Notes/new.md) and [[Other]]\n```\n[[old]]\n```",
    );
  });

  test("a link in a text node that no spelling reaches is reported and left", () => {
    const { rewriter, moves } = rewriterFor(["Zed/new.md"], {
      "Notes/old.md": "Odd#Dir/new.md",
    });
    const before = canvas([
      { id: "1", type: "text", text: "[[Notes/old]]", ...box },
    ]);
    const out = rewriteCanvas(before, rewriter, moves, "C.canvas");
    expect(out.unwritable).toEqual(["[[Notes/old]]"]);
    expect(out.content).toBe(before);
  });

  test("a canvas with nothing to change is returned byte for byte", () => {
    const { rewriter, moves } = rewriterFor(["Other.md"], FILE_MOVE);
    const odd =
      '{"nodes":[{"id":"1","type":"file","file":"Other.md"}],  "edges":[]}';
    expect(rewriteCanvas(odd, rewriter, moves, "C.canvas").content).toBe(odd);
  });

  test.each([
    ["a tab", "\t"],
    ["two spaces", 2],
    ["four spaces", 4],
  ])("keeps the indent it was written with: %s", (_name, indent) => {
    const { rewriter, moves } = rewriterFor([], FILE_MOVE);
    const before = canvas(
      [{ id: "1", type: "file", file: "Notes/old.md", ...box }],
      indent,
    );
    const out = rewriteCanvas(before, rewriter, moves, "C.canvas").content;
    expect(out).toBe(before.replace("Notes/old.md", "Notes/new.md"));
  });

  test("keeps a missing final newline", () => {
    const { rewriter, moves } = rewriterFor([], FILE_MOVE);
    const before = canvas([
      { id: "1", type: "file", file: "Notes/old.md", ...box },
    ]).trimEnd();
    expect(rewriteCanvas(before, rewriter, moves, "C.canvas").content).toBe(
      before.replace("Notes/old.md", "Notes/new.md"),
    );
  });

  test.each([
    ["not JSON", "{ nope"],
    ["an array", "[]"],
    ["no nodes", '{"edges":[]}'],
    ["empty", ""],
  ])("%s is left as it is", (_name, text) => {
    const { rewriter, moves } = rewriterFor([], FILE_MOVE);
    expect(rewriteCanvas(text, rewriter, moves, "C.canvas")).toEqual({
      content: text,
      unwritable: [],
    });
  });

  test("a canvas that moved with its folder resolves relative links from where it was", () => {
    const { rewriter, moves } = rewriterFor([], {
      "Proj/C.canvas": "Work/C.canvas",
      "Proj/a.md": "Work/a.md",
    });
    const before = canvas([
      { id: "1", type: "text", text: "[x](./a.md) [[a]]", ...box },
    ]);
    const out = JSON.parse(
      rewriteCanvas(before, rewriter, moves, "Proj/C.canvas").content,
    );
    // Both still lead to the same note, so neither needs a new spelling.
    expect(out.nodes[0].text).toBe("[x](./a.md) [[a]]");
  });
});

describe("baseRefersToRename", () => {
  const refers = (
    text: string,
    moves: Record<string, string>,
    from: string,
  ) => {
    const { rewriter } = rewriterFor([], moves);
    return baseRefersToRename(text, rewriter, "B.base", from);
  };

  test("a wikilink or markdown link to the renamed file", () => {
    expect(refers('name: "[[old]]"\n', FILE_MOVE, "Notes/old.md")).toBe(true);
    expect(refers("see [t](Notes/old.md)\n", FILE_MOVE, "Notes/old.md")).toBe(
      true,
    );
  });

  test("a link to a file under a renamed folder", () => {
    expect(refers("x: '[[Proj/a]]'\n", FOLDER_MOVE, "Proj")).toBe(true);
  });

  test("a filter that holds link-shaped text counts, and the text is left alone", () => {
    const filter = 'filters:\n  and:\n    - note.text == "[[old]]"\n';
    expect(refers(filter, FILE_MOVE, "Notes/old.md")).toBe(true);
  });

  test("a quoted path in a filter", () => {
    expect(refers('file.inFolder("Proj")\n', FOLDER_MOVE, "Proj")).toBe(true);
    expect(
      refers('file.path == "Notes/old.md"\n', FILE_MOVE, "Notes/old.md"),
    ).toBe(true);
  });

  test("a link no spelling can reach still counts", () => {
    const { rewriter } = rewriterFor(["Zed/new.md"], {
      "Notes/old.md": "Odd#Dir/new.md",
    });
    expect(
      baseRefersToRename(
        'x: "[[Notes/old]]"\n',
        rewriter,
        "B.base",
        "Notes/old.md",
      ),
    ).toBe(true);
  });

  test("a base that names something else does not", () => {
    expect(
      refers(
        'x: "[[other]]"\nfile.folder == "Archive"\n',
        FILE_MOVE,
        "Notes/old.md",
      ),
    ).toBe(false);
    expect(refers("name: Projects overview\n", FOLDER_MOVE, "Proj")).toBe(
      false,
    );
  });
});

describe("mentionsOldPath", () => {
  test.each([
    ['file.path == "Notes/old.md"', "Notes/old.md", true],
    ["file.path == 'Notes/old.md'", "Notes/old.md", true],
    ['link("Notes/old")', "Notes/old.md", true],
    ['link("Notes/old#Heading")', "Notes/old.md", true],
    ['file.folder == "Projects"', "Projects", true],
    ['file.inFolder("Projects/Sub")', "Projects", true],
    ['file.inFolder("Archive/Projects")', "Projects", false],
    ['file.folder == "Projects2"', "Projects", false],
    ["name: Projects overview", "Projects", false],
    ['file.name == "old.md"', "Notes/old.md", false],
    ['x: "[[Notes/old]]"', "Notes/old.md", false],
  ])("%s mentions %s: %s", (text, oldPath, expected) => {
    expect(mentionsOldPath(text, oldPath)).toBe(expected);
  });

  test("a name with regex characters is taken literally", () => {
    expect(mentionsOldPath('file.folder == "a.b(c)"', "a.b(c)")).toBe(true);
    expect(mentionsOldPath('file.folder == "aXb(c)"', "a.b(c)")).toBe(false);
  });
});

describe("withRenameWarnings", () => {
  const ok = {
    content: [{ type: "text" as const, text: '{"ok":true,"path":"n.md"}' }],
  };

  test("adds the warnings to a JSON result", () => {
    const out = withRenameWarnings(ok, ["x.base still names it"]);
    expect(JSON.parse(out.content[0].text)).toEqual({
      ok: true,
      path: "n.md",
      warnings: ["x.base still names it"],
    });
  });

  test("leaves a result without warnings as it is", () => {
    expect(withRenameWarnings(ok, [])).toBe(ok);
  });

  test("adds them to a failure too", () => {
    const failed = {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: '{"error":"x","errorCode":"rename_failed"}',
        },
      ],
    };
    const out = withRenameWarnings(failed, ["w"]);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text).warnings).toEqual(["w"]);
  });

  test("does not touch a text that is not a JSON object", () => {
    const plain = { content: [{ type: "text" as const, text: "done" }] };
    expect(withRenameWarnings(plain, ["w"])).toBe(plain);
    const list = { content: [{ type: "text" as const, text: "[1]" }] };
    expect(withRenameWarnings(list, ["w"])).toBe(list);
  });
});
