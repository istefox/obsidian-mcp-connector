import { describe, expect, test } from "bun:test";
import { parseFrontmatterBlock, parseMetadata } from "./parseMetadata";

const tagNames = (md: string): string[] =>
  (parseMetadata(md).tags ?? []).map((t) => t.tag);

describe("frontmatter", () => {
  test("parses a mapping and records its position", () => {
    const md = "---\ntitle: Hi\ncount: 2\n---\nBody\n";
    const meta = parseMetadata(md);
    expect(meta.frontmatter).toEqual({ title: "Hi", count: 2 });
    expect(meta.frontmatterPosition).toEqual({
      start: { line: 0, col: 0, offset: 0 },
      end: { line: 3, col: 3, offset: 26 },
    });
  });

  test("block and flow tag lists, and string tags, are parsed", () => {
    expect(
      parseMetadata("---\ntags:\n  - a\n  - b/c\n---\n").frontmatter?.tags,
    ).toEqual(["a", "b/c"]);
    expect(parseMetadata("---\ntags: [x, y]\n---\n").frontmatter?.tags).toEqual(
      ["x", "y"],
    );
    expect(parseMetadata("---\ntags: solo\n---\n").frontmatter?.tags).toBe(
      "solo",
    );
  });

  test("frontmatter tags are not mirrored into cache.tags", () => {
    expect(parseMetadata("---\ntags: [x]\n---\nBody\n").tags).toBeUndefined();
  });

  test("invalid YAML leaves the frontmatter uncached", () => {
    const meta = parseMetadata("---\nkey: [unclosed\n---\n# Real\n");
    expect(meta.frontmatter).toBeUndefined();
    // The block is still frontmatter, so its content is not scanned.
    expect(meta.headings?.map((h) => h.heading)).toEqual(["Real"]);
  });

  test("a non-mapping YAML document is not frontmatter data", () => {
    expect(parseMetadata("---\n- a\n- b\n---\n").frontmatter).toBeUndefined();
  });

  test("an unclosed block is not frontmatter", () => {
    const meta = parseMetadata("---\ntitle: x\n# Heading\n");
    expect(meta.frontmatter).toBeUndefined();
    expect(meta.frontmatterPosition).toBeUndefined();
  });

  test("must start on the first line", () => {
    expect(parseMetadata("\n---\na: 1\n---\n").frontmatter).toBeUndefined();
  });

  test("accepts a ... closing line", () => {
    expect(parseMetadata("---\na: 1\n...\nText").frontmatter).toEqual({ a: 1 });
  });

  test("handles CRLF", () => {
    const md = "---\r\ntitle: Hi\r\n---\r\n# Head\r\ntext #t\r\n";
    const meta = parseMetadata(md);
    expect(meta.frontmatter).toEqual({ title: "Hi" });
    expect(meta.frontmatterPosition?.end).toEqual({
      line: 2,
      col: 3,
      offset: 19,
    });
    expect(meta.headings?.[0].heading).toBe("Head");
    expect(meta.headings?.[0].position.start.offset).toBe(21);
    expect(meta.headings?.[0].position.end.col).toBe(6);
    expect(meta.tags?.[0].position.start).toEqual({
      line: 4,
      col: 5,
      offset: 34,
    });
  });

  test("parseFrontmatterBlock exposes spans for re-serialising", () => {
    const md = "---\r\na: 1\r\nb: 2\r\n---\r\nBody";
    const block = parseFrontmatterBlock(md)!;
    expect(block.yaml).toBe("a: 1\r\nb: 2");
    expect(block.eol).toBe("\r\n");
    expect(md.slice(0, block.openEnd)).toBe("---\r\n");
    expect(md.slice(block.closeStart, block.end)).toBe("---");
    expect(md.slice(block.bodyStart)).toBe("Body");
    expect(block.data).toEqual({ a: 1, b: 2 });
    expect(parseFrontmatterBlock("no frontmatter")).toBeNull();
    expect(parseFrontmatterBlock("---\nempty\n")).toBeNull();
  });

  test("parseFrontmatterBlock reports data null for invalid YAML", () => {
    expect(parseFrontmatterBlock("---\na: [\n---\n")?.data).toBeNull();
    expect(parseFrontmatterBlock("---\n---\n")?.data).toEqual({});
  });
});

