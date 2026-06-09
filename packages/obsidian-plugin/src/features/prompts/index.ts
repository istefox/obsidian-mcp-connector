import { TFile, type App } from "obsidian";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { PromptFrontmatterSchema } from "shared";
import type { PromptRegistry } from "$/features/mcp-transport/services/promptRegistry";
import { discoverPrompts } from "./services/promptDiscovery";
import { renderPrompt } from "./services/promptRenderer";
import { createVaultWatcher, type VaultWatcher } from "./services/vaultWatcher";

export type PromptsFeatureState = { watcher: VaultWatcher };

export async function setup(
  promptRegistry: PromptRegistry,
  app: App,
): Promise<
  | { success: true; state: PromptsFeatureState }
  | { success: false; error: string }
> {
  try {
    promptRegistry.setLister(() => discoverPrompts(app));

    promptRegistry.setHandler("*", async (name, args) => {
      const path = `Prompts/${name}.md`;
      const abstractFile = app.vault.getAbstractFileByPath(path);
      if (abstractFile === null) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Prompt not found: ${name}`,
        );
      }
      if (!(abstractFile instanceof TFile)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Prompt not found: ${name}`,
        );
      }
      const file = abstractFile;

      const cache = app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      const rawTags = fm?.tags;
      const tagsArray = Array.isArray(rawTags)
        ? rawTags
        : typeof rawTags === "string"
          ? [rawTags]
          : null;

      if (!tagsArray) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Prompt not found: ${name}`,
        );
      }

      try {
        PromptFrontmatterSchema.assert({ ...fm, tags: tagsArray });
      } catch {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Prompt not found: ${name}`,
        );
      }

      const content = await app.vault.cachedRead(file);
      const text = renderPrompt(content, args);

      return {
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    });

    const watcher = createVaultWatcher(app, () => {
      // no-op: stateless transport has no persistent session to notify
    });

    return { success: true, state: { watcher } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function teardown(state: PromptsFeatureState): void {
  state.watcher.stop();
}
