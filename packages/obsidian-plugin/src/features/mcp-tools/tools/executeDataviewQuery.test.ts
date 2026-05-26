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

    test("extra Dataview fields (idMeaning) pass through unchanged", async () => {
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
      expect(body.idMeaning).toEqual({ type: "path" });
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
