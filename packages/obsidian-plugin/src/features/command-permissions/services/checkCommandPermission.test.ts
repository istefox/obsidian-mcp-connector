import { describe, expect, test } from "bun:test";
import type { App } from "obsidian";
import { SettingsStore } from "$/shared/settingsStore";
import { createMutex } from "$/shared/settingsLock";
import { createRuntimeRateCounter } from "../utils";
import {
  checkCommandPermission,
  type PermissionModalFactory,
} from "./checkCommandPermission";
import type { ModalDecision } from "./commandPermissionModal";

/** In-memory plugin data with a save counter. */
function makeStore(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = structuredClone(initial);
  let saves = 0;
  const plugin = {
    loadData: async () => structuredClone(data),
    saveData: async (next: unknown) => {
      saves++;
      data = structuredClone(next as Record<string, unknown>);
    },
  };
  // Fresh mutex per test for isolation.
  const store = new SettingsStore(plugin, createMutex());
  return { store, snapshot: () => structuredClone(data), saves: () => saves };
}

/** Modal stub: resolves to `decision`, or never resolves for "never". */
function stubModal(decision: ModalDecision | "never") {
  let opened = false;
  const factory: PermissionModalFactory = () => ({
    open: () => {
      opened = true;
    },
    close: () => {},
    waitForDecision: () =>
      decision === "never"
        ? new Promise<ModalDecision>(() => {})
        : Promise.resolve(decision),
  });
  return { factory, opened: () => opened };
}

const app = {} as App;

function permsOf(snapshot: Record<string, unknown>) {
  return (snapshot.commandPermissions ?? {}) as {
    allowlist?: string[];
    recentInvocations?: { decision: string; commandId: string }[];
  };
}

describe("checkCommandPermission", () => {
  test("fast path: master toggle off → deny, audit written", async () => {
    const { store, snapshot, saves } = makeStore({
      commandPermissions: { enabled: false },
    });
    const result = await checkCommandPermission(
      { app, store, rateCounter: createRuntimeRateCounter() },
      "app:reload",
    );
    expect(result.outcome).toBe("deny");
    expect(saves()).toBe(1); // fast-path audit write
    expect(permsOf(snapshot()).recentInvocations?.at(-1)?.decision).toBe(
      "deny",
    );
  });

  test("fast path: enabled + in allowlist → allow, audit written", async () => {
    const { store, snapshot } = makeStore({
      commandPermissions: { enabled: true, allowlist: ["app:reload"] },
    });
    const result = await checkCommandPermission(
      { app, store, rateCounter: createRuntimeRateCounter() },
      "app:reload",
    );
    expect(result.outcome).toBe("allow");
    expect(permsOf(snapshot()).recentInvocations?.at(-1)?.decision).toBe(
      "allow",
    );
  });

  test("trims the command id before deciding", async () => {
    const { store } = makeStore({
      commandPermissions: { enabled: true, allowlist: ["app:reload"] },
    });
    const result = await checkCommandPermission(
      { app, store, rateCounter: createRuntimeRateCounter() },
      "  app:reload  ",
    );
    expect(result.outcome).toBe("allow");
  });

  test("needs-modal path performs NO write in Phase A", async () => {
    const { store, saves } = makeStore({
      commandPermissions: { enabled: true, allowlist: [] },
    });
    const { factory, opened } = stubModal("deny");
    await checkCommandPermission(
      {
        app,
        store,
        rateCounter: createRuntimeRateCounter(),
        modalFactory: factory,
      },
      "app:reload",
    );
    expect(opened()).toBe(true);
    // Phase A wrote nothing (NO_CHANGE); only Phase B persists the outcome.
    expect(saves()).toBe(1);
  });

  test("modal allow-always appends the command to the allowlist", async () => {
    const { store, snapshot } = makeStore({
      commandPermissions: { enabled: true, allowlist: [] },
    });
    const { factory } = stubModal("allow-always");
    const result = await checkCommandPermission(
      {
        app,
        store,
        rateCounter: createRuntimeRateCounter(),
        modalFactory: factory,
      },
      "app:reload",
    );
    expect(result.outcome).toBe("allow");
    expect(permsOf(snapshot()).allowlist).toEqual(["app:reload"]);
  });

  test("modal allow-once does not touch the allowlist", async () => {
    const { store, snapshot } = makeStore({
      commandPermissions: { enabled: true, allowlist: [] },
    });
    const { factory } = stubModal("allow-once");
    const result = await checkCommandPermission(
      {
        app,
        store,
        rateCounter: createRuntimeRateCounter(),
        modalFactory: factory,
      },
      "app:reload",
    );
    expect(result.outcome).toBe("allow");
    expect(permsOf(snapshot()).allowlist).toEqual([]);
  });

  test("modal deny → deny with a reason", async () => {
    const { store } = makeStore({
      commandPermissions: { enabled: true, allowlist: [] },
    });
    const { factory } = stubModal("deny");
    const result = await checkCommandPermission(
      {
        app,
        store,
        rateCounter: createRuntimeRateCounter(),
        modalFactory: factory,
      },
      "app:reload",
    );
    expect(result.outcome).toBe("deny");
    expect(result.reason).toMatch(/confirmation modal/);
  });

  test("modal timeout → deny with timeout reason", async () => {
    const { store } = makeStore({
      commandPermissions: { enabled: true, allowlist: [] },
    });
    const { factory } = stubModal("never");
    const result = await checkCommandPermission(
      {
        app,
        store,
        rateCounter: createRuntimeRateCounter(),
        modalFactory: factory,
        timeoutMs: 20,
      },
      "app:reload",
    );
    expect(result.outcome).toBe("deny");
    expect(result.reason).toMatch(/did not respond/);
  });
});
