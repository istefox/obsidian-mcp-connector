import { type } from "arktype";
import type { App } from "obsidian";

export const showFileInObsidianSchema = type({
  name: '"show_file_in_obsidian"',
  arguments: {
    filename: type("string>0").describe(
      "Vault-relative path (e.g. 'Notes/foo.md'). Created if missing.",
    ),
    "newLeaf?": "boolean",
  },
}).describe(
  "Opens the given file in the Obsidian UI. Creates it if it does not exist. Optionally opens in a new leaf (split).",
);

export type ShowFileInObsidianContext = {
  arguments: { filename: string; newLeaf?: boolean };
  app: App;
};

export async function showFileInObsidianHandler(
  ctx: ShowFileInObsidianContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  await ctx.app.workspace.openLinkText(
    ctx.arguments.filename,
    "",
    ctx.arguments.newLeaf ?? false,
  );
  return { content: [{ type: "text", text: "File opened successfully" }] };
}
