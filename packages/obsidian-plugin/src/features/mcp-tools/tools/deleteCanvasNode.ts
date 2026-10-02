import { type } from "arktype";
import type { App } from "obsidian";
import { parseCanvas, serializeCanvas } from "../services/canvasDocument";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson, successJson } from "../services/responseBuilders";
import { withVaultWriteLock } from "../services/vaultWriteLock";

export const deleteCanvasNodeSchema = type({
  name: '"delete_canvas_node"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the .canvas file."),
    nodeId: type("string>0").describe(
      "Id of the node to remove, as returned by `get_canvas`.",
    ),
  },
}).describe(
  "Removes one node from a canvas together with every edge attached to it, so the file never holds a dangling edge. Other nodes keep their positions; a group's members are not removed with the group. Atomic write. Returns the removed node and the ids of the removed edges.",
);

export type DeleteCanvasNodeContext = {
  arguments: { path: string; nodeId: string };
  app: App;
};

export async function deleteCanvasNodeHandler(
  ctx: DeleteCanvasNodeContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, nodeId } = ctx.arguments;

  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson(`Canvas file not found: ${path}`, "canvas_not_found", {
          path,
        })
      : errorJson(`Path is a folder: ${path}`, "not_a_file", { path });
  }

  let failure: ReturnType<typeof errorJson> | null = null;
  let removed: Record<string, unknown> | null = null;
  let removedEdges: string[] = [];
  await withVaultWriteLock(() =>
    ctx.app.vault.process(resolved.file, (raw) => {
      const doc = parseCanvas(raw);
      if (!doc) {
        failure = errorJson(
          `Canvas file is malformed: ${path}`,
          "malformed_canvas",
          { path },
        );
        return raw;
      }
      const index = doc.nodes.findIndex((n) => n.id === nodeId);
      if (index === -1) {
        failure = errorJson(`Node not found: ${nodeId}`, "node_not_found", {
          path,
          nodeId,
        });
        return raw;
      }
      removed = { ...doc.nodes[index] };
      doc.nodes.splice(index, 1);
      removedEdges = doc.edges
        .filter((e) => e.fromNode === nodeId || e.toNode === nodeId)
        .map((e) => e.id);
      doc.edges = doc.edges.filter(
        (e) => e.fromNode !== nodeId && e.toNode !== nodeId,
      );
      return serializeCanvas(doc);
    }),
  );

  if (failure !== null) return failure;
  return successJson({
    path,
    removed,
    removedEdges,
  });
}
