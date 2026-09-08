/**
 * The settings panel's Task 7 view-state seam (ADR-0025 D11, R-08):
 * resolves the migration toggle's three render states from
 * `(eligibility, profile)`. Pure and Obsidian-free, so the component's
 * render logic is testable without a DOM — the same boundary
 * `migrateToken.ts`'s header states for the mutation itself.
 *
 * The profile is the sole toggle authority (ADR-0025 D11): an
 * `adaptive` profile always renders "on", even while the token is
 * still under its observation window. The countdown gates the FIRST
 * migration, never an already-migrated (or hand-set) profile.
 */

import type { ToolProfile } from "../tokenPolicyStore";
import type { MigrationEligibility } from "./migrationEligibility";

export type MigrationViewState = {
  state: "under-observation" | "eligible-off" | "on";
  /** Drives the checkbox's `checked` attribute. */
  checked: boolean;
  /** Drives the checkbox's `disabled` attribute. */
  disabled: boolean;
  /** What the countdown renders while `state === "under-observation"`. */
  daysRemaining: number;
};

export function migrationViewState(
  eligibility: MigrationEligibility,
  profile: ToolProfile,
): MigrationViewState {
  if (profile === "adaptive") {
    return {
      state: "on",
      checked: true,
      disabled: false,
      daysRemaining: eligibility.daysRemaining,
    };
  }
  return {
    state: eligibility.eligible ? "eligible-off" : "under-observation",
    checked: false,
    disabled: !eligibility.eligible,
    daysRemaining: eligibility.daysRemaining,
  };
}
