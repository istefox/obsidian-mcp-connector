import { Type, type } from "arktype";

/**
 * A Templater user function that retrieves the value of the specified argument from the `params.arguments` object. In this implementation, all arguments are optional.
 *
 * @param argName - The name of the argument to retrieve.
 * @param argDescription - A description of the argument.
 * @returns The value of the specified argument.
 *
 * @example
 * ```markdown
 * <% tp.mcpTools.prompt("argName", "Argument description") %>
 * ```
 */
export interface PromptArgAccessor {
  (argName: string, argDescription?: string): string;
}

export const PromptParameterSchema = type({
  name: "string",
  "description?": "string",
  "required?": "boolean",
});
export type PromptParameter = typeof PromptParameterSchema.infer;

export const PromptMetadataSchema = type({
  name: "string",
  "description?": type("string").describe("Description of the prompt"),
  "arguments?": PromptParameterSchema.array(),
});
export type PromptMetadata = typeof PromptMetadataSchema.infer;

export const PromptTemplateTag = type("'mcp-tools-prompt'");

/**
 * Strip the `#` Obsidian puts in front of a frontmatter tag.
 *
 * `metadataCache` normalises `tags` to their hashed form, so the same note can
 * read `mcp-tools-prompt` on disk and come back as `#mcp-tools-prompt` from the
 * cache — the value flips once the note is opened and saved in Obsidian. Both
 * spellings denote the same tag, and matching only the bare one made a prompt
 * disappear from `prompts/list` the moment its author edited it.
 */
export function normalizePromptTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

export const PromptFrontmatterSchema = type({
  tags: type("string[]").narrow((arr) =>
    arr.some((tag) => PromptTemplateTag.allows(normalizePromptTag(tag))),
  ),
  "description?": type("string"),
});
export type PromptFrontmatter = typeof PromptFrontmatterSchema.infer;

export const PromptValidationErrorSchema = type({
  type: "'MISSING_REQUIRED_ARG'|'INVALID_ARG_VALUE'",
  message: "string",
  "argumentName?": "string",
});
export type PromptValidationError = typeof PromptValidationErrorSchema.infer;

export const PromptExecutionResultSchema = type({
  content: "string",
  "errors?": PromptValidationErrorSchema.array(),
});
export type PromptExecutionResult = typeof PromptExecutionResultSchema.infer;

export function buildTemplateArgumentsSchema(
  args: PromptParameter[],
): Type<Record<string, "string" | "string?">> {
  return type(
    Object.fromEntries(
      args.map((arg) => [arg.name, arg.required ? "string" : "string?"]),
    ) as Record<string, "string" | "string?">,
  );
}
