import { describe, expect, test, beforeEach } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";
import { parseArgDeclarations, discoverPrompts } from "./promptDiscovery";

beforeEach(() => {
  resetMockVault();
});

describe("parseArgDeclarations", () => {
  test("returns empty array for body with no declarations", () => {
    expect(parseArgDeclarations("Hello {{name}}")).toEqual([]);
  });

  test("parses a single two-arg declaration", () => {
    const body = `<% tp.mcpTools.prompt("recipient", "Who to greet") %>`;
    expect(parseArgDeclarations(body)).toEqual([
      { name: "recipient", description: "Who to greet" },
    ]);
  });

  test("parses two different declarations", () => {
    const body = [
      `<% tp.mcpTools.prompt("lang", "Language") %>`,
      `<% tp.mcpTools.prompt("tone", "Writing tone") %>`,
    ].join("\n");
    expect(parseArgDeclarations(body)).toEqual([
      { name: "lang", description: "Language" },
      { name: "tone", description: "Writing tone" },
    ]);
  });

  test("deduplicates declarations with the same name", () => {
    const body = [
      `<% tp.mcpTools.prompt("name", "First decl") %>`,
      `<% tp.mcpTools.prompt("name", "Second decl") %>`,
    ].join("\n");
    const result = parseArgDeclarations(body);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("name");
  });

  test("parses single-arg form with empty description", () => {
    const body = `<% tp.mcpTools.prompt("topic") %>`;
    expect(parseArgDeclarations(body)).toEqual([
      { name: "topic", description: "" },
    ]);
  });

  test("does not count same name from both two-arg and one-arg patterns twice", () => {
    const body = [
      `<% tp.mcpTools.prompt("lang", "Language") %>`,
      `<% tp.mcpTools.prompt("lang") %>`,
    ].join("\n");
    const result = parseArgDeclarations(body);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Language");
  });
});

describe("discoverPrompts", () => {
  test("returns empty array when vault has no Prompts/ files", async () => {
    const app = mockApp();
    expect(await discoverPrompts(app)).toEqual([]);
  });

  test("includes file in Prompts/ with mcp-tools-prompt tag", async () => {
    setMockFile(
      "Prompts/greet.md",
      `<% tp.mcpTools.prompt("who", "Target") %>\nHello {{who}}`,
    );
    setMockMetadata("Prompts/greet.md", {
      frontmatter: { tags: ["mcp-tools-prompt"], description: "A greeting" },
    });
    const app = mockApp();
    const result = await discoverPrompts(app);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("greet");
    expect(result[0].description).toBe("A greeting");
    expect(result[0].arguments).toEqual([
      { name: "who", description: "Target", required: false },
    ]);
  });

  test("coerces scalar string tag to array", async () => {
    setMockFile("Prompts/foo.md", "Hello");
    setMockMetadata("Prompts/foo.md", {
      frontmatter: { tags: "mcp-tools-prompt" },
    });
    const app = mockApp();
    const result = await discoverPrompts(app);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("foo");
  });

  // metadataCache returns the hashed spelling once the note has been opened
  // and saved in Obsidian, while the file on disk still reads the bare tag.
  test("includes file whose cached tag carries the `#` prefix", async () => {
    setMockFile("Prompts/hashed.md", "Hello");
    setMockMetadata("Prompts/hashed.md", {
      frontmatter: { tags: ["#mcp-tools-prompt"], description: "Hashed" },
    });
    const app = mockApp();
    const result = await discoverPrompts(app);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("hashed");
    expect(result[0].description).toBe("Hashed");
  });

  test("excludes file missing the mcp-tools-prompt tag", async () => {
    setMockFile("Prompts/no-tag.md", "Hello");
    setMockMetadata("Prompts/no-tag.md", {
      frontmatter: { tags: ["other-tag"] },
    });
    const app = mockApp();
    expect(await discoverPrompts(app)).toEqual([]);
  });

  test("excludes file with no frontmatter", async () => {
    setMockFile("Prompts/bare.md", "No frontmatter");
    const app = mockApp();
    expect(await discoverPrompts(app)).toEqual([]);
  });

  test("excludes file in Prompts/ subdirectory", async () => {
    setMockFile("Prompts/sub/deep.md", "Hello");
    setMockMetadata("Prompts/sub/deep.md", {
      frontmatter: { tags: ["mcp-tools-prompt"] },
    });
    const app = mockApp();
    expect(await discoverPrompts(app)).toEqual([]);
  });

  test("excludes files outside Prompts/ even with correct tag", async () => {
    setMockFile("Notes/greet.md", "Hello");
    setMockMetadata("Notes/greet.md", {
      frontmatter: { tags: ["mcp-tools-prompt"] },
    });
    const app = mockApp();
    expect(await discoverPrompts(app)).toEqual([]);
  });
});