describe("frontmatterLinks", () => {
  test("scalars use the key, list items use key.index", () => {
    const md = [
      "---",
      'up: "[[Parent]]"',
      "related:",
      '  - "[[One|First]]"',
      '  - "plain"',
      '  - "[[Two#Sec]]"',
      "---",
    ].join("\n");
    expect(parseMetadata(md).frontmatterLinks).toEqual([
      {
        key: "up",
        link: "Parent",
        original: "[[Parent]]",
        displayText: "Parent",
      },
      {
        key: "related.0",
        link: "One",
        original: "[[One|First]]",
        displayText: "First",
      },
      {
        key: "related.2",
        link: "Two#Sec",
        original: "[[Two#Sec]]",
        displayText: "Two#Sec",
      },
    ]);
  });
});

describe("headings", () => {
  test("level, raw text, closing hashes and position", () => {
    const md =
      "# One\n\n## Two ##\n\n###### Six  \n#Not heading\n####### seven\n";
    const h = parseMetadata(md).headings!;
    expect(h.map((x) => [x.level, x.heading])).toEqual([
      [1, "One"],
      [2, "Two"],
      [6, "Six"],
    ]);
    expect(h[1].position).toEqual({
      start: { line: 2, col: 0, offset: 7 },
      end: { line: 2, col: 9, offset: 16 },
    });
  });

  test("keeps formatting and inner #", () => {
    const md = "## **Bold** [[Link]] C#\n";
    expect(parseMetadata(md).headings![0].heading).toBe("**Bold** [[Link]] C#");
  });

  test("skips fenced code and frontmatter", () => {
    const md =
      "---\n# not: heading\n---\n```\n# no\n```\n~~~\n## no\n~~~\n# Yes\n";
    expect(parseMetadata(md).headings!.map((h) => h.heading)).toEqual(["Yes"]);
  });

  test("a shorter inner fence does not close a longer one", () => {
    const md = "````\n```\n# no\n```\n````\n# Yes\n";
    expect(parseMetadata(md).headings!.map((h) => h.heading)).toEqual(["Yes"]);
  });

  test("an unclosed fence runs to the end of the file", () => {
    expect(parseMetadata("```\n# no\n## no\n").headings).toBeUndefined();
  });

  test("a fence indented four spaces is not a fence", () => {
    expect(parseMetadata("    ```\n# yes\n").headings).toHaveLength(1);
  });
});

describe("tags", () => {
  test("simple, nested, dashed and unicode tags", () => {
    expect(
      tagNames("#one #a/b/c and #tag-with-dash plus #日本語 and #über_x"),
    ).toEqual(["#one", "#a/b/c", "#tag-with-dash", "#日本語", "#über_x"]);
  });

  test("numeric-only tags are rejected, mixed ones accepted", () => {
    expect(tagNames("#1984 #y1984 #2024/q1 #123")).toEqual([
      "#y1984",
      "#2024/q1",
    ]);
  });

  test("a#b, ##x and escaped hashes are not tags", () => {
    expect(tagNames("a#b ##x \\#esc &#amp;")).toEqual([]);
  });

  test("allowed after punctuation and at line start", () => {
    expect(tagNames('(#paren) "#quoted"\n#start')).toEqual([
      "#paren",
      "#quoted",
      "#start",
    ]);
  });

  test("trailing punctuation is not part of the tag", () => {
    expect(tagNames("see #tag, #other. and #last!")).toEqual([
      "#tag",
      "#other",
      "#last",
    ]);
  });

  test("positions are 0-indexed line/col with offsets", () => {
    const meta = parseMetadata("first\nab #tag\n");
    expect(meta.tags![0].position).toEqual({
      start: { line: 1, col: 3, offset: 9 },
      end: { line: 1, col: 7, offset: 13 },
    });
  });

  test("not inside code fences or inline code", () => {
    const md = "```\n#fenced\n```\n`#inline` ``a ` #double`` #real\n";
    expect(tagNames(md)).toEqual(["#real"]);
  });

  test("inline code spanning lines of one paragraph is masked", () => {
    expect(tagNames("start `code\n#hidden` end #shown\n")).toEqual(["#shown"]);
  });

  test("an unmatched backtick is literal", () => {
    expect(tagNames("a ` b #still\n")).toEqual(["#still"]);
  });

  test("not inside wikilinks, markdown links or URLs", () => {
    const md =
      "[[Note#heading]] [[#same]] [x](page.md#frag) https://e.com/#anchor #ok\n";
    expect(tagNames(md)).toEqual(["#ok"]);
  });

  test("tags in headings, list items and quotes count", () => {
    expect(tagNames("# Title #h\n- item #li\n> quote #q\n")).toEqual([
      "#h",
      "#li",
      "#q",
    ]);
  });
});

