import { describe, expect, test } from "bun:test";
import { editFrontmatter } from "./frontmatterEdit";

const set = (key: string, value: unknown) => (fm: Record<string, unknown>) => {
  fm[key] = value;
};

describe("editFrontmatter", () => {
  test("adds a key and leaves the body untouched", () => {
    const body = "# Title\n\nText with --- inside\n";
    const out = editFrontmatter(`---\na: 1\n---\n${body}`, set("b", "two"));
    expect(out).toBe(`---\na: 1\nb: two\n---\n${body}`);
  });

  test("round-trips lists, booleans and numbers", () => {
    const out = editFrontmatter(
      "---\ntags:\n  - x\n  - y\nok: true\nn: 3\n---\nbody\n",
      set("n", 4),
    );
    expect(out).toBe("---\ntags:\n  - x\n  - y\nok: true\nn: 4\n---\nbody\n");
  });

  test("creates a block on a note that has none", () => {
    expect(editFrontmatter("body\n", set("a", 1))).toBe(
      "---\na: 1\n---\nbody\n",
    );
  });

  test("removing the last key keeps an empty block", () => {
    const out = editFrontmatter("---\na: 1\n---\nbody\n", (fm) => {
      delete fm.a;
    });
    expect(out).toBe("---\n---\nbody\n");
  });

  test("a no-op edit returns the text unchanged, comments included", () => {
    const text = "---\n# keep me\na: 1\n---\nbody\n";
    expect(editFrontmatter(text, set("a", 1))).toBe(text);
  });

  test("keeps CRLF line endings", () => {
    const out = editFrontmatter("---\r\na: 1\r\n---\r\nbody\r\n", set("b", 2));
    expect(out).toBe("---\r\na: 1\r\nb: 2\r\n---\r\nbody\r\n");
  });

  test("refuses invalid YAML instead of overwriting it", () => {
    expect(() =>
      editFrontmatter("---\na: [1\n---\nbody\n", set("b", 1)),
    ).toThrow("not valid YAML");
  });
});
