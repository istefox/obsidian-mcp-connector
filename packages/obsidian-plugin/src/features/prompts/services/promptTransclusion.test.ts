import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";
import {
  expandEmbeds,
  parseEmbeds,
  MAX_EMBED_DEPTH,
} from "./promptTransclusion";
import { createGuardedApp } from "$/shared/guardedApp";
import { compilePolicy } from "$/shared/pathPolicy";

beforeEach(() => {
  resetMockVault();
});

describe("parseEmbeds", () => {
  test("parses a bare embed", () => {
    // Mutation: drop the `!` from EMBED_PATTERN — `original` loses it.
    const [ref] = parseEmbeds("before ![[note]] after");
    expect(ref.original).toBe("![[note]]");
    expect(ref.linkpath).toBe("note");
    expect(ref.heading).toBeUndefined();
    expect(ref.blockId).toBeUndefined();
  });

  test("ignores a plain wikilink", () => {
    // Mutation: drop the `!` from EMBED_PATTERN — this returns one ref.
    expect(parseEmbeds("see [[note]] for detail")).toHaveLength(0);
  });

  test("strips the alias from an aliased embed", () => {
    // Mutation: remove the `|` split in the no-fragment branch.
    const [ref] = parseEmbeds("![[note|Displayed name]]");
    expect(ref.linkpath).toBe("note");
  });

  test("splits on the first # then the first | ", () => {
    // Mutation: split on `|` before `#` — heading becomes "H|alias".
    const [ref] = parseEmbeds("![[note#H|alias]]");
    expect(ref.linkpath).toBe("note");
    expect(ref.heading).toBe("H");
  });

  test("recognises a block id", () => {
    // Mutation: remove the `^` branch — blockId undefined, heading "^abc".
    const [ref] = parseEmbeds("![[note#^abc]]");
    expect(ref.blockId).toBe("abc");
    expect(ref.heading).toBeUndefined();
  });

  test("gives two identical embeds distinct indices", () => {
    // Mutation: use body.indexOf(original) instead of match.index — both 0.
    const refs = parseEmbeds("![[a]] ![[a]]");
    expect(refs).toHaveLength(2);
    expect(refs[0].index).toBe(0);
    expect(refs[1].index).toBe(7);
  });

  test("does not span a line break", () => {
    // Mutation: allow \n in the character class — one bogus ref appears.
    expect(parseEmbeds("![[start\nend]]")).toHaveLength(0);
  });
});

