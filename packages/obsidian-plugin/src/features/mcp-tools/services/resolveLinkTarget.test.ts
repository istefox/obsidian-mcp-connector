import { describe, expect, test, beforeEach } from "bun:test";
import { resolveLinkTarget } from "./resolveLinkTarget";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";
import { TFile } from "obsidian";

beforeEach(() => resetMockVault());

function getFile(app: ReturnType<typeof mockApp>, path: string): TFile {
  const abstract = app.vault.getAbstractFileByPath(path);
  if (!(abstract instanceof TFile)) throw new Error(`not a file: ${path}`);
  return abstract;
}

describe("resolveLinkTarget", () => {
  test("resolves a plain link to an existing file", () => {
    setMockFile("note.md", "");
    setMockFile("target.md", "");
    const app = mockApp();
    const r = resolveLinkTarget(app, "target", getFile(app, "note.md"));
    expect(r.resolved).toBe(true);
    if (r.resolved) expect(r.file.path).toBe("target.md");
  });

  test("a link to a nonexistent file is file_not_found", () => {
    setMockFile("note.md", "");
    const app = mockApp();
    const r = resolveLinkTarget(app, "ghost", getFile(app, "note.md"));
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toBe("file_not_found");
  });

  test("same-doc heading that exists resolves to the source file", () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {
      headings: [{ heading: "Sezione B", level: 2, line: 5 }],
    });
    const app = mockApp();
    const r = resolveLinkTarget(app, "#Sezione B", getFile(app, "note.md"));
    expect(r.resolved).toBe(true);
    if (r.resolved) expect(r.file.path).toBe("note.md");
  });

  test("same-doc heading that does NOT exist is subpath_not_found (the #525 regression)", () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {
      headings: [{ heading: "Sezione B", level: 2, line: 5 }],
    });
    const app = mockApp();
    const r = resolveLinkTarget(
      app,
      "#Sezione Inesistente",
      getFile(app, "note.md"),
    );
    expect(r.resolved).toBe(false);
    if (!r.resolved) {
      expect(r.reason).toBe("subpath_not_found");
      expect(r.file?.path).toBe("note.md");
    }
  });

  test("same-doc block ref that exists resolves", () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {
      blocks: { abc: { startLine: 3, endLine: 3 } },
    });
    const app = mockApp();
    const r = resolveLinkTarget(app, "#^abc", getFile(app, "note.md"));
    expect(r.resolved).toBe(true);
  });

  test("same-doc block ref that does NOT exist is subpath_not_found", () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {
      blocks: { abc: { startLine: 3, endLine: 3 } },
    });
    const app = mockApp();
    const r = resolveLinkTarget(app, "#^ghost", getFile(app, "note.md"));
    expect(r.resolved).toBe(false);
    if (!r.resolved) expect(r.reason).toBe("subpath_not_found");
  });

  test("cross-file heading link that exists resolves to the target file", () => {
    setMockFile("note.md", "");
    setMockFile("other.md", "");
    setMockMetadata("other.md", {
      headings: [{ heading: "Sec", level: 1, line: 0 }],
    });
    const app = mockApp();
    const r = resolveLinkTarget(app, "other#Sec", getFile(app, "note.md"));
    expect(r.resolved).toBe(true);
    if (r.resolved) expect(r.file.path).toBe("other.md");
  });

  test("cross-file heading link with a missing heading is subpath_not_found", () => {
    setMockFile("note.md", "");
    setMockFile("other.md", "");
    setMockMetadata("other.md", {
      headings: [{ heading: "Sec", level: 1, line: 0 }],
    });
    const app = mockApp();
    const r = resolveLinkTarget(app, "other#Ghost", getFile(app, "note.md"));
    expect(r.resolved).toBe(false);
    if (!r.resolved) {
      expect(r.reason).toBe("subpath_not_found");
      expect(r.file?.path).toBe("other.md");
    }
  });

  test("a destination file with no metadata cache entry is conservatively resolved", () => {
    setMockFile("note.md", "");
    setMockFile("other.md", ""); // no setMockMetadata call
    const app = mockApp();
    const r = resolveLinkTarget(app, "other#Anything", getFile(app, "note.md"));
    expect(r.resolved).toBe(true);
  });

  test("a non-markdown destination with a subpath is resolved without validation", () => {
    setMockFile("note.md", "");
    setMockFile("diagram.png", "");
    const app = mockApp();
    const r = resolveLinkTarget(
      app,
      "diagram.png#page=3",
      getFile(app, "note.md"),
    );
    expect(r.resolved).toBe(true);
  });

  test("heading matching is case-insensitive", () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {
      headings: [{ heading: "Heading", level: 2, line: 0 }],
    });
    const app = mockApp();
    const r = resolveLinkTarget(app, "#heading", getFile(app, "note.md"));
    expect(r.resolved).toBe(true);
  });

  test("a heading path (#Parent#Child) resolves against nested headings", () => {
    setMockFile("note.md", "");
    setMockMetadata("note.md", {
      headings: [
        { heading: "Parent", level: 1, line: 0 },
        { heading: "Child", level: 2, line: 1 },
      ],
    });
    const app = mockApp();
    const r = resolveLinkTarget(app, "#Parent#Child", getFile(app, "note.md"));
    expect(r.resolved).toBe(true);
  });
});
