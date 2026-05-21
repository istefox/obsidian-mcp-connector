import { type } from "arktype";
import type { App } from "obsidian";
import { normalizeAppendBody } from "$/features/mcp-tools/services/patchHelpers";

export const appendToActiveFileSchema = type({
  name: '"append_to_active_file"',
  arguments: {
    content: type("string").describe(
      "Markdown content to append at the end of the active note.",
    ),
  },
}).describe(
  "Appends content to the end of the currently active note. A trailing double newline is added when missing to keep the next section visually separated.",
);

export type AppendToActiveFileContext = {
  arguments: { content: string };
  app: App;
};

export async function appendToActiveFileHandler(
  ctx: AppendToActiveFileContext,
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
  const existing = await ctx.app.vault.read(file);
  const normalized = normalizeAppendBody(ctx.arguments.content, "append");
  await ctx.app.vault.modify(file, existing + normalized);
  return { content: [{ type: "text", text: "OK" }] };
}
