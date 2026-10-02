import { describe, expect, test, beforeEach } from "bun:test";
import {
  executeTemplateHandler,
  executeTemplateSchema,
} from "./executeTemplate";
import {
  mockApp,
  mockPlugin,
  resetMockVault,
  setMockFile,
  setMockFolder,
  setMockCoreTemplatesState,
} from "$/test-setup";

beforeEach(() => resetMockVault());

// ---------------------------------------------------------------------------
// Helpers — build a minimal fake Templater ITemplater API that records calls
// ---------------------------------------------------------------------------

type FakeTemplaterCall = {
  method: string;
  templatePath: string;
  /** Path of the `target_file` the running config carried (#541). */
  targetPath: string;
  runMode: unknown;
  processedContent: string;
};

function makeFakeTemplater(renderedContent = "RENDERED") {
  const calls: FakeTemplaterCall[] = [];
  // Templater's own start/end task bookkeeping, recorded in order so a test
  // can assert the render sat between them (that is what makes
  // `on_all_templates_executed` hooks fire against the new note).
  const taskLog: string[] = [];

  const fakeTemplater = {
    _calls: calls,
    _taskLog: taskLog,
    functions_generator: {
      generate_object: async (
        _config: unknown,
        _mode: unknown,
      ): Promise<Record<string, unknown>> => {
        return {};
      },
    },
    create_running_config: (
      templateFile: unknown,
      targetFile: unknown,
      runMode: unknown,
    ) => {
      return {
        template_file: templateFile,
        target_file: targetFile,
        run_mode: runMode,
      };
    },
    read_and_parse_template: async (config: {
      template_file: { path: string };
      target_file: { path: string };
      run_mode: unknown;
    }) => {
      taskLog.push("render");
      calls.push({
        method: "read_and_parse_template",
        templatePath: config.template_file.path,
        targetPath: config.target_file.path,
        runMode: config.run_mode,
        processedContent: renderedContent,
      });
      return renderedContent;
    },
    start_templater_task: (path: string) => {
      taskLog.push(`start:${path}`);
    },
    end_templater_task: async (path: string) => {
      taskLog.push(`end:${path}`);
    },
  };

  return fakeTemplater;
}

