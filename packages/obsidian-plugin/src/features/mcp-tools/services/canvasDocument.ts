/**
 * Canvas document service — parse, serialize, id generation, and node placement.
 *
 * Pure logic; no vault interaction. All functions here are usable in tests
 * without any Obsidian mock. Tool handlers call into this service and handle
 * their own vault I/O.
 */

export type CanvasNode = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
} & Record<string, unknown>;

export type CanvasEdge = {
  id: string;
  fromNode: string;
  toNode: string;
} & Record<string, unknown>;

export type CanvasDocument = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} & Record<string, unknown>;

export type Rect = { x: number; y: number; width: number; height: number };

export type PlacementOpts = {
  width: number;
  height: number;
  explicitX?: number;
  explicitY?: number;
};

/** Column width (px) at which the auto-placer starts a new row. */
export const CANVAS_ROW_WRAP_WIDTH = 3200;

/** Pixel gap between auto-placed nodes (horizontal and vertical). */
export const CANVAS_GAP = 32;

/**
 * Default node dimensions by type, matching Obsidian's canvas editor defaults.
 * Exported so tool handlers can pass the right size to `computePlacement`.
 */
export const NODE_DEFAULT_SIZES: Record<
  string,
  { width: number; height: number }
> = {
  text: { width: 400, height: 200 },
  file: { width: 400, height: 300 },
  link: { width: 400, height: 200 },
};

/**
 * Parse a raw canvas JSON string into a `CanvasDocument`.
 *
 * Returns `null` when the input is not valid JSON, or when the top-level
 * object is missing `nodes` or `edges` arrays. Unknown fields on the
 * document and on individual nodes/edges are preserved intact (index
 * signature on the types), so a round-trip write never drops data that
 * came from a hand-edited canvas.
 */
export function parseCanvas(raw: string): CanvasDocument | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj["nodes"]) || !Array.isArray(obj["edges"])) {
    return null;
  }
  return obj as unknown as CanvasDocument;
}

/** Return a fresh empty canvas document. */
export function buildEmptyCanvas(): CanvasDocument {
  return { nodes: [], edges: [] };
}

/**
 * Serialize a canvas document to a pretty-printed JSON string (2-space
 * indent), matching Obsidian's on-disk canvas format.
 */
export function serializeCanvas(doc: CanvasDocument): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Generate a unique 16-character lowercase hex node id.
 *
 * Retries until it produces an id not already present in `existing`.
 * An optional `gen` argument overrides the random source — useful in
 * tests to inject a deterministic sequence and exercise the retry path.
 */
export function generateNodeId(existing: string[], gen?: () => string): string {
  const existingSet = new Set(existing);
  const defaultGen = (): string => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
  const generator = gen ?? defaultGen;
  while (true) {
    const candidate = generator();
    if (!existingSet.has(candidate)) return candidate;
  }
}

/**
 * Compute the position of a new node given the current set of canvas nodes.
 *
 * Each axis is resolved independently: an explicit `explicitX` or `explicitY`
 * overrides the auto-computed value for that axis only, so a caller can pin one
 * coordinate (e.g. a fixed `x`) while letting the other auto-place.
 *
 * Auto-placement rules:
 *  1. When no nodes exist, place at (0, 0).
 *  2. Otherwise place immediately to the right of the widest bounding-box extent,
 *     with `CANVAS_GAP` px of horizontal spacing.
 *  3. When the right edge of the candidate position exceeds `CANVAS_ROW_WRAP_WIDTH`,
 *     start a new row below the tallest node in the current layout (gap: `CANVAS_GAP`).
 */
export function computePlacement(
  nodes: CanvasNode[],
  opts: PlacementOpts,
): Rect {
  const { width, height, explicitX, explicitY } = opts;

  const auto = computeAutoPosition(nodes, width);

  return {
    x: explicitX ?? auto.x,
    y: explicitY ?? auto.y,
    width,
    height,
  };
}

/**
 * Compute the auto-placement origin for a new node of the given width.
 *
 * Returns (0, 0) on an empty canvas; otherwise the slot to the right of the
 * current bounding box, wrapping to a new row when the candidate would exceed
 * `CANVAS_ROW_WRAP_WIDTH`. Within a row the new node shares the top edge of the
 * existing nodes (`minY`) rather than assuming the layout is anchored at y=0.
 */
function computeAutoPosition(
  nodes: CanvasNode[],
  width: number,
): { x: number; y: number } {
  if (nodes.length === 0) {
    return { x: 0, y: 0 };
  }

  // Compute the bounding box of all existing nodes.
  let maxRight = -Infinity;
  let maxBottom = -Infinity;
  let minY = Infinity;

  for (const n of nodes) {
    const right = n.x + n.width;
    const bottom = n.y + n.height;
    if (right > maxRight) maxRight = right;
    if (bottom > maxBottom) maxBottom = bottom;
    if (n.y < minY) minY = n.y;
  }

  const candidateX = maxRight + CANVAS_GAP;

  // Wrap to a new row when the new node's right edge would exceed the wrap threshold.
  if (candidateX + width > CANVAS_ROW_WRAP_WIDTH) {
    return { x: 0, y: maxBottom + CANVAS_GAP };
  }

  return { x: candidateX, y: minY };
}
