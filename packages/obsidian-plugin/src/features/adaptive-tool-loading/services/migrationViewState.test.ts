import { describe, expect, test } from "bun:test";

// Task 7 test-first contract, derived from the supplied brief only.
// The coder supplies this pure helper and calls it from the settings panel.
// Existing service tests provide only the eligibility/profile input shapes.
type Eligibility = { eligible: boolean; daysRemaining: number };
type Profile = "all" | "core" | "adaptive";
type ViewState = {
  state: "under-observation" | "eligible-off" | "on";
  checked: boolean;
  disabled: boolean;
  daysRemaining: number;
};

async function subject(): Promise<{
  migrationViewState: (eligibility: Eligibility, profile: Profile) => ViewState;
}> {
  const modulePath = "./migrationViewState";
  return import(modulePath);
}

describe("Task 7 migration state (R-08)", () => {
  for (const profile of ["all", "core"] as const) {
    for (const daysRemaining of [7, 1]) {
      test(`${profile}: blocks migration with ${daysRemaining} observation days remaining`, async () => {
        const { migrationViewState } = await subject();

        expect(
          migrationViewState({ eligible: false, daysRemaining }, profile),
        ).toEqual({
          state: "under-observation",
          checked: false,
          disabled: true,
          daysRemaining,
        });
      });
    }

    test(`${profile}: becomes eligible-off at zero remaining days`, async () => {
      const { migrationViewState } = await subject();

      expect(
        migrationViewState({ eligible: true, daysRemaining: 0 }, profile),
      ).toEqual({
        state: "eligible-off",
        checked: false,
        disabled: false,
        daysRemaining: 0,
      });
    });
  }

  test("adaptive is on when eligible", async () => {
    const { migrationViewState } = await subject();

    expect(
      migrationViewState({ eligible: true, daysRemaining: 0 }, "adaptive"),
    ).toEqual({
      state: "on",
      checked: true,
      disabled: false,
      daysRemaining: 0,
    });
  });

  test("an adaptive profile remains on even while under observation", async () => {
    const { migrationViewState } = await subject();

    // The profile is the sole toggle authority. The brief does not specify
    // whether this already-on state disables reversion during observation.
    expect(
      migrationViewState({ eligible: false, daysRemaining: 7 }, "adaptive"),
    ).toMatchObject({ state: "on", checked: true });
  });

  test("re-reading profiles after policychange resolves both toggle directions", async () => {
    const { migrationViewState } = await subject();
    const eligibility = Object.freeze({ eligible: true, daysRemaining: 0 });

    expect(migrationViewState(eligibility, "all").state).toBe("eligible-off");
    expect(migrationViewState(eligibility, "adaptive").state).toBe("on");
    expect(migrationViewState(eligibility, "all").state).toBe("eligible-off");
    expect(eligibility).toEqual({ eligible: true, daysRemaining: 0 });
  });
});

describe("Task 7 failed writes at the panel's service boundary (R-06, R-08)", () => {
  for (const direction of ["on", "off"] as const) {
    test(`turning ${direction}: exposes a rejected save without persisting a new profile`, async () => {
      const { migrateTokenToAdaptive, revertTokenToAll } =
        await import("./migrateToken");
      const profile: Profile = direction === "on" ? "all" : "adaptive";
      const persisted = {
        mcpTransport: {
          tokens: [
            { id: "client", label: "Work client", createdAt: 1, token: "test" },
          ],
        },
        toolLoading: {
          profile,
          promoted: [],
          counters: {},
          profiles: { client: { profile, promoted: [], allowed: null } },
          everCalled: { client: [] },
        },
      };
      const before = structuredClone(persisted);
      const failure = new Error("Save failed: read-only vault");
      let saveAttempts = 0;
      const plugin = {
        loadData: async () => structuredClone(persisted),
        saveData: async (_next: unknown) => {
          saveAttempts += 1;
          throw failure;
        },
      };

      const operation =
        direction === "on"
          ? migrateTokenToAdaptive(plugin, "client", ["unused_tool"])
          : revertTokenToAll(plugin, "client");

      await expect(operation).rejects.toBe(failure);
      expect(saveAttempts).toBe(1);
      expect(persisted).toEqual(before);
    });
  }
});
