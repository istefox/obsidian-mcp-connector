/**
 * The tools the headless server registers: the vault tools that need
 * nothing but a vault-shaped `App` and a settings host.
 *
 * The desktop plugin registers its tools in `features/mcp-tools/index.ts`,
 * which also pulls in the settings UI and the desktop-only tools (active
 * file, workspace, commands, Dataview, Templater, bookmarks). The
 * headless bundle cannot carry those, so `bun.headless.config.ts` points
 * the shared composition root's `$/features/mcp-tools` import at this
 * file. It exports the same `registerTools` and takes the same context.
 * `registerTools.test.ts` builds both registries and compares them, so a
 * tool added on the desktop cannot be left out here unnoticed.
 *
 * Every tool uses the shared schema and handler, only the set differs.
 */

import type { App } from "obsidian";
import type McpToolsPlugin from "$/main";
import type { ToolRegistry } from "$/features/mcp-transport/services/toolRegistry";
import { TOOL_ANNOTATIONS } from "$/features/mcp-tools/toolAnnotations";
import {
  TOOL_CLIENT_META,
  TOOL_TITLES,
} from "$/features/mcp-tools/toolClientMeta";

import {
  getServerInfoHandler,
  getServerInfoSchema,
} from "$/features/mcp-tools/tools/getServerInfo";
import {
  listTasksHandler,
  listTasksSchema,
} from "$/features/mcp-tools/tools/listTasks";
import {
  getNotePropertiesHandler,
  getNotePropertiesSchema,
} from "$/features/mcp-tools/tools/getNoteProperties";
import {
  updateNotePropertiesHandler,
  updateNotePropertiesSchema,
} from "$/features/mcp-tools/tools/updateNoteProperties";
import {
  renameTagHandler,
  renameTagSchema,
} from "$/features/mcp-tools/tools/renameTag";
import {
  getFileInfoHandler,
  getFileInfoSchema,
} from "$/features/mcp-tools/tools/getFileInfo";
import {
  searchFilesByNameHandler,
  searchFilesByNameSchema,
} from "$/features/mcp-tools/tools/searchFilesByName";
import {
  ensureBlockIdHandler,
  ensureBlockIdSchema,
} from "$/features/mcp-tools/tools/ensureBlockId";
import {
  listAttachmentsHandler,
  listAttachmentsSchema,
} from "$/features/mcp-tools/tools/listAttachments";
import {
  updateCanvasNodeHandler,
  updateCanvasNodeSchema,
} from "$/features/mcp-tools/tools/updateCanvasNode";
import {
  deleteCanvasNodeHandler,
  deleteCanvasNodeSchema,
} from "$/features/mcp-tools/tools/deleteCanvasNode";
import {
  setTaskStatusHandler,
  setTaskStatusSchema,
} from "$/features/mcp-tools/tools/setTaskStatus";
import {
  listVaultFilesHandler,
  listVaultFilesSchema,
} from "$/features/mcp-tools/tools/listVaultFiles";
import {
  getVaultFileHandler,
  getVaultFileSchema,
} from "$/features/mcp-tools/tools/getVaultFile";
import {
  getVaultFilesHandler,
  getVaultFilesSchema,
} from "$/features/mcp-tools/tools/getVaultFiles";
import {
  createVaultFileHandler,
  createVaultFileSchema,
} from "$/features/mcp-tools/tools/createVaultFile";
import {
  createVaultBinaryFileHandler,
  createVaultBinaryFileSchema,
} from "$/features/mcp-tools/tools/createVaultBinaryFile";
import {
  appendToVaultFileHandler,
  appendToVaultFileSchema,
} from "$/features/mcp-tools/tools/appendToVaultFile";
import {
  patchVaultFileHandler,
  patchVaultFileSchema,
} from "$/features/mcp-tools/tools/patchVaultFile";
import {
  deleteVaultFileHandler,
  deleteVaultFileSchema,
} from "$/features/mcp-tools/tools/deleteVaultFile";
import {
  renameVaultFileHandler,
  renameVaultFileSchema,
} from "$/features/mcp-tools/tools/renameVaultFile";
import {
  renameHeadingHandler,
  renameHeadingSchema,
} from "$/features/mcp-tools/tools/renameHeading";
import {
  createVaultDirectoryHandler,
  createVaultDirectorySchema,
} from "$/features/mcp-tools/tools/createVaultDirectory";
import {
  deleteVaultDirectoryHandler,
  deleteVaultDirectorySchema,
} from "$/features/mcp-tools/tools/deleteVaultDirectory";
import {
  searchVaultHandler,
  searchVaultSchema,
} from "$/features/mcp-tools/tools/searchVault";
import {
  searchVaultSimpleHandler,
  searchVaultSimpleSchema,
} from "$/features/mcp-tools/tools/searchVaultSimple";
import {
  searchVaultSmartHandler,
  searchVaultSmartSchema,
  type SearchVaultSmartContext,
} from "$/features/mcp-tools/tools/searchVaultSmart";
import {
  listTagsHandler,
  listTagsSchema,
} from "$/features/mcp-tools/tools/listTags";
import {
  getFilesByTagHandler,
  getFilesByTagSchema,
} from "$/features/mcp-tools/tools/getFilesByTag";
import {
  getNotePropertyHandler,
  getNotePropertySchema,
} from "$/features/mcp-tools/tools/getNoteProperty";
import {
  setNotePropertyHandler,
  setNotePropertySchema,
} from "$/features/mcp-tools/tools/setNoteProperty";
import {
  deleteNotePropertyHandler,
  deleteNotePropertySchema,
} from "$/features/mcp-tools/tools/deleteNoteProperty";
import {
  listPropertyValuesHandler,
  listPropertyValuesSchema,
} from "$/features/mcp-tools/tools/listPropertyValues";
import {
  getRecentFilesHandler,
  getRecentFilesSchema,
} from "$/features/mcp-tools/tools/getRecentFiles";
import {
  getVaultOverviewHandler,
  getVaultOverviewSchema,
} from "$/features/mcp-tools/tools/getVaultOverview";
import {
  getVaultFilePartialHandler,
  getVaultFilePartialSchema,
} from "$/features/mcp-tools/tools/getVaultFilePartial";
import {
  getOutgoingLinksHandler,
  getOutgoingLinksSchema,
} from "$/features/mcp-tools/tools/getOutgoingLinks";
import {
  getBacklinksHandler,
  getBacklinksSchema,
} from "$/features/mcp-tools/tools/getBacklinks";
import {
  findBrokenLinksHandler,
  findBrokenLinksSchema,
} from "$/features/mcp-tools/tools/findBrokenLinks";
import {
  findOrphanedNotesHandler,
  findOrphanedNotesSchema,
} from "$/features/mcp-tools/tools/findOrphanedNotes";
import {
  searchAndReplaceHandler,
  searchAndReplaceSchema,
} from "$/features/mcp-tools/tools/searchAndReplace";
import {
  getNoteOutlineHandler,
  getNoteOutlineSchema,
} from "$/features/mcp-tools/tools/getNoteOutline";
import {
  getCanvasHandler,
  getCanvasSchema,
} from "$/features/mcp-tools/tools/getCanvas";
import {
  addCanvasNodeHandler,
  addCanvasNodeSchema,
} from "$/features/mcp-tools/tools/addCanvasNode";
import {
  connectCanvasNodesHandler,
  connectCanvasNodesSchema,
} from "$/features/mcp-tools/tools/connectCanvasNodes";
import { errorJson } from "$/features/mcp-tools/services/responseBuilders";
import { logger } from "$/shared/logger";
import {
  fixedMessage,
  isOwnRuntimeFailure,
  leadingErrno,
} from "./clientMessage";
import { hostOf } from "./hostData";
import { collectRenameWarnings, withRenameWarnings } from "./renameWarnings";

