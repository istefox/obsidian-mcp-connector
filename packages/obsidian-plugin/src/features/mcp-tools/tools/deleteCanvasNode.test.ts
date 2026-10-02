import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";
import {
  deleteCanvasNodeHandler,
  deleteCanvasNodeSchema,
} from "./deleteCanvasNode";

const CANVAS = {
  nodes: [
    { id: "a", type: "text", x: 0, y: 0, width: 400, height: 200, text: "A" },
    { id: "b", type: "text", x: 500, y: 0, width: 400, height: 200, text: "B" },
    {
      id: "c",
      type: "text",
      x: 1000,
      y: 0,
      width: 400,
      height: 200,
      text: "C",
    },
  ],
  edges: [
    { id: "ab", fromNode: "a", toNode: "b" },
    { id: "bc", fromNode: "b", toNode: "c" },
    { id: "ca", fromNode: "c", toNode: "a" },
  ],
  meta: 1,
};

beforeEach(() => {
  resetMockVault();
  setMockFile("b.canvas", JSON.stringify(CANVAS, null, 2));
});

async function run(args: Record<string, unknown>) {
  const r = await deleteCanvasNodeHandler({
    arguments: args as never,
    app: mockApp(),
  });
  return { r, data: JSON.parse(r.content[0].text) };
}
async function doc() {
  const app = mockApp();
  return JSON.parse(
    await app.vault.read(app.vault.getAbstractFileByPath("b.canvas") as never),
  );
}

describe("delete_canvas_node", () => {
  test("schema declares the tool name", () => {
    expect(deleteCanvasNodeSchema.get("name").toString()).toContain(
      "delete_canvas_node",
    );
  });

  test("removes the node and every edge touching it, keeps the rest", async () => {
    const { r, data } = await run({ path: "b.canvas", nodeId: "b" });
    expect(r.isError).toBeUndefined();
    expect(data.removed).toEqual(CANVAS.nodes[1]);
    expect(data.removedEdges).toEqual(["ab", "bc"]);
    const after = await doc();
    expect(after.nodes.map((n: { id: string }) => n.id)).toEqual(["a", "c"]);
    expect(after.edges).toEqual([{ id: "ca", fromNode: "c", toNode: "a" }]);
    expect(after.meta).toBe(1);
  });

  test("a node without edges reports an empty edge list", async () => {
    setMockFile(
      "solo.canvas",
      JSON.stringify({
        nodes: [
          { id: "x", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" },
        ],
        edges: [],
      }),
    );
    const { data } = await run({ path: "solo.canvas", nodeId: "x" });
    expect(data.removedEdges).toEqual([]);
  });

  test("unknown node, missing canvas, folder, malformed; nothing written", async () => {
    expect((await run({ path: "b.canvas", nodeId: "zz" })).data.errorCode).toBe(
      "node_not_found",
    );
    expect(
      (await run({ path: "none.canvas", nodeId: "a" })).data.errorCode,
    ).toBe("canvas_not_found");
    setMockFolder("Dir");
    expect((await run({ path: "Dir", nodeId: "a" })).data.errorCode).toBe(
      "not_a_file",
    );
    setMockFile("bad.canvas", "[]");
    expect(
      (await run({ path: "bad.canvas", nodeId: "a" })).data.errorCode,
    ).toBe("malformed_canvas");
    expect(await doc()).toEqual(CANVAS);
  });
});
