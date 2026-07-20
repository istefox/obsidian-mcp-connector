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
import { withVaultWriteLock } from "../services/vaultWriteLock";

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

  /**
   * Pure, synchronous per-document step shared by both branches:
   * validates the type-specific arguments in the original order (embed
   * target → placement → url/type switch) and appends the new node to
   * `doc`. Runs inside the `vault.process` callback on the
   * existing-file branch, so it must not touch the vault beyond the
   * sync `resolveTFile` lookup.
   */
  type BuiltNode = {
    id: string;
    rect: { x: number; y: number; width: number; height: number };
  };
  const buildNodeInto = (doc: {
    nodes: Array<{ id: string }>;
  }): BuiltNode | { failure: ReturnType<typeof errorJson> } => {
    // Validate file-type embed target before mutating the canvas.
    if (nodeType === "file") {
      const embedPath = ctx.arguments.file;
      if (!embedPath) {
        return {
          failure: errorJson(
            'The "file" argument is required when type is "file".',
            "missing_argument",
            { path },
          ),
        };
      }
      const embedResolved = resolveTFile(ctx.app.vault, embedPath);
      if (!embedResolved.ok) {
        return {
          failure: errorJson(
            `Embed target not found: ${embedPath}`,
            "embed_target_not_found",
            { path: embedPath },
          ),
        };
      }
    }

    // Determine node dimensions.
    const defaults = NODE_DEFAULT_SIZES[nodeType] ?? {
      width: 400,
      height: 200,
    };
    const nodeWidth = width ?? defaults.width;
    const nodeHeight = height ?? defaults.height;

    // Compute placement.
    const rect = computePlacement(doc.nodes as never, {
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
        return {
          failure: errorJson(
            'The "url" argument is required when type is "link".',
            "missing_argument",
            { path },
          ),
        };
      }
      newNode = { ...baseNode, url: ctx.arguments.url };
    } else {
      return {
        failure: errorJson(
          `Unsupported node type: ${nodeType}`,
          "invalid_node_type",
          { nodeType },
        ),
      };
    }

    doc.nodes.push(newNode as never);
    return { id, rect };
  };

  // Resolution + write under the vault write lock: the exists-check and
  // the create are two steps (TOCTOU), and the existing-file branch is a
  // read-modify-write — see vaultWriteLock.ts.
  return withVaultWriteLock(async () => {
    // Resolve the canvas file — or detect a folder collision early.
    const resolved = resolveTFile(ctx.app.vault, path);
    if (!resolved.ok && resolved.reason === "not_a_file") {
      return errorJson(`Path is a folder: ${path}`, "not_a_file", { path });
    }

    if (resolved.ok) {
      // Atomic read-modify-write on the existing canvas: parse,
      // validate and splice against the exact content that is written
      // back. Error paths return the input unchanged.
      let failure: ReturnType<typeof errorJson> | null = null;
      let built: BuiltNode | null = null;
      await ctx.app.vault.process(resolved.file, (raw) => {
        const doc = parseCanvas(raw);
        if (!doc) {
          failure = errorJson(
            `Canvas file is malformed: ${path}`,
            "malformed_canvas",
            { path },
          );
          return raw;
        }
        const result = buildNodeInto(doc);
        if ("failure" in result) {
          failure = result.failure;
          return raw;
        }
        built = result;
        return serializeCanvas(doc);
      });
      if (failure !== null) return failure;
      const { id, rect } = built!;
      return successJson({
        id,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        created: false,
      });
    }

    // not_found — create a new canvas document.
    const doc = buildEmptyCanvas();
    const result = buildNodeInto(doc);
    if ("failure" in result) return result.failure;
    await ensureParentFolderExists(ctx.app, path);
    await ctx.app.vault.create(path, serializeCanvas(doc));
    return successJson({
      id: result.id,
      x: result.rect.x,
      y: result.rect.y,
      width: result.rect.width,
      height: result.rect.height,
      created: true,
    });
  });
}