describe("links and embeds", () => {
  test("wikilink with alias, heading and block", () => {
    const md =
      "[[Note]] [[Note|alias]] [[Note#Head]] [[Note#^abc]] [[#Same]]\n";
    const links = parseMetadata(md).links!;
    expect(links.map((l) => [l.link, l.displayText, l.original])).toEqual([
      ["Note", "Note", "[[Note]]"],
      ["Note", "alias", "[[Note|alias]]"],
      ["Note#Head", "Note#Head", "[[Note#Head]]"],
      ["Note#^abc", "Note#^abc", "[[Note#^abc]]"],
      ["#Same", "#Same", "[[#Same]]"],
    ]);
    expect(links[1].position).toEqual({
      start: { line: 0, col: 9, offset: 9 },
      end: { line: 0, col: 23, offset: 23 },
    });
  });

  test("alias containing an escaped pipe (table cell)", () => {
    const l = parseMetadata("| [[Note\\|alias]] |\n").links![0];
    expect(l.link).toBe("Note");
    expect(l.displayText).toBe("alias");
  });

  test("markdown links: local kept and decoded, URLs skipped", () => {
    const md =
      "[a](My%20Note.md) [b](<Other Note.md#Sec>) [c](https://x.y) [d](mailto:a@b.c) [e](#head) [f]()\n";
    const links = parseMetadata(md).links!;
    expect(links.map((l) => [l.link, l.displayText])).toEqual([
      ["My Note.md", "a"],
      ["Other Note.md#Sec", "b"],
      ["#head", "e"],
    ]);
    expect(links[0].original).toBe("[a](My%20Note.md)");
  });

  test("a %23 in the path is a character of the name, a literal # starts the subpath", () => {
    const md =
      "[a](a%23b/old.md) [b](a%23b/old.md#Head%20One) [c](x%23y.md#^blk) [d](a%23b/old.md#A%23B)\n";
    expect(parseMetadata(md).links!.map((l) => l.link)).toEqual([
      "a%23b/old.md",
      "a%23b/old.md#Head One",
      "x%23y.md#^blk",
      "a%23b/old.md#A#B",
    ]);
  });

  test("a % in a name stays escaped so it is not read as an escape again", () => {
    const md = "[a](100%25.md) [b](50%2523.md) [c](bad%zz.md) [d](a%3Fb.md)\n";
    expect(parseMetadata(md).links!.map((l) => l.link)).toEqual([
      "100%25.md",
      "50%2523.md",
      "bad%25zz.md",
      "a?b.md",
    ]);
  });

  test("embeds do not appear in links", () => {
    const md =
      "![[img.png]] ![alt](pic%201.png) [[note]] ![x](https://u/i.png)\n";
    const meta = parseMetadata(md);
    expect(meta.embeds!.map((e) => [e.link, e.displayText])).toEqual([
      ["img.png", "img.png"],
      ["pic 1.png", "alt"],
    ]);
    expect(meta.links!.map((l) => l.link)).toEqual(["note"]);
  });

  test("links and embeds are ordered by position within a line", () => {
    const md = "[a](x.md) [[b]] [c](y.md)\n";
    expect(parseMetadata(md).links!.map((l) => l.link)).toEqual([
      "x.md",
      "b",
      "y.md",
    ]);
  });

  test("none inside code fences or inline code", () => {
    const md = "```\n[[fenced]]\n```\n`[[inline]]` [[real]]\n";
    expect(parseMetadata(md).links!.map((l) => l.link)).toEqual(["real"]);
  });

  test("link syntax inside a markdown link's title or destination is not a link", () => {
    const md = '[t](old.md "[[old]]") [u](a[[b]]c.md) [[real]]\n';
    const links = parseMetadata(md).links!;
    expect(links.map((l) => l.original)).toEqual([
      '[t](old.md "[[old]]")',
      "[u](a[[b]]c.md)",
      "[[real]]",
    ]);
  });

  test("a wikilink in the title of a skipped URL link is not a link either", () => {
    const md = '[t](https://x.y "[[old]]") [[real]]\n';
    expect(parseMetadata(md).links!.map((l) => l.link)).toEqual(["real"]);
  });

  test("links in frontmatter bodies are not body links", () => {
    expect(parseMetadata('---\na: "[[X]]"\n---\n').links).toBeUndefined();
  });
});

