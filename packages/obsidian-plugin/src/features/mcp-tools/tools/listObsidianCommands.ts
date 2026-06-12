import { type } from "arktype";
import { successText } from "../services/responseBuilders";
import type { App } from "obsidian";

export const listObsidianCommandsSchema = type({
  name: '"list_obsidian_commands"',
  arguments: {
    "filter?": type("string").describe(
      "Case-insensitive substring; matches against command id or display name.",
    ),
    "limit?": type("number>0").describe("Max results returned (default 200)."),
  },
}).describe(
  "Lists registered Obsidian commands (core + plugins). Always read-only and unrestricted by command-permissions.",
);

export type ListObsidianCommandsContext = {
  arguments: { filter?: string; limit?: number };
  app: App;
};

export async function listObsidianCommandsHandler(
  ctx: ListObsidianCommandsContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // Access the commands API via a type-safe cast. The App type from obsidian
  // does not expose `commands` in its public signature — it's an internal API.
  // We cast through `unknown` to suppress type errors while keeping type safety
  // downstream (the result is fully typed as the commands array).
  const all = (
    ctx.app as unknown as {
      commands: { listCommands: () => Array<{ id: string; name: string }> };
    }
  ).commands.listCommands();

  const filter = ctx.arguments.filter?.toLowerCase();
  const commands = filter
    ? all.filter(
        (c) =>
          c.id.toLowerCase().includes(filter) ||
          c.name.toLowerCase().includes(filter),
      )
    : all;

  const limit = Math.min(
    1000,
    Math.max(1, Math.floor(ctx.arguments.limit ?? 200)),
  );
  const truncated = commands.length > limit;

  return successText(
    JSON.stringify({
      commands: truncated ? commands.slice(0, limit) : commands,
      ...(truncated ? { truncated: true, total: commands.length } : {}),
    }),
  );
}
