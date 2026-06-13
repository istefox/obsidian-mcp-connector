import { type } from "arktype";
import { type App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";
import {
  buildEmptyCanvas,
  computePlacement,
  generateNodeId,
  NODE_DEFAULT_SIZES,
  parseCanvas,
  serializeCanvas,
} from "../services/canvasDocument";
import { errorJson, successJson } from "../services/responseBuilders";

export const addCanvasNodeSchema = type({
  name: '"add_canvas_node"',
  arguments: {
    path: "string>0",
    type: '"text" | "file" | "link"',
    "text?": "string",
    "file?": "string>0",
    "subpath?": "string",
    "url?": "string>0",
    "color?": "string",
    "x?": "number",
    "y?": "number",
    "width?": "number",
    "height?": "number",
  },
}).describe(
  "Adds a node (text, file, or link) to a canvas. Creates the canvas if it does not exist.",
);

export type AddCanvasNodeContext = {
  arguments: {
    path: string;
    type: "text" | "file" | "link";
    text?: string;
    file?: string;
    subpath?: string;
    url?: string;
    color?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  app: App;
};

export async function addCanvasNodeHandler(ctx: AddCanvasNodeContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, type: nodeType, color, x, y, width, height } = ctx.arguments;

  // Resolve the canvas file — or detect a folder collision early.
  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok && resolved.reason === "not_a_file") {
    return errorJson(`Path is a folder: ${path}`, "not_a_file", { path });
  }

  let doc;
  let created = false;
  // Retain the TFile reference so the modify call below remains type-safe
  // after the narrowing from the resolved.ok branch is no longer in scope.
  let existingFile: import("obsidian").TFile | null = null;

  if (resolved.ok) {
    existingFile = resolved.file;
    const raw = await ctx.app.vault.read(resolved.file);
    doc = parseCanvas(raw);
    if (!doc) {
      return errorJson(
        `Canvas file is malformed: ${path}`,
        "malformed_canvas",
        { path },
      );
    }
  } else {
    // not_found — create a new canvas document.
    doc = buildEmptyCanvas();
    created = true;
  }

  // Validate file-type embed target before mutating the canvas.
  if (nodeType === "file") {
    const embedPath = ctx.arguments.file;
    if (!embedPath) {
      return errorJson(
        'The "file" argument is required when type is "file".',
        "missing_argument",
        { path },
      );
    }
    const embedResolved = resolveTFile(ctx.app.vault, embedPath);
    if (!embedResolved.ok) {
      return errorJson(
        `Embed target not found: ${embedPath}`,
        "embed_target_not_found",
        { path: embedPath },
      );
    }
  }

  // Determine node dimensions.
  const defaults = NODE_DEFAULT_SIZES[nodeType] ?? { width: 400, height: 200 };
  const nodeWidth = width ?? defaults.width;
  const nodeHeight = height ?? defaults.height;

  // Compute placement.
  const rect = computePlacement(doc.nodes, {
    width: nodeWidth,
    height: nodeHeight,
    explicitX: x,
    explicitY: y,
  });

  // Generate a unique node id.
  const existingIds = doc.nodes.map((n) => n.id);
  const id = generateNodeId(existingIds);

  // Build the node payload based on type.
  const baseNode = {
    id,
    type: nodeType,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    ...(color !== undefined ? { color } : {}),
  };

  let newNode: Record<string, unknown>;

  if (nodeType === "text") {
    newNode = { ...baseNode, text: ctx.arguments.text ?? "" };
  } else if (nodeType === "file") {
    newNode = {
      ...baseNode,
      file: ctx.arguments.file!,
      ...(ctx.arguments.subpath !== undefined
        ? { subpath: ctx.arguments.subpath }
        : {}),
    };
  } else if (nodeType === "link") {
    if (!ctx.arguments.url) {
      return errorJson(
        'The "url" argument is required when type is "link".',
        "missing_argument",
        { path },
      );
    }
    newNode = { ...baseNode, url: ctx.arguments.url };
  } else {
    return errorJson(
      `Unsupported node type: ${nodeType}`,
      "invalid_node_type",
      {
        nodeType,
      },
    );
  }

  doc.nodes.push(newNode as never);

  const serialized = serializeCanvas(doc);

  if (created) {
    await ensureParentFolderExists(ctx.app, path);
    await ctx.app.vault.create(path, serialized);
  } else {
    await ctx.app.vault.modify(existingFile!, serialized);
  }

  return successJson({
    id,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    created,
  });
}
