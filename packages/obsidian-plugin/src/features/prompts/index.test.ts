import { describe, expect, test, beforeEach } from "bun:test";
import {
  fireMockVaultEvent,
  mockApp,
  resetMockVault,
  setMockFile,
  setMockMetadata,
} from "$/test-setup";
import { PromptRegistryClass } from "$/features/mcp-transport/services/promptRegistry";
import { setup, teardown } from "./index";

beforeEach(() => {
  resetMockVault();
});

describe("prompts feature setup", () => {
  test("returns success with watcher state", async () => {
    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app);
    expect(result.success).toBe(true);
    if (result.success) teardown(result.state);
  });

  test("registry.list() returns discovered prompts", async () => {
    setMockFile(
      "Prompts/greet.md",
      `<% tp.mcpTools.prompt("who", "Target") %>\nHello {{who}}`,
    );
    setMockMetadata("Prompts/greet.md", {
      frontmatter: { tags: ["mcp-tools-prompt"], description: "A greeting" },
    });

    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app);
    expect(result.success).toBe(true);

    const list = await registry.list();
    expect(list.prompts).toHaveLength(1);
    expect(list.prompts[0].name).toBe("greet");
    expect(list.prompts[0].description).toBe("A greeting");
    expect(list.prompts[0].arguments[0].name).toBe("who");

    if (result.success) teardown(result.state);
  });

  test("list() is memoized and invalidated by vault events", async () => {
    setMockFile("Prompts/greet.md", `Hello`);
    setMockMetadata("Prompts/greet.md", {
      frontmatter: { tags: ["mcp-tools-prompt"] },
    });

    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app);
    expect(result.success).toBe(true);

    expect((await registry.list()).prompts).toHaveLength(1);

    // A new prompt file with NO vault event: the memoized list must
    // still be served (this is what proves the cache exists).
    setMockFile("Prompts/other.md", `Bye`);
    setMockMetadata("Prompts/other.md", {
      frontmatter: { tags: ["mcp-tools-prompt"] },
    });
    expect((await registry.list()).prompts).toHaveLength(1);

    // The create event invalidates; the next list re-discovers.
    fireMockVaultEvent("create", { path: "Prompts/other.md" });
    expect((await registry.list()).prompts).toHaveLength(2);

    if (result.success) teardown(result.state);
  });

  test("modify event invalidates the memoized list", async () => {
    setMockFile("Prompts/greet.md", `Hello`);
    setMockMetadata("Prompts/greet.md", {
      frontmatter: { tags: ["mcp-tools-prompt"], description: "old" },
    });

    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app);
    expect(result.success).toBe(true);

    expect((await registry.list()).prompts[0].description).toBe("old");

    setMockMetadata("Prompts/greet.md", {
      frontmatter: { tags: ["mcp-tools-prompt"], description: "new" },
    });
    fireMockVaultEvent("modify", { path: "Prompts/greet.md" });
    expect((await registry.list()).prompts[0].description).toBe("new");

    if (result.success) teardown(result.state);
  });

  test("registry.dispatch() returns rendered message for known prompt", async () => {
    const content = [
      "---",
      "tags: [mcp-tools-prompt]",
      "---",
      "",
      `<% tp.mcpTools.prompt("who", "Target") %>`,
      "",
      "Hello {{who}}!",
    ].join("\n");
    setMockFile("Prompts/greet.md", content);
    setMockMetadata("Prompts/greet.md", {
      frontmatter: { tags: ["mcp-tools-prompt"] },
    });

    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app);
    expect(result.success).toBe(true);

    const dispatchResult = await registry.dispatch({
      name: "greet",
      arguments: { who: "World" },
    });
    expect(dispatchResult.messages[0].role).toBe("user");
    expect(dispatchResult.messages[0].content.text).toContain("Hello World!");

    if (result.success) teardown(result.state);
  });

  test("registry.dispatch() expands an embed in the returned text", async () => {
    // Mutation: revert index.ts to `renderPrompt(content, args)` alone —
    // the literal `![[Notes/ref.md]]` comes back instead of its content.
    setMockFile("Notes/ref.md", "Referenced body.");
    setMockFile(
      "Prompts/withEmbed.md",
      ["---", "tags: [mcp-tools-prompt]", "---", "", "![[Notes/ref.md]]"].join(
        "\n",
      ),
    );
    setMockMetadata("Prompts/withEmbed.md", {
      frontmatter: { tags: ["mcp-tools-prompt"] },
    });

    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app);
    expect(result.success).toBe(true);

    const dispatchResult = await registry.dispatch({ name: "withEmbed" });
    expect(dispatchResult.messages[0].content.text).toBe("Referenced body.");

    if (result.success) teardown(result.state);
  });

  test("registry.dispatch() resolves an embed named by an argument", async () => {
    // Pins the call-site ordering. Mutation: run expandEmbeds before
    // renderPrompt — `{{note}}` is still a placeholder at that point, so the
    // target never resolves and the marker comes back instead.
    setMockFile("Notes/weekly.md", "Weekly body.");
    setMockFile(
      "Prompts/dynamic.md",
      [
        "---",
        "tags: [mcp-tools-prompt]",
        "---",
        "",
        `<% tp.mcpTools.prompt("note", "Note to embed") %>`,
        "",
        "![[{{note}}]]",
      ].join("\n"),
    );
    setMockMetadata("Prompts/dynamic.md", {
      frontmatter: { tags: ["mcp-tools-prompt"] },
    });

    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app);
    expect(result.success).toBe(true);

    const dispatchResult = await registry.dispatch({
      name: "dynamic",
      arguments: { note: "Notes/weekly.md" },
    });
    expect(dispatchResult.messages[0].content.text).toBe("Weekly body.");

    if (result.success) teardown(result.state);
  });

  test("registry.dispatch() throws InvalidParams for unknown prompt", async () => {
    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app);
    expect(result.success).toBe(true);

    await expect(
      registry.dispatch({ name: "nonexistent" }),
    ).rejects.toMatchObject({ code: expect.any(Number) });

    if (result.success) teardown(result.state);
  });

  test("teardown stops the vault watcher", async () => {
    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(() => teardown(result.state)).not.toThrow();
    }
  });
});
