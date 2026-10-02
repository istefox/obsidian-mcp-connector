import { beforeEach, describe, expect, test } from "bun:test";
import {
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";
import {
  updateCanvasNodeHandler,
  updateCanvasNodeSchema,
} from "./updateCanvasNode";

const CANVAS = {
  nodes: [
    {
      id: "t1",
      type: "text",
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      text: "hello",
      color: "2",
    },
    {
      id: "f1",
      type: "file",
      x: 500,
      y: 0,
      width: 400,
      height: 300,
      file: "notes/a.md",
      subpath: "#Intro",
    },
    {
      id: "l1",
      type: "link",
      x: 0,
      y: 300,
      width: 400,
      height: 200,
      url: "https://example.com",
    },
    {
      id: "g1",
      type: "group",
      x: -50,
      y: -50,
      width: 1000,
      height: 600,
      label: "Area",
    },
  ],
  edges: [
    {
      id: "e1",
      fromNode: "t1",
      toNode: "f1",
      fromSide: "right",
      toSide: "left",
    },
  ],
  extra: { keep: true },
};

beforeEach(() => {
  resetMockVault();
  setMockFile("b.canvas", JSON.stringify(CANVAS, null, 2));
  setMockFile("notes/a.md", "# Intro");
  setMockFile("notes/b.md", "# Other");
});

async function run(args: Record<string, unknown>) {
  const r = await updateCanvasNodeHandler({
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

describe("update_canvas_node", () => {
  test("schema: name, nullable subpath/label/color, positive size", () => {
    expect(updateCanvasNodeSchema.get("name").toString()).toContain(
      "update_canvas_node",
    );
    const a = updateCanvasNodeSchema.get("arguments");
    expect(
      a.assert({
        path: "b.canvas",
        nodeId: "t1",
        color: null,
        subpath: null,
        label: null,
      }),
    ).toBeTruthy();
    expect(() =>
      a.assert({ path: "b.canvas", nodeId: "t1", width: 0 }),
    ).toThrow();
  });

  test("text node: content, color removal, move and resize; everything else intact", async () => {
    const { r, data } = await run({
      path: "b.canvas",
      nodeId: "t1",
      text: "bye",
      color: null,
      x: 10,
      y: 20,
      width: 300,
      height: 100,
    });
    expect(r.isError).toBeUndefined();
    expect(data.node).toEqual({
      id: "t1",
      type: "text",
      x: 10,
      y: 20,
      width: 300,
      height: 100,
      text: "bye",
    });
    expect(data.changed).toEqual([
      "text",
      "color",
      "x",
      "y",
      "width",
      "height",
    ]);
    const after = await doc();
    expect(after.nodes[0]).toEqual(data.node);
    expect(after.nodes.slice(1)).toEqual(CANVAS.nodes.slice(1));
    expect(after.edges).toEqual(CANVAS.edges);
    expect(after.extra).toEqual({ keep: true });
  });

  test("file node: new embed must exist; subpath null removes it", async () => {
    const missing = await run({
      path: "b.canvas",
      nodeId: "f1",
      file: "notes/none.md",
    });
    expect(missing.data.errorCode).toBe("embed_target_not_found");
    const { data } = await run({
      path: "b.canvas",
      nodeId: "f1",
      file: "notes/b.md",
      subpath: null,
    });
    expect(data.node).toEqual({
      id: "f1",
      type: "file",
      x: 500,
      y: 0,
      width: 400,
      height: 300,
      file: "notes/b.md",
    });
  });

  test("link url, group label and preset color", async () => {
    expect(
      (
        await run({
          path: "b.canvas",
          nodeId: "l1",
          url: "https://obsidian.md",
        })
      ).data.node.url,
    ).toBe("https://obsidian.md");
    const g = (
      await run({ path: "b.canvas", nodeId: "g1", label: "Zone", color: "4" })
    ).data.node;
    expect(g.label).toBe("Zone");
    expect(g.color).toBe("4");
  });

  test("a content field of another type is refused and nothing is written", async () => {
    const { r, data } = await run({
      path: "b.canvas",
      nodeId: "t1",
      url: "https://x",
      x: 1,
    });
    expect(r.isError).toBe(true);
    expect(data.errorCode).toBe("invalid_params");
    expect(data.fields).toEqual(["url"]);
    expect(data.nodeType).toBe("text");
    expect(await doc()).toEqual(CANVAS);
  });

  test("nothing to change, unknown node, missing canvas, folder, malformed", async () => {
    expect((await run({ path: "b.canvas", nodeId: "t1" })).data.errorCode).toBe(
      "invalid_params",
    );
    expect(
      (await run({ path: "b.canvas", nodeId: "zz", x: 1 })).data.errorCode,
    ).toBe("node_not_found");
    expect(
      (await run({ path: "none.canvas", nodeId: "t1", x: 1 })).data.errorCode,
    ).toBe("canvas_not_found");
    setMockFolder("Dir");
    expect(
      (await run({ path: "Dir", nodeId: "t1", x: 1 })).data.errorCode,
    ).toBe("not_a_file");
    setMockFile("bad.canvas", "{ not json");
    expect(
      (await run({ path: "bad.canvas", nodeId: "t1", x: 1 })).data.errorCode,
    ).toBe("malformed_canvas");
  });
});
