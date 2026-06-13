/**
 * In-process command-permission check for the `execute_obsidian_command`
 * MCP tool. Extracted from the plugin class so the two-phase decision
 * logic is testable without a live Obsidian app.
 *
 * Two-phase mutex policy: Phase A (decide + fast-path audit write) and
 * Phase B (persist the final outcome) each run as one atomic slice
 * update through `SettingsStore.updateSlice`; the modal wait happens
 * BETWEEN them, outside any lock, so the fast path stays fast and
 * concurrent modals coexist.
 */

import type { App } from "obsidian";
import type { SettingsStore } from "$/shared/settingsStore";
import {
  appendAuditEntry,
  createRuntimeRateCounter,
  decidePermission,
  isDestructiveCommand,
  SOFT_RATE_LIMIT_PER_MINUTE,
  type RuntimeRateCounter,
} from "../utils";
import type { CommandAuditEntry } from "../types";
import {
  CommandPermissionModal,
  type CommandPermissionModalOptions,
  type ModalDecision,
} from "./commandPermissionModal";

const SLICE = "commandPermissions";
const DEFAULT_MODAL_TIMEOUT_MS = 30_000;

/** Local view of the `commandPermissions` data.json slice. */
type CommandPermissionsSlice = {
  enabled?: boolean;
  allowlist?: string[];
  recentInvocations?: CommandAuditEntry[];
  softRateLimit?: number;
};

/** Minimal modal surface the permission check needs. */
export interface PermissionModalLike {
  open(): void;
  close(): void;
  waitForDecision(): Promise<ModalDecision>;
}

export type PermissionModalFactory = (
  app: App,
  options: CommandPermissionModalOptions,
) => PermissionModalLike;

const defaultModalFactory: PermissionModalFactory = (app, options) =>
  new CommandPermissionModal(app, options);

/**
 * Process-wide soft-rate counter for the in-process check path (UI
 * warning only; the hard limiter lives in services/rateLimit.ts).
 * Module-level so the count persists across calls.
 */
const inProcessRateCounter = createRuntimeRateCounter();

export type CheckCommandPermissionDeps = {
  app: App;
  store: SettingsStore;
  /** Defaults to the module-level process-wide counter. */
  rateCounter?: RuntimeRateCounter;
  /** Defaults to the real CommandPermissionModal. */
  modalFactory?: PermissionModalFactory;
  /** Defaults to 30s. */
  timeoutMs?: number;
};

export async function checkCommandPermission(
  deps: CheckCommandPermissionDeps,
  rawCommandId: string,
): Promise<{ outcome: "allow" | "deny"; reason?: string }> {
  const rateCounter = deps.rateCounter ?? inProcessRateCounter;
  const modalFactory = deps.modalFactory ?? defaultModalFactory;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_MODAL_TIMEOUT_MS;

  // Allowlist entries are exact ids; a stray leading/trailing space in
  // the request must not cause a spurious deny. Trim only — ids are
  // case-sensitive by Obsidian convention, so no lowercasing.
  const commandId = rawCommandId.trim();

  rateCounter.record();

  type PhaseAResult =
    | { kind: "done"; outcome: "allow" | "deny"; reason?: string }
    | { kind: "needs-modal"; softRateLimit: number };

  let phaseA!: PhaseAResult;
  await deps.store.updateSlice(SLICE, (current): CommandPermissionsSlice => {
    const perms = (current as CommandPermissionsSlice | undefined) ?? {};
    const pureOutcome = decidePermission(
      commandId,
      perms.enabled,
      perms.allowlist,
    );
    const inAllowlist = (perms.allowlist ?? []).includes(commandId);
    const needsModal =
      perms.enabled === true && pureOutcome.decision === "deny" && !inAllowlist;

    if (needsModal) {
      phaseA = {
        kind: "needs-modal",
        softRateLimit: perms.softRateLimit ?? SOFT_RATE_LIMIT_PER_MINUTE,
      };
      return perms; // NO_CHANGE: no write on the modal path
    }

    // Fast path: write the audit entry and return the decision.
    const auditEntry: CommandAuditEntry = {
      timestamp: new Date().toISOString(),
      commandId,
      decision: pureOutcome.decision,
      ...(pureOutcome.reason ? { reason: pureOutcome.reason } : {}),
    };
    phaseA = {
      kind: "done",
      outcome: pureOutcome.decision,
      reason: pureOutcome.reason,
    };
    return {
      ...perms,
      recentInvocations: appendAuditEntry(perms.recentInvocations, auditEntry),
    };
  });

  if (phaseA.kind === "done") {
    return { outcome: phaseA.outcome, reason: phaseA.reason };
  }

  // Slow path: open the confirmation modal.
  const commandName = (
    deps.app as unknown as {
      commands?: {
        commands?: Record<string, { id: string; name: string }>;
      };
    }
  ).commands?.commands?.[commandId]?.name;

  const isDestructive = isDestructiveCommand(commandId, commandName);
  const rateCount = rateCounter.countInLastMinute();
  const showRateWarning = rateCount > phaseA.softRateLimit;

  const modal = modalFactory(deps.app, {
    commandId,
    commandName,
    isDestructive,
    showRateWarning,
    rateCount,
  });
  modal.open();

  let timeoutHandle: number | undefined;
  type ModalOutcome =
    | { kind: "decided"; decision: ModalDecision }
    | { kind: "timeout" };

  const outcome = await Promise.race<ModalOutcome>([
    modal
      .waitForDecision()
      .then((d) => ({ kind: "decided" as const, decision: d })),
    new Promise<ModalOutcome>((resolve) => {
      timeoutHandle = window.setTimeout(
        () => resolve({ kind: "timeout" }),
        timeoutMs,
      );
    }),
  ]);

  if (timeoutHandle) window.clearTimeout(timeoutHandle);
  if (outcome.kind === "timeout") modal.close();

  let finalOutcome: "allow" | "deny";
  let finalReason: string | undefined;
  let persistAllowlistEntry = false;

  if (outcome.kind === "timeout") {
    finalOutcome = "deny";
    finalReason = `User did not respond within ${timeoutMs / 1000} seconds.`;
  } else {
    const d = outcome.decision;
    if (d === "deny") {
      finalOutcome = "deny";
      finalReason = `User denied permission for command '${commandId}' via the confirmation modal.`;
    } else {
      finalOutcome = "allow";
      if (d === "allow-always") persistAllowlistEntry = true;
    }
  }

  // Phase B: persist the final outcome.
  await deps.store.updateSlice(SLICE, (current): CommandPermissionsSlice => {
    const perms = (current as CommandPermissionsSlice | undefined) ?? {};
    const auditEntry: CommandAuditEntry = {
      timestamp: new Date().toISOString(),
      commandId,
      decision: finalOutcome,
      ...(finalReason ? { reason: finalReason } : {}),
    };
    const updatedAllowlist =
      persistAllowlistEntry && !(perms.allowlist ?? []).includes(commandId)
        ? [...(perms.allowlist ?? []), commandId]
        : undefined;
    return {
      ...perms,
      ...(updatedAllowlist !== undefined
        ? { allowlist: updatedAllowlist }
        : {}),
      recentInvocations: appendAuditEntry(perms.recentInvocations, auditEntry),
    };
  });

  return { outcome: finalOutcome, reason: finalReason };
}
