import { describe, expect, test, beforeEach } from "bun:test";
import { addCanvasNodeHandler, addCanvasNodeSchema } from "./addCanvasNode";
import {
  getMockFolders,
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";
import { serializeCanvas, buildEmptyCanvas } from "../services/canvasDocument";

beforeEach(() => resetMockVault());

describe("add_canvas_node tool", () => {
  test("schema declares the tool name", () => {
    expect(addCanvasNodeSchema.get("name")?.toString()).toContain(
      "add_canvas_node",
    );
  });

  test("adds a text node to an existing canvas; returns id, coords, created:false", async () => {
    const canvas = serializeCanvas(buildEmptyCanvas());
    setMockFile("boards/work.canvas", canvas);
    const r = await addCanvasNodeHandler({
      arguments: { path: "boards/work.canvas", type: "text", text: "hello" },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const data = JSON.parse(r.content[0].text as string);
    expect(typeof data.id).toBe("string");
    expect(data.id).toHaveLength(16);
    expect(typeof data.x).toBe("number");
    expect(typeof data.y).toBe("number");
    expect(typeof data.width).toBe("number");
    expect(typeof data.height).toBe("number");
    expect(data.created).toBe(false);
  });

  test("auto-places a second node to the right of the first", async () => {
    const canvas = {
      nodes: [
        {
          id: "aaaa000000000001",
          type: "text",
          x: 0,
          y: 0,
          width: 400,
          height: 200,
        },
      ],
      edges: [],
    };
    setMockFile("boards/auto.canvas", JSON.stringify(canvas, null, 2));
    const app = mockApp();
    const r = await addCanvasNodeHandler({
      arguments: { path: "boards/auto.canvas", type: "text", text: "second" },
      app,
    });
    const data = JSON.parse(r.content[0].text as string);
    // Should be placed to the right: x = 0 + 400 + 32 = 432
    expect(data.x).toBe(432);
    expect(data.y).toBe(0);
  });

  test("explicit x/y are used verbatim", async () => {
    const canvas = serializeCanvas(buildEmptyCanvas());
    setMockFile("boards/explicit.canvas", canvas);
    const r = await addCanvasNodeHandler({
      arguments: {
        path: "boards/explicit.canvas",
        type: "text",
        text: "hi",
        x: 100,
        y: 200,
      },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.x).toBe(100);
    expect(data.y).toBe(200);
  });

  test("adds a file node when the embed target exists", async () => {
    setMockFile("boards/board.canvas", serializeCanvas(buildEmptyCanvas()));
    setMockFile("Notes/ref.md", "# Reference");
    const r = await addCanvasNodeHandler({
      arguments: {
        path: "boards/board.canvas",
        type: "file",
        file: "Notes/ref.md",
      },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const data = JSON.parse(r.content[0].text as string);
    expect(typeof data.id).toBe("string");
    expect(data.created).toBe(false);
  });

  test("returns embed_target_not_found when file target does not exist", async () => {
    setMockFile("boards/board.canvas", serializeCanvas(buildEmptyCanvas()));
    const r = await addCanvasNodeHandler({
      arguments: {
        path: "boards/board.canvas",
        type: "file",
        file: "Notes/missing.md",
      },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("embed_target_not_found");
  });

  test("adds a link node", async () => {
    setMockFile("boards/board.canvas", serializeCanvas(buildEmptyCanvas()));
    const r = await addCanvasNodeHandler({
      arguments: {
        path: "boards/board.canvas",
        type: "link",
        url: "https://example.com",
      },
      app: mockApp(),
    });
    expect(r.isError).toBeUndefined();
    const data = JSON.parse(r.content[0].text as string);
    expect(typeof data.id).toBe("string");
  });

  test("returns missing_argument when type is link but url is omitted", async () => {
    setMockFile("boards/board.canvas", serializeCanvas(buildEmptyCanvas()));
    const r = await addCanvasNodeHandler({
      arguments: {
        path: "boards/board.canvas",
        type: "link",
      },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("missing_argument");
  });

  test("returns missing_argument when type is file but file is omitted", async () => {
    setMockFile("boards/board.canvas", serializeCanvas(buildEmptyCanvas()));
    const r = await addCanvasNodeHandler({
      arguments: {
        path: "boards/board.canvas",
        type: "file",
      },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("missing_argument");
  });

  test("creates the canvas file when the path is missing; response has created:true", async () => {
    const app = mockApp();
    const r = await addCanvasNodeHandler({
      arguments: {
        path: "boards/new.canvas",
        type: "text",
        text: "first node",
      },
      app,
    });
    expect(r.isError).toBeUndefined();
    const data = JSON.parse(r.content[0].text as string);
    expect(data.created).toBe(true);
    // The file must now exist in the vault
    const file = app.vault.getAbstractFileByPath("boards/new.canvas");
    expect(file).not.toBeNull();
  });

  test("creates parent folders when canvas path is nested and missing", async () => {
    const app = mockApp();
    await addCanvasNodeHandler({
      arguments: { path: "deep/nested/board.canvas", type: "text", text: "x" },
      app,
    });
    const folders = getMockFolders();
    expect(folders).toContain("deep");
    expect(folders).toContain("deep/nested");
  });

  test("preserves unknown fields on existing nodes after write", async () => {
    const canvas = {
      nodes: [
        {
          id: "bbbb000000000001",
          type: "text",
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          text: "existing",
          customExtension: "preserved",
        },
      ],
      edges: [],
    };
    setMockFile("boards/custom.canvas", JSON.stringify(canvas, null, 2));
    const app = mockApp();
    await addCanvasNodeHandler({
      arguments: {
        path: "boards/custom.canvas",
        type: "text",
        text: "new node",
      },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/custom.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.nodes[0].customExtension).toBe("preserved");
  });

  test("written canvas is pretty-printed with 2-space indent", async () => {
    setMockFile("boards/pretty.canvas", serializeCanvas(buildEmptyCanvas()));
    const app = mockApp();
    await addCanvasNodeHandler({
      arguments: { path: "boards/pretty.canvas", type: "text", text: "hi" },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/pretty.canvas") as never,
    );
    // A pretty-printed JSON has lines starting with spaces
    expect(written).toMatch(/^\{/);
    expect(written).toMatch(/\n  /);
  });

  test("returns not_a_file when path is a folder", async () => {
    setMockFolder("boards");
    const r = await addCanvasNodeHandler({
      arguments: { path: "boards", type: "text", text: "x" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("not_a_file");
  });

  test("returns malformed_canvas when canvas JSON is invalid", async () => {
    setMockFile("boards/bad.canvas", "{ not valid json }");
    const r = await addCanvasNodeHandler({
      arguments: { path: "boards/bad.canvas", type: "text", text: "x" },
      app: mockApp(),
    });
    expect(r.isError).toBe(true);
    const data = JSON.parse(r.content[0].text as string);
    expect(data.errorCode).toBe("malformed_canvas");
  });

  test("optional color field is written onto the new node", async () => {
    setMockFile("boards/colored.canvas", serializeCanvas(buildEmptyCanvas()));
    const app = mockApp();
    await addCanvasNodeHandler({
      arguments: {
        path: "boards/colored.canvas",
        type: "text",
        text: "node",
        color: "5",
      },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/colored.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.nodes[0].color).toBe("5");
  });

  test("node is written with correct type-specific fields for text", async () => {
    setMockFile("boards/types.canvas", serializeCanvas(buildEmptyCanvas()));
    const app = mockApp();
    await addCanvasNodeHandler({
      arguments: { path: "boards/types.canvas", type: "text", text: "content" },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/types.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.nodes[0].type).toBe("text");
    expect(parsed.nodes[0].text).toBe("content");
  });

  test("node is written with correct type-specific fields for file with subpath", async () => {
    setMockFile("boards/file.canvas", serializeCanvas(buildEmptyCanvas()));
    setMockFile("Notes/ref.md", "# Ref");
    const app = mockApp();
    await addCanvasNodeHandler({
      arguments: {
        path: "boards/file.canvas",
        type: "file",
        file: "Notes/ref.md",
        subpath: "#heading",
      },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/file.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.nodes[0].type).toBe("file");
    expect(parsed.nodes[0].file).toBe("Notes/ref.md");
    expect(parsed.nodes[0].subpath).toBe("#heading");
  });

  test("node is written with correct type-specific fields for link", async () => {
    setMockFile("boards/link.canvas", serializeCanvas(buildEmptyCanvas()));
    const app = mockApp();
    await addCanvasNodeHandler({
      arguments: {
        path: "boards/link.canvas",
        type: "link",
        url: "https://example.com",
      },
      app,
    });
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/link.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.nodes[0].type).toBe("link");
    expect(parsed.nodes[0].url).toBe("https://example.com");
  });

  test("returns an error when type is link but url is absent; canvas is not written", async () => {
    setMockFile("boards/board.canvas", serializeCanvas(buildEmptyCanvas()));
    const app = mockApp();
    const r = await addCanvasNodeHandler({
      arguments: { path: "boards/board.canvas", type: "link" },
      app,
    });
    expect(r.isError).toBe(true);
    const written = await app.vault.read(
      app.vault.getAbstractFileByPath("boards/board.canvas") as never,
    );
    const parsed = JSON.parse(written);
    expect(parsed.nodes).toHaveLength(0);
  });

  test("explicit width/height override defaults", async () => {
    setMockFile("boards/sizing.canvas", serializeCanvas(buildEmptyCanvas()));
    const r = await addCanvasNodeHandler({
      arguments: {
        path: "boards/sizing.canvas",
        type: "text",
        text: "x",
        width: 800,
        height: 400,
      },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.width).toBe(800);
    expect(data.height).toBe(400);
  });
});
