import { describe, expect, test, beforeEach, spyOn } from "bun:test";
import {
  fireMockMetadataEvent,
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

  test("registry.dispatch() renders a prompt whose cached tag is `#`-prefixed", async () => {
    // Regression: Obsidian rewrites the cached tag to its hashed form once the
    // note is opened and saved, and dispatch used to answer "Prompt not found"
    // from then on, with the file unchanged on disk.
    const content = ["---", "tags: [mcp-tools-prompt]", "---", "", "Hi."].join(
      "\n",
    );
    setMockFile("Prompts/hashed.md", content);
    setMockMetadata("Prompts/hashed.md", {
      frontmatter: { tags: ["#mcp-tools-prompt"] },
    });

    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app);
    expect(result.success).toBe(true);

    const dispatchResult = await registry.dispatch({ name: "hashed" });
    expect(dispatchResult.messages[0].content.text).toContain("Hi.");

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

/**
 * ADR-0017. The modern era advertises `prompts.listChanged: true`, so the
 * server has to actually send `notifications/prompts/list_changed` when the
 * set changes — and, just as importantly, NOT send one when it hasn't.
 *
 * The watcher fires on `modify` as well as create/delete/rename, so every
 * save inside a prompt reaches this path. A per-event implementation passes
 * "notifies on create" and still floods a client with one notification per
 * keystroke burst, which is why the negative cases below carry the design
 * rather than decorating it.
 */
describe("prompts list-changed notification (ADR-0017)", () => {
  const DEBOUNCE = 5;
  // Comfortably past the debounce, and past the microtask the comparison's
  // own `await discoverPrompts` costs.
  const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE + 40));

  function promptFile(path: string, description: string): void {
    setMockFile(path, "Body");
    setMockMetadata(path, {
      frontmatter: { tags: ["mcp-tools-prompt"], description },
    });
  }

  async function setupWithSpy(app: ReturnType<typeof mockApp>) {
    const calls: number[] = [];
    const result = await setup(new PromptRegistryClass(), app, {
      notifyPromptsChanged: () => calls.push(1),
      debounceMs: DEBOUNCE,
    });
    if (!result.success) throw new Error(result.error);
    return { calls, state: result.state };
  }

  test("a new prompt file notifies once", async () => {
    promptFile("Prompts/greet.md", "one");
    const app = mockApp();
    const { calls, state } = await setupWithSpy(app);

    promptFile("Prompts/second.md", "two");
    fireMockVaultEvent("create", { path: "Prompts/second.md" });
    await settle();

    expect(calls).toHaveLength(1);
    teardown(state);
  });

  test("a prompt leaving the list notifies once", async () => {
    promptFile("Prompts/greet.md", "one");
    promptFile("Prompts/second.md", "two");
    const app = mockApp();
    const { calls, state } = await setupWithSpy(app);

    // The list shrinks by dropping the qualifying tag rather than by
    // removing the file: `resetMockVault()` also clears the registered
    // vault-event handlers, so tearing the mock down mid-test would unhook
    // the very watcher under test. What reaches `discoverPrompts` is the
    // same either way — one fewer entry — and the `delete` event is real.
    setMockMetadata("Prompts/second.md", { frontmatter: { tags: [] } });
    fireMockVaultEvent("delete", { path: "Prompts/second.md" });
    await settle();

    expect(calls).toHaveLength(1);
    teardown(state);
  });

  test("a save that changes nothing observable does NOT notify", async () => {
    promptFile("Prompts/greet.md", "unchanged");
    const app = mockApp();
    const { calls, state } = await setupWithSpy(app);

    // Exactly what Obsidian does while the user types in a prompt: a
    // modify event whose content leaves the description and the argument
    // declarations alone. Nothing a client can observe moved, so there is
    // no list change to announce.
    fireMockVaultEvent("modify", { path: "Prompts/greet.md" });
    await settle();

    expect(calls).toHaveLength(0);
    teardown(state);
  });

  test("a changed description notifies, because the list carries it", async () => {
    promptFile("Prompts/greet.md", "old");
    const app = mockApp();
    const { calls, state } = await setupWithSpy(app);

    promptFile("Prompts/greet.md", "new");
    fireMockVaultEvent("modify", { path: "Prompts/greet.md" });
    await settle();

    expect(calls).toHaveLength(1);
    teardown(state);
  });

  test("a burst of saves re-scans the vault once, not once per event", async () => {
    promptFile("Prompts/greet.md", "old");
    const app = mockApp();
    const { calls, state } = await setupWithSpy(app);

    // Counting NOTIFICATIONS here would prove nothing: the list comparison
    // already collapses a burst to one notification even with no debounce
    // at all, because the first comparison to run updates the baseline and
    // the rest find nothing new. Verified by mutation — deleting the
    // `stopNotifier()` that resets the timer leaves a notification-counting
    // assertion green.
    //
    // The re-scan is the cost the debounce actually exists to avoid, so the
    // scan is what gets counted. `discoverPrompts` calls `getMarkdownFiles`
    // exactly once per scan (`promptDiscovery.ts:34`).
    const scan = spyOn(app.vault, "getMarkdownFiles");
    promptFile("Prompts/greet.md", "new");
    for (let i = 0; i < 5; i++) {
      fireMockVaultEvent("modify", { path: "Prompts/greet.md" });
    }
    await settle();

    expect(scan).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    scan.mockRestore();
    teardown(state);
  });

  test("no callback (legacy-only wiring) still invalidates the memo", async () => {
    promptFile("Prompts/greet.md", "one");
    const app = mockApp();
    const registry = new PromptRegistryClass();
    // No `notifyPromptsChanged`: what the legacy era gets, and what every
    // other suite in this file constructs.
    const result = await setup(registry, app, { debounceMs: DEBOUNCE });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect((await registry.list()).prompts).toHaveLength(1);

    promptFile("Prompts/second.md", "two");
    fireMockVaultEvent("create", { path: "Prompts/second.md" });
    await settle();

    // Cache invalidation is not era-specific and must not have moved into
    // the notification path: without a callback there is nothing to send,
    // but the next list still re-discovers.
    expect((await registry.list()).prompts).toHaveLength(2);
    teardown(result.state);
  });

  test("teardown cancels a comparison already scheduled", async () => {
    promptFile("Prompts/greet.md", "old");
    const app = mockApp();
    const { calls, state } = await setupWithSpy(app);

    promptFile("Prompts/greet.md", "new");
    fireMockVaultEvent("modify", { path: "Prompts/greet.md" });
    // Tear down INSIDE the debounce window: the callback would otherwise
    // publish onto a handler this teardown is closing.
    teardown(state);
    await settle();

    expect(calls).toHaveLength(0);
  });
});

