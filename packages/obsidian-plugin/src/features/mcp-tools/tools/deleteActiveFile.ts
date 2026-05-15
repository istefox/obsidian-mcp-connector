import { type } from "arktype";
import type { App } from "obsidian";

export const deleteActiveFileSchema = type({
  name: '"delete_active_file"',
  arguments: {},
}).describe("Deletes the currently active note from the vault.");

export type DeleteActiveFileContext = {
  // `object` (not `Record<string, never>`) to match the ToolRegistry
  // constraint which uses `object` for no-arg tools (see toolRegistry.ts).
  arguments: object;
  app: App;
};

export async function deleteActiveFileHandler(
  ctx: DeleteActiveFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const file = ctx.app.workspace.getActiveFile();
  if (!file) {
    return {
      content: [{ type: "text", text: "No active file." }],
      isError: true,
    };
  }
  await ctx.app.fileManager.trashFile(file);
  return { content: [{ type: "text", text: "OK" }] };
}
