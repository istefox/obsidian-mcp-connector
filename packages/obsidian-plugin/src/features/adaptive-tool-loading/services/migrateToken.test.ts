import { describe, expect, test } from "bun:test";
import { ALWAYS_ACTIVE_TOOLS, CORE_SET, META_TOOLS } from "../constants";
import { resolveToolScope } from "../resolveToolScope";

type PluginDataLike = {
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
};

type MigrateTokenModule = {
  migrateTokenToAdaptive: (
    plugin: PluginDataLike,
    tokenId: string,
    allNames: string[],
  ) => Promise<string[]>;
  revertTokenToAll: (plugin: PluginDataLike, tokenId: string) => Promise<void>;
};

async function subject(): Promise<MigrateTokenModule> {
  const modulePath = "./migrateToken";
  return import(modulePath) as Promise<MigrateTokenModule>;
}

type TokenPolicy = {
  profile: "all" | "core" | "adaptive";
  promoted: string[];
  allowed: string[] | null;
};

type ToolLoadingSlice = {
  profile: "all" | "core" | "adaptive";
  promoted: string[];
  counters: Record<string, number>;
  profiles: Record<string, TokenPolicy>;
  everCalled?: Record<string, string[]>;
};

function makePlugin(data: Record<string, unknown>) {
  let store = structuredClone(data);
  let loads = 0;
  let saves = 0;
  return {
    plugin: {
      loadData: async () => {
        loads += 1;
        return structuredClone(store);
      },
      saveData: async (next: unknown) => {
        saves += 1;
        store = structuredClone(next as Record<string, unknown>);
      },
    },
    getStore: () => structuredClone(store),
    replaceStore: (next: Record<string, unknown>) => {
      store = structuredClone(next);
    },
    resetCounts: () => {
      loads = 0;
      saves = 0;
    },
    get loads() {
      return loads;
    },
    get saves() {
      return saves;
    },
  };
}

const TOKENS = [
  { id: "default", label: "Default", token: "a".repeat(43), createdAt: 1 },
  { id: "claude", label: "claude.ai", token: "b".repeat(43), createdAt: 2 },
];

const ALL_NAMES = [
  ...new Set([
    ...CORE_SET,
    ...ALWAYS_ACTIVE_TOOLS,
    ...META_TOOLS,
    "existing_promotion",
    "called_tool",
    "called_later",
    "unused_tool",
  ]),
];

function fixture(overrides: Partial<ToolLoadingSlice> = {}) {
  const toolLoading: ToolLoadingSlice = {
    profile: "all",
    promoted: ["existing_promotion"],
    counters: {},
    profiles: {
      default: {
        profile: "all",
        promoted: ["existing_promotion"],
        allowed: null,
      },
      claude: {
        profile: "core",
        promoted: ["called_later"],
        allowed: null,
      },
    },
    everCalled: { default: ["called_tool"] },
    ...overrides,
  };
  return { mcpTransport: { tokens: TOKENS }, toolLoading };
}

function readSlice(harness: ReturnType<typeof makePlugin>): ToolLoadingSlice {
  return harness.getStore().toolLoading as ToolLoadingSlice;
}

function expectedDeactivated(
  policy: TokenPolicy,
  everCalled: string[],
): string[] {
  const promoted = [...new Set([...policy.promoted, ...everCalled])];
  const current = resolveToolScope(
    "default",
    policy,
    ALL_NAMES,
    new Set(),
  ).active;
  const migrated = resolveToolScope(
    "default",
    { ...policy, profile: "adaptive", promoted },
    ALL_NAMES,
    new Set(),
  ).active;
  return ALL_NAMES.filter((name) => current.has(name) && !migrated.has(name));
}

