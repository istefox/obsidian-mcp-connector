import { type } from "arktype";
import { errorText } from "../services/responseBuilders";
import { TFile, type App } from "obsidian";
import { moment } from "obsidian";
import type McpToolsPlugin from "$/main";
import { Templater, type PromptArgAccessor } from "shared";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";
import { createMutex } from "$/features/command-permissions";

// Runtime shape of the core Templates internal plugin. `app.internalPlugins`
// is not typed in obsidian.d.ts — same cast pattern as AppWithPlugins above.
interface AppWithInternalPlugins {
  internalPlugins?: {
    plugins?: {
      templates?: {
        enabled?: boolean;
        instance?: {
          options?: { dateFormat?: string; timeFormat?: string };
        };
      };
    };
  };
}

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
  'Renders a template via Templater when installed, else the core Templates plugin ({{title}}/{{date}}/{{time}} only). With targetPath and createFile="true" also creates the note at targetPath. Error codes: templater_not_installed, template_not_found, template_execution_failed, core_templates_execution_failed. `arguments` is Templater-only (warning on the core path).',
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
    // Fallback to core Templates when Templater is absent.
    const coreTemplates = (ctx.app as unknown as AppWithInternalPlugins)
      .internalPlugins?.plugins?.templates;
    if (coreTemplates?.enabled) {
      return runCoreTemplates(ctx, coreTemplates.instance?.options);
    }
    return errorPayload(
      "No template engine found. Install Templater for dynamic templates, or enable the core Templates plugin for basic {{title}}/{{date}}/{{time}} substitution.",
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
  if (!(templateFile instanceof TFile)) {
    return errorPayload(
      `Template path is a folder: ${ctx.arguments.templatePath}`,
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
        templateFile,
        templateFile,
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
              text: JSON.stringify({
                message: "Template executed and file created successfully",
                content: processedContent,
                path: ctx.arguments.targetPath,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              message: "Template executed without creating a file",
              content: processedContent,
            }),
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

async function runCoreTemplates(
  ctx: ExecuteTemplateContext,
  options: { dateFormat?: string; timeFormat?: string } | undefined,
): Promise<ToolResult> {
  const {
    templatePath,
    targetPath,
    createFile: createFileArg,
    arguments: argMap,
  } = ctx.arguments;

  const templateFile = ctx.app.vault.getAbstractFileByPath(templatePath);
  if (!templateFile) {
    return errorPayload(
      `Template not found: ${templatePath}`,
      "template_not_found",
      { templatePath },
    );
  }
  if (!(templateFile instanceof TFile)) {
    return errorPayload(
      `Template path is a folder: ${templatePath}`,
      "template_not_found",
      { templatePath },
    );
  }

  let raw: string;
  try {
    raw = await ctx.app.vault.read(templateFile);
  } catch (err) {
    return errorPayload(
      `Core Templates could not read template file: ${err instanceof Error ? err.message : String(err)}`,
      "core_templates_execution_failed",
      { templatePath },
    );
  }

  // Compute the three substitution values core Templates supports.
  const dateFormat = options?.dateFormat ?? "YYYY-MM-DD";
  const timeFormat = options?.timeFormat ?? "HH:mm";

  // {{title}}: targetPath basename without extension when provided, else template basename.
  const baseName = (p: string) => {
    const name = p.split("/").pop() ?? p;
    return name.replace(/\.[^.]+$/, "");
  };
  const title = targetPath ? baseName(targetPath) : baseName(templatePath);

  const processed = raw
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{date\}\}/g, moment().format(dateFormat))
    .replace(/\{\{time\}\}/g, moment().format(timeFormat));

  const createFile = createFileArg === "true";
  const hasArgs = argMap && Object.keys(argMap).length > 0;
  const warning = hasArgs
    ? "arguments map is ignored by the core Templates engine (Templater-specific)"
    : undefined;

  if (createFile && targetPath) {
    await ensureParentFolderExists(ctx.app, targetPath);
    await ctx.app.vault.create(targetPath, processed);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            message: "Template executed and file created successfully",
            content: processed,
            path: targetPath,
            ...(warning ? { warning } : {}),
          }),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          message: "Template executed without creating a file",
          content: processed,
          ...(warning ? { warning } : {}),
        }),
      },
    ],
  };
}

function errorPayload(
  message: string,
  errorCode: string,
  extras: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return errorText(JSON.stringify({ error: message, errorCode, ...extras }));
}
