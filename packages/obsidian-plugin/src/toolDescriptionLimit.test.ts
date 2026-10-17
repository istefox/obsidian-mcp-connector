import { describe, expect, test } from "bun:test";
import { composeToolRegistry } from "./composeToolRegistry";
import { SessionPromotions } from "$/features/adaptive-tool-loading/sessionPromotions";
import { mockApp, mockPlugin } from "$/test-setup";

/**
 * ADR-0023 D5: a tool description is at most 350 characters. The ceiling
 * regressed more than once because nothing enforced it (#628).
 *
 * Measured on the live registry, the surface a client actually receives,
 * not on source literals: a description composed at registration time
 * would escape a static scan (ADR-0023 D5, "count discrepancy").
 */
const MAX_DESCRIPTION_CHARS = 350;

async function listedTools() {
  const { toolRegistry } = await composeToolRegistry({
    app: mockApp(),
    plugin: mockPlugin({ loadData: async () => ({}) } as never),
    pluginVersion: "0.0.0-test",
    session: new SessionPromotions(),
  });
  return toolRegistry.list().tools;
}

describe("tool description ceiling (ADR-0023 D5)", () => {
  test("the registry lists tools to measure", async () => {
    expect((await listedTools()).length).toBeGreaterThan(50);
  });

  test(`no tool description exceeds ${MAX_DESCRIPTION_CHARS} characters`, async () => {
    const over = (await listedTools())
      .map((t) => ({ name: t.name, length: (t.description ?? "").length }))
      .filter((t) => t.length > MAX_DESCRIPTION_CHARS);
    // Naming the offenders and their length makes a red CI run actionable.
    expect(over).toEqual([]);
  });
});
