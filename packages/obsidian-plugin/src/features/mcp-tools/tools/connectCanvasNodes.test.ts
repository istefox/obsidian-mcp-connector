import { describe, expect, test, beforeEach } from "bun:test";
import {
  connectCanvasNodesHandler,
  connectCanvasNodesSchema,
} from "./connectCanvasNodes";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";
import { serializeCanvas } from "../services/canvasDocument";

const CANVAS_WITH_TWO_NODES = {
  nodes: [
    {
      id: "aaaa000000000001",
      type: "text",
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      text: "node A",
    },
    {
      id: "bbbb000000000002",
      type: "text",
      x: 432,
      y: 0,
      width: 400,
      height: 200,
      text: "node B",
    },
  ],
  edges: [],
};

beforeEach(() => resetMockVault());

describe("connect_canvas_nodes tool", () => {
  test("schema declares the tool name", () => {
    expect(connectCanvasNodesSchema.get("name")?.toString()).toContain(
      "connect_canvas_nodes",
    );
  });

  test("adds an edge between two existing nodes; returns { id }", async () => {
    setMockFile(
      "boards/work.canvas",
      JSON.stringify(CANVAS_WITH_TWO_NODES, null, 2),
    );
    const r = await connectCanvasNodesHandler({
      arguments: {
        path: "boards/work.canvas",
        fromNode: "aaaa000000000001",
        toNode: "bbbb000000000002",
      },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const data = JSON.parse(r.content[0].text as string);
    expect(typeof data.id).toBe("string");
    expect(data.id).toHaveLength(16);
  });

  test("default sides are right and left when omitted", async () => {
    const app = mockApp();
    setMockFile(
      "boards/work.canvas",
      JSON.stringify(CANVAS_WITH_TWO_NODES, null, 2),
    );
    await connectCanvasNodesHandler({
      arguments: {
        path: "boards/work.canvas",
        fromNode: "aaaa000000000001",
        toNode: "bbbb000000000002",
      },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/work.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.edges[0].fromSide).toBe("right");
    expect(parsed.edges[0].toSide).toBe("left");
  });

  test("explicit fromSide/toSide override defaults", async () => {
    const app = mockApp();
    setMockFile(
      "boards/work.canvas",
      JSON.stringify(CANVAS_WITH_TWO_NODES, null, 2),
    );
    await connectCanvasNodesHandler({
      arguments: {
        path: "boards/work.canvas",
        fromNode: "aaaa000000000001",
        toNode: "bbbb000000000002",
        fromSide: "top",
        toSide: "bottom",
      },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/work.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.edges[0].fromSide).toBe("top");
    expect(parsed.edges[0].toSide).toBe("bottom");
  });

  test("label and color are written onto the edge when provided", async () => {
    const app = mockApp();
    setMockFile(
      "boards/work.canvas",
      JSON.stringify(CANVAS_WITH_TWO_NODES, null, 2),
    );
    await connectCanvasNodesHandler({
      arguments: {
        path: "boards/work.canvas",
        fromNode: "aaaa000000000001",
        toNode: "bbbb000000000002",
        label: "my edge",
        color: "1",
      },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/work.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.edges[0].label).toBe("my edge");
    expect(parsed.edges[0].color).toBe("1");
  });

  test("returns node_not_found with nodeId when fromNode id is absent", async () => {
    setMockFile(
      "boards/work.canvas",
      JSON.stringify(CANVAS_WITH_TWO_NODES, null, 2),
    );
    const r = await connectCanvasNodesHandler({
      arguments: {
        path: "boards/work.canvas",
        fromNode: "doesnotexist0000",
        toNode: "bbbb000000000002",
      },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("node_not_found");
    expect(data.nodeId).toBe("doesnotexist0000");
  });

  test("returns node_not_found with nodeId when toNode id is absent", async () => {
    setMockFile(
      "boards/work.canvas",
      JSON.stringify(CANVAS_WITH_TWO_NODES, null, 2),
    );
    const r = await connectCanvasNodesHandler({
      arguments: {
        path: "boards/work.canvas",
        fromNode: "aaaa000000000001",
        toNode: "doesnotexist0000",
      },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("node_not_found");
    expect(data.nodeId).toBe("doesnotexist0000");
  });

  test("returns canvas_not_found when the canvas file does not exist", async () => {
    const r = await connectCanvasNodesHandler({
      arguments: {
        path: "boards/missing.canvas",
        fromNode: "aaaa000000000001",
        toNode: "bbbb000000000002",
      },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("canvas_not_found");
  });

  test("returns not_a_file when path is a folder", async () => {
    setMockFolder("boards");
    const r = await connectCanvasNodesHandler({
      arguments: {
        path: "boards",
        fromNode: "aaaa000000000001",
        toNode: "bbbb000000000002",
      },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("not_a_file");
  });

  test("returns malformed_canvas on invalid JSON", async () => {
    setMockFile("boards/bad.canvas", "{ not valid json }");
    const r = await connectCanvasNodesHandler({
      arguments: {
        path: "boards/bad.canvas",
        fromNode: "aaaa000000000001",
        toNode: "bbbb000000000002",
      },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("malformed_canvas");
  });

  test("edge is written with correct fromNode and toNode ids", async () => {
    const app = mockApp();
    setMockFile(
      "boards/work.canvas",
      JSON.stringify(CANVAS_WITH_TWO_NODES, null, 2),
    );
    await connectCanvasNodesHandler({
      arguments: {
        path: "boards/work.canvas",
        fromNode: "aaaa000000000001",
        toNode: "bbbb000000000002",
      },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/work.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.edges[0].fromNode).toBe("aaaa000000000001");
    expect(parsed.edges[0].toNode).toBe("bbbb000000000002");
  });

  test("written canvas is pretty-printed with 2-space indent", async () => {
    const app = mockApp();
    setMockFile(
      "boards/pretty.canvas",
      serializeCanvas({
        nodes: [
          {
            id: "aaaa000000000001",
            type: "text",
            x: 0,
            y: 0,
            width: 400,
            height: 200,
            text: "A",
          },
          {
            id: "bbbb000000000002",
            type: "text",
            x: 432,
            y: 0,
            width: 400,
            height: 200,
            text: "B",
          },
        ],
        edges: [],
      }),
    );
    await connectCanvasNodesHandler({
      arguments: {
        path: "boards/pretty.canvas",
        fromNode: "aaaa000000000001",
        toNode: "bbbb000000000002",
      },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/pretty.canvas") as never,
    );
    expect(written).toMatch(/^\{/);
    expect(written).toMatch(/\n  /);
  });

  test("existing edges are preserved after adding a new edge", async () => {
    const canvasWithEdge = {
      nodes: [
        {
          id: "aaaa000000000001",
          type: "text",
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          text: "A",
        },
        {
          id: "bbbb000000000002",
          type: "text",
          x: 432,
          y: 0,
          width: 400,
          height: 200,
          text: "B",
        },
        {
          id: "cccc000000000003",
          type: "text",
          x: 864,
          y: 0,
          width: 400,
          height: 200,
          text: "C",
        },
      ],
      edges: [
        {
          id: "eeee000000000001",
          fromNode: "aaaa000000000001",
          toNode: "bbbb000000000002",
          fromSide: "right",
          toSide: "left",
        },
      ],
    };
    const app = mockApp();
    setMockFile("boards/multi.canvas", JSON.stringify(canvasWithEdge, null, 2));
    await connectCanvasNodesHandler({
      arguments: {
        path: "boards/multi.canvas",
        fromNode: "bbbb000000000002",
        toNode: "cccc000000000003",
      },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/multi.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.edges).toHaveLength(2);
    expect(parsed.edges[0].id).toBe("eeee000000000001");
    expect(parsed.edges[1].fromNode).toBe("bbbb000000000002");
    expect(parsed.edges[1].toNode).toBe("cccc000000000003");
  });
});
