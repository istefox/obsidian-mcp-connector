import { describe, expect, test } from "bun:test";
import { toolCatalogHandler } from "./toolCatalog";

function makeRegistry(
  entries: {
    name: string;
    description?: string;
    enabled: boolean;
    userDisabled?: boolean;
  }[],
): Parameters<typeof toolCatalogHandler>[0]["registry"] {
  return {
    listAll: () =>
      entries.map((e) => ({
        name: e.name,
        description: e.description ?? `${e.name} description`,
        enabled: e.enabled,
        userDisabled: e.userDisabled ?? false,
      })),
  };
}

function makePlugin(toolLoading?: {
  counters?: Record<string, number>;
  promoted?: string[];
}): Parameters<typeof toolCatalogHandler>[0]["plugin"] {
  return {
    loadData: async () => (toolLoading ? { toolLoading } : {}),
  };
}

type CatalogEntry = {
  name: string;
  status: "active" | "inactive" | "promoted";
  call_count: number;
  description?: string;
};

function parse(result: { content: Array<{ text: string }> }): CatalogEntry[] {
  return JSON.parse(result.content[0].text) as CatalogEntry[];
}

const ENTRIES = [
  { name: "search_vault", enabled: true },
  {
    name: "find_broken_links",
    enabled: false,
    description:
      "Finds broken internal links across the vault. Second sentence with more detail that should be dropped.",
  },
  { name: "delete_vault_file", enabled: false, userDisabled: true },
];

describe("toolCatalogHandler", () => {
  test("omits user-disabled tools entirely (SPEC success criterion)", async () => {
    const plugin = makePlugin();
    const result = await toolCatalogHandler({
      registry: makeRegistry(ENTRIES),
      plugin,
    });
    const catalog = parse(result);
    expect(catalog.map((e) => e.name)).not.toContain("delete_vault_file");
    expect(catalog.map((e) => e.name)).toEqual([
      "search_vault",
      "find_broken_links",
    ]);
  });

  test("active tool gets status active", async () => {
    const plugin = makePlugin();
    const result = await toolCatalogHandler({
      registry: makeRegistry(ENTRIES),
      plugin,
    });
    const catalog = parse(result);
    const entry = catalog.find((e) => e.name === "search_vault");
    expect(entry?.status).toBe("active");
  });

  test("active tool that is promoted gets status promoted", async () => {
    const plugin = makePlugin({ promoted: ["search_vault"] });
    const result = await toolCatalogHandler({
      registry: makeRegistry(ENTRIES),
      plugin,
    });
    const catalog = parse(result);
    const entry = catalog.find((e) => e.name === "search_vault");
    expect(entry?.status).toBe("promoted");
  });

  test("inactive (adaptive) tool gets status inactive with call_count and first-sentence description", async () => {
    const plugin = makePlugin({
      counters: { find_broken_links: 3 },
    });
    const result = await toolCatalogHandler({
      registry: makeRegistry(ENTRIES),
      plugin,
    });
    const catalog = parse(result);
    const entry = catalog.find((e) => e.name === "find_broken_links");
    expect(entry?.status).toBe("inactive");
    expect(entry?.call_count).toBe(3);
    expect(entry?.description).toBe(
      "Finds broken internal links across the vault.",
    );
  });
});