describe("expandEmbeds", () => {
  test("inlines the body of a resolved markdown note", async () => {
    // Mutation: return `body` unchanged.
    setMockFile("Notes/target.md", "Target body.");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "before ![[Notes/target.md]] after",
    );
    expect(out).toBe("before Target body. after");
  });

  test("strips the embedded note's frontmatter", async () => {
    // Mutation: skip stripFrontmatter on embedded content.
    setMockFile("Notes/fm.md", "---\ntitle: X\n---\nVisible.");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/fm.md]]",
    );
    expect(out).toBe("Visible.");
    expect(out).not.toContain("title: X");
  });

  test("strips an argument declaration from embedded content", async () => {
    // Mutation: skip stripArgDeclarations on embedded content.
    setMockFile(
      "Notes/decl.md",
      '<% tp.mcpTools.prompt("who", "Target") %>\nBody stays.',
    );
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/decl.md]]",
    );
    expect(out).not.toContain("tp.mcpTools.prompt");
    expect(out).toContain("Body stays.");
  });

  test("leaves placeholders inside embedded content unsubstituted", async () => {
    // Pins the ordering decision. Mutation: call substituteArgs on embedded
    // content — `{{who}}` would resolve and this fails.
    setMockFile("Notes/ph.md", "Hello {{who}}");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/ph.md]]",
    );
    expect(out).toBe("Hello {{who}}");
  });

  test("keeps an unresolved embed verbatim with a marker", async () => {
    // Mutation: replace the not-found branch with "" — the token disappears.
    const out = await expandEmbeds(mockApp(), "Prompts/p.md", "![[missing]]");
    expect(out).toContain("![[missing]]");
    expect(out).toContain("not expanded (not found)");
  });

  test("keeps an embed into an excluded folder verbatim with the SAME marker as a missing one (ADR-0020 D8)", async () => {
    setMockFile("Secret/canary.md", "Secret body.");
    const app = createGuardedApp(mockApp(), () => compilePolicy(["Secret"]));
    const out = await expandEmbeds(
      app,
      "Prompts/p.md",
      "![[Secret/canary.md]]",
    );
    // A distinct "excluded" reason string is forbidden here: it would
    // confirm the folder exists, which is exactly what D8 hides. The
    // marker must read identically to the genuinely-missing case above.
    expect(out).toBe(
      "![[Secret/canary.md]] <!-- prompt-transclusion: not expanded (not found) -->",
    );
  });

  test("keeps a non-markdown embed verbatim with a marker", async () => {
    // Mutation: remove the extension guard — the mock resolves img.png and
    // its bytes get inlined into the prompt.
    setMockFile("Assets/img.png", "binary-ish");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Assets/img.png]]",
    );
    expect(out).toContain("![[Assets/img.png]]");
    expect(out).toContain("not markdown (.png)");
    expect(out).not.toContain("binary-ish");
  });

  test("does not expand an embed nested inside embedded content", async () => {
    // Mutation: recurse with depth + 1 and no ceiling — "Inner body" appears.
    setMockFile("Notes/outer.md", "Outer ![[Notes/inner.md]]");
    setMockFile("Notes/inner.md", "Inner body");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/outer.md]]",
    );
    expect(out).toContain("Outer ![[Notes/inner.md]]");
    expect(out).toContain(`not expanded (depth limit ${MAX_EMBED_DEPTH})`);
    expect(out).not.toContain("Inner body");
  });

  test("terminates on a self-embed", async () => {
    // Mutation: remove the depth guard — this recurses forever and the test
    // fails by timeout.
    setMockFile("Notes/self.md", "Self ![[Notes/self.md]]");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/self.md]]",
    );
    expect(out).toContain("Self ![[Notes/self.md]]");
  });

  test("terminates on an A -> B -> A cycle", async () => {
    // Depth 1 means A's body is inlined and B is not followed at all, so the
    // cycle is cut before it can close. Mutation: remove the depth guard —
    // this recurses forever and the test fails by timeout.
    setMockFile("Notes/a.md", "A ![[Notes/b.md]]");
    setMockFile("Notes/b.md", "B ![[Notes/a.md]]");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/a.md]]",
    );
    expect(out).toContain("A ![[Notes/b.md]]");
    expect(out).not.toContain("B ");
  });

  test("expands only the named section of a heading embed", async () => {
    // Mutation: ignore the fragment and inline the whole note — "Intro"
    // and "Third" would appear.
    setMockFile(
      "Notes/doc.md",
      "Intro\n\n## First\nFirst body\n\n## Second\nSecond body",
    );
    setMockMetadata("Notes/doc.md", {
      headings: [
        { heading: "First", level: 2, line: 2 },
        { heading: "Second", level: 2, line: 5 },
      ],
    });
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/doc.md#First]]",
    );
    expect(out).toBe("## First\nFirst body");
  });

  test("counts heading offsets against the raw file, frontmatter included", async () => {
    // Mutation: stripFrontmatter before slicing — the offsets shift and the
    // wrong lines come back.
    setMockFile("Notes/fmdoc.md", "---\ntitle: T\n---\n## Only\nSection body");
    setMockMetadata("Notes/fmdoc.md", {
      headings: [{ heading: "Only", level: 2, line: 3 }],
    });
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/fmdoc.md#Only]]",
    );
    expect(out).toBe("## Only\nSection body");
  });

  test("keeps a missing heading verbatim with a marker", async () => {
    // Mutation: fall back to the whole note when the heading is absent.
    setMockFile("Notes/doc2.md", "Body");
    setMockMetadata("Notes/doc2.md", { headings: [] });
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/doc2.md#Nope]]",
    );
    expect(out).toContain("![[Notes/doc2.md#Nope]]");
    expect(out).toContain("heading not found");
    expect(out).not.toContain("Body");
  });

  test("expands the line range of a block embed", async () => {
    // Mutation: ignore blockId — the whole note comes back.
    setMockFile("Notes/blk.md", "line0\nline1\nline2\nline3");
    setMockMetadata("Notes/blk.md", {
      blocks: { abc: { startLine: 1, endLine: 2 } },
    });
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/blk.md#^abc]]",
    );
    expect(out).toBe("line1\nline2");
  });

  test("keeps a missing block verbatim with a marker", async () => {
    // Mutation: fall back to the whole note when the block is absent.
    setMockFile("Notes/blk2.md", "Body");
    setMockMetadata("Notes/blk2.md", { blocks: {} });
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/blk2.md#^nope]]",
    );
    expect(out).toContain("block not found");
    expect(out).not.toContain("Body");
  });

  test("skips an over-budget embed whole rather than truncating it", async () => {
    // Mutation: drop the budget check, or truncate instead of skipping —
    // the prefix assertion catches a truncation that the plain one misses.
    setMockFile("Notes/big.md", "0123456789ABCDEF");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/big.md]]",
      { maxBytes: 8 },
    );
    expect(out).toContain("size budget 8 bytes");
    expect(out).not.toContain("0123456789ABCDEF");
    expect(out).not.toContain("01234567");
  });

  test("spends the budget in document order", async () => {
    // Mutation: make the budget per-embed, or iterate right to left — the
    // second embed would expand and the first would not.
    setMockFile("Notes/one.md", "AAAAA");
    setMockFile("Notes/two.md", "BBBBB");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/one.md]] ![[Notes/two.md]]",
      { maxBytes: 6 },
    );
    expect(out).toContain("AAAAA");
    expect(out).not.toContain("BBBBB");
  });

  test("stops expanding past the embed count limit", async () => {
    // Mutation: remove the count guard — both expand.
    setMockFile("Notes/one.md", "AAAAA");
    setMockFile("Notes/two.md", "BBBBB");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[Notes/one.md]] ![[Notes/two.md]]",
      { maxEmbeds: 1 },
    );
    expect(out).toContain("AAAAA");
    expect(out).toContain("embed limit 1");
    expect(out).not.toContain("BBBBB");
  });

  test("returns a body with no embeds byte for byte", async () => {
    // Mutation: unconditionally append a marker, or normalise whitespace.
    const body = "Plain prompt.\n\nSee [[a link]] and {{arg}}.\n";
    expect(await expandEmbeds(mockApp(), "Prompts/p.md", body)).toBe(body);
  });

  test("a failed embed does not consume the budget", async () => {
    // Mutation: increment `spent` before the guards — the good embed after
    // a missing one would then be skipped too.
    setMockFile("Notes/ok.md", "GOOD");
    const out = await expandEmbeds(
      mockApp(),
      "Prompts/p.md",
      "![[missing]] ![[Notes/ok.md]]",
      { maxEmbeds: 1 },
    );
    expect(out).toContain("GOOD");
  });
});
