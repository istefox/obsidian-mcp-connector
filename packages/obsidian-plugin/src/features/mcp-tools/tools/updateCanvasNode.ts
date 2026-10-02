import { type } from "arktype";
import type { App } from "obsidian";
import { parseCanvas, serializeCanvas } from "../services/canvasDocument";
import { resolveTFile } from "../services/resolveTFile";
import { errorJson, successJson } from "../services/responseBuilders";
import { withVaultWriteLock } from "../services/vaultWriteLock";

export const updateCanvasNodeSchema = type({
  name: '"update_canvas_node"',
  arguments: {
    path: type("string>0").describe("Vault-relative path to the .canvas file."),
    nodeId: type("string>0").describe(
      "Id of the node to change, as returned by `get_canvas`.",
    ),
    "text?": type("string").describe("New content. `text` nodes only."),
    "file?": type("string>0").describe(
      "New embedded file, vault-relative; must exist. `file` nodes only.",
    ),
    "subpath?": type("string | null").describe(
      "New heading/block subpath of the embed (`#Heading`, `#^block`); `null` removes it. `file` nodes only.",
    ),
    "url?": type("string>0").describe("New URL. `link` nodes only."),
    "label?": type("string | null").describe(
      "New label; `null` removes it. `group` nodes only.",
    ),
    "color?": type("string | null").describe(
      'Canvas color: a preset "1"-"6" or a hex string; `null` removes the color. Any node type.',
    ),
    "x?": "number",
    "y?": "number",
    "width?": "number>0",
    "height?": "number>0",
  },
}).describe(
  "Changes one existing canvas node in place: content (`text`, `file`/`subpath`, `url`, `label` according to the node type), `color`, position and size. Only the fields passed change; the node keeps its id, type, edges and every other field. A content field that does not belong to the node's type is refused. Atomic write. Returns the node after the change.",
);

export type UpdateCanvasNodeContext = {
  arguments: {
    path: string;
    nodeId: string;
    text?: string;
    file?: string;
    subpath?: string | null;
    url?: string;
    label?: string | null;
    color?: string | null;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  app: App;
};

/** Which content fields each node type owns. */
const CONTENT_FIELDS: Record<
  string,
  ReadonlyArray<keyof UpdateCanvasNodeContext["arguments"]>
> = {
  text: ["text"],
  file: ["file", "subpath"],
  link: ["url"],
  group: ["label"],
};
const ALL_CONTENT_FIELDS = ["text", "file", "subpath", "url", "label"] as const;

export async function updateCanvasNodeHandler(
  ctx: UpdateCanvasNodeContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const { path, nodeId } = ctx.arguments;
  const args = ctx.arguments;

  const changes = (
    [
      "text",
      "file",
      "subpath",
      "url",
      "label",
      "color",
      "x",
      "y",
      "width",
      "height",
    ] as const
  ).filter((k) => args[k] !== undefined);
  if (changes.length === 0) {
    return errorJson(
      "Nothing to change: pass at least one of text, file, subpath, url, label, color, x, y, width, height.",
      "invalid_params",
      { tool: "update_canvas_node" },
    );
  }

  const resolved = resolveTFile(ctx.app.vault, path);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson(`Canvas file not found: ${path}`, "canvas_not_found", {
          path,
        })
      : errorJson(`Path is a folder: ${path}`, "not_a_file", { path });
  }
  if (args.file !== undefined) {
    const embed = resolveTFile(ctx.app.vault, args.file);
    if (!embed.ok) {
      return errorJson(
        `Embed target not found: ${args.file}`,
        "embed_target_not_found",
        {
          path: args.file,
        },
      );
    }
  }

  let failure: ReturnType<typeof errorJson> | null = null;
  let after: Record<string, unknown> | null = null;
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
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node) {
        failure = errorJson(`Node not found: ${nodeId}`, "node_not_found", {
          path,
          nodeId,
        });
        return raw;
      }
      const owned = CONTENT_FIELDS[node.type] ?? [];
      const foreign = ALL_CONTENT_FIELDS.filter(
        (k) => args[k] !== undefined && !owned.includes(k),
      );
      if (foreign.length > 0) {
        failure = errorJson(
          `Field${foreign.length > 1 ? "s" : ""} ${foreign.map((f) => `"${f}"`).join(", ")} do not apply to a "${node.type}" node${owned.length > 0 ? ` (it takes ${owned.map((f) => `"${f}"`).join(", ")})` : ""}.`,
          "invalid_params",
          { path, nodeId, nodeType: node.type, fields: foreign },
        );
        return raw;
      }

      const target = node as Record<string, unknown>;
      for (const k of [
        "text",
        "file",
        "url",
        "x",
        "y",
        "width",
        "height",
      ] as const) {
        if (args[k] !== undefined) target[k] = args[k];
      }
      for (const k of ["subpath", "label", "color"] as const) {
        const v = args[k];
        if (v === undefined) continue;
        if (v === null) delete target[k];
        else target[k] = v;
      }
      after = { ...target };
      return serializeCanvas(doc);
    }),
  );

  if (failure !== null) return failure;
  return successJson({ path, node: after, changed: changes });
}