export type RegisterToolsContext = {
  app: App;
  plugin: McpToolsPlugin;
  pluginVersion: string;
};

/**
 * The shared `search_vault_smart` handler puts the provider's own error
 * message in its `semantic_search_failed` result, and a failure in the model
 * cache, the index or the ONNX runtime names paths and URLs of the host. The
 * client is not given that message: it gets `Semantic search failed`, with
 * the errno code the message starts with if it has one (clientMessage.ts),
 * and `errorCode` and every other field as they were. The one message kept
 * is the runtime-file failure that headless itself words. The whole message
 * goes to the log, which is stderr on the server. Every other result, the
 * `index_building` and `semantic_search_unavailable` answers among them,
 * names no host path and is returned as it is.
 */
function withoutHostPaths<T extends { content: Array<{ text?: string }> }>(
  result: T & { isError?: boolean },
): T {
  const first = result.content[0];
  if (!result.isError || typeof first?.text !== "string") return result;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(first.text) as Record<string, unknown>;
  } catch {
    return result;
  }
  if (body.errorCode !== "semantic_search_failed") return result;
  if (typeof body.error !== "string" || isOwnRuntimeFailure(body.error))
    return result;
  logger.error("search_vault_smart failed", { error: body.error });
  const error = fixedMessage(
    "Semantic search failed",
    leadingErrno(body.error.replace(/^Semantic search failed: /, "")),
  );
  return {
    ...result,
    content: [
      { ...first, text: JSON.stringify({ ...body, error }) },
      ...result.content.slice(1),
    ],
  };
}

