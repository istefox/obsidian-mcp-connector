import { describe, expect, test } from "bun:test";
import { ALWAYS_ACTIVE_TOOLS, CORE_SET, META_TOOLS } from "../constants";
import { resolveToolScope } from "../resolveToolScope";

type TokenPolicy = {
  profile: "all" | "core" | "adaptive";
  promoted: string[];
  allowed: string[] | null;
};

type MigrationPlan = {
  promotedAfter: string[];
  deactivated: string[];
};

type PlanMigrationModule = {
  planMigration: (
    allNames: string[],
    policy: TokenPolicy,
    everCalled: string[],
  ) => MigrationPlan;
};

async function subject(): Promise<PlanMigrationModule> {
  const modulePath = "./planMigration";
  return import(modulePath) as Promise<PlanMigrationModule>;
}

const unique = (names: readonly string[]): string[] => [...new Set(names)];

const ALL_NAMES = unique([
  ...CORE_SET,
  ...ALWAYS_ACTIVE_TOOLS,
  ...META_TOOLS,
  "existing_promotion",
  "called_tool",
  "unused_tool",
]);

function expectedDeactivated(
  allNames: string[],
  policy: TokenPolicy,
  everCalled: string[],
): string[] {
  const promotedAfter = [...new Set([...policy.promoted, ...everCalled])];
  const current = resolveToolScope(
    "migration-preview",
    policy,
    allNames,
    new Set(),
  ).active;
  const migrated = resolveToolScope(
    "migration-preview",
    { ...policy, profile: "adaptive", promoted: promotedAfter },
    allNames,
    new Set(),
  ).active;
  return allNames.filter((name) => current.has(name) && !migrated.has(name));
}

describe("planMigration (R-03, R-08)", () => {
  test("promotedAfter is the first-seen union of existing promotions and call history", async () => {
    const { planMigration } = await subject();
    const policy: TokenPolicy = {
      profile: "all",
      promoted: ["existing_promotion", "called_tool", "existing_promotion"],
      allowed: null,
    };

    const plan = planMigration(ALL_NAMES, policy, [
      "called_tool",
      "unused_tool",
      "called_tool",
    ]);

    expect(plan.promotedAfter).toEqual([
      "existing_promotion",
      "called_tool",
      "unused_tool",
    ]);
  });

  test("deactivated is exactly the current scope minus the migrated scope", async () => {
    const { planMigration } = await subject();
    const policy: TokenPolicy = {
      profile: "all",
      promoted: ["existing_promotion"],
      allowed: null,
    };

    const plan = planMigration(ALL_NAMES, policy, ["called_tool"]);

    expect(plan.deactivated).toEqual(
      expectedDeactivated(ALL_NAMES, policy, ["called_tool"]),
    );
  });

  test("a tool present in everCalled is never deactivated", async () => {
    const { planMigration } = await subject();
    const policy: TokenPolicy = {
      profile: "all",
      promoted: [],
      allowed: null,
    };

    const plan = planMigration(ALL_NAMES, policy, ["called_tool"]);

    expect(plan.deactivated).not.toContain("called_tool");
  });

  test("core, always-active, and meta-tools are never deactivated", async () => {
    const { planMigration } = await subject();
    const policy: TokenPolicy = {
      profile: "all",
      promoted: [],
      allowed: null,
    };

    const plan = planMigration(ALL_NAMES, policy, []);

    for (const protectedName of unique([
      ...CORE_SET,
      ...ALWAYS_ACTIVE_TOOLS,
      ...META_TOOLS,
    ])) {
      expect(plan.deactivated).not.toContain(protectedName);
    }
  });

  test("empty everCalled deactivates every tool outside the adaptive core", async () => {
    const { planMigration } = await subject();
    const policy: TokenPolicy = {
      profile: "all",
      promoted: [],
      allowed: null,
    };
    const adaptive = resolveToolScope(
      "migration-preview",
      { ...policy, profile: "adaptive" },
      ALL_NAMES,
      new Set(),
    ).active;
    const everyNonCore = ALL_NAMES.filter((name) => !adaptive.has(name));

    const plan = planMigration(ALL_NAMES, policy, []);

    expect(plan.deactivated).toEqual(everyNonCore);
  });

  test("an already-adaptive token has no deactivated tools", async () => {
    const { planMigration } = await subject();
    const policy: TokenPolicy = {
      profile: "adaptive",
      promoted: ["existing_promotion"],
      allowed: null,
    };

    expect(
      planMigration(ALL_NAMES, policy, ["called_tool"]).deactivated,
    ).toEqual([]);
  });

  test("allowed remains an input ceiling and is absent from the plan output", async () => {
    const { planMigration } = await subject();
    const policy: TokenPolicy = {
      profile: "all",
      promoted: ["existing_promotion"],
      allowed: ["existing_promotion", "unused_tool"],
    };
    const before = structuredClone(policy);

    const plan = planMigration(ALL_NAMES, policy, ["called_tool"]);

    expect(policy).toEqual(before);
    expect(Object.prototype.hasOwnProperty.call(plan, "allowed")).toBe(false);
    expect(plan.deactivated).toEqual(
      expectedDeactivated(ALL_NAMES, policy, ["called_tool"]),
    );
  });

  test("a name omitted by the served-name caller is never advertised as deactivated", async () => {
    const { planMigration } = await subject();
    const servedNames = ALL_NAMES.filter((name) => name !== "unused_tool");
    const policy: TokenPolicy = {
      profile: "all",
      promoted: [],
      allowed: null,
    };

    const plan = planMigration(servedNames, policy, []);

    expect(plan.deactivated).not.toContain("unused_tool");
  });
});
