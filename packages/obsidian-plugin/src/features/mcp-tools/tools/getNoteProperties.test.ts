import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockMetadata,
} from "$/test-setup";
import {
  getNotePropertiesHandler,
  getNotePropertiesSchema,
} from "./getNoteProperties";

beforeEach(() => resetMockVault());

async function run(path: string) {
  const r = await getNotePropertiesHandler({
    arguments: { path },
    app: mockApp(),
  });
  return { r, data: JSON.parse(r.content[0].text) };
}

describe("get_note_properties", () => {
  test("schema declares the tool name", () => {
    expect(getNotePropertiesSchema.get("name").toString()).toContain(
      "get_note_properties",
    );
  });

  test("returns the whole frontmatter with native types and the key list", async () => {
    setMockFile("n.md", "");
    setMockMetadata("n.md", {
      frontmatter: {
        title: "Plan",
        priority: 2,
        done: false,
        tags: ["a", "b"],
        due: "2026-10-03",
      },
    });
    const { r, data } = await run("n.md");
    expect(r.isError).toBeUndefined();
    expect(data).toEqual({
      path: "n.md",
      frontmatter: {
        title: "Plan",
        priority: 2,
        done: false,
        tags: ["a", "b"],
        due: "2026-10-03",
      },
      keys: ["title", "priority", "done", "tags", "due"],
    });
  });

  test("a note without frontmatter answers null, not an error", async () => {
    setMockFile("plain.md", "just text");
    const { r, data } = await run("plain.md");
    expect(r.isError).toBeUndefined();
    expect(data.frontmatter).toBeNull();
    expect(data.keys).toEqual([]);
  });

  test("missing file and folder are refused with the shared codes", async () => {
    setMockFolder("Dir");
    expect((await run("none.md")).data.errorCode).toBe("file_not_found");
    expect((await run("Dir")).data.errorCode).toBe("not_a_file");
  });
});
