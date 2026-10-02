import { type } from "arktype";
import { errorJson } from "../services/responseBuilders";
import { type App, type TFile } from "obsidian";
import { resolveTFile } from "../services/resolveTFile";
import { withVaultWriteLock } from "$/features/mcp-tools/services/vaultWriteLock";
import { momentFn } from "$/shared/typedMoment";
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
      "Optional vault-relative path of the note to create. With createFile true, the note is created first and Templater renders against it, so tp.file.title/folder/path and on_all_templates_executed hooks see the new note, as with Templater's own 'Create new note from template'. If omitted, the template is rendered and returned without writing a file, and tp.file.* describe the template itself.",
    ),
    // A real boolean: the registry's coerceBooleanParams turns the "true" /
    // "false" strings some clients still send into booleans before the
    // schema runs (#444), so the string-literal union is no longer needed.
    "createFile?": type("boolean").describe(
      "Set to true to create the note at targetPath. Ignored if targetPath is not supplied. Default false.",
    ),
    "arguments?": type("Record<string, string>").describe(
      "Optional key-value pairs forwarded to the template via tp.user.mcpTools.prompt(argName).",
    ),
  },
}).describe(
  "Renders a template via Templater when installed, else the core Templates plugin ({{title}}/{{date}}/{{time}} only). With targetPath and createFile true also creates the note at targetPath and renders against it (tp.file.* = the new note). Without a target, tp.file.* describe the template. Error codes: templater_not_installed, template_not_found, file_exists, template_execution_failed, core_templates_execution_failed. `arguments` is Templater-only (warning on the core path).",
);

export type ExecuteTemplateContext = {
  arguments: {
    templatePath: string;
    targetPath?: string;
    createFile?: boolean;
    arguments?: Record<string, string>;
  };
  app: App;
  plugin: McpToolsPlugin;
};

/**
 * Templater brackets every render it owns between `start_templater_task` and
 * `end_templater_task`; the latter is what fires the callbacks a template
 * registered through `tp.hooks.on_all_templates_executed` once no task is
 * pending. Both are `private` in Templater's TypeScript (so absent from the
 * shared ITemplater surface) but are plain instance methods at runtime,
 * present since Templater 2.0.0 (read from `src/core/Templater.ts` at tags
 * 1.16.0 → absent, 2.0.0 → present). Optional-called so an older Templater
 * degrades to the pre-#541 behaviour (hooks fire with the next
 * Templater-owned task) instead of throwing.
 */
