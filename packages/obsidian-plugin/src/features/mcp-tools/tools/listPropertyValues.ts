import { type } from "arktype";
import type { App, TFile } from "obsidian";

export const listPropertyValuesSchema = type({
  name: '"list_property_values"',
  arguments: {
    key: type("string>0").describe(
      "Frontmatter (YAML) key whose distinct values to enumerate across the vault.",
    ),
    "folder?": type("string").describe(
      "Optional vault-relative folder prefix; only notes under it are scanned. Empty/omitted = whole vault.",
    ),
    "limit?": type("number>0").describe(
      "Max distinct values to return (default 500), ordered by count descending. If more exist, `truncated` is true and `totalDistinct` reports the full count.",
    ),
  },
}).describe(
  "Enumerates the distinct values of a single frontmatter (note property) key across the vault, with per-value occurrence counts and native types preserved. List-valued frontmatter contributes each element. Scans Obsidian's metadata cache only (no file I/O), so it scales to large vaults. To find which notes carry a given value, use `search_vault` with a DQL/JsonLogic query. Always read-only.",
);

export type ListPropertyValuesContext = {
  arguments: { key: string; folder?: string; limit?: number };
  app: App;
};

export async function listPropertyValuesHandler(
  ctx: ListPropertyValuesContext,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
}> {
  const { key } = ctx.arguments;
  const limit = ctx.arguments.limit ?? 500;
  let prefix = ctx.arguments.folder ?? "";
  if (prefix && !prefix.endsWith("/")) prefix = prefix + "/";

  // Distinct-value counter keyed by a stable JSON serialisation so native
  // types stay distinct (number 5 vs string "5") while still groupable.
  // The original native value is kept alongside the count.
  const counts = new Map<string, { value: unknown; count: number }>();

  const record = (v: unknown): void => {
    const k = JSON.stringify(v);
    const entry = counts.get(k);
    if (entry) entry.count++;
    else counts.set(k, { value: v, count: 1 });
  };

  for (const file of ctx.app.vault.getMarkdownFiles()) {
    if (prefix && !file.path.startsWith(prefix)) continue;
    const fm = ctx.app.metadataCache.getFileCache(file as TFile)
      ?.frontmatter as Record<string, unknown> | undefined;
    if (!fm || !Object.prototype.hasOwnProperty.call(fm, key)) continue;
    const raw = fm[key];
    if (Array.isArray(raw)) {
      for (const el of raw) record(el);
    } else {
      record(raw);
    }
  }

  const all = [...counts.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return JSON.stringify(a.value).localeCompare(JSON.stringify(b.value), "en");
  });
  const totalDistinct = all.length;
  const values = all.slice(0, limit);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { key, values, truncated: totalDistinct > limit, totalDistinct },
          null,
          2,
        ),
      },
    ],
  };
}
