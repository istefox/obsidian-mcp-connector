import { describe, expect, test } from "bun:test";
import { toolCatalogHandler } from "./toolCatalog";
import type { ToolScope } from "$/shared/types";

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
  // R-04: `call_count` is omitted entirely from the wire entry when the
  // count is 0 — the key itself is optional, not merely `0`-valued.
  call_count?: number;
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

  // R-04: `call_count: 0` has NO `call_count` key on the wire; a non-zero
  // count still reports it. Assert both sides of the omission on the same
  // shape so a regression that always includes (or always omits) the key
  // cannot slip through.
  test("R-04: call_count is omitted entirely when the count is 0, present when non-zero", async () => {
    const plugin = makePlugin({
      counters: { find_broken_links: 0 },
    });
    const result = await toolCatalogHandler({
      registry: makeRegistry(ENTRIES),
      plugin,
    });
    const catalog = parse(result);
    const entry = catalog.find((e) => e.name === "find_broken_links");
    expect(entry).toBeDefined();
    expect("call_count" in (entry as object)).toBe(false);

    const pluginWithCalls = makePlugin({
      counters: { find_broken_links: 3 },
    });
    const resultWithCalls = await toolCatalogHandler({
      registry: makeRegistry(ENTRIES),
      plugin: pluginWithCalls,
    });
    const catalogWithCalls = parse(resultWithCalls);
    const entryWithCalls = catalogWithCalls.find(
      (e) => e.name === "find_broken_links",
    );
    expect(entryWithCalls).toBeDefined();
    expect("call_count" in (entryWithCalls as object)).toBe(true);
    expect(entryWithCalls?.call_count).toBe(3);
  });

  // R-04's explicit requirement: first-sentence truncation must be
  // exercised against a description with at least three sentences, not
  // just the two-sentence fixture already used above — a truncation bug
  // that keeps the first TWO sentences (off-by-one on the split) would
  // pass a two-sentence fixture by accident.
  test("R-04: first-sentence truncation holds for a genuinely multi-sentence (3+) description", async () => {
    const entries = [
      {
        name: "multi_sentence_tool",
        enabled: false,
        description:
          "Reads a note by path. Supports partial ranges via startLine and endLine. Returns UTF-8 text content only, never binary bytes.",
      },
    ];
    const plugin = makePlugin();
    const result = await toolCatalogHandler({
      registry: makeRegistry(entries),
      plugin,
    });
    const catalog = parse(result);
    const entry = catalog.find((e) => e.name === "multi_sentence_tool");
    expect(entry?.description).toBe("Reads a note by path.");
  });
});

type ScopedCatalogEntry = Omit<CatalogEntry, "status"> & { status: string };

function parseScoped(result: {
  content: Array<{ text: string }>;
}): ScopedCatalogEntry[] {
  return JSON.parse(result.content[0].text) as ScopedCatalogEntry[];
}

/** Raw plugin data carrying a per-token `profiles` entry, as
 * `tokenPolicyStore.ts` stores it (ADR-0014 §1). */
function makeScopedPlugin(data: {
  counters?: Record<string, number>;
  profiles?: Record<string, { promoted?: string[] }>;
}): Parameters<typeof toolCatalogHandler>[0]["plugin"] {
  return {
    loadData: async () => ({
      toolLoading: {
        profile: "all",
        promoted: [],
        counters: data.counters ?? {},
        profiles: data.profiles ?? {},
      },
    }),
  };
}

const SCOPED_ENTRIES = [
  { name: "search_vault", enabled: true },
  // `enabled` mirrors the registry's global adaptive flag, which nothing
  // clears per token: a tool inside a token's active set is served
  // globally too. A promoted-for-this-token tool that the registry is NOT
  // serving is the separate case covered by its own test below.
  { name: "find_broken_links", enabled: true },
  { name: "rename_vault_file", enabled: false },
  { name: "delete_vault_file", enabled: false, userDisabled: true },
];

describe("toolCatalogHandler — per-token scope (ADR-0014, Task 6)", () => {
  test("reports active/inactive/promoted from the calling scope, and unavailable for an allowlist-excluded tool; call_count stays global (R-09)", async () => {
    const plugin = makeScopedPlugin({
      counters: { search_vault: 5, find_broken_links: 2 },
      profiles: { claude: { promoted: ["find_broken_links"] } },
    });
    const scope: ToolScope = {
      id: "claude",
      active: new Set(["search_vault", "find_broken_links", "tool_catalog"]),
      allowed: new Set(["search_vault"]),
    };

    const result = await toolCatalogHandler({
      registry: makeRegistry(SCOPED_ENTRIES),
      plugin,
      scope,
    });
    const catalog = parseScoped(result);
    const byName = Object.fromEntries(catalog.map((e) => [e.name, e]));

    // omitted regardless of scope — the ADR-0010 kill switch outranks
    // every per-token policy.
    expect(byName.delete_vault_file).toBeUndefined();

    expect(byName.search_vault.status).toBe("active");
    expect(byName.search_vault.call_count).toBe(5);

    expect(byName.find_broken_links.status).toBe("promoted");
    expect(byName.find_broken_links.call_count).toBe(2);

    // Not in `active` AND outside `allowed` — the ceiling, not "inactive".
    expect(byName.rename_vault_file.status).toBe("unavailable");
  });

  test("a globally adaptive-disabled tool reads inactive even when the token's active set holds it", async () => {
    // The registry's adaptive flag is global, so dispatch's branch (a)
    // refuses this call whatever the scope says, and branch b2 answers
    // "exists but is inactive". Reporting it `active` here would promise
    // a call that cannot run.
    const plugin = makeScopedPlugin({
      profiles: { claude: { promoted: ["find_broken_links"] } },
    });
    const scope: ToolScope = {
      id: "claude",
      // Inside `allowed`, so the `unavailable` branch cannot be what
      // makes this test pass.
      active: new Set(["find_broken_links"]),
      allowed: new Set(["find_broken_links"]),
    };

    const result = await toolCatalogHandler({
      registry: makeRegistry([{ name: "find_broken_links", enabled: false }]),
      plugin,
      scope,
    });

    expect(parseScoped(result)[0].status).toBe("inactive");
  });

  test("no scope passed ⇒ current global behaviour (unit-test ergonomics; the settings UI path)", async () => {
    // Deliberately omits `scope`: the pre-Task-6 assertions in the
    // `toolCatalogHandler` describe block above already lock this in.
    const plugin = makePlugin({ promoted: ["search_vault"] });
    const result = await toolCatalogHandler({
      registry: makeRegistry(ENTRIES),
      plugin,
    });
    const catalog = parse(result);
    expect(catalog.find((e) => e.name === "search_vault")?.status).toBe(
      "promoted",
    );
  });
});