describe("blocks", () => {
  test("multi-line paragraph spans from its first line to the id line", () => {
    const md = "Intro\n\nline one\nline two\nline three ^para\n\nAfter\n";
    const b = parseMetadata(md).blocks!;
    expect(b.para.id).toBe("para");
    expect(b.para.position).toEqual({
      start: { line: 2, col: 0, offset: 7 },
      end: { line: 4, col: 16, offset: 41 },
    });
  });

  test("single-line paragraph", () => {
    const b = parseMetadata("Hello ^abc-1\n").blocks!;
    expect(b["abc-1"].position.start.line).toBe(0);
    expect(b["abc-1"].position.end.line).toBe(0);
  });

  test("a paragraph after a heading starts below the heading", () => {
    const b = parseMetadata("# H\ntext ^x\n").blocks!;
    expect(b.x.position.start.line).toBe(1);
  });

  test("list item span, with the id on the item", () => {
    const md = "- one\n- two ^item\n  continued\n- three\n";
    const meta = parseMetadata(md);
    // The id sits mid-item, so it is not a block id.
    expect(meta.blocks).toBeUndefined();

    const md2 = "- one\n- two\n  continued ^item\n- three\n";
    const meta2 = parseMetadata(md2);
    expect(meta2.blocks!.item.position.start).toEqual({
      line: 1,
      col: 0,
      offset: 6,
    });
    expect(meta2.blocks!.item.position.end.line).toBe(2);
    expect(meta2.listItems![1].id).toBe("item");
    expect(meta2.listItems![0].id).toBeUndefined();
  });

  test("own-line id after a blank line refers to the previous block", () => {
    const md = "first\nsecond\n\n^own\n\nnext\n";
    const b = parseMetadata(md).blocks!;
    expect(b.own.position.start.line).toBe(0);
    expect(b.own.position.end.line).toBe(1);
  });

  test("own-line id directly after a paragraph belongs to that paragraph", () => {
    const b = parseMetadata("first\nsecond\n^own\n").blocks!;
    expect(b.own.position.start.line).toBe(0);
    expect(b.own.position.end.line).toBe(2);
  });

  test("own-line id after a quote or a list spans that block", () => {
    const quote = parseMetadata("> a\n> b\n\n^q\n").blocks!;
    expect(quote.q.position.start.line).toBe(0);
    expect(quote.q.position.end.line).toBe(1);
    const list = parseMetadata("- a\n- b\n\n^l\n").blocks!;
    expect(list.l.position.start.line).toBe(0);
    expect(list.l.position.end.line).toBe(1);
  });

  test("a quote with the id on its last line spans the whole quote", () => {
    const b = parseMetadata("> a\n> b ^qq\n").blocks!;
    expect(b.qq.position.start.line).toBe(0);
    expect(b.qq.position.end.line).toBe(1);
  });

  test("ids need preceding whitespace and a valid charset", () => {
    expect(parseMetadata("a^b\n").blocks).toBeUndefined();
    expect(parseMetadata("text ^bad_id\n").blocks).toBeUndefined();
    expect(parseMetadata("text ^ok-1  \n").blocks!["ok-1"]).toBeDefined();
  });

  test("not inside code fences or tables", () => {
    const md = "```\ncode ^fenced\n```\n\n| a | b ^cell |\n| - | - |\n";
    expect(parseMetadata(md).blocks).toBeUndefined();
  });

  test("first duplicate id wins", () => {
    const b = parseMetadata("one ^dup\n\ntwo ^dup\n").blocks!;
    expect(b.dup.position.start.line).toBe(0);
  });

  test("an id named like an Object member is a plain own key", () => {
    const b = parseMetadata("x ^constructor\n\ny ^other\n").blocks!;
    expect(Object.keys(b)).toEqual(["constructor", "other"]);
    expect(
      (
        Object.getOwnPropertyDescriptor(b, "constructor")?.value as {
          id: string;
        }
      ).id,
    ).toBe("constructor");
    // No prototype, so a lookup of an absent id never hits Object.prototype.
    expect(Object.getPrototypeOf(b)).toBeNull();
  });
});