describe("migrateTokenToAdaptive (R-03, R-04)", () => {
  test("writes the adaptive profile, seeds promotions, and returns the preview deactivations", async () => {
    const { migrateTokenToAdaptive } = await subject();
    const harness = makePlugin(fixture());
    const before = readSlice(harness).profiles.default!;

    const deactivated = await migrateTokenToAdaptive(
      harness.plugin,
      "default",
      ALL_NAMES,
    );

    const policy = readSlice(harness).profiles.default!;
    expect(policy.profile).toBe("adaptive");
    expect(policy.promoted).toEqual(["existing_promotion", "called_tool"]);
    expect(deactivated).toEqual(expectedDeactivated(before, ["called_tool"]));
  });

  test("migrating tokens[0] updates the legacy mirror without mirror-specific migration behavior", async () => {
    const { migrateTokenToAdaptive } = await subject();
    const harness = makePlugin(fixture());

    await migrateTokenToAdaptive(harness.plugin, "default", ALL_NAMES);

    const slice = readSlice(harness);
    expect(slice.profile).toBe("adaptive");
    expect(slice.promoted).toEqual(["existing_promotion", "called_tool"]);
    expect(slice.promoted).toEqual(slice.profiles.default?.promoted);
  });

  test("migrating tokens[1] leaves the legacy mirror byte-for-byte unchanged", async () => {
    const { migrateTokenToAdaptive } = await subject();
    const harness = makePlugin(fixture());
    const mirrorBefore = {
      profile: readSlice(harness).profile,
      promoted: readSlice(harness).promoted,
    };

    await migrateTokenToAdaptive(harness.plugin, "claude", ALL_NAMES);

    const slice = readSlice(harness);
    expect({ profile: slice.profile, promoted: slice.promoted }).toEqual(
      mirrorBefore,
    );
    expect(slice.profiles.claude?.profile).toBe("adaptive");
  });

  test("a missing profiles entry starts from the new-token adaptive policy and cannot widen first", async () => {
    const { migrateTokenToAdaptive } = await subject();
    const data = fixture();
    delete data.toolLoading.profiles.claude;
    data.toolLoading.everCalled = { claude: ["called_tool"] };
    const harness = makePlugin(data);

    const deactivated = await migrateTokenToAdaptive(
      harness.plugin,
      "claude",
      ALL_NAMES,
    );

    expect(deactivated).toEqual([]);
    expect(readSlice(harness).profiles.claude).toEqual({
      profile: "adaptive",
      promoted: ["called_tool"],
      allowed: null,
    });
  });
});

describe("revertTokenToAll (R-05)", () => {
  test("revert restores all, updates the mirror token, and preserves history byte-for-byte", async () => {
    const { migrateTokenToAdaptive, revertTokenToAll } = await subject();
    const harness = makePlugin(fixture());
    await migrateTokenToAdaptive(harness.plugin, "default", ALL_NAMES);
    const historyBefore = JSON.stringify(readSlice(harness).everCalled);

    await revertTokenToAll(harness.plugin, "default");

    const slice = readSlice(harness);
    expect(slice.profiles.default?.profile).toBe("all");
    expect(slice.profile).toBe("all");
    expect(slice.promoted).toEqual(slice.profiles.default?.promoted);
    expect(JSON.stringify(slice.everCalled)).toBe(historyBefore);
  });

  test("migrate, revert, then migrate is stable and reads the current history again", async () => {
    const { migrateTokenToAdaptive, revertTokenToAll } = await subject();
    const harness = makePlugin(fixture());

    await migrateTokenToAdaptive(harness.plugin, "default", ALL_NAMES);
    await revertTokenToAll(harness.plugin, "default");
    const next = harness.getStore();
    (next.toolLoading as ToolLoadingSlice).everCalled = {
      default: ["called_tool", "called_later"],
    };
    harness.replaceStore(next);

    await migrateTokenToAdaptive(harness.plugin, "default", ALL_NAMES);

    expect(readSlice(harness).profiles.default?.promoted).toEqual([
      "existing_promotion",
      "called_tool",
      "called_later",
    ]);
  });

  test("allowed survives migration and reversion untouched", async () => {
    const { migrateTokenToAdaptive, revertTokenToAll } = await subject();
    const data = fixture();
    data.toolLoading.profiles.default!.allowed = [
      "existing_promotion",
      "unused_tool",
    ];
    const harness = makePlugin(data);
    const allowedBefore = JSON.stringify(
      readSlice(harness).profiles.default?.allowed,
    );

    await migrateTokenToAdaptive(harness.plugin, "default", ALL_NAMES);
    expect(JSON.stringify(readSlice(harness).profiles.default?.allowed)).toBe(
      allowedBefore,
    );
    await revertTokenToAll(harness.plugin, "default");
    expect(JSON.stringify(readSlice(harness).profiles.default?.allowed)).toBe(
      allowedBefore,
    );
  });

  test("each operation performs exactly one read and one write through the tool-loading update", async () => {
    const { migrateTokenToAdaptive, revertTokenToAll } = await subject();
    const harness = makePlugin(fixture());

    await migrateTokenToAdaptive(harness.plugin, "default", ALL_NAMES);
    expect(harness.loads).toBe(1);
    expect(harness.saves).toBe(1);

    harness.resetCounts();
    await revertTokenToAll(harness.plugin, "default");
    expect(harness.loads).toBe(1);
    expect(harness.saves).toBe(1);
  });
});
