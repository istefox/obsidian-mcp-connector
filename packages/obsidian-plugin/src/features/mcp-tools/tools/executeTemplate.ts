import { type } from "arktype";
import type { App, TFile } from "obsidian";
import type McpToolsPlugin from "$/main";
import { Templater, type PromptArgAccessor } from "shared";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";
import { createMutex } from "$/features/command-permissions";

// Serializes the global monkey-patch of `generate_object`: concurrent
// execute_template calls would otherwise restore each other's patch
// mid-render and corrupt the injected `mcpTools` accessor. Feature-local
// (NOT the settings mutex) so a slow template never blocks settings I/O.
const templateExecutionMutex = createMutex();

export const executeTemplateSchema = type({
  name: '"execute_template"',
  arguments: {
    templatePath: type("string>0").describe(
      "Vault-relative path to the Templater template file (e.g. 'Templates/daily.md').",
    ),
    "targetPath?": type("string").describe(
      "Optional vault-relative path where the rendered file will be created. If omitted, the template is rendered and the content returned without writing a file.",
    ),
    // Typed as string literal union — older MCP clients serialize booleans as strings.
    // Belt-and-suspenders workaround kept consistent with the rest of the codebase.
    "createFile?": type('"true"|"false"').describe(
      'Set to "true" to create a file at targetPath after rendering. Ignored if targetPath is not supplied.',
    ),
    "arguments?": type("Record<string, string>").describe(
      "Optional key-value pairs forwarded to the template via tp.user.mcpTools.prompt(argName).",
    ),
  },
}).describe(
  'Renders a Templater template. If targetPath is given and createFile="true", creates a new note at that path and returns the rendered content. Requires the Templater community plugin: `errorCode: "templater_not_installed"` if absent, `template_not_found` if the template file does not exist in the vault, `template_execution_failed` if Templater throws during rendering (the underlying error is surfaced verbatim).',
);

export type ExecuteTemplateContext = {
  arguments: {
    templatePath: string;
    targetPath?: string;
    createFile?: "true" | "false";
    arguments?: Record<string, string>;
  };
  app: App;
  plugin: McpToolsPlugin;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export async function executeTemplateHandler(
  ctx: ExecuteTemplateContext,
): Promise<ToolResult> {
  // Reach the Templater ITemplater instance the same way main.ts does:
  // plugin.app.plugins.plugins["templater-obsidian"]?.templater
  const templater = (
    ctx.plugin.app as unknown as {
      plugins: {
        plugins: {
          "templater-obsidian"?: { templater?: Templater.ITemplater };
        };
      };
    }
  ).plugins.plugins["templater-obsidian"]?.templater;

  if (!templater) {
    return errorPayload(
      "Templater plugin is not installed or not yet loaded. Install Templater from Obsidian community plugins, restart Obsidian, then retry.",
      "templater_not_installed",
      { templatePath: ctx.arguments.templatePath },
    );
  }

  // Resolve template file from vault
  const templateFile = ctx.app.vault.getAbstractFileByPath(
    ctx.arguments.templatePath,
  );
  if (!templateFile) {
    return errorPayload(
      `Template not found: ${ctx.arguments.templatePath}`,
      "template_not_found",
      { templatePath: ctx.arguments.templatePath },
    );
  }

  // createFile coercion — belt-and-suspenders: accept both boolean string "true" and missing
  const createFile = ctx.arguments.createFile === "true";
  const argMap: Record<string, string> = ctx.arguments.arguments ?? {};

  // Build the PromptArgAccessor that templates can call via tp.user.mcpTools.prompt(name)
  const prompt: PromptArgAccessor = (argName: string) => argMap[argName] ?? "";

  // Serialize the patch→render→restore window: a concurrent call would
  // restore this call's `generate_object` mid-render and corrupt the
  // injected accessor.
  return templateExecutionMutex.run(async () => {
    // Save the original generate_object so we can restore it after execution.
    // We temporarily override it to inject our `mcpTools.prompt` accessor into
    // the functions object — matching exactly what main.ts does for the REST
    // endpoint handler.
    const oldGenerateObject =
      templater.functions_generator.generate_object.bind(
        templater.functions_generator,
      );

    templater.functions_generator.generate_object = async function (
      config,
      functions_mode,
    ) {
      const functions = await oldGenerateObject(config, functions_mode);
      Object.assign(functions, { mcpTools: { prompt } });
      return functions;
    };

    try {
      // create_running_config needs a target file — use the template itself as a
      // stand-in when no targetPath is provided (same pattern as main.ts).
      const config = templater.create_running_config(
        templateFile as unknown as TFile,
        templateFile as unknown as TFile,
        Templater.RunMode.CreateNewFromTemplate,
      );

      const processedContent = await templater.read_and_parse_template(config);

      // Optionally create a vault file at targetPath.
      //
      // Issue #20 (folotp, 0.3.12 → ported here): the response includes
      // `path` so callers chaining off the response (open-in-Obsidian,
      // follow-up patch, link-rewrite) don't have to re-track the
      // targetPath themselves. `path` reflects what THIS handler operated
      // on (`ctx.arguments.targetPath`), not where Templater may have
      // moved the rendered file via `tp.file.move()` in the prelude —
      // that's a side effect of the rendering pass and produces a
      // separate file at the move target. The contract is "the path this
      // handler operated on", semantically forward-compatible with a
      // future refactor that delegates to
      // `templater.create_new_note_from_template(...)`.
      if (createFile && ctx.arguments.targetPath) {
        await ensureParentFolderExists(ctx.app, ctx.arguments.targetPath);
        await ctx.app.vault.create(ctx.arguments.targetPath, processedContent);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  message: "Template executed and file created successfully",
                  content: processedContent,
                  path: ctx.arguments.targetPath,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                message: "Template executed without creating a file",
                content: processedContent,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      // Issue #19 (folotp): surface the underlying Templater message verbatim
      // through the `isError`-style result instead of letting it propagate to
      // the registry's catch — that path wraps the error in McpError, which
      // some clients then double-prefix as `MCP error -32603: MCP error -32603:
      // <text>`. Returning `isError: true` keeps the message clean and matches
      // the convention used by the other vault tools.
      const message = error instanceof Error ? error.message : String(error);
      return errorPayload(
        `Template execution failed: ${message}`,
        "template_execution_failed",
        {
          templatePath: ctx.arguments.templatePath,
        },
      );
    } finally {
      // Always restore generate_object — even when an error is thrown — to
      // avoid leaking the mcpTools injection into subsequent template runs.
      templater.functions_generator.generate_object = oldGenerateObject;
    }
  });
}

function errorPayload(
  message: string,
  errorCode: string,
  extras: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, errorCode, ...extras }, null, 2),
      },
    ],
    isError: true,
  };
}
