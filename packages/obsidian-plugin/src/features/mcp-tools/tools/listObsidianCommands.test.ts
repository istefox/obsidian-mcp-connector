import { describe, expect, test, beforeEach } from "bun:test";
import {
  listObsidianCommandsHandler,
  listObsidianCommandsSchema,
} from "./listObsidianCommands";
import { mockApp, resetMockVault, setMockCommands } from "$/test-setup";

beforeEach(() => resetMockVault());

describe("list_obsidian_commands tool", () => {
  test("schema declares the tool name", () => {
    expect(listObsidianCommandsSchema.get("name")?.toString()).toContain(
      "list_obsidian_commands",
    );
  });

  test("returns all registered commands when no filter", async () => {
    setMockCommands([
      { id: "editor:fold", name: "Fold" },
      { id: "editor:unfold", name: "Unfold" },
    ]);
    const result = await listObsidianCommandsHandler({
      arguments: {},
      app: mockApp(),
    });
    const data = JSON.parse(result.content[0].text as string);
    expect(data.commands).toHaveLength(2);
    expect(data.commands.map((c: { id: string }) => c.id)).toEqual([
      "editor:fold",
      "editor:unfold",
    ]);
  });

  test("filters by substring match on id or name", async () => {
    setMockCommands([
      { id: "editor:fold", name: "Fold" },
      { id: "editor:unfold", name: "Unfold" },
      { id: "graph:open", name: "Open graph view" },
    ]);
    const r = await listObsidianCommandsHandler({
      arguments: { filter: "graph" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.commands).toHaveLength(1);
    expect(data.commands[0].id).toBe("graph:open");
  });

  test("filter is case-insensitive", async () => {
    setMockCommands([{ id: "Editor:Fold", name: "Fold" }]);
    const r = await listObsidianCommandsHandler({
      arguments: { filter: "FOLD" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.commands).toHaveLength(1);
  });

  test("returns empty array when no command matches filter", async () => {
    setMockCommands([{ id: "x", name: "X" }]);
    const r = await listObsidianCommandsHandler({
      arguments: { filter: "nomatch" },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.commands).toEqual([]);
  });

  test("caps output at limit and reports truncated+total", async () => {
    setMockCommands([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ]);
    const r = await listObsidianCommandsHandler({
      arguments: { limit: 2 },
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.commands).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.total).toBe(3);
  });

  test("default limit leaves a small result set untouched (no truncated field)", async () => {
    setMockCommands([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    const r = await listObsidianCommandsHandler({
      arguments: {},
      app: mockApp(),
    });
    const data = JSON.parse(r.content[0].text as string);
    expect(data.commands).toHaveLength(2);
    expect(data.truncated).toBeUndefined();
    expect(data.total).toBeUndefined();
  });
});
