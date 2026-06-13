import { describe, expect, test } from "bun:test";
import {
  parseCanvas,
  buildEmptyCanvas,
  serializeCanvas,
  generateNodeId,
  computePlacement,
  CANVAS_ROW_WRAP_WIDTH,
  CANVAS_GAP,
  NODE_DEFAULT_SIZES,
} from "./canvasDocument";
import type { CanvasNode } from "./canvasDocument";

describe("parseCanvas", () => {
  test("returns null on empty string", () => {
    expect(parseCanvas("")).toBeNull();
  });

  test("returns null on non-JSON", () => {
    expect(parseCanvas("not json at all")).toBeNull();
  });

  test("returns null on {} (missing nodes/edges)", () => {
    expect(parseCanvas("{}")).toBeNull();
  });

  test("returns null when nodes is missing but edges present", () => {
    expect(parseCanvas(JSON.stringify({ edges: [] }))).toBeNull();
  });

  test("returns null when edges is missing but nodes present", () => {
    expect(parseCanvas(JSON.stringify({ nodes: [] }))).toBeNull();
  });

  test("returns null when nodes is not an array", () => {
    expect(parseCanvas(JSON.stringify({ nodes: null, edges: [] }))).toBeNull();
  });

  test("returns null when edges is not an array", () => {
    expect(parseCanvas(JSON.stringify({ nodes: [], edges: null }))).toBeNull();
  });

  test("returns the document on { nodes: [], edges: [] }", () => {
    const raw = JSON.stringify({ nodes: [], edges: [] });
    const doc = parseCanvas(raw);
    expect(doc).not.toBeNull();
    expect(doc!.nodes).toEqual([]);
    expect(doc!.edges).toEqual([]);
  });

  test("preserves unknown field color on a node verbatim", () => {
    const raw = JSON.stringify({
      nodes: [
        {
          id: "abc1",
          type: "text",
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          text: "hello",
          color: "1",
        },
      ],
      edges: [],
    });
    const doc = parseCanvas(raw);
    expect(doc).not.toBeNull();
    const node = doc!.nodes[0] as Record<string, unknown>;
    expect(node["color"]).toBe("1");
  });

  test("preserves extra top-level fields", () => {
    const raw = JSON.stringify({ nodes: [], edges: [], version: "1.0" });
    const doc = parseCanvas(raw);
    expect(doc).not.toBeNull();
    expect((doc as Record<string, unknown>)["version"]).toBe("1.0");
  });
});

