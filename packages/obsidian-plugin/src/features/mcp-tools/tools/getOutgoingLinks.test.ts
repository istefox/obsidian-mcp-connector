import { describe, expect, test, beforeEach } from "bun:test";
import {
  getOutgoingLinksHandler,
  getOutgoingLinksSchema,
} from "./getOutgoingLinks";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_outgoing_links tool", () => {
  test("schema declares the tool name", () => {
    expect(getOutgoingLinksSchema.get("name")?.toString()).toContain(
      "get_outgoing_links",
    );
  });

  test("returns isError when the source file does not exist", async () => {
    const r = await getOutgoingLinksHandler({
      arguments: { path: "missing.md" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("File not found");
  });

  test("returns empty list for a file with no links", async () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {});
    const r = await getOutgoingLinksHandler({
      arguments: { path: "note.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data).toEqual({
      source: "note.md",
      totalLinks: 0,
      links: [],
    });
  });

  test("returns body links with resolved targets", async () => {
    setMockFile("note.md", "");
    setMockFile("target.md", "");
    setMockMetadata("note.md", {
      links: [{ link: "target", original: "[[target]]" }],
    });
    const r = await getOutgoingLinksHandler({
      arguments: { path: "note.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalLinks).toBe(1);
    expect(data.links[0]).toEqual({
      link: "target",
      original: "[[target]]",
      source: "body",
      embed: false,
      resolved: true,
      targetPath: "target.md",
    });
  });

  test("marks unresolved links with resolved:false and targetPath:null", async () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {
      links: [{ link: "ghost", original: "[[ghost]]" }],
    });
    const r = await getOutgoingLinksHandler({
      arguments: { path: "note.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.links[0].resolved).toBe(false);
    expect(data.links[0].targetPath).toBeNull();
  });

  test("excludes unresolved links when includeUnresolved=false", async () => {
    setMockFile("note.md", "");
    setMockFile("real.md", "");
    setMockMetadata("note.md", {
      links: [
        { link: "real", original: "[[real]]" },
        { link: "ghost", original: "[[ghost]]" },
      ],
    });
    const r = await getOutgoingLinksHandler({
      arguments: { path: "note.md", includeUnresolved: "false" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalLinks).toBe(1);
    expect(data.links[0].link).toBe("real");
  });

  test("returns embeds with embed:true by default", async () => {
    setMockFile("note.md", "");
    setMockFile("image.png", "");
    setMockMetadata("note.md", {
      embeds: [{ link: "image.png", original: "![[image.png]]" }],
    });
    const r = await getOutgoingLinksHandler({
      arguments: { path: "note.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalLinks).toBe(1);
    expect(data.links[0].embed).toBe(true);
    expect(data.links[0].original).toBe("![[image.png]]");
  });

  test("excludes embeds when includeEmbeds=false", async () => {
    setMockFile("note.md", "");
    setMockFile("image.png", "");
    setMockMetadata("note.md", {
      links: [{ link: "other", original: "[[other]]" }],
      embeds: [{ link: "image.png", original: "![[image.png]]" }],
    });
    const r = await getOutgoingLinksHandler({
      arguments: { path: "note.md", includeEmbeds: "false" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalLinks).toBe(1);
    expect(data.links[0].link).toBe("other");
    expect(data.links[0].embed).toBe(false);
  });

  test("returns frontmatter links with source:'frontmatter'", async () => {
    setMockFile("child.md", "");
    setMockFile("parent.md", "");
    setMockMetadata("child.md", {
      frontmatterLinks: [
        { link: "parent", original: "[[parent]]", key: "parent" },
      ],
    });
    const r = await getOutgoingLinksHandler({
      arguments: { path: "child.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.totalLinks).toBe(1);
    expect(data.links[0].source).toBe("frontmatter");
    expect(data.links[0].embed).toBe(false);
    expect(data.links[0].resolved).toBe(true);
  });

  test("preserves displayText when present on the link", async () => {
    setMockFile("note.md", "");
    setMockFile("target.md", "");
    setMockMetadata("note.md", {
      links: [
        {
          link: "target",
          original: "[[target|Friendly]]",
          displayText: "Friendly",
        },
      ],
    });
    const r = await getOutgoingLinksHandler({
      arguments: { path: "note.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.links[0].displayText).toBe("Friendly");
  });

  test("preserves order: body links → embeds → frontmatter links", async () => {
    setMockFile("note.md", "");
    setMockFile("a.md", "");
    setMockFile("b.png", "");
    setMockFile("c.md", "");
    setMockMetadata("note.md", {
      links: [{ link: "a", original: "[[a]]" }],
      embeds: [{ link: "b.png", original: "![[b.png]]" }],
      frontmatterLinks: [{ link: "c", original: "[[c]]", key: "ref" }],
    });
    const r = await getOutgoingLinksHandler({
      arguments: { path: "note.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.links.map((l: { link: string }) => l.link)).toEqual([
      "a",
      "b.png",
      "c",
    ]);
  });

  test("mixes body + frontmatter links with all flags off → minimal subset", async () => {
    setMockFile("note.md", "");
    setMockFile("real.md", "");
    setMockMetadata("note.md", {
      links: [
        { link: "real", original: "[[real]]" },
        { link: "ghost", original: "[[ghost]]" },
      ],
      embeds: [{ link: "img.png", original: "![[img.png]]" }],
      frontmatterLinks: [
        { link: "ghost-fm", original: "[[ghost-fm]]", key: "ref" },
      ],
    });
    const r = await getOutgoingLinksHandler({
      arguments: {
        path: "note.md",
        includeEmbeds: "false",
        includeUnresolved: "false",
      },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    // Only resolved body link survives.
    expect(data.totalLinks).toBe(1);
    expect(data.links[0]).toMatchObject({
      link: "real",
      source: "body",
      embed: false,
      resolved: true,
      targetPath: "real.md",
    });
  });

  test("frontmatter unresolved link → resolved:false, targetPath:null", async () => {
    setMockFile("child.md", "");
    setMockMetadata("child.md", {
      frontmatterLinks: [
        {
          link: "missing-parent",
          original: "[[missing-parent]]",
          key: "parent",
        },
      ],
    });
    const r = await getOutgoingLinksHandler({
      arguments: { path: "child.md" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.links[0]).toMatchObject({
      source: "frontmatter",
      resolved: false,
      targetPath: null,
    });
  });
});