// Build a mockPlugin with a fake Templater plugin wired in via
// app.plugins.plugins["templater-obsidian"].templater
function mockPluginWithTemplater(
  fakeTemplater: ReturnType<typeof makeFakeTemplater> | undefined,
) {
  const app = mockApp();
  // Wire the fake templater into the app's plugins registry
  (
    app as unknown as {
      plugins: {
        plugins: Record<string, { templater?: unknown }>;
      };
    }
  ).plugins = {
    plugins: {
      "templater-obsidian": fakeTemplater ? { templater: fakeTemplater } : {},
    },
  };

  return mockPlugin({ app } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("execute_template tool", () => {
  test("schema declares the tool name", () => {
    expect(executeTemplateSchema.get("name")?.toString()).toContain(
      "execute_template",
    );
  });

  test("returns error when Templater plugin not available", async () => {
    const plugin = mockPluginWithTemplater(undefined);

    const result = await executeTemplateHandler({
      arguments: { templatePath: "Templates/foo.md" },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.errorCode).toBe("templater_not_installed");
    expect(payload.templatePath).toBe("Templates/foo.md");
    expect(payload.error).toMatch(/templater|not installed/i);
  });

  test("returns error when template file not found in vault", async () => {
    // No file registered in the mock vault — getAbstractFileByPath returns null
    const fakeTemplater = makeFakeTemplater();
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: { templatePath: "Templates/missing.md" },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.errorCode).toBe("template_not_found");
    expect(payload.templatePath).toBe("Templates/missing.md");
  });

  test("renders template and returns content without creating a file", async () => {
    setMockFile("Templates/foo.md", "Hello {{name}}");

    const fakeTemplater = makeFakeTemplater("Hello World");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "Templates/foo.md",
        arguments: { name: "World" },
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    expect(fakeTemplater._calls).toHaveLength(1);
    expect(fakeTemplater._calls[0].method).toBe("read_and_parse_template");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toBe("Hello World");
    expect(parsed.message).toMatch(/without creating/i);
  });

  test("executes template and creates target file when createFile=true and targetPath specified", async () => {
    setMockFile("Templates/foo.md", "Hello {{name}}");

    const fakeTemplater = makeFakeTemplater("RENDERED_CONTENT");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "Templates/foo.md",
        targetPath: "Output/note.md",
        createFile: true,
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    expect(fakeTemplater._calls).toHaveLength(1);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toBe("RENDERED_CONTENT");
    expect(parsed.message).toMatch(/created successfully/i);
    // Issue #20: createFile success response includes the targetPath.
    expect(parsed.path).toBe("Output/note.md");
    expect(parsed.requestedPath).toBeUndefined();

    // Verify the file was actually created in the mock vault, with the
    // rendered content (not the empty placeholder the note starts as).
    const createdFile =
      plugin.app.vault.getAbstractFileByPath("Output/note.md");
    expect(createdFile).not.toBeNull();
    expect(await plugin.app.vault.read(createdFile as never)).toBe(
      "RENDERED_CONTENT",
    );
  });

  // #541: Templater must render against the NEW note, not the template.
  test("#541: the running config's target_file is the new note, created before the render", async () => {
    setMockFile("Templates/T.md", "# <% tp.file.title %>");
    const fakeTemplater = makeFakeTemplater("# My note");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "Templates/T.md",
        targetPath: "Notes/My note.md",
        createFile: true,
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    const [call] = fakeTemplater._calls;
    expect(call?.templatePath).toBe("Templates/T.md");
    expect(call?.targetPath).toBe("Notes/My note.md");
    // Same mode as Templater's "Create new note from template" command.
    expect(call?.runMode).toBe(0);
    // The render is bracketed by Templater's task bookkeeping, keyed by the
    // note's path, so on_all_templates_executed hooks fire for this run.
    expect(fakeTemplater._taskLog).toEqual([
      "start:Notes/My note.md",
      "render",
      "end:Notes/My note.md",
    ]);
  });

  test("#541: without a target the template is the stand-in target_file (render-only), and no task is started", async () => {
    setMockFile("Templates/T.md", "X");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: { templatePath: "Templates/T.md" },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    expect(fakeTemplater._calls[0]?.targetPath).toBe("Templates/T.md");
    expect(fakeTemplater._taskLog).toEqual(["render"]);
  });

  test("#541: a render failure removes the empty note it had created and ends the task", async () => {
    setMockFile("Templates/T.md", "X");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    fakeTemplater.read_and_parse_template = async () => {
      fakeTemplater._taskLog.push("render");
      throw new Error("boom");
    };
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "Templates/T.md",
        targetPath: "Notes/new.md",
        createFile: true,
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.errorCode).toBe("template_execution_failed");
    expect(payload.error).toContain("boom");
    expect(payload.path).toBe("Notes/new.md");
    expect(plugin.app.vault.getAbstractFileByPath("Notes/new.md")).toBeNull();
    expect(fakeTemplater._taskLog).toEqual([
      "start:Notes/new.md",
      "render",
      "end:Notes/new.md",
    ]);
  });

  test("#541: an existing target is refused with file_exists and left untouched", async () => {
    setMockFile("Templates/T.md", "X");
    setMockFile("Notes/taken.md", "precious");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "Templates/T.md",
        targetPath: "Notes/taken.md",
        createFile: true,
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.errorCode).toBe("file_exists");
    expect(payload.path).toBe("Notes/taken.md");
    // No render happened and the file is untouched.
    expect(fakeTemplater._calls).toHaveLength(0);
    const file = plugin.app.vault.getAbstractFileByPath("Notes/taken.md");
    expect(await plugin.app.vault.read(file as never)).toBe("precious");
  });

  test("#541: `path` follows a tp.file.move() rename and `requestedPath` records the original", async () => {
    setMockFile("Templates/T.md", "X");
    setMockFolder("Moved");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    const plugin = mockPluginWithTemplater(fakeTemplater);
    // Simulate `tp.file.move()`: the template renames the target during
    // the render, as Templater does through fileManager.renameFile.
    fakeTemplater.read_and_parse_template = async (config: {
      template_file: { path: string };
      target_file: { path: string };
      run_mode: unknown;
    }) => {
      await plugin.app.fileManager.renameFile(
        config.target_file as never,
        "Moved/elsewhere.md",
      );
      return "RENDERED";
    };

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "Templates/T.md",
        targetPath: "Notes/new.md",
        createFile: true,
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.path).toBe("Moved/elsewhere.md");
    expect(parsed.requestedPath).toBe("Notes/new.md");
    expect(plugin.app.vault.getAbstractFileByPath("Notes/new.md")).toBeNull();
    const moved = plugin.app.vault.getAbstractFileByPath("Moved/elsewhere.md");
    expect(await plugin.app.vault.read(moved as never)).toBe("RENDERED");
  });

  test("#541: an older Templater without the task bookkeeping methods still works", async () => {
    setMockFile("Templates/T.md", "X");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    const legacy = fakeTemplater as unknown as Record<string, unknown>;
    delete legacy.start_templater_task;
    delete legacy.end_templater_task;
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "Templates/T.md",
        targetPath: "Notes/new.md",
        createFile: true,
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    expect(fakeTemplater._calls[0]?.targetPath).toBe("Notes/new.md");
  });

  test("does NOT create a file when createFile is omitted", async () => {
    setMockFile("a.md", "X");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: { templatePath: "a.md", targetPath: "Output/out.md" },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    // createFile was not "true" — file should NOT be created
    const file = plugin.app.vault.getAbstractFileByPath("Output/out.md");
    expect(file).toBeNull();
  });

  // The "true" / "false" STRING form is coerced to a boolean by the registry
  // (`coerceBooleanParams`, exercised in toolRegistry.test.ts #444), not by
  // the handler, which now takes a real boolean like every other tool.
  test("createFile=true creates the file at a root-level targetPath", async () => {
    setMockFile("a.md", "X");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "a.md",
        targetPath: "out.md",
        createFile: true,
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    const file = plugin.app.vault.getAbstractFileByPath("out.md");
    expect(file).not.toBeNull();
  });

  test("createFile=false does not create file even with targetPath", async () => {
    setMockFile("a.md", "X");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "a.md",
        targetPath: "out.md",
        createFile: false,
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    const file = plugin.app.vault.getAbstractFileByPath("out.md");
    expect(file).toBeNull();
  });

  test("restores generate_object after successful execution (not the injecting override)", async () => {
    setMockFile("a.md", "X");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    await executeTemplateHandler({
      arguments: { templatePath: "a.md" },
      app: plugin.app,
      plugin,
    });

    // After execution, the current generate_object must NOT be the injecting
    // override — it does not produce an `mcpTools` property in its output.
    // We verify by calling it and checking there is no `mcpTools` key.
    const result = await fakeTemplater.functions_generator.generate_object(
      {} as never,
      undefined,
    );
    expect((result as Record<string, unknown>).mcpTools).toBeUndefined();
  });

  test("FIX 4: concurrent execute_template calls are serialized (no patch/restore race)", async () => {
    setMockFile("a.md", "X");

    // A templater whose render is async + slow, and which actually
    // invokes the patched generate_object so each call observes the
    // accessor THAT call installed. If the mutex were absent, call B's
    // patch (and finally-restore) would interleave with call A's render
    // and one of them would see the wrong / restored generate_object.
    function makeRacyTemplater() {
      const seen: string[] = [];
      const t = {
        functions_generator: {
          generate_object: async (): Promise<Record<string, unknown>> => ({}),
        },
        create_running_config: () => ({}),
        read_and_parse_template: async () => {
          // Render reaches into the (currently-patched) generate_object
          // and records which prompt accessor is live right now.
          const fns = await t.functions_generator.generate_object();
          const accessor = (fns as { mcpTools?: { prompt: PromptArg } })
            .mcpTools?.prompt;
          // Yield so a second concurrent call would interleave here if
          // the critical section were not serialized.
          await new Promise((r) => setTimeout(r, 10));
          seen.push(accessor ? accessor("who") : "<none>");
          await new Promise((r) => setTimeout(r, 10));
          // Read again AFTER the yield: must still be this call's accessor.
          const fns2 = await t.functions_generator.generate_object();
          const accessor2 = (fns2 as { mcpTools?: { prompt: PromptArg } })
            .mcpTools?.prompt;
          seen.push(accessor2 ? accessor2("who") : "<none>");
          return "RENDERED";
        },
        _seen: seen,
      };
      return t;
    }
    type PromptArg = (name: string) => string;

    const fakeTemplater = makeRacyTemplater();
    const plugin = mockPluginWithTemplater(
      fakeTemplater as unknown as ReturnType<typeof makeFakeTemplater>,
    );

    const callA = executeTemplateHandler({
      arguments: { templatePath: "a.md", arguments: { who: "A" } },
      app: plugin.app,
      plugin,
    });
    const callB = executeTemplateHandler({
      arguments: { templatePath: "a.md", arguments: { who: "B" } },
      app: plugin.app,
      plugin,
    });

    const [rA, rB] = await Promise.all([callA, callB]);
    expect(rA.isError).toBeUndefined();
    expect(rB.isError).toBeUndefined();

    // Serialized → each pair of reads is internally consistent: the
    // first call sees [X, X], the second sees [Y, Y] (never [A, B] or
    // [<none>, …] which a patch/restore race would produce).
    expect(fakeTemplater._seen).toHaveLength(4);
    const [a1, a2, b1, b2] = fakeTemplater._seen;
    expect(a1).toBe(a2);
    expect(b1).toBe(b2);
    expect(new Set(fakeTemplater._seen)).toEqual(new Set(["A", "B"]));

    // generate_object fully restored (non-injecting) after both finish.
    const restored = await fakeTemplater.functions_generator.generate_object();
    expect((restored as Record<string, unknown>).mcpTools).toBeUndefined();
  });

  test("issue #19: read_and_parse_template error surfaces as isError result with verbatim message (no double prefix)", async () => {
    setMockFile("a.md", "X");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    fakeTemplater.read_and_parse_template = async () => {
      throw new Error("Templater internal error");
    };
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: { templatePath: "a.md" },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.errorCode).toBe("template_execution_failed");
    expect(payload.error).toContain("Templater internal error");
    expect(payload.templatePath).toBe("a.md");
    // The handler must NOT wrap the message in `MCP error -<code>:` itself —
    // the registry would then wrap again, producing the double prefix folotp
    // reported.
    expect(payload.error).not.toMatch(/MCP error -?\d+:.*MCP error/);

    // generate_object must be restored to the non-injecting version
    const restored = await fakeTemplater.functions_generator.generate_object(
      {} as never,
      undefined,
    );
    expect((restored as Record<string, unknown>).mcpTools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Core Templates fallback (issue #228)
// ---------------------------------------------------------------------------

// Build a plugin where Templater is absent (plugin key missing) but
// internalPlugins is backed by the mock state seeded via
// setMockCoreTemplatesState(). The mockApp() already wires the templates slot.
function mockPluginWithoutTemplater() {
  const app = mockApp();
  (
    app as unknown as {
      plugins: { plugins: Record<string, unknown> };
    }
  ).plugins = { plugins: {} };
  return mockPlugin({ app } as never);
}

describe("execute_template — core Templates fallback", () => {
  test("returns templater_not_installed when both Templater and core Templates are absent", async () => {
    // core Templates disabled by default (resetMockVault already called it)
    const plugin = mockPluginWithoutTemplater();

    const result = await executeTemplateHandler({
      arguments: { templatePath: "Templates/foo.md" },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.errorCode).toBe("templater_not_installed");
    expect(payload.error).toMatch(/no template engine/i);
  });

  test("renders via core Templates when Templater absent and core Templates enabled", async () => {
    setMockCoreTemplatesState({ enabled: true });
    setMockFile("Templates/foo.md", "Hello {{title}}");
    const plugin = mockPluginWithoutTemplater();

    const result = await executeTemplateHandler({
      arguments: { templatePath: "Templates/foo.md" },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toContain("Hello");
    expect(parsed.message).toMatch(/without creating/i);
  });

  test("creates file via core Templates when createFile=true and targetPath given", async () => {
    setMockCoreTemplatesState({ enabled: true });
    setMockFile("Templates/foo.md", "content");
    const plugin = mockPluginWithoutTemplater();

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "Templates/foo.md",
        targetPath: "Output/note.md",
        createFile: true,
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.message).toMatch(/created successfully/i);
    expect(parsed.path).toBe("Output/note.md");
    expect(
      plugin.app.vault.getAbstractFileByPath("Output/note.md"),
    ).not.toBeNull();
  });

  test("{{title}} uses targetPath basename when targetPath provided", async () => {
    setMockCoreTemplatesState({ enabled: true });
    setMockFile("Templates/foo.md", "# {{title}}");
    const plugin = mockPluginWithoutTemplater();

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "Templates/foo.md",
        targetPath: "Notes/My Note.md",
      },
      app: plugin.app,
      plugin,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toBe("# My Note");
  });

  test("{{title}} uses template basename when no targetPath", async () => {
    setMockCoreTemplatesState({ enabled: true });
    setMockFile("Templates/weekly-review.md", "# {{title}}");
    const plugin = mockPluginWithoutTemplater();

    const result = await executeTemplateHandler({
      arguments: { templatePath: "Templates/weekly-review.md" },
      app: plugin.app,
      plugin,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.content).toBe("# weekly-review");
  });

  test("{{date}} and {{time}} use formats from core Templates settings", async () => {
    setMockCoreTemplatesState({
      enabled: true,
      dateFormat: "DD/MM/YYYY",
      timeFormat: "HH:mm:ss",
    });
    setMockFile("t.md", "date={{date}} time={{time}}");
    const plugin = mockPluginWithoutTemplater();

    const result = await executeTemplateHandler({
      arguments: { templatePath: "t.md" },
      app: plugin.app,
      plugin,
    });

    const parsed = JSON.parse(result.content[0].text);
    // DD/MM/YYYY → matches \d{2}/\d{2}/\d{4}
    expect(parsed.content).toMatch(/date=\d{2}\/\d{2}\/\d{4}/);
    // HH:mm:ss → matches \d{2}:\d{2}:\d{2}
    expect(parsed.content).toMatch(/time=\d{2}:\d{2}:\d{2}/);
  });

  test("ignores arguments map and includes warning in response", async () => {
    setMockCoreTemplatesState({ enabled: true });
    setMockFile("t.md", "{{title}}");
    const plugin = mockPluginWithoutTemplater();

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "t.md",
        arguments: { name: "ignored" },
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warning).toMatch(/arguments map is ignored/i);
  });

  test("returns template_not_found via core Templates path when file missing", async () => {
    setMockCoreTemplatesState({ enabled: true });
    const plugin = mockPluginWithoutTemplater();

    const result = await executeTemplateHandler({
      arguments: { templatePath: "Templates/missing.md" },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.errorCode).toBe("template_not_found");
  });
});