describe("buildEmptyCanvas", () => {
  test("returns { nodes: [], edges: [] }", () => {
    expect(buildEmptyCanvas()).toEqual({ nodes: [], edges: [] });
  });

  test("returns a fresh object on each call", () => {
    const a = buildEmptyCanvas();
    const b = buildEmptyCanvas();
    a.nodes.push({
      id: "x",
      type: "text",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(b.nodes).toHaveLength(0);
  });
});

describe("serializeCanvas", () => {
  test("uses 2-space indent", () => {
    const doc = buildEmptyCanvas();
    const out = serializeCanvas(doc);
    expect(out).toBe(JSON.stringify(doc, null, 2));
  });

  test("round-trips a well-formed canvas", () => {
    const raw =
      JSON.stringify({ nodes: [], edges: [], version: "1.0" }, null, 2) + "\n";
    // Obsidian may or may not write trailing newline; normalize for comparison
    const doc = parseCanvas(raw.trim());
    expect(doc).not.toBeNull();
    expect(serializeCanvas(doc!)).toBe(
      JSON.stringify(JSON.parse(raw), null, 2),
    );
  });

  test("serializeCanvas(parseCanvas(raw)) equals re-stringified raw", () => {
    const original = {
      nodes: [
        {
          id: "n1",
          type: "text",
          x: 0,
          y: 0,
          width: 400,
          height: 200,
          text: "hi",
        },
      ],
      edges: [{ id: "e1", fromNode: "n1", toNode: "n1" }],
    };
    const raw = JSON.stringify(original, null, 2);
    const doc = parseCanvas(raw);
    expect(doc).not.toBeNull();
    expect(serializeCanvas(doc!)).toBe(raw);
  });
});

describe("generateNodeId", () => {
  test("returns a 16-char lowercase hex string", () => {
    const id = generateNodeId([]);
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("retries when first candidate is in existing list", () => {
    // Supply a custom generator that returns a known collision on the first
    // call and a fresh id on the second, verifying the retry path.
    const collision = "aaaaaaaaaaaaaaaa";
    let callCount = 0;
    const gen = () => {
      callCount++;
      return callCount === 1 ? collision : "bbbbbbbbbbbbbbbb";
    };
    const id = generateNodeId([collision], gen);
    expect(id).toBe("bbbbbbbbbbbbbbbb");
    expect(callCount).toBe(2);
  });

  test("does not collide with existing ids", () => {
    const existing: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = generateNodeId(existing);
      expect(existing).not.toContain(id);
      existing.push(id);
    }
  });
});

describe("computePlacement", () => {
  const W = NODE_DEFAULT_SIZES.text.width;
  const H = NODE_DEFAULT_SIZES.text.height;

  test("empty nodes returns { x: 0, y: 0, width, height }", () => {
    const rect = computePlacement([], { width: W, height: H });
    expect(rect).toEqual({ x: 0, y: 0, width: W, height: H });
  });

  test("places second node to the right of the first with CANVAS_GAP gap", () => {
    const first: CanvasNode = {
      id: "n1",
      type: "text",
      x: 0,
      y: 0,
      width: W,
      height: H,
    };
    const rect = computePlacement([first], { width: W, height: H });
    expect(rect.x).toBe(W + CANVAS_GAP);
    expect(rect.y).toBe(0);
    expect(rect.width).toBe(W);
    expect(rect.height).toBe(H);
  });

  test("wraps to a new row when right edge would exceed CANVAS_ROW_WRAP_WIDTH", () => {
    // Fill up the row with nodes so the next one must wrap.
    const nodes: CanvasNode[] = [];
    let x = 0;
    while (x + W + CANVAS_GAP <= CANVAS_ROW_WRAP_WIDTH) {
      nodes.push({
        id: `n${nodes.length}`,
        type: "text",
        x,
        y: 0,
        width: W,
        height: H,
      });
      x += W + CANVAS_GAP;
    }
    // The last node's right edge is x (x was incremented past the wrap limit).
    // Now adding one more should wrap.
    const rect = computePlacement(nodes, { width: W, height: H });
    // Wrapped: x should reset to 0, y should be at H + CANVAS_GAP
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(H + CANVAS_GAP);
  });

  test("returns explicit x/y verbatim when supplied", () => {
    const first: CanvasNode = {
      id: "n1",
      type: "text",
      x: 0,
      y: 0,
      width: W,
      height: H,
    };
    const rect = computePlacement([first], {
      width: W,
      height: H,
      explicitX: 999,
      explicitY: 777,
    });
    expect(rect.x).toBe(999);
    expect(rect.y).toBe(777);
    expect(rect.width).toBe(W);
    expect(rect.height).toBe(H);
  });

  test("explicit x/y with no existing nodes", () => {
    const rect = computePlacement([], {
      width: 200,
      height: 100,
      explicitX: 50,
      explicitY: 60,
    });
    expect(rect).toEqual({ x: 50, y: 60, width: 200, height: 100 });
  });

  test("honors explicit x alone, auto-placing y", () => {
    const first: CanvasNode = {
      id: "n1",
      type: "text",
      x: 0,
      y: 0,
      width: W,
      height: H,
    };
    const rect = computePlacement([first], {
      width: W,
      height: H,
      explicitX: 1234,
    });
    expect(rect.x).toBe(1234);
    expect(rect.y).toBe(0);
  });

  test("honors explicit y alone, auto-placing x", () => {
    const first: CanvasNode = {
      id: "n1",
      type: "text",
      x: 0,
      y: 0,
      width: W,
      height: H,
    };
    const rect = computePlacement([first], {
      width: W,
      height: H,
      explicitY: 555,
    });
    expect(rect.x).toBe(W + CANVAS_GAP);
    expect(rect.y).toBe(555);
  });

  test("non-wrapping placement uses the top edge of existing nodes, not y=0", () => {
    const first: CanvasNode = {
      id: "n1",
      type: "text",
      x: 0,
      y: 500,
      width: W,
      height: H,
    };
    const rect = computePlacement([first], { width: W, height: H });
    expect(rect.x).toBe(W + CANVAS_GAP);
    expect(rect.y).toBe(500);
  });
});

describe("constants", () => {
  test("CANVAS_ROW_WRAP_WIDTH is 3200", () => {
    expect(CANVAS_ROW_WRAP_WIDTH).toBe(3200);
  });

  test("CANVAS_GAP is 32", () => {
    expect(CANVAS_GAP).toBe(32);
  });

  test("NODE_DEFAULT_SIZES has text, file, link entries", () => {
    expect(NODE_DEFAULT_SIZES.text).toEqual({ width: 400, height: 200 });
    expect(NODE_DEFAULT_SIZES.file).toEqual({ width: 400, height: 300 });
    expect(NODE_DEFAULT_SIZES.link).toEqual({ width: 400, height: 200 });
  });
});
