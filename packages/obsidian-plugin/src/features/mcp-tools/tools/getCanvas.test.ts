import { describe, expect, test, beforeEach } from "bun:test";
import { getCanvasHandler, getCanvasSchema } from "./getCanvas";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";

beforeEach(() => resetMockVault());

describe("get_canvas tool", () => {
  test("schema declares the tool name", () => {
    expect(getCanvasSchema.get("name")?.toString()).toContain("get_canvas");
  });

  test("returns structured result for an empty canvas", async () => {
    const raw = JSON.stringify({ nodes: [], edges: [] });
    setMockFile("boards/empty.canvas", raw);
    const r = await getCanvasHandler({
      arguments: { path: "boards/empty.canvas" },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const data = JSON.parse(r.content[0].text as string);
    expect(data.path).toBe("boards/empty.canvas");
    expect(data.nodeCount).toBe(0);
    expect(data.edgeCount).toBe(0);
    expect(data.nodes).toEqual([]);
    expect(data.edges).toEqual([]);
  });

  test("returns structured nodes and edges for a canvas with content", async () => {
    const canvas = {
      nodes: [
        {
          id: "a1b2c3d4e5f6a1b2",
          type: "text",
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          text: "hello",
        },
      ],
      edges: [
        {
          id: "0011223344556677",
          fromNode: "a1b2c3d4e5f6a1b2",
          toNode: "a1b2c3d4e5f6a1b2",
        },
      ],
    };
    setMockFile("boards/work.canvas", JSON.stringify(canvas));
    const r = await getCanvasHandler({
      arguments: { path: "boards/work.canvas" },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const data = JSON.parse(r.content[0].text as string);
    expect(data.nodeCount).toBe(1);
    expect(data.edgeCount).toBe(1);
    expect(data.nodes[0].id).toBe("a1b2c3d4e5f6a1b2");
    expect(data.nodes[0].text).toBe("hello");
    expect(data.edges[0].fromNode).toBe("a1b2c3d4e5f6a1b2");
  });

  test("unknown field on a node is present in the response (round-trip fidelity)", async () => {
    const canvas = {
      nodes: [
        {
          id: "aabbccdd11223344",
          type: "text",
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          text: "hi",
          color: "5",
          customExtension: "preserved",
        },
      ],
      edges: [],
    };
    setMockFile("boards/custom.canvas", JSON.stringify(canvas));
    const r = await getCanvasHandler({
      arguments: { path: "boards/custom.canvas" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.nodes[0].color).toBe("5");
    expect(data.nodes[0].customExtension).toBe("preserved");
  });

  test("long text node content is truncated and textTruncated flag is set", async () => {
    const longText = "x".repeat(600);
    const canvas = {
      nodes: [
        {
          id: "1234567890abcdef",
          type: "text",
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          text: longText,
        },
      ],
      edges: [],
    };
    setMockFile("boards/long.canvas", JSON.stringify(canvas));
    const app = mockApp();
    const r = await getCanvasHandler({
      arguments: { path: "boards/long.canvas" },
      app,
    });
    const data = JSON.parse(r.content[0].text as string);
    const node = data.nodes[0];
    expect(node.text.length).toBe(500);
    expect(node.textTruncated).toBe(true);
  });

  test("file on disk is unchanged after truncation (read-only)", async () => {
    const longText = "y".repeat(600);
    const canvas = {
      nodes: [
        {
          id: "fedcba0987654321",
          type: "text",
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          text: longText,
        },
      ],
      edges: [],
    };
    const originalContent = JSON.stringify(canvas);
    setMockFile("boards/ro.canvas", originalContent);
    const app = mockApp();
    await getCanvasHandler({
      arguments: { path: "boards/ro.canvas" },
      app,
    });
    // Verify the vault content is still the original serialization
    const file = app.vault.getAbstractFileByPath("boards/ro.canvas");
    if (!file) throw new Error("expected file");
    const diskContent = await app.vault.read(file as never);
    expect(diskContent).toBe(originalContent);
  });

  test("returns isError with canvas_not_found for a missing path", async () => {
    const r = await getCanvasHandler({
      arguments: { path: "missing.canvas" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("canvas_not_found");
  });

  test("returns isError with not_a_file when path is a folder", async () => {
    setMockFolder("boards");
    const r = await getCanvasHandler({
      arguments: { path: "boards" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("not_a_file");
  });

  test("returns isError with malformed_canvas for invalid JSON", async () => {
    setMockFile("boards/bad.canvas", "{ not valid json }");
    const r = await getCanvasHandler({
      arguments: { path: "boards/bad.canvas" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("malformed_canvas");
  });
});
