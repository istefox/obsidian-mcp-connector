import { describe, expect, test } from "bun:test";
import { decideMigrationAction } from "./setup";
import type { LegacyInstallState } from "./detect";

const NO_LEGACY: LegacyInstallState = {
  hasLegacySettingsKeys: false,
  hasLegacyBinary: false,
  hasLegacyClaudeConfigEntry: false,
};

function withSignal(partial: Partial<LegacyInstallState>): LegacyInstallState {
  return { ...NO_LEGACY, ...partial };
}

describe("decideMigrationAction (fork #78)", () => {
  test("no legacy signal + never skipped → noop", () => {
    expect(decideMigrationAction(NO_LEGACY, false)).toBe("noop");
  });

  test("no legacy signal + previously skipped → noop", () => {
    // Migration completed: skippedAt set as a "do not re-prompt" marker
    // even on success. No signals = clean state, no notice needed.
    expect(decideMigrationAction(NO_LEGACY, true)).toBe("noop");
  });

  test("legacy binary present + never skipped → modal (first-load flow)", () => {
    expect(
      decideMigrationAction(withSignal({ hasLegacyBinary: true }), false),
    ).toBe("modal");
  });

  test("legacy binary present + previously skipped → notice (recurring soft signal)", () => {
    expect(
      decideMigrationAction(withSignal({ hasLegacyBinary: true }), true),
    ).toBe("notice");
  });

  test("legacy claude config entry only + previously skipped → notice", () => {
    expect(
      decideMigrationAction(
        withSignal({ hasLegacyClaudeConfigEntry: true }),
        true,
      ),
    ).toBe("notice");
  });

  test("legacy plugin data keys only + previously skipped → notice", () => {
    expect(
      decideMigrationAction(withSignal({ hasLegacySettingsKeys: true }), true),
    ).toBe("notice");
  });

  test("multiple signals + never skipped → modal (modal handles all)", () => {
    expect(
      decideMigrationAction(
        withSignal({
          hasLegacyBinary: true,
          hasLegacyClaudeConfigEntry: true,
          hasLegacySettingsKeys: true,
        }),
        false,
      ),
    ).toBe("modal");
  });
});