type TemplaterTaskBookkeeping = {
  start_templater_task?: (path: string) => void;
  end_templater_task?: (path: string) => Promise<void>;
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
    return errorJson(
      "No template engine found. Install Templater for dynamic templates, or enable the core Templates plugin for basic {{title}}/{{date}}/{{time}} substitution.",
      "templater_not_installed",
      { templatePath: ctx.arguments.templatePath },
    );
  }

  // Resolve template file from vault
  const resolved = resolveTFile(ctx.app.vault, ctx.arguments.templatePath);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson(
          `Template not found: ${ctx.arguments.templatePath}`,
          "template_not_found",
          { templatePath: ctx.arguments.templatePath },
        )
      : errorJson(
          `Template path is a folder: ${ctx.arguments.templatePath}`,
          "template_not_found",
          { templatePath: ctx.arguments.templatePath },
        );
  }
  const templateFile = resolved.file;

  const createFile = ctx.arguments.createFile === true;
  const targetPath =
    createFile && ctx.arguments.targetPath ? ctx.arguments.targetPath : null;
  const argMap: Record<string, string> = ctx.arguments.arguments ?? {};

  // #541. Templater's own "Create new note from template" creates the EMPTY
  // note first and renders against it, so `tp.file.title` / `.folder` /
  // `.path`, `tp.config.target_file` and `on_all_templates_executed` hooks
  // all describe the note being created. Rendering against the template and
  // writing the result afterwards (the pre-2.8 behaviour) gave every one of
  // them the template instead: `# <% tp.file.title %>` produced the
  // template's name as H1, and a hook that edits `target_file` would have
  // edited the template. The create is its own locked step: the render that
  // follows runs user code of unbounded duration and must not hold the
  // vault-wide write lock.
  let targetFile: TFile | null = null;
  if (targetPath !== null) {
    const created = await withVaultWriteLock(
      async (): Promise<TFile | "exists"> => {
        if (ctx.app.vault.getAbstractFileByPath(targetPath)) return "exists";
        await ensureParentFolderExists(ctx.app, targetPath);
        return ctx.app.vault.create(targetPath, "");
      },
    );
    if (created === "exists") {
      return errorJson(
        `Target already exists: ${targetPath}. execute_template creates a new note and never overwrites one; delete or rename the existing file first, or pick another targetPath.`,
        "file_exists",
        { templatePath: ctx.arguments.templatePath, path: targetPath },
      );
    }
    targetFile = created;
  }

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

    const bookkeeping = templater as unknown as TemplaterTaskBookkeeping;
    // Keyed by the path at creation time, as Templater does: a `tp.file.move`
    // during the render renames the TFile, and the task must still be the one
    // that was started.
    const taskPath = targetFile?.path;
    if (taskPath !== undefined) bookkeeping.start_templater_task?.(taskPath);

    try {
      // With a target, render against the new note (#541). Without one,
      // `create_running_config` still needs a target file, and the template
      // itself is the stand-in: in render-only mode `tp.file.*` describe the
      // template, which the tool description says out loud.
      const config = templater.create_running_config(
        templateFile,
        targetFile ?? templateFile,
        Templater.RunMode.CreateNewFromTemplate,
      );

      const processedContent = await templater.read_and_parse_template(config);

      if (targetFile !== null) {
        // The TFile is written through, not `targetPath`: a `tp.file.move()`
        // in the template has already renamed it, and writing by the
        // original path would recreate the note where it was moved from.
        await ctx.app.vault.modify(targetFile, processedContent);
        // The same workspace event Templater's own command emits, for
        // plugins that listen to it. `trigger` is a Workspace (Events)
        // method; optional-called for the test mock's sake.
        (
          ctx.app.workspace as unknown as {
            trigger?: (name: string, ...data: unknown[]) => void;
          }
        ).trigger?.("templater:new-note-from-template", {
          file: targetFile,
          content: processedContent,
        });
        if (taskPath !== undefined) {
          await bookkeeping.end_templater_task?.(taskPath);
        }
        // Issue #20 (folotp): `path` lets a caller chain off the response
        // (open-in-Obsidian, follow-up patch, link-rewrite) without
        // re-tracking the target. It is the note's FINAL path: identical to
        // `targetPath` unless the template moved the note with
        // `tp.file.move()`, in which case this is where it ended up.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: "Template executed and file created successfully",
                content: processedContent,
                path: targetFile.path,
                ...(targetFile.path !== targetPath
                  ? { requestedPath: targetPath }
                  : {}),
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
      // A failed render must not leave the empty note behind: Templater's
      // own command deletes it too. Best-effort — the render error is the
      // one the caller needs to see.
      if (targetFile !== null) {
        try {
          await ctx.app.vault.delete(targetFile);
        } catch {
          // The note is gone already or cannot be removed; the render error
          // below still reaches the caller.
        }
        if (taskPath !== undefined) {
          await bookkeeping.end_templater_task?.(taskPath);
        }
      }
      return errorJson(
        `Template execution failed: ${message}`,
        "template_execution_failed",
        {
          templatePath: ctx.arguments.templatePath,
          ...(targetPath !== null ? { path: targetPath } : {}),
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

  const resolved = resolveTFile(ctx.app.vault, templatePath);
  if (!resolved.ok) {
    return resolved.reason === "not_found"
      ? errorJson(`Template not found: ${templatePath}`, "template_not_found", {
          templatePath,
        })
      : errorJson(
          `Template path is a folder: ${templatePath}`,
          "template_not_found",
          { templatePath },
        );
  }
  const templateFile = resolved.file;

  let raw: string;
  try {
    raw = await ctx.app.vault.read(templateFile);
  } catch (err) {
    return errorJson(
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
    .replace(/\{\{date\}\}/g, momentFn().format(dateFormat))
    .replace(/\{\{time\}\}/g, momentFn().format(timeFormat));

  const createFile = createFileArg === true;
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
