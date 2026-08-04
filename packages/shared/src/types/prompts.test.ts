import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { PromptFrontmatterSchema } from "./prompts";

// FIX 6: `tags` must be `string[]` AND contain the required literal.
// A mixed array (e.g. `[42, "mcp-tools-prompt"]`) must be rejected so a
// non-string element cannot slip past the tag predicate.
describe("PromptFrontmatterSchema.tags", () => {
  test("accepts a string array containing the required tag", () => {
    const r = PromptFrontmatterSchema({
      tags: ["foo", "mcp-tools-prompt"],
      description: "ok",
    });
    expect(r instanceof type.errors).toBe(false);
  });

  test("rejects a mixed array with a non-string element", () => {
    const r = PromptFrontmatterSchema({
      tags: [42, "mcp-tools-prompt"],
    });
    expect(r instanceof type.errors).toBe(true);
  });

  test("rejects an all-string array missing the required tag", () => {
    const r = PromptFrontmatterSchema({ tags: ["foo", "bar"] });
    expect(r instanceof type.errors).toBe(true);
  });

  test("rejects when tags is not an array at all", () => {
    const r = PromptFrontmatterSchema({ tags: "mcp-tools-prompt" });
    expect(r instanceof type.errors).toBe(true);
  });

  // Obsidian's metadataCache hands back the hashed spelling, so the same note
  // validates differently before and after it is opened in the editor.
  test("accepts the tag in its `#`-prefixed form", () => {
    const r = PromptFrontmatterSchema({
      tags: ["#mcp-tools-prompt"],
      description: "ok",
    });
    expect(r instanceof type.errors).toBe(false);
  });

  test("rejects a `#`-prefixed tag that is not the required one", () => {
    const r = PromptFrontmatterSchema({ tags: ["#mcp-tools", "#prompt"] });
    expect(r instanceof type.errors).toBe(true);
  });
});
