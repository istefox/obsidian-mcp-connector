import { type } from "arktype";
import { type App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import {
  generateNodeId,
  parseCanvas,
  serializeCanvas,
} from "../services/canvasDocument";
import { errorJson, successJson } from "../services/responseBuilders";

export const connectCanvasNodesSchema = type({
  name: '"connect_canvas_nodes"',
  arguments: {
    path: "string>0",
    fromNode: "string>0",
    toNode: "string>0",
    "fromSide?": '"top" | "right" | "bottom" | "left"',
    "toSide?": '"top" | "right" | "bottom" | "left"',
    "label?": "string",
    "color?": "string",
  },
}).describe(
  "Adds an edge between two existing nodes in a canvas. Both node ids must exist.",
);

export type ConnectCanvasNodesContext = {
  arguments: {
    path: string;
    fromNode: string;
    toNode: string;
    fromSide?: "top" | "right" | "bottom" | "left";
    toSide?: "top" | "right" | "bottom" | "left";
    label?: string;
    color?: string;
  };
  app: App;
};

export async function connectCanvasNodesHandler(
  ctx: ConnectCanvasNodesContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, fromNode, toNode, fromSide, toSide, label, color } =
    ctx.arguments;

  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson(`Canvas file not found: ${path}`, "canvas_not_found", {
          path,
        })
      : errorJson(`Path is a folder: ${path}`, "not_a_file", { path });
  }

  const raw = await ctx.app.vault.read(resolved.file);
  const doc = parseCanvas(raw);
  if (!doc) {
    return errorJson(`Canvas file is malformed: ${path}`, "malformed_canvas", {
      path,
    });
  }

  // Verify both node ids exist before mutating.
  const nodeIds = new Set(doc.nodes.map((n) => n.id));
  if (!nodeIds.has(fromNode)) {
    return errorJson(`Node not found: ${fromNode}`, "node_not_found", {
      nodeId: fromNode,
    });
  }
  if (!nodeIds.has(toNode)) {
    return errorJson(`Node not found: ${toNode}`, "node_not_found", {
      nodeId: toNode,
    });
  }

  // Generate a unique edge id from the combined existing node and edge id pool.
  const existingIds = [
    ...doc.nodes.map((n) => n.id),
    ...doc.edges.map((e) => e.id),
  ];
  const id = generateNodeId(existingIds);

  const edge: Record<string, unknown> = {
    id,
    fromNode,
    fromSide: fromSide ?? "right",
    toNode,
    toSide: toSide ?? "left",
    ...(label !== undefined ? { label } : {}),
    ...(color !== undefined ? { color } : {}),
  };

  doc.edges.push(edge as never);

  await ctx.app.vault.modify(resolved.file, serializeCanvas(doc));

  return successJson({ id });
}
