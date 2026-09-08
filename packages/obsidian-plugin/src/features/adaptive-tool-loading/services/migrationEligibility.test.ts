import { describe, expect, spyOn, test } from "bun:test";
import * as constants from "../constants";
import { updateToolLoading } from "../tokenPolicyStore";

const DAY_MS = 86_400_000;

type Eligibility = {
  eligible: boolean;
  daysRemaining: number;
};

type MigrationEligibilityModule = {
  migrationEligibility: (
    now: number,
    everCalledSince: number,
    createdAt: number,
  ) => Eligibility;
  ensureEverCalledTracking: (
    plugin: ReturnType<typeof makePlugin>["plugin"],
  ) => Promise<void>;
};

async function subject(): Promise<MigrationEligibilityModule> {
  return import("./migrationEligibility") as Promise<MigrationEligibilityModule>;
}

function makePlugin(data: Record<string, unknown> = {}) {
  let store: Record<string, unknown> = { ...data };
  let saves = 0;
  return {
    plugin: {
      loadData: async () => ({ ...store }),
      saveData: async (next: unknown) => {
        saves += 1;
        store = { ...(next as Record<string, unknown>) };
      },
    },
    getStore: () => store,
    get saves() {
      return saves;
    },
  };
}

describe("migration observation anchor (R-02)", () => {
  test("uses a 14-day observation window", () => {
    const value = (
      constants as typeof constants & {
        MIGRATION_OBSERVATION_DAYS?: number;
      }
    ).MIGRATION_OBSERVATION_DAYS;
    expect(value).toBe(14);
  });

  test("writes the vault anchor once and is NO_CHANGE on a second run", async () => {
    const anchor = Date.UTC(2026, 8, 8, 10, 0, 0);
    const clock = spyOn(Date, "now").mockReturnValue(anchor);
    try {
      const { ensureEverCalledTracking } = await subject();
      const harness = makePlugin();

      await ensureEverCalledTracking(harness.plugin);
      await ensureEverCalledTracking(harness.plugin);

      const slice = harness.getStore().toolLoading as {
        everCalledSince: number;
      };
      expect(slice.everCalledSince).toBe(anchor);
      expect(harness.saves).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  test("becomes eligible exactly at the boundary, not one millisecond early", async () => {
    const { migrationEligibility } = await subject();
    const anchor = Date.UTC(2026, 0, 1);
    const boundary = anchor + 14 * DAY_MS;

    expect(migrationEligibility(boundary - 1, anchor, anchor).eligible).toBe(
      false,
    );
    expect(migrationEligibility(boundary, anchor, anchor).eligible).toBe(true);
  });

  test("measures a newer token from createdAt rather than the older vault anchor", async () => {
    const { migrationEligibility } = await subject();
    const vaultAnchor = Date.UTC(2026, 0, 1);
    const createdAt = vaultAnchor + 10 * DAY_MS;

    expect(
      migrationEligibility(vaultAnchor + 14 * DAY_MS, vaultAnchor, createdAt)
        .eligible,
    ).toBe(false);
    expect(
      migrationEligibility(createdAt + 14 * DAY_MS, vaultAnchor, createdAt)
        .eligible,
    ).toBe(true);
  });

  test("falls back to the vault anchor when createdAt is zero", async () => {
    const { migrationEligibility } = await subject();
    const vaultAnchor = Date.UTC(2026, 0, 1);

    expect(
      migrationEligibility(vaultAnchor + 14 * DAY_MS - 1, vaultAnchor, 0)
        .eligible,
    ).toBe(false);
    expect(
      migrationEligibility(vaultAnchor + 14 * DAY_MS, vaultAnchor, 0).eligible,
    ).toBe(true);
  });

  test("profile toggles never move the existing vault anchor", async () => {
    const anchor = Date.UTC(2026, 8, 8, 10, 0, 0);
    const clock = spyOn(Date, "now").mockReturnValue(anchor);
    try {
      const { ensureEverCalledTracking } = await subject();
      const harness = makePlugin({
        mcpTransport: {
          tokens: [{ id: "default", createdAt: anchor - DAY_MS }],
        },
        toolLoading: {
          profile: "all",
          promoted: [],
          counters: {},
          profiles: {
            default: { profile: "all", promoted: [], allowed: null },
          },
        },
      });

      await ensureEverCalledTracking(harness.plugin);
      clock.mockReturnValue(anchor + DAY_MS);
      await updateToolLoading(harness.plugin, (state) => {
        state.profile = "adaptive";
        state.profiles.default = {
          profile: "adaptive",
          promoted: [],
          allowed: null,
        };
        return state;
      });
      await ensureEverCalledTracking(harness.plugin);

      clock.mockReturnValue(anchor + 2 * DAY_MS);
      await updateToolLoading(harness.plugin, (state) => {
        state.profile = "all";
        state.profiles.default = {
          profile: "all",
          promoted: [],
          allowed: null,
        };
        return state;
      });
      await ensureEverCalledTracking(harness.plugin);

      const slice = harness.getStore().toolLoading as {
        everCalledSince: number;
      };
      expect(slice.everCalledSince).toBe(anchor);
    } finally {
      clock.mockRestore();
    }
  });

  test("rounds daysRemaining up and clamps it at zero", async () => {
    const { migrationEligibility } = await subject();
    const anchor = Date.UTC(2026, 0, 1);

    expect(
      migrationEligibility(anchor + 13 * DAY_MS + 1, anchor, anchor)
        .daysRemaining,
    ).toBe(1);
    expect(
      migrationEligibility(anchor + 14 * DAY_MS, anchor, anchor).daysRemaining,
    ).toBe(0);
    expect(
      migrationEligibility(anchor + 30 * DAY_MS, anchor, anchor).daysRemaining,
    ).toBe(0);
  });
});
