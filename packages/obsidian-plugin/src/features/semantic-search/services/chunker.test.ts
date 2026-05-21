import { describe, expect, test } from "bun:test";
import { chunk, countTokens, hashChunk } from "./chunker";

const lorem = (words: number): string => {
  const base = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  // Repeat enough to reach `words` whitespace-delimited tokens.
  let out = "";
  while (countTokens(out) < words) out += base;
  // Truncate to roughly the target.
  const tokens = out.split(/\s+/).filter(Boolean).slice(0, words);
  return tokens.join(" ");
};

describe("chunker", () => {
  test("single H1 section between min and max tokens → 1 chunk", async () => {
    const content = `# Hello\n\n${lorem(40)}`;
    const chunks = await chunk(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe("Hello");
    expect(chunks[0]?.text.startsWith("# Hello")).toBe(true);
    expect(chunks[0]?.id).toBe("0");
    expect(chunks[0]?.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("H1 + multiple H2 → one chunk per section, frontmatter merged with first", async () => {
    const content = [
      "---",
      "tags: [research, ai]",
      "title: Notes",
      "---",
      "# Top",
      "",
      lorem(30),
      "",
      "## Section A",
      "",
      lorem(30),
      "",
      "## Section B",
      "",
      lorem(30),
    ].join("\n");

    const chunks = await chunk(content);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.heading).toBe("Top");
    expect(chunks[1]?.heading).toBe("Section A");
    expect(chunks[2]?.heading).toBe("Section B");

    // Frontmatter merged into the first chunk only.
    expect(chunks[0]?.text).toContain("tags: [research, ai]");
    expect(chunks[0]?.text).toContain("title: Notes");
    expect(chunks[1]?.text).not.toContain("tags:");
    expect(chunks[2]?.text).not.toContain("tags:");

    // IDs ordinal across the file.
    expect(chunks.map((c) => c.id)).toEqual(["0", "1", "2"]);
  });

  test("section over 512 tokens → multiple windows with overlap", async () => {
    const longBody = lorem(900);
    const content = `# Long\n\n${longBody}`;
    const chunks = await chunk(content);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.heading).toBe("Long");
      // Heading line is repeated on every window for context preservation.
      expect(c.text.startsWith("# Long")).toBe(true);
      expect(countTokens(c.text)).toBeLessThanOrEqual(512 + 2); // +2 for the heading words
    }

    // Overlap: consecutive windows share the last 64 / first 64 token region.
    // Verify via shared substring of mid-window content.
    const w0Tokens = chunks[0]!.text.split(/\s+/).filter(Boolean);
    const w1Tokens = chunks[1]!.text.split(/\s+/).filter(Boolean);
    // The last ~60 tokens of window 0 should appear at the start of window 1
    // (after the repeated heading prefix "# Long").
    const w0Tail = w0Tokens.slice(-50).join(" ");
    expect(w1Tokens.join(" ")).toContain(w0Tail.slice(0, 100));
  });

  test("section under min tokens is skipped", async () => {
    const content = "# Tiny\n\nshort body";
    const chunks = await chunk(content);
    expect(chunks).toHaveLength(0);
  });

  test("no headings → single chunk when under max", async () => {
    const content = lorem(40);
    const chunks = await chunk(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBeNull();
  });

  test("no headings → sliding window when over max", async () => {
    const content = lorem(900);
    const chunks = await chunk(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.heading).toBeNull();
    }
  });

  test("contentHash is deterministic and changes on edits", async () => {
    const a = await hashChunk("hello world");
    const b = await hashChunk("hello world");
    const c = await hashChunk("hello world!");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test("H3 stays inside its parent H2 section", async () => {
    const content = [
      "## Parent",
      "",
      lorem(15),
      "",
      "### Child",
      "",
      lorem(15),
    ].join("\n");

    const chunks = await chunk(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe("Parent");
    expect(chunks[0]?.text).toContain("### Child");
  });

  test("frontmatter-only with no body sections produces zero chunks when frontmatter is small", async () => {
    const content = "---\ntag: a\n---\n";
    const chunks = await chunk(content);
    expect(chunks).toHaveLength(0);
  });

  test("frontmatter-only large enough → single chunk when no body", async () => {
    const fm = lorem(40);
    const content = `---\nnotes: |\n  ${fm}\n---\n`;
    const chunks = await chunk(content);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]?.text).toContain("notes:");
  });

  test("respects custom maxTokens / overlapTokens / minTokens", async () => {
    const content = `# T\n\n${lorem(50)}`;
    // With minTokens=200 the section (~52 tokens incl heading) is skipped.
    const skipped = await chunk(content, { minTokens: 200 });
    expect(skipped).toHaveLength(0);

    // With maxTokens=20 the same section is sliced into multiple windows.
    const sliced = await chunk(content, { maxTokens: 20, overlapTokens: 4 });
    expect(sliced.length).toBeGreaterThan(1);
  });

  test("offset reflects section position in file", async () => {
    const content = ["# A", "", lorem(30), "", "## B", "", lorem(30)].join(
      "\n",
    );
    const chunks = await chunk(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.offset).toBe(0);
    expect(chunks[1]?.offset).toBeGreaterThan(0);
  });
});
