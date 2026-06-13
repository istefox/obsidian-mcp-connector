import { type } from "arktype";
import { type App } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import { parseCanvas, type CanvasNode } from "../services/canvasDocument";
import { errorJson, successJson } from "../services/responseBuilders";

export const getCanvasSchema = type({
  name: '"get_canvas"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the .canvas file."),
  },
}).describe(
  "Reads a canvas file and returns its nodes and edges as structured JSON.",
);

export type GetCanvasContext = {
  arguments: { path: string };
  app: App;
};

/** Maximum characters of text-node content returned inline. */
const TEXT_NODE_CAP = 500;

export async function getCanvasHandler(ctx: GetCanvasContext): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path } = ctx.arguments;

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

  // Truncate long text-node content in-memory only; the file is never modified.
  const nodes = doc.nodes.map((node: CanvasNode) => {
    if (
      node.type === "text" &&
      typeof node.text === "string" &&
      node.text.length > TEXT_NODE_CAP
    ) {
      return {
        ...node,
        text: node.text.slice(0, TEXT_NODE_CAP),
        textTruncated: true as const,
      };
    }
    return node;
  });

  return successJson({
    path,
    nodeCount: doc.nodes.length,
    edgeCount: doc.edges.length,
    nodes,
    edges: doc.edges,
  });
}