/**
 * The indexing window (#483).
 *
 * `discoverPrompts` reads frontmatter out of `app.metadataCache` and skips any
 * file whose cache is still null. The vault announces a file the moment it
 * appears; the cache is populated later, when the file has been indexed. Every
 * test above sets the file and its metadata together, so none of them can see
 * what happens in between — and what happens is that a list served inside that
 * window omits the new prompt and is then MEMOIZED, keyed on an epoch only a
 * vault event advances. Indexing is not a vault event, so the omission is
 * permanent for the session.
 *
 * These tests therefore set the file and its metadata as two separate steps,
 * with the list call deliberately placed between them.
 */
describe("prompts list vs the metadata indexing window", () => {
  const DEBOUNCE = 5;
  const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE + 40));

  /** A prompt that exists on disk but has not been indexed yet. */
  function unindexedPromptFile(path: string): void {
    setMockFile(path, "Body");
  }

  /** The indexing that `metadataCache` performs some time afterwards. */
  function indexPromptFile(path: string, description = "d"): void {
    setMockMetadata(path, {
      frontmatter: { tags: ["mcp-tools-prompt"], description },
    });
    fireMockMetadataEvent("changed", { path });
  }

  test("a list served before the new file is indexed is not cached forever", async () => {
    unindexedPromptFile("Prompts/greet.md");
    indexPromptFile("Prompts/greet.md");

    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app, { debounceMs: DEBOUNCE });
    expect(result.success).toBe(true);
    if (!result.success) return;

    unindexedPromptFile("Prompts/probe.md");
    fireMockVaultEvent("create", { path: "Prompts/probe.md" });

    // Correct at this instant, and the whole problem: the file is there, its
    // frontmatter is not, so it is not a prompt yet. This answer gets cached.
    expect((await registry.list()).prompts).toHaveLength(1);

    indexPromptFile("Prompts/probe.md");

    expect((await registry.list()).prompts).toHaveLength(2);
    teardown(result.state);
  });

  test("a list served at startup, before ANY file is indexed, is not cached forever", async () => {
    // No vault event anywhere in this test. This is a client that calls
    // prompts/list while Obsidian is still indexing at launch — `setup` runs
    // from `onload`, not behind `onLayoutReady`, so the window is reachable.
    unindexedPromptFile("Prompts/greet.md");

    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app, { debounceMs: DEBOUNCE });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect((await registry.list()).prompts).toHaveLength(0);

    indexPromptFile("Prompts/greet.md");

    expect((await registry.list()).prompts).toHaveLength(1);
    teardown(result.state);
  });

  test("the list a client re-fetches on a notification is the list that was notified about", async () => {
    unindexedPromptFile("Prompts/greet.md");
    indexPromptFile("Prompts/greet.md");

    const calls: number[] = [];
    const registry = new PromptRegistryClass();
    const app = mockApp();
    const result = await setup(registry, app, {
      notifyPromptsChanged: () => calls.push(1),
      debounceMs: DEBOUNCE,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    unindexedPromptFile("Prompts/probe.md");
    fireMockVaultEvent("create", { path: "Prompts/probe.md" });
    // Poisons the memo, exactly as above.
    await registry.list();

    indexPromptFile("Prompts/probe.md");
    await settle();

    // The comparison re-scans and sees the probe, so it notifies. The memo is
    // keyed on an epoch that comparison never touches, so a client acting on
    // that notification used to be handed the list without the probe in it —
    // told the set had changed and then shown that it had not.
    expect(calls).toHaveLength(1);
    expect((await registry.list()).prompts).toHaveLength(2);
    teardown(result.state);
  });
});