describe("listItems", () => {
  test("root items use the negated first line of the list", () => {
    const md = "intro\n\n- a\n- b\n";
    const items = parseMetadata(md).listItems!;
    expect(items.map((i) => i.parent)).toEqual([-2, -2]);
  });

  test("a list starting on line 0 still has a negative parent", () => {
    const items = parseMetadata("- a\n- b\n").listItems!;
    expect(items.every((i) => i.parent < 0)).toBe(true);
  });

  test("nested items point at the start line of their parent", () => {
    const md = "- a\n  - b\n    - c\n  - d\n- e\n";
    const items = parseMetadata(md).listItems!;
    expect(items.map((i) => i.parent)).toEqual([-1, 0, 1, 0, -1]);
    expect(items.map((i) => i.position.start.line)).toEqual([0, 1, 2, 3, 4]);
  });

  test("separate lists get their own negative parent", () => {
    const md = "- a\n\ntext\n\n1. b\n2. c\n";
    const items = parseMetadata(md).listItems!;
    expect(items.map((i) => i.parent)).toEqual([-1, -4, -4]);
  });

  test("task characters", () => {
    const md =
      "- [ ] open\n- [x] done\n* [X] caps\n+ [-] dropped\n- plain\n- [] no\n";
    const items = parseMetadata(md).listItems!;
    expect(items.map((i) => i.task)).toEqual([
      " ",
      "x",
      "X",
      "-",
      undefined,
      undefined,
    ]);
  });

  test("ordered markers with . and )", () => {
    const items = parseMetadata("1. a\n2) b\n").listItems!;
    expect(items).toHaveLength(2);
  });

  test("position starts at the marker and ends at the line end", () => {
    const items = parseMetadata("- a\n  - [ ] nested task\n").listItems!;
    expect(items[1].position).toEqual({
      start: { line: 1, col: 2, offset: 6 },
      end: { line: 1, col: 19, offset: 23 },
    });
  });

  test("continuation lines belong to the item", () => {
    const items = parseMetadata("- a\n  more\nlazy\n- b\n").listItems!;
    expect(items[0].position.end.line).toBe(2);
    expect(items[1].position.start.line).toBe(3);
  });

  test("items in a blockquote or callout", () => {
    const md = "> [!todo]\n> - [ ] one\n>   - [x] two\n";
    const items = parseMetadata(md).listItems!;
    expect(items.map((i) => i.task)).toEqual([" ", "x"]);
    expect(items.map((i) => i.parent)).toEqual([-1, 1]);
    expect(items[0].position.start).toEqual({ line: 1, col: 2, offset: 12 });
  });

  test.each([
    ["spaces", "  "],
    ["a tab", "\t"],
  ])("a callout indented with %s keeps the subtask's parent", (_, ind) => {
    const md = `- [ ] parent\n${ind}> [!note] x\n${ind}- [ ] child\n`;
    const items = parseMetadata(md).listItems!;
    expect(items.map((i) => i.position.start.line)).toEqual([0, 2]);
    expect(items.map((i) => i.parent)).toEqual([-1, 0]);
  });

  test("thematic breaks and fenced content are not items", () => {
    const md = "---\n* * *\n```\n- not\n```\n";
    expect(parseMetadata(md).listItems).toBeUndefined();
  });

  test("a loose list stays one list across blank lines", () => {
    const items = parseMetadata("x\n\n- a\n\n- b\n").listItems!;
    expect(items.map((i) => i.parent)).toEqual([-2, -2]);
  });
});

describe("empty and plain input", () => {
  test("empty collections are omitted", () => {
    expect(parseMetadata("")).toEqual({});
    expect(parseMetadata("just text\n")).toEqual({});
  });
});

