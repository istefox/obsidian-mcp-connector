import { type } from "arktype";
import type { App } from "obsidian";
import { logger } from "$/shared/logger";

export const listBookmarksSchema = type({
  name: '"list_bookmarks"',
  arguments: {
    "include_types?": type(
      '("file" | "folder" | "search" | "heading" | "block" | "group")[]',
    ).describe(
      'Optional filter: only include items of these types. When `"group"` is excluded, group children are flattened to the parent level instead of being nested under a group node. Omit for all types.',
    ),
  },
}).describe(
  "Returns the native Obsidian bookmarks (core Bookmarks plugin) with their full hierarchy: groups, file bookmarks, folder bookmarks, searches, heading anchors, and block refs. `enabled: false` when the Bookmarks core plugin is disabled. `total_items` counts non-group items recursively. Always read-only.",
);

export type ListBookmarksContext = {
  arguments: {
    include_types?: Array<
      "file" | "folder" | "search" | "heading" | "block" | "group"
    >;
  };
  app: App;
};

type BookmarkItem =
  | { type: "file"; path: string; title?: string }
  | { type: "folder"; path: string; title?: string }
  | { type: "search"; query: string; title?: string }
  | { type: "heading"; path: string; heading: string; title?: string }
  | { type: "block"; path: string; id: string; title?: string }
  | { type: "group"; title: string; items: BookmarkItem[] };

function toTypedItem(raw: Record<string, unknown>): BookmarkItem | null {
  const t = raw["type"] as string | undefined;
  if (!t) return null;
  if (t === "group") {
    const children = Array.isArray(raw["items"])
      ? (raw["items"] as Record<string, unknown>[])
          .map(toTypedItem)
          .filter((x): x is BookmarkItem => x !== null)
      : [];
    return {
      type: "group",
      title: String(raw["title"] ?? ""),
      items: children,
    };
  }
  if (t === "file" || t === "folder")
    return {
      type: t,
      path: String(raw["path"] ?? ""),
      title: raw["title"] != null ? String(raw["title"]) : undefined,
    };
  if (t === "search")
    return {
      type: "search",
      query: String(raw["query"] ?? ""),
      title: raw["title"] != null ? String(raw["title"]) : undefined,
    };
  if (t === "heading")
    return {
      type: "heading",
      path: String(raw["path"] ?? ""),
      heading: String(raw["subpath"] ?? raw["heading"] ?? ""),
      title: raw["title"] != null ? String(raw["title"]) : undefined,
    };
  if (t === "block")
    return {
      type: "block",
      path: String(raw["path"] ?? ""),
      id: String(raw["subpath"] ?? raw["id"] ?? ""),
      title: raw["title"] != null ? String(raw["title"]) : undefined,
    };
  logger.warn("list_bookmarks: unrecognized bookmark type, skipping", {
    type: t,
  });
  return null;
}

function filterItems(
  items: BookmarkItem[],
  include: Set<string>,
): BookmarkItem[] {
  const out: BookmarkItem[] = [];
  for (const item of items) {
    if (item.type === "group") {
      const children = filterItems(item.items, include);
      if (include.has("group")) {
        out.push({ ...item, items: children });
      } else {
        // flatten group children to parent level
        out.push(...children);
      }
    } else if (include.has(item.type)) {
      out.push(item);
    }
  }
  return out;
}

function countItems(items: BookmarkItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.type === "group") n += countItems(item.items);
    else n++;
  }
  return n;
}

export async function listBookmarksHandler(
  ctx: ListBookmarksContext,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const bkPlugin = (
    ctx.app as unknown as {
      internalPlugins: {
        plugins: {
          bookmarks?: {
            enabled: boolean;
            instance?: { items: unknown[] };
          };
        };
      };
    }
  ).internalPlugins.plugins.bookmarks;

  if (!bkPlugin?.enabled) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ enabled: false, total_items: 0, items: [] }),
        },
      ],
    };
  }
  if (!bkPlugin.instance) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            enabled: true,
            total_items: 0,
            items: [],
            note: "Bookmarks plugin not yet initialized",
          }),
        },
      ],
    };
  }

  const rawItems = bkPlugin.instance.items as Record<string, unknown>[];
  let items: BookmarkItem[] = rawItems
    .map(toTypedItem)
    .filter((x): x is BookmarkItem => x !== null);

  if (ctx.arguments.include_types && ctx.arguments.include_types.length > 0) {
    const include = new Set<string>(ctx.arguments.include_types);
    items = filterItems(items, include);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          enabled: true,
          total_items: countItems(items),
          items,
        }),
      },
    ],
  };
}
