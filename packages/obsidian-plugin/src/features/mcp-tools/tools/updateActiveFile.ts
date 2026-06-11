import { type } from "arktype";
import { errorText, successText } from "../services/responseBuilders";
import type { App } from "obsidian";

export const updateActiveFileSchema = type({
  name: '"update_active_file"',
  arguments: {
    content: type("string").describe(
      "Full new markdown content to replace the current active file's content with.",
    ),
  },
}).describe(
  "Overwrites the entire content of the currently active note with the supplied content.",
);

export type UpdateActiveFileContext = {
  arguments: { content: string };
  app: App;
};

export async function updateActiveFileHandler(
  ctx: UpdateActiveFileContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const file = ctx.app.workspace.getActiveFile();
  if (!file) {
    return errorText("No active file.");
  }
  await ctx.app.vault.modify(file, ctx.arguments.content);
  return successText("OK");
}