describe("indented code blocks", () => {
  test("hide tags, links, headings and block ids", () => {
    const md =
      "    #old [[Hidden]] ^code-id\n    # not a heading\n\nVisible #old [[Shown]]\n\n    #again\n";
    const meta = parseMetadata(md);
    expect(tagNames(md)).toEqual(["#old"]);
    expect(meta.tags?.[0].position.start.line).toBe(3);
    expect(meta.links?.map((l) => l.link)).toEqual(["Shown"]);
    expect(meta.headings).toBeUndefined();
    expect(meta.blocks).toBeUndefined();
  });

  test("start after a heading or a closed fence too", () => {
    expect(tagNames("# H\n    #code\n")).toEqual([]);
    expect(tagNames("```\nx\n```\n    #code\n")).toEqual([]);
  });

  test("a blank line inside the block does not end it", () => {
    expect(tagNames("    #one\n\n    #two\nafter #three\n")).toEqual([
      "#three",
    ]);
  });

  test("an indented paragraph continuation is not code", () => {
    expect(tagNames("para\n    #cont [[L]]\n")).toEqual(["#cont"]);
    expect(parseMetadata("para\n    [[L]]\n").links?.[0].link).toBe("L");
  });

  test("indented list continuation lines keep their tags and links", () => {
    const md = "- item\n\n    #cont [[Cont]]\n";
    expect(tagNames(md)).toEqual(["#cont"]);
    expect(parseMetadata(md).links?.map((l) => l.link)).toEqual(["Cont"]);
  });

  test("nested list items keep their tags and links", () => {
    const md = "- a\n    - nested #deep [[Deep]]\n        - deeper #deeper\n";
    expect(tagNames(md)).toEqual(["#deep", "#deeper"]);
    expect(parseMetadata(md).links?.map((l) => l.link)).toEqual(["Deep"]);
    expect(parseMetadata(md).listItems?.length).toBe(3);
  });

  test("are measured from the content of a list item or quote", () => {
    for (const md of [
      "- item\n\n      #old [[Target]]\n",
      "1. item\n\n       #old [[Target]]\n",
      ">     #old [[Target]]\n",
      "> quote\n>\n>     #old [[Target]]\n",
    ]) {
      expect(tagNames(md)).toEqual([]);
      expect(parseMetadata(md).links).toBeUndefined();
    }
  });

  test("a tab after a list marker reaches the next tab stop", () => {
    for (const md of [
      "-\titem\n\n      #cont [[Target]]\n",
      "1.\titem\n\n       #cont [[Target]]\n",
    ]) {
      expect(tagNames(md)).toEqual(["#cont"]);
      expect(parseMetadata(md).links?.map((l) => l.link)).toEqual(["Target"]);
    }
    expect(tagNames("-\titem\n\n        #old\n")).toEqual([]);
  });

  test("container text that is not code keeps its tags and links", () => {
    for (const md of [
      "- item\n\n  #cont [[Target]]\n",
      "- item\n      #cont [[Target]]\n",
      "- a\n\n  - #cont [[Target]]\n",
      "> quote\n>     #cont [[Target]]\n",
      "> #cont [[Target]]\n",
      "> - a\n>\n>   #cont [[Target]]\n",
    ]) {
      expect(tagNames(md)).toEqual(["#cont"]);
      expect(parseMetadata(md).links?.map((l) => l.link)).toEqual(["Target"]);
    }
  });
});

