// See docs/architecture/ADR-0026-obsidian-uri-on-note-tools.md.
import { describe, expect, test } from "bun:test";
import {
  buildObsidianUri,
  headingNotFoundError,
  withUriBlock,
} from "./buildObsidianUri";

describe("buildObsidianUri (R-03)", () => {
  test("plain vault-relative path, vault name with a space", () => {
    expect(buildObsidianUri("Test Vault", "Notes/Todo.md")).toBe(
      "obsidian://open?vault=Test%20Vault&file=Notes%2FTodo.md",
    );
  });

  test("non-ASCII in both vault name and path round-trips through decodeURIComponent", () => {
    const uri = buildObsidianUri("Archivio Città", "Appunti/Perché.md");
    const match = uri.match(/^obsidian:\/\/open\?vault=([^&]+)&file=(.+)$/);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![1])).toBe("Archivio Città");
    expect(decodeURIComponent(match![2])).toBe("Appunti/Perché.md");
  });

  test("heading present — separator is %23 inside the file value, never a bare # after the query", () => {
    const uri = buildObsidianUri("Vault", "Notes/Todo.md", "My Heading");
    expect(uri).toContain("%23My%20Heading");
    expect(uri).not.toContain("#");
  });

  test("heading with a space and a non-ASCII character encodes and round-trips", () => {
    const uri = buildObsidianUri("Vault", "Note.md", "Città è bella");
    const match = uri.match(/^obsidian:\/\/open\?vault=[^&]+&file=(.+)$/);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![1])).toBe("Note.md#Città è bella");
    expect(uri).not.toContain("#");
  });

  test("heading omitted and heading undefined produce the same file-only URI", () => {
    const base = buildObsidianUri("Vault", "Note.md");
    expect(buildObsidianUri("Vault", "Note.md", undefined)).toBe(base);
  });
});

describe("withUriBlock (ADR-0026 D4)", () => {
  test("appends exactly one trailing text block, leaves content[0] referentially identical", () => {
    const original = { content: [{ type: "text" as const, text: "hello" }] };
    const result = withUriBlock(original, "obsidian://open?vault=V&file=F");
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toBe(original.content[0]);
    expect(result.content[1]).toEqual({
      type: "text",
      text: "URI: obsidian://open?vault=V&file=F",
    });
  });

  test("preserves every other key on the result", () => {
    const original = {
      content: [{ type: "text" as const, text: "hello" }],
      structuredContent: { foo: "bar" },
    };
    const result = withUriBlock(original, "obsidian://open?vault=V&file=F");
    expect(result.structuredContent).toEqual({ foo: "bar" });
  });

  test("is a no-op when result.isError is true", () => {
    const original = {
      content: [{ type: "text" as const, text: "boom" }],
      isError: true as const,
    };
    const result = withUriBlock(original, "obsidian://open?vault=V&file=F");
    expect(result).toBe(original);
  });
});

describe("headingNotFoundError (R-05)", () => {
  test("isError true, single text block, parsed JSON names heading and path", () => {
    const result = headingNotFoundError("Foo", "a.md");
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.errorCode).toBe("heading_not_found");
    expect(parsed.heading).toBe("Foo");
    expect(parsed.path).toBe("a.md");
    expect(parsed.error).toContain("Foo");
    expect(parsed.error).toContain("a.md");
  });
});
