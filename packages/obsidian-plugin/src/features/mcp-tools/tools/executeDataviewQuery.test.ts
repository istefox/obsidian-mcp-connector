import { beforeEach, describe, expect, test } from "bun:test";
import {
  getMockDataviewCalls,
  mockApp,
  resetMockVault,
  setMockDataviewQueryImpl,
  setMockDataviewState,
} from "$/test-setup";
import { executeDataviewQueryHandler } from "./executeDataviewQuery";

function parse(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("execute_dataview_query", () => {
  beforeEach(() => {
    resetMockVault();
  });

  describe("three-state plugin detection", () => {
    test("absent → errorCode dataview_not_installed (permanent)", async () => {
      // Default state is "absent" — no extra setup.
      const res = await executeDataviewQueryHandler({
        arguments: { query: 'TABLE FROM ""' },
        app: mockApp(),
      });
      expect(res.isError).toBe(true);
      const body = parse(res);
      expect(body.errorCode).toBe("dataview_not_installed");
      expect(body.query).toBe('TABLE FROM ""');
    });

    test("loaded but index not built → errorCode dataview_not_ready (transient)", async () => {
      setMockDataviewState("not_ready");
      const res = await executeDataviewQueryHandler({
        arguments: { query: 'TABLE FROM ""' },
        app: mockApp(),
      });
      expect(res.isError).toBe(true);
      const body = parse(res);
      expect(body.errorCode).toBe("dataview_not_ready");
      // Caller hint references the dataview:index-ready event so the agent
      // knows to retry rather than treat it as a permanent failure.
      expect(body.error.toLowerCase()).toContain("index");
    });

    test("ready + successful query → returns native typed result, no isError", async () => {
      setMockDataviewState("ready");
      setMockDataviewQueryImpl(() => ({
        successful: true,
        value: {
          type: "table",
          headers: ["file", "mtime"],
          values: [
            ["Notes/A.md", "2026-05-22"],
            ["Notes/B.md", "2026-05-20"],
          ],
        },
      }));
      const res = await executeDataviewQueryHandler({
        arguments: { query: 'TABLE file.mtime FROM "Notes"' },
        app: mockApp(),
      });
      expect(res.isError).toBeUndefined();
      const body = parse(res);
      expect(body.type).toBe("table");
      expect(body.headers).toEqual(["file", "mtime"]);
      expect(body.values).toHaveLength(2);
    });
  });

  describe("query result envelope unwrap", () => {
    test.each([
      [
        "list",
        { type: "list", values: ["Notes/A.md", "Notes/B.md"] },
        ["values"],
      ],
      [
        "task",
        { type: "task", values: [{ text: "todo", completed: false }] },
        ["values"],
      ],
      [
        "calendar",
        { type: "calendar", values: [{ date: "2026-05-22" }] },
        ["values"],
      ],
    ] as const)(
      "%s query type passes through verbatim",
      async (_label, value, expectedKeys) => {
        setMockDataviewState("ready");
        setMockDataviewQueryImpl(() => ({ successful: true, value }));
        const res = await executeDataviewQueryHandler({
          arguments: { query: "..." },
          app: mockApp(),
        });
        expect(res.isError).toBeUndefined();
        const body = parse(res);
        expect(body.type).toBe(value.type);
        for (const k of expectedKeys) expect(body[k]).toBeDefined();
      },
    );

    test("idMeaning is removed from TABLE-mode output (R-03, repairs the pre-ADR contract)", async () => {
      // Pre-ADR-0023 this field passed through unchanged; R-03 removes it
      // as part of the Dataview result-shape cleanup (Invariant 7 — the
      // old contract is updated, never silently skipped).
      setMockDataviewState("ready");
      setMockDataviewQueryImpl(() => ({
        successful: true,
        value: {
          type: "table",
          headers: ["file"],
          values: [],
          idMeaning: { type: "path" },
        },
      }));
      const res = await executeDataviewQueryHandler({
        arguments: { query: 'TABLE FROM ""' },
        app: mockApp(),
      });
      const body = parse(res);
      expect("idMeaning" in body).toBe(false);
    });
  });

  describe("Dataview Link flattening (R-03)", () => {
    // Dataview's real Link shape, per the SPEC's stated contract:
    // {path, embed, type, display} — not derived from an installed
    // Dataview type, since the plugin API is out-of-repo at runtime
    // (see the file-level comment on DataviewApi above).
    function makeLink(path: string) {
      return { path, embed: false, type: "file", display: null };
    }

    test("a top-level Link value flattens to its plain path string", async () => {
      setMockDataviewState("ready");
      setMockDataviewQueryImpl(() => ({
        successful: true,
        value: {
          type: "list",
          values: [makeLink("Notes/A.md")],
        },
      }));
      const res = await executeDataviewQueryHandler({
        arguments: { query: 'LIST FROM ""' },
        app: mockApp(),
      });
      expect(res.isError).toBeUndefined();
      const body = parse(res);
      expect(body.values).toEqual(["Notes/A.md"]);
    });

    test("a Link nested inside an array inside a TABLE cell also flattens (SPEC edge case)", async () => {
      // The explicit edge case the SPEC calls out: a top-level-only
      // transform passes a naive test and fails this one, because the
      // TABLE cell here is itself an array of Links, one level deeper
      // than the top-level case above.
      setMockDataviewState("ready");
      setMockDataviewQueryImpl(() => ({
        successful: true,
        value: {
          type: "table",
          headers: ["file", "outlinks"],
          values: [
            ["Notes/A.md", [makeLink("Notes/B.md"), makeLink("Notes/C.md")]],
          ],
        },
      }));
      const res = await executeDataviewQueryHandler({
        arguments: { query: 'TABLE file.outlinks FROM ""' },
        app: mockApp(),
      });
      expect(res.isError).toBeUndefined();
      const body = parse(res);
      expect(body.values).toEqual([
        ["Notes/A.md", ["Notes/B.md", "Notes/C.md"]],
      ]);
    });
  });

  describe("query failure (Dataview returns successful:false)", () => {
    test("errorCode dataview_query_failed surfaces Dataview's error verbatim", async () => {
      setMockDataviewState("ready");
      setMockDataviewQueryImpl(() => ({
        successful: false,
        error: "Failed to parse query: expected FROM after TABLE",
      }));
      const res = await executeDataviewQueryHandler({
        arguments: { query: "TABLE" },
        app: mockApp(),
      });
      expect(res.isError).toBe(true);
      const body = parse(res);
      expect(body.errorCode).toBe("dataview_query_failed");
      expect(body.error).toBe(
        "Failed to parse query: expected FROM after TABLE",
      );
      expect(body.query).toBe("TABLE");
    });

    test("api.query() throws → structured dataview_query_failed (not unhandled rejection)", async () => {
      setMockDataviewState("ready");
      setMockDataviewQueryImpl(() => {
        throw new Error("Dataview internal error: index corrupted");
      });
      const res = await executeDataviewQueryHandler({
        arguments: { query: 'TABLE FROM ""' },
        app: mockApp(),
      });
      expect(res.isError).toBe(true);
      const body = parse(res);
      expect(body.errorCode).toBe("dataview_query_failed");
      expect(body.error).toContain("index corrupted");
    });

    test("non-serialisable result (circular ref) → structured dataview_query_failed", async () => {
      setMockDataviewState("ready");
      const circular: Record<string, unknown> = { type: "table" };
      circular["self"] = circular;
      setMockDataviewQueryImpl(() => ({ successful: true, value: circular }));
      const res = await executeDataviewQueryHandler({
        arguments: { query: 'TABLE FROM ""' },
        app: mockApp(),
      });
      expect(res.isError).toBe(true);
      const body = parse(res);
      expect(body.errorCode).toBe("dataview_query_failed");
      expect(body.error).toMatch(/non-serialisable/i);
    });

    test("error field coerced via String() when Dataview returns Error object", async () => {
      setMockDataviewState("ready");
      setMockDataviewQueryImpl(() => ({
        successful: false,
        error: new Error("Error object from Dataview") as unknown as string,
      }));
      const res = await executeDataviewQueryHandler({
        arguments: { query: "TABLE" },
        app: mockApp(),
      });
      expect(res.isError).toBe(true);
      const body = parse(res);
      expect(body.errorCode).toBe("dataview_query_failed");
      expect(body.error).toContain("Error object from Dataview");
    });
  });

  describe("sourcePath flows through to Dataview's originFile", () => {
    test("when sourcePath provided, originFile arg matches", async () => {
      setMockDataviewState("ready");
      const res = await executeDataviewQueryHandler({
        arguments: {
          query: "LIST FROM [[#]]",
          sourcePath: "Projects/Roadmap.md",
        },
        app: mockApp(),
      });
      expect(res.isError).toBeUndefined();
      const calls = getMockDataviewCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].source).toBe("LIST FROM [[#]]");
      expect(calls[0].originFile).toBe("Projects/Roadmap.md");
    });

    test("when sourcePath omitted, originFile is undefined (not coerced)", async () => {
      setMockDataviewState("ready");
      await executeDataviewQueryHandler({
        arguments: { query: "LIST" },
        app: mockApp(),
      });
      const calls = getMockDataviewCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].originFile).toBeUndefined();
    });
  });
});
