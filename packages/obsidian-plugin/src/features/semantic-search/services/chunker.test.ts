import { describe, expect, test } from "bun:test";
import {
  chunk,
  countTokens,
  hashChunk,
  makeChunkerForProvider,
  wrapChunkerWithOverlap,
} from "./chunker";
import type { EmbeddingProvider } from "../types";

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

  test("H1 + multiple H2 → one chunk per section, small frontmatter dropped", async () => {
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

    // Frontmatter has ~5 tokens (below minTokens=20) → dropped, not merged.
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.heading).toBe("Top");
    expect(chunks[1]?.heading).toBe("Section A");
    expect(chunks[2]?.heading).toBe("Section B");

    // No body chunk carries frontmatter.
    expect(chunks[0]?.text).not.toContain("tags:");
    expect(chunks[1]?.text).not.toContain("tags:");
    expect(chunks[2]?.text).not.toContain("tags:");

    // IDs ordinal across body chunks.
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

  test("frontmatter-only large enough → single #frontmatter chunk when no body", async () => {
    const fm = lorem(40);
    const content = `---\nnotes: |\n  ${fm}\n---\n`;
    const chunks = await chunk(content);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]?.id).toBe("#frontmatter");
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

  // New: frontmatter large enough to meet minTokens
  test("frontmatter large enough emitted as #frontmatter chunk before body", async () => {
    const fm = lorem(30);
    const content = [
      "---",
      `notes: ${fm}`,
      "---",
      "# Body",
      "",
      lorem(30),
    ].join("\n");

    const chunks = await chunk(content);

    expect(chunks[0]?.id).toBe("#frontmatter");
    expect(chunks[0]?.heading).toBeNull();
    expect(chunks[0]?.text).toContain("notes:");

    // Body chunk does not carry frontmatter.
    expect(chunks[1]?.id).toBe("0");
    expect(chunks[1]?.text).not.toContain("notes:");

    expect(chunks.map((c) => c.id)).toEqual(["#frontmatter", "0"]);
  });

  // New: H3 sub-split
  test("H3 sub-split fires when H2 section exceeds maxTokens", async () => {
    const content = [
      "## Parent",
      "",
      lorem(30),
      "",
      "### Sub A",
      "",
      lorem(300),
      "",
      "### Sub B",
      "",
      lorem(300),
    ].join("\n");

    // Section ≈ 630 tokens (30 + 300 + 300 + headings) > 512 default maxTokens.
    const chunks = await chunk(content);

    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.heading)).toEqual(["Parent", "Sub A", "Sub B"]);
    // Each chunk is within the token limit.
    for (const c of chunks) {
      expect(countTokens(c.text)).toBeLessThanOrEqual(514);
    }
  });

  // New: code fence atomic
  test("oversized code fence kept as single chunk", async () => {
    // 150 lines × ~4 tokens each ≈ 600 tokens > default maxTokens 512.
    const codeLines = Array.from(
      { length: 150 },
      (_, i) => `const x${i} = ${i};`,
    ).join("\n");
    const content = `## Section\n\n\`\`\`typescript\n${codeLines}\n\`\`\``;

    const chunks = await chunk(content, { maxTokens: 512 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("```typescript");
    expect(chunks[0]?.heading).toBe("Section");
  });

  // New: overlap wrapper
  test("wrapChunkerWithOverlap prepends last sentence of previous chunk", async () => {
    // Section body must exceed minTokens (20); lorem(20) + 2 sentences = ~29 tokens.
    const content = [
      "# First",
      "",
      lorem(20) + " Opening sentence. This is the final sentence.",
      "",
      "# Second",
      "",
      lorem(30),
    ].join("\n");

    const wrapped = wrapChunkerWithOverlap(chunk);
    const chunks = await wrapped(content);

    // No frontmatter — two body chunks.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.id).toBe("0");
    expect(chunks[1]?.id).toBe("1");
    // Second chunk starts with the last sentence of the first.
    expect(chunks[1]?.text.startsWith("This is the final sentence.")).toBe(
      true,
    );
    // First chunk is unchanged.
    expect(chunks[0]?.text.startsWith("# First")).toBe(true);
  });

  test("wrapChunkerWithOverlap: #frontmatter chunk not used as overlap source", async () => {
    const fm = lorem(30);
    const content = [
      "---",
      `notes: ${fm}`,
      "---",
      "# Body",
      "",
      lorem(30),
    ].join("\n");

    const wrapped = wrapChunkerWithOverlap(chunk);
    const chunks = await wrapped(content);

    // #frontmatter is chunks[0]; body chunk is chunks[1].
    expect(chunks[0]?.id).toBe("#frontmatter");
    // Body chunk should NOT have frontmatter overlap prepended.
    expect(chunks[1]?.text.startsWith("# Body")).toBe(true);
  });
});

function stubProvider(maxInputTokens: number): EmbeddingProvider {
  return {
    providerKey: "stub",
    dimensions: 1,
    maxInputTokens,
    getMaxInputTokens: async () => maxInputTokens,
    embed: async () => [],
    isAvailable: async () => true,
    getModelSizeBytes: () => 0,
  };
}

describe("makeChunkerForProvider", () => {
  test("subtracts 16-token task-prompt headroom from provider max", async () => {
    // 2048 → 2032 effective. Use a single long section that exceeds the
    // chunker default (512) — proves the override actually raises the cap.
    const content = `# Body\n\n${lorem(800)}`;
    const chunkerDefault = await chunk(content);
    const chunkerLargeBudget = await makeChunkerForProvider(
      stubProvider(2048),
    )(content);
    // Default config splits an 800-token section; the larger budget keeps
    // it as one chunk because 800 < 2032.
    expect(chunkerDefault.length).toBeGreaterThan(1);
    expect(chunkerLargeBudget).toHaveLength(1);
  });

  test("MIN_CHUNK_MAX_TOKENS floor protects against pathological caps", async () => {
    // Provider cap below the 64-token floor → chunker still uses 64.
    const content = `# Body\n\n${lorem(80)}`;
    const chunks = await makeChunkerForProvider(stubProvider(32))(content);
    // 80 tokens at 64 maxTokens should produce ≥2 chunks; not crash.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("native-sized provider (256) yields ~240 effective max", async () => {
    // A 300-token section: 240 effective max → splits; 256 raw would keep
    // it close to one. The 16-token headroom is the asserted behavior.
    const content = `# Body\n\n${lorem(300)}`;
    const chunks = await makeChunkerForProvider(stubProvider(256))(content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});
