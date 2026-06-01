import { describe, expect, test, beforeEach } from "bun:test";
import {
  executeTemplateHandler,
  executeTemplateSchema,
} from "./executeTemplate";
import { mockApp, mockPlugin, resetMockVault, setMockFile } from "$/test-setup";

beforeEach(() => resetMockVault());

// ---------------------------------------------------------------------------
// Helpers — build a minimal fake Templater ITemplater API that records calls
// ---------------------------------------------------------------------------

type FakeTemplaterCall = {
  method: string;
  templatePath: string;
  processedContent: string;
};

function makeFakeTemplater(renderedContent = "RENDERED") {
  const calls: FakeTemplaterCall[] = [];

  const fakeTemplater = {
    _calls: calls,
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
      _targetFile: unknown,
      _runMode: unknown,
    ) => {
      return { template_file: templateFile, target_file: templateFile };
    },
    read_and_parse_template: async (config: {
      template_file: { path: string };
    }) => {
      calls.push({
        method: "read_and_parse_template",
        templatePath: config.template_file.path,
        processedContent: renderedContent,
      });
      return renderedContent;
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

  test("executes template and creates target file when createFile='true' and targetPath specified", async () => {
    setMockFile("Templates/foo.md", "Hello {{name}}");

    const fakeTemplater = makeFakeTemplater("RENDERED_CONTENT");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "Templates/foo.md",
        targetPath: "Output/note.md",
        createFile: "true",
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

    // Verify the file was actually created in the mock vault
    const createdFile =
      plugin.app.vault.getAbstractFileByPath("Output/note.md");
    expect(createdFile).not.toBeNull();
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

  test("createFile coercion accepts string 'true'", async () => {
    setMockFile("a.md", "X");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "a.md",
        targetPath: "out.md",
        createFile: "true",
      },
      app: plugin.app,
      plugin,
    });

    expect(result.isError).toBeUndefined();
    const file = plugin.app.vault.getAbstractFileByPath("out.md");
    expect(file).not.toBeNull();
  });

  test("createFile='false' does not create file even with targetPath", async () => {
    setMockFile("a.md", "X");
    const fakeTemplater = makeFakeTemplater("RENDERED");
    const plugin = mockPluginWithTemplater(fakeTemplater);

    const result = await executeTemplateHandler({
      arguments: {
        templatePath: "a.md",
        targetPath: "out.md",
        createFile: "false",
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
