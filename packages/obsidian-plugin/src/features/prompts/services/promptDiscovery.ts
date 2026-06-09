import type { App } from "obsidian";
import { TFile } from "obsidian";
import { PromptFrontmatterSchema } from "shared";
import type { PromptListEntry } from "$/features/mcp-transport/services/promptRegistry";

const TWO_ARG_PATTERN = /<% tp\.mcpTools\.prompt\("([^"]+)",\s*"([^"]*)"\) %>/g;
const ONE_ARG_PATTERN = /<% tp\.mcpTools\.prompt\("([^"]+)"\) %>/g;

export function parseArgDeclarations(
  body: string,
): Array<{ name: string; description: string }> {
  const seen = new Set<string>();
  const results: Array<{ name: string; description: string }> = [];

  for (const m of body.matchAll(TWO_ARG_PATTERN)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      results.push({ name, description: m[2] });
    }
  }

  for (const m of body.matchAll(ONE_ARG_PATTERN)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      results.push({ name, description: "" });
    }
  }

  return results;
}

export async function discoverPrompts(app: App): Promise<PromptListEntry[]> {
  const files = app.vault.getMarkdownFiles().filter((f) => {
    if (!f.path.startsWith("Prompts/")) return false;
    const rest = f.path.slice("Prompts/".length);
    return !rest.includes("/");
  });

  const entries: PromptListEntry[] = [];

  for (const file of files) {
    const cache = app.metadataCache.getFileCache(
      file as unknown as InstanceType<typeof TFile>,
    );
    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
    if (!fm) continue;

    const rawTags = fm.tags;
    const tagsArray = Array.isArray(rawTags)
      ? rawTags
      : typeof rawTags === "string"
        ? [rawTags]
        : null;
    if (!tagsArray) continue;

    try {
      PromptFrontmatterSchema.assert({ ...fm, tags: tagsArray });
    } catch {
      continue;
    }

    const content = await app.vault.cachedRead(
      file as unknown as InstanceType<typeof TFile>,
    );
    const args = parseArgDeclarations(content);
    const name = file.basename;

    entries.push({
      name,
      description:
        typeof fm.description === "string" ? fm.description : undefined,
      arguments: args.map((a) => ({
        name: a.name,
        description: a.description,
        required: false as const,
      })),
    });
  }

  return entries;
}
