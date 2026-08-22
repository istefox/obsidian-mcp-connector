import { beforeEach, describe, expect, test } from "bun:test";
import { svelteMockCalls } from "$/test-setup";
import {
  ExcludedFoldersConsentModal,
  type ConsentDecision,
} from "./excludedFoldersConsentModal";

/**
 * Tests for the consent gate's Modal wrapper (ADR-0020 §D12).
 *
 * Same harness as `commandPermissionModal.test.ts`: `Modal` and Svelte's
 * `mount`/`unmount` are stubbed in `test-setup.ts`, and the recorder
 * exposes the props so a test can invoke the `onDecision` callback a
 * real click would fire.
 *
 * The contract worth pinning is the failure direction. Every way of
 * dismissing this dialog must mean "change nothing" — anything else and
 * a stray Esc grants consent the user never gave.
 */

interface PromptProps {
  folder?: string;
  mode: "gate" | "review";
  pluginVersion: string;
  onDecision: (decision: ConsentDecision) => void;
}

function lastMountProps(): PromptProps {
  const call = svelteMockCalls.mount[0];
  if (!call) throw new Error("No mount call recorded");
  return call.options.props as PromptProps;
}

const fakeApp = {} as never;

function openGate(folder = "Journal/Therapy") {
  const modal = new ExcludedFoldersConsentModal(fakeApp, {
    folder,
    mode: "gate",
    pluginVersion: "2.1.1",
  });
  modal.open();
  return modal;
}

beforeEach(() => {
  svelteMockCalls.mount = [];
  svelteMockCalls.unmount = [];
});

describe("ExcludedFoldersConsentModal — decisions", () => {
  test("accepting resolves accept", async () => {
    const modal = openGate();
    const decision = modal.waitForDecision();
    lastMountProps().onDecision("accept");
    expect(await decision).toBe("accept");
  });

  test("cancelling resolves cancel", async () => {
    const modal = openGate();
    const decision = modal.waitForDecision();
    lastMountProps().onDecision("cancel");
    expect(await decision).toBe("cancel");
  });

  // The failure direction. Esc, the X, a backdrop click and a
  // programmatic close all land here, and all of them mean "leave things
  // as they are" — which is the state the user already had.
  test("dismissal without a click resolves cancel", async () => {
    const modal = openGate();
    const decision = modal.waitForDecision();
    modal.close();
    expect(await decision).toBe("cancel");
  });

  test("a decision wins over the close it triggers", async () => {
    const modal = openGate();
    const decision = modal.waitForDecision();
    // Clicking accept closes the modal, which fires onClose, which would
    // otherwise resolve cancel on top of the answer already given.
    lastMountProps().onDecision("accept");
    expect(await decision).toBe("accept");
  });

  test("a second decision after the first is ignored", async () => {
    const modal = openGate();
    const decision = modal.waitForDecision();
    const props = lastMountProps();
    props.onDecision("accept");
    props.onDecision("cancel");
    expect(await decision).toBe("accept");
  });
});

describe("ExcludedFoldersConsentModal — what the prompt is told", () => {
  test("the gate names the folder being added and the running version", () => {
    openGate("Finances/2026");
    const props = lastMountProps();
    expect(props.folder).toBe("Finances/2026");
    expect(props.mode).toBe("gate");
    // Named in the downgrade warning, so it has to be a real version
    // rather than a placeholder that ships as literal text.
    expect(props.pluginVersion).toBe("2.1.1");
  });

  // Same component in both modes, so the terms a user agreed to and the
  // terms shown afterwards cannot drift apart.
  test("review mode reuses the same component with no folder", () => {
    const modal = new ExcludedFoldersConsentModal(fakeApp, {
      mode: "review",
      pluginVersion: "2.1.1",
    });
    modal.open();
    const props = lastMountProps();
    expect(props.mode).toBe("review");
    expect(props.folder).toBeUndefined();
    expect(svelteMockCalls.mount).toHaveLength(1);
  });
});

describe("ExcludedFoldersConsentModal — lifecycle", () => {
  test("mounts on open and unmounts on close", () => {
    const modal = openGate();
    expect(svelteMockCalls.mount).toHaveLength(1);
    expect(svelteMockCalls.unmount).toHaveLength(0);
    modal.close();
    expect(svelteMockCalls.unmount).toHaveLength(1);
  });

  test("closing twice unmounts once", () => {
    const modal = openGate();
    modal.close();
    modal.close();
    expect(svelteMockCalls.unmount).toHaveLength(1);
  });
});