describe("fences inside containers", () => {
  test("an unclosed fence in a list item ends with the item", () => {
    const md = "- item\n  ~~~\n  code #no\n\nOutside #real [[Target]]\n";
    const meta = parseMetadata(md);
    expect(tagNames(md)).toEqual(["#real"]);
    expect(meta.links?.map((l) => l.link)).toEqual(["Target"]);
    expect(meta.listItems?.length).toBe(1);
    expect(meta.listItems?.[0].position.end.line).toBe(0);
  });

  test("an unclosed fence in a quote ends with the quote", () => {
    const md = "> ~~~\n> code #no\nOutside #real [[Target]]\n";
    expect(tagNames(md)).toEqual(["#real"]);
    expect(parseMetadata(md).links?.map((l) => l.link)).toEqual(["Target"]);
  });

  test("blank and item-indented lines stay inside a list fence", () => {
    const md = "- item\n  ~~~\n\n  #no [[No]]\n  ~~~\n  #yes\n";
    expect(tagNames(md)).toEqual(["#yes"]);
    expect(parseMetadata(md).links).toBeUndefined();
  });
  test("a fence may open right after a list marker", () => {
    for (const md of [
      "- ~~~\n  #hidden [[Hidden]]\n  ~~~\n  #real [[Target]]\n",
      "- ```js\n  #hidden [[Hidden]]\n  ```\n  #real [[Target]]\n",
      "1. ```\n   #hidden [[Hidden]]\n   ```\n   #real [[Target]]\n",
      "> - ~~~\n>   #hidden [[Hidden]]\n>   ~~~\n>   #real [[Target]]\n",
    ]) {
      expect(tagNames(md)).toEqual(["#real"]);
      expect(parseMetadata(md).links?.map((l) => l.link)).toEqual(["Target"]);
      expect(parseMetadata(md).listItems?.length).toBe(1);
    }
  });

  test("a closing fence is indented at most 3 columns past its container", () => {
    for (const md of [
      "~~~\n    ~~~\n#hidden [[Hidden]]\n~~~\n#real [[Target]]\n",
      "- ~~~\n      ~~~\n  #hidden [[Hidden]]\n  ~~~\n  #real [[Target]]\n",
      "> ~~~\n>     ~~~\n> #hidden [[Hidden]]\n> ~~~\n> #real [[Target]]\n",
    ]) {
      expect(tagNames(md)).toEqual(["#real"]);
      expect(parseMetadata(md).links?.map((l) => l.link)).toEqual(["Target"]);
    }
  });

  test("a fence ends with the quote or quoted list it opened in", () => {
    for (const md of [
      "> > ~~~\n> > code #no\n> Outside #real [[Target]]\n",
      "> - ~~~\n>   code #no\n> Outside #real [[Target]]\n",
      "> - a\n>   ~~~\n>   code #no\n> Outside #real [[Target]]\n",
    ]) {
      expect(tagNames(md)).toEqual(["#real"]);
      expect(parseMetadata(md).links?.map((l) => l.link)).toEqual(["Target"]);
    }
  });

  test("a fence opens after nested or stacked container prefixes", () => {
    for (const md of [
      "> - a\n>   - b\n>     ~~~\n>     #old\n>     ~~~\n",
      "- > ~~~\n  > #old\n  > ~~~\n",
      "- - ~~~\n    #old\n    ~~~\n",
    ]) {
      expect(tagNames(md)).toEqual([]);
    }
  });

  test("a tab-indented fence in a list item opens and closes", () => {
    expect(tagNames("- item\n\t~~~\n\t#old\n\t~~~\n\t#real\n")).toEqual([
      "#real",
    ]);
    expect(tagNames("- item\n  ~~~\n  #old\n\t~~~\n  #real\n")).toEqual([
      "#real",
    ]);
  });

  test("each container shape hides its fence and nothing after it", () => {
    const shapes: Array<[string, string, string]> = [
      ["top level", "", ""],
      ["list", "- a\n", "  "],
      ["ordered list", "1. a\n", "   "],
      ["tab-indented list", "- a\n", "\t"],
      ["quote", "", "> "],
      ["nested quote", "", "> > "],
      ["quote in list", "- a\n", "  > "],
      ["list in quote", "> - a\n", ">   "],
      ["nested list in quote", "> - a\n>   - b\n", ">     "],
    ];
    for (const [name, intro, cont] of shapes) {
      const body = ["~~~", "#old", "~~~", "#real"].map((l) => cont + l);
      const md = intro + body.join("\n") + "\n";
      expect([name, tagNames(md)]).toEqual([name, ["#real"]]);
    }
  });
});

describe("cyclic frontmatter", () => {
  test("a self-referencing anchor is walked once", () => {
    const md = "---\na: &self\n  link: '[[B]]'\n  next: *self\n---\nbody\n";
    const meta = parseMetadata(md);
    expect(meta.frontmatterLinks?.map((l) => [l.key, l.link])).toEqual([
      ["a.link", "B"],
    ]);
  });
});
