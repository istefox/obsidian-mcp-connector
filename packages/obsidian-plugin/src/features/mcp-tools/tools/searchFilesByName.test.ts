import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockIgnored,
  setMockMetadata,
} from "$/test-setup";
import {
  searchFilesByNameHandler,
  searchFilesByNameSchema,
  type SearchFilesByNameContext,
} from "./searchFilesByName";

beforeEach(() => resetMockVault());

async function run(args: SearchFilesByNameContext["arguments"]) {
  const r = await searchFilesByNameHandler({ arguments: args, app: mockApp() });
  return { r, data: JSON.parse(r.content[0].text) };
}
const paths = (data: { results: Array<{ path: string }> }) =>
  data.results.map((x) => x.path);

function seed(): void {
  setMockFile("Projects/Meeting Notes.md", "");
  setMockFile("Projects/Roadmap 2026.md", "");
  setMockFile("Daily/2026-10-03.md", "");
  setMockFile("Archive/old meeting.md", "");
  setMockFile("Boards/Plan.canvas", "{}");
  setMockFile("img/meeting-photo.png", "x");
  setMockMetadata("Projects/Roadmap 2026.md", {
    frontmatter: { aliases: ["Yearly plan", "mtg"] },
  });
}

describe("search_files_by_name", () => {
  test("schema declares the tool name", () => {
    expect(searchFilesByNameSchema.get("name").toString()).toContain(
      "search_files_by_name",
    );
  });

  test("ranks exact name matches first and reports what matched", async () => {
    seed();
    const { r, data } = await run({ query: "meeting" });
    expect(r.isError).toBeUndefined();
    expect(data.query).toBe("meeting");
    expect(data.truncated).toBeUndefined();
    expect(paths(data)).toEqual([
      "Projects/Meeting Notes.md",
      "Archive/old meeting.md",
    ]);
    expect(data.results[0]).toMatchObject({
      basename: "Meeting Notes",
      extension: "md",
      matchedOn: "basename",
      matches: [[0, 7]],
      uri: "obsidian://open?vault=Test%20Vault&file=Projects%2FMeeting%20Notes.md",
    });
    expect(typeof data.results[0].score).toBe("number");
    expect(data.results[0].score).toBeGreaterThan(data.results[1].score);
  });

  test("matches aliases and names the alias", async () => {
    seed();
    const { data } = await run({ query: "mtg" });
    expect(data.results[0]).toMatchObject({
      path: "Projects/Roadmap 2026.md",
      matchedOn: "alias",
      alias: "mtg",
    });
  });

  test("falls back to the path when only a folder segment matches", async () => {
    seed();
    const { data } = await run({ query: "daily" });
    expect(data.results[0]).toMatchObject({
      path: "Daily/2026-10-03.md",
      matchedOn: "path",
    });
  });

  test("fuzzy: non-contiguous characters match, case-insensitively", async () => {
    seed();
    const { data } = await run({ query: "RM26" });
    expect(paths(data)).toContain("Projects/Roadmap 2026.md");
  });

  test("notes only by default; attachments on request", async () => {
    seed();
    expect(paths((await run({ query: "photo" })).data)).toEqual([]);
    expect(
      paths((await run({ query: "photo", includeAttachments: true })).data),
    ).toEqual(["img/meeting-photo.png"]);
    expect(paths((await run({ query: "plan" })).data)).toEqual([
      "Boards/Plan.canvas",
      "Projects/Roadmap 2026.md",
    ]);
  });

  test("folder scope and excluded files narrow the candidates", async () => {
    seed();
    expect(
      paths((await run({ query: "meeting", folder: "/Archive/" })).data),
    ).toEqual(["Archive/old meeting.md"]);
    setMockIgnored("Archive/old meeting.md");
    expect(paths((await run({ query: "meeting" })).data)).toEqual([
      "Projects/Meeting Notes.md",
    ]);
  });

  test("limit truncates and total reports the full count", async () => {
    seed();
    const { data } = await run({ query: "e", limit: 2 });
    expect(data.results).toHaveLength(2);
    expect(data.total).toBeGreaterThan(2);
    expect(data.truncated).toBe(true);
  });

  test("no match is an empty result, not an error", async () => {
    seed();
    const { r, data } = await run({ query: "zzzz" });
    expect(r.isError).toBeUndefined();
    expect(data).toEqual({ query: "zzzz", total: 0, results: [] });
  });
});