export async function registerTools(
  registry: ToolRegistry,
  ctx: RegisterToolsContext,
): Promise<void> {
  // Health
  registry.register(getServerInfoSchema, async ({ arguments: args }) =>
    getServerInfoHandler({
      arguments: args,
      pluginVersion: ctx.pluginVersion,
      // Lazy: at registration time the HTTP server has not bound yet,
      // so plugin.mcpTransportState is undefined. By tool-call time
      // setup() has populated it with a live RunningServer.
      getLocalTransport: () => {
        const port = ctx.plugin.mcpTransportState?.server.port;
        if (port === undefined) return undefined;
        return {
          protocol: "http",
          host: "127.0.0.1",
          port,
          path: "/mcp",
        };
      },
    }),
  );

  // Tasks
  registry.register(listTasksSchema, async ({ arguments: args }) =>
    listTasksHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(setTaskStatusSchema, async ({ arguments: args }) =>
    setTaskStatusHandler({ arguments: args, app: ctx.app }),
  );

  // Frontmatter, whole-block variants
  registry.register(getNotePropertiesSchema, async ({ arguments: args }) =>
    getNotePropertiesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(updateNotePropertiesSchema, async ({ arguments: args }) =>
    updateNotePropertiesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(renameTagSchema, async ({ arguments: args }) =>
    renameTagHandler({ arguments: args, app: ctx.app }),
  );

  // File metadata without the body
  registry.register(getFileInfoSchema, async ({ arguments: args }) =>
    getFileInfoHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(listAttachmentsSchema, async ({ arguments: args }) =>
    listAttachmentsHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(ensureBlockIdSchema, async ({ arguments: args }) =>
    ensureBlockIdHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(searchFilesByNameSchema, async ({ arguments: args }) =>
    searchFilesByNameHandler({ arguments: args, app: ctx.app }),
  );

  // Vault file ops
  registry.register(listVaultFilesSchema, async ({ arguments: args }) =>
    listVaultFilesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getVaultFileSchema, async ({ arguments: args }) =>
    getVaultFileHandler({ arguments: args, app: ctx.app, plugin: ctx.plugin }),
  );
  registry.register(getVaultFilesSchema, async ({ arguments: args }) =>
    getVaultFilesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(createVaultFileSchema, async ({ arguments: args }) =>
    createVaultFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(createVaultBinaryFileSchema, async ({ arguments: args }) =>
    createVaultBinaryFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(appendToVaultFileSchema, async ({ arguments: args }) =>
    appendToVaultFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(patchVaultFileSchema, async ({ arguments: args }) =>
    patchVaultFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(deleteVaultFileSchema, async ({ arguments: args }) =>
    deleteVaultFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  // Reports what the rename could not settle (see renameWarnings.ts).
  registry.register(renameVaultFileSchema, async ({ arguments: args }) => {
    const { result, warnings } = await collectRenameWarnings(() =>
      renameVaultFileHandler({ arguments: args, app: ctx.app }),
    );
    return withRenameWarnings(result, warnings);
  });
  registry.register(renameHeadingSchema, async ({ arguments: args }) =>
    renameHeadingHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(createVaultDirectorySchema, async ({ arguments: args }) =>
    createVaultDirectoryHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(deleteVaultDirectorySchema, async ({ arguments: args }) =>
    deleteVaultDirectoryHandler({ arguments: args, app: ctx.app }),
  );

  // Metadata
  registry.register(listTagsSchema, async ({ arguments: args }) =>
    listTagsHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getFilesByTagSchema, async ({ arguments: args }) =>
    getFilesByTagHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getNotePropertySchema, async ({ arguments: args }) =>
    getNotePropertyHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(setNotePropertySchema, async ({ arguments: args }) =>
    setNotePropertyHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(deleteNotePropertySchema, async ({ arguments: args }) =>
    deleteNotePropertyHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(listPropertyValuesSchema, async ({ arguments: args }) =>
    listPropertyValuesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getRecentFilesSchema, async ({ arguments: args }) =>
    getRecentFilesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getVaultOverviewSchema, async ({ arguments: args }) =>
    getVaultOverviewHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getVaultFilePartialSchema, async ({ arguments: args }) =>
    getVaultFilePartialHandler({ arguments: args, app: ctx.app }),
  );

  // Links
  registry.register(getOutgoingLinksSchema, async ({ arguments: args }) =>
    getOutgoingLinksHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getBacklinksSchema, async ({ arguments: args }) =>
    getBacklinksHandler({ arguments: args, app: ctx.app }),
  );

  // Vault intelligence
  registry.register(findBrokenLinksSchema, async ({ arguments: args }) =>
    findBrokenLinksHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(findOrphanedNotesSchema, async ({ arguments: args }) =>
    findOrphanedNotesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(searchAndReplaceSchema, async ({ arguments: args }) =>
    searchAndReplaceHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getNoteOutlineSchema, async ({ arguments: args }) =>
    getNoteOutlineHandler({ arguments: args, app: ctx.app }),
  );

  // Canvas
  registry.register(getCanvasSchema, async ({ arguments: args }) =>
    getCanvasHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(addCanvasNodeSchema, async ({ arguments: args }) =>
    addCanvasNodeHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(connectCanvasNodesSchema, async ({ arguments: args }) =>
    connectCanvasNodesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(updateCanvasNodeSchema, async ({ arguments: args }) =>
    updateCanvasNodeHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(deleteCanvasNodeSchema, async ({ arguments: args }) =>
    deleteCanvasNodeHandler({ arguments: args, app: ctx.app }),
  );

  // Search
  registry.register(searchVaultSchema, async ({ arguments: args }) =>
    searchVaultHandler({
      arguments: args,
      app: ctx.app,
    }),
  );
  // `hasUiCapability` rides the HandlerContext the same way
  // `sendNotification` does (R-09, ADR-0023 D9). Forwarded as-is,
  // `undefined` included: the tools distinguish "declared no support"
  // from "no signal at all", and collapsing the two here would silently
  // strip the payload from every legacy-era call.
  registry.register(
    searchVaultSimpleSchema,
    async ({ arguments: args }, { hasUiCapability }) =>
      searchVaultSimpleHandler({
        arguments: args,
        app: ctx.app,
        hasUiCapability,
      }),
  );
  // Semantic search is on when the entry gave the host a gate. The gate
  // takes the index lock and wires the feature before the first search.
  const gate = hostOf(ctx.plugin).semanticGate;
  if (gate) {
    registry.register(
      searchVaultSmartSchema,
      async (params, { sendNotification, hasUiCapability }) => {
        const unavailable = await gate();
        if (unavailable !== undefined) {
          return errorJson(unavailable, "semantic_search_unavailable");
        }
        const result = await searchVaultSmartHandler({
          arguments: (
            params as { arguments: SearchVaultSmartContext["arguments"] }
          ).arguments,
          app: ctx.app,
          plugin: ctx.plugin,
          progressToken: (
            params as { _meta?: { progressToken?: string | number } }
          )._meta?.progressToken,
          sendNotification,
          hasUiCapability,
        });
        return withoutHostPaths(result);
      },
    );
  }

  // Covers the meta-tools registered later in mcpServer.ts too:
  // annotations are looked up by name at list() time.
  registry.setAnnotations(TOOL_ANNOTATIONS);
  // Same by-name contract: `title`, and the client hints in `_meta` (which
  // tools to always load, the size of the large results). setMeta merges,
  // so the MCP Apps pointer wired later in composeToolRegistry sits beside
  // them.
  registry.setTitles(TOOL_TITLES);
  registry.setMeta(TOOL_CLIENT_META);

  // No registry.setOutputSchemas() call, on purpose. The MCP SDK client
  // rejects a non-error response of a tool that advertises an outputSchema
  // unless it carries structuredContent, and a tool such as get_vault_file
  // returns text, an image, audio or a JSON hint. The desktop registration
  // makes the same choice, and registerTools.test.ts compares the two.
}
