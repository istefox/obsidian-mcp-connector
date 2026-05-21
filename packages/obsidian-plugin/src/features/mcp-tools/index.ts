import type { App } from "obsidian";
import type McpToolsPlugin from "$/main";
import type { ToolRegistry } from "$/features/mcp-transport/services/toolRegistry";

import {
  getServerInfoHandler,
  getServerInfoSchema,
} from "./tools/getServerInfo";
import {
  getActiveFileHandler,
  getActiveFileSchema,
} from "./tools/getActiveFile";
import {
  updateActiveFileHandler,
  updateActiveFileSchema,
} from "./tools/updateActiveFile";
import {
  appendToActiveFileHandler,
  appendToActiveFileSchema,
} from "./tools/appendToActiveFile";
import {
  patchActiveFileHandler,
  patchActiveFileSchema,
} from "./tools/patchActiveFile";
import {
  deleteActiveFileHandler,
  deleteActiveFileSchema,
} from "./tools/deleteActiveFile";
import {
  showFileInObsidianHandler,
  showFileInObsidianSchema,
} from "./tools/showFileInObsidian";
import {
  listVaultFilesHandler,
  listVaultFilesSchema,
} from "./tools/listVaultFiles";
import { getVaultFileHandler, getVaultFileSchema } from "./tools/getVaultFile";
import {
  createVaultFileHandler,
  createVaultFileSchema,
} from "./tools/createVaultFile";
import {
  appendToVaultFileHandler,
  appendToVaultFileSchema,
} from "./tools/appendToVaultFile";
import {
  patchVaultFileHandler,
  patchVaultFileSchema,
} from "./tools/patchVaultFile";
import {
  deleteVaultFileHandler,
  deleteVaultFileSchema,
} from "./tools/deleteVaultFile";
import {
  renameVaultFileHandler,
  renameVaultFileSchema,
} from "./tools/renameVaultFile";
import {
  renameHeadingHandler,
  renameHeadingSchema,
} from "./tools/renameHeading";
import {
  createVaultDirectoryHandler,
  createVaultDirectorySchema,
} from "./tools/createVaultDirectory";
import {
  deleteVaultDirectoryHandler,
  deleteVaultDirectorySchema,
} from "./tools/deleteVaultDirectory";
import { searchVaultHandler, searchVaultSchema } from "./tools/searchVault";
import {
  searchVaultSimpleHandler,
  searchVaultSimpleSchema,
} from "./tools/searchVaultSimple";
import {
  searchVaultSmartHandler,
  searchVaultSmartSchema,
} from "./tools/searchVaultSmart";
import {
  listObsidianCommandsHandler,
  listObsidianCommandsSchema,
} from "./tools/listObsidianCommands";
import {
  executeObsidianCommandHandler,
  executeObsidianCommandSchema,
} from "./tools/executeObsidianCommand";
import { fetchHandler, fetchSchema } from "./tools/fetch";
import {
  executeTemplateHandler,
  executeTemplateSchema,
} from "./tools/executeTemplate";
import { listTagsHandler, listTagsSchema } from "./tools/listTags";
import {
  getFilesByTagHandler,
  getFilesByTagSchema,
} from "./tools/getFilesByTag";
import {
  getRecentFilesHandler,
  getRecentFilesSchema,
} from "./tools/getRecentFiles";
import {
  getVaultFilePartialHandler,
  getVaultFilePartialSchema,
} from "./tools/getVaultFilePartial";
import {
  getOutgoingLinksHandler,
  getOutgoingLinksSchema,
} from "./tools/getOutgoingLinks";
import { getBacklinksHandler, getBacklinksSchema } from "./tools/getBacklinks";

export type RegisterToolsContext = {
  app: App;
  plugin: McpToolsPlugin;
  pluginVersion: string;
};

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

  // Active file
  registry.register(getActiveFileSchema, async ({ arguments: args }) =>
    getActiveFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(updateActiveFileSchema, async ({ arguments: args }) =>
    updateActiveFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(appendToActiveFileSchema, async ({ arguments: args }) =>
    appendToActiveFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(patchActiveFileSchema, async ({ arguments: args }) =>
    patchActiveFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(deleteActiveFileSchema, async ({ arguments: args }) =>
    deleteActiveFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(showFileInObsidianSchema, async ({ arguments: args }) =>
    showFileInObsidianHandler({ arguments: args, app: ctx.app }),
  );

  // Vault file ops
  registry.register(listVaultFilesSchema, async ({ arguments: args }) =>
    listVaultFilesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getVaultFileSchema, async ({ arguments: args }) =>
    getVaultFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(createVaultFileSchema, async ({ arguments: args }) =>
    createVaultFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(appendToVaultFileSchema, async ({ arguments: args }) =>
    appendToVaultFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(patchVaultFileSchema, async ({ arguments: args }) =>
    patchVaultFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(deleteVaultFileSchema, async ({ arguments: args }) =>
    deleteVaultFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(renameVaultFileSchema, async ({ arguments: args }) =>
    renameVaultFileHandler({ arguments: args, app: ctx.app }),
  );
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
  registry.register(getRecentFilesSchema, async ({ arguments: args }) =>
    getRecentFilesHandler({ arguments: args, app: ctx.app }),
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

  // Search
  registry.register(searchVaultSchema, async ({ arguments: args }) =>
    searchVaultHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(searchVaultSimpleSchema, async ({ arguments: args }) =>
    searchVaultSimpleHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(searchVaultSmartSchema, async ({ arguments: args }) =>
    searchVaultSmartHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );

  // Commands
  registry.register(listObsidianCommandsSchema, async ({ arguments: args }) =>
    listObsidianCommandsHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(executeObsidianCommandSchema, async ({ arguments: args }) =>
    executeObsidianCommandHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );

  // Misc
  registry.register(fetchSchema, async ({ arguments: args }) =>
    fetchHandler({ arguments: args }),
  );
  registry.register(executeTemplateSchema, async ({ arguments: args }) =>
    executeTemplateHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
}
