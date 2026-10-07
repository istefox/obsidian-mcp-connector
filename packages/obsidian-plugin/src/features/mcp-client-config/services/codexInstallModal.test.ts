import { beforeEach, describe, expect, test } from "bun:test";
import { svelteMockCalls } from "$/test-setup";
import type { CodexInstallPreview } from "./codexConfig";
import type {
  CodexInstallDecision,
  CodexProfileOffer,
} from "./codexInstallFlow";
import { CodexInstallModal } from "./codexInstallModal";

/**
 * Tests for the install prompt's Modal wrapper (ADR-0028 D1, D8).
 *
 * Same harness as `excludedFoldersConsentModal.test.ts`: `Modal` and
 * Svelte's `mount`/`unmount` are stubbed in `test-setup.ts`, and the
 * recorder exposes the props so a test can invoke the `onDecision`
 * callback a real click would fire. The failure direction is the one
 * worth pinning: every dismissal means "write nothing".
 */

interface PromptProps {
  preview: CodexInstallPreview;
  profileOffer: CodexProfileOffer;
  tokenLabel: string;
  onDecision: (decision: CodexInstallDecision) => void;
}

function lastMountProps(): PromptProps {
  const call = svelteMockCalls.mount[0];
  if (!call) throw new Error("No mount call recorded");
  return call.options.props as PromptProps;
}

const fakeApp = {} as never;

const preview: CodexInstallPreview = {
  scope: "user",
  configPath: "/home/me/.codex/config.toml",
  serverId: "obsidian_neon_hades_2",
  url: "http://127.0.0.1:27200/v1/123e4567-e89b-42d3-a456-426614174000/mcp",
  action: "add",
  tokenForm: "literal",
  createsFile: true,
  createsDirectory: false,
  revision: "revision",
  snippet: "[mcp_servers.obsidian_neon_hades_2]",
};

const offer: CodexProfileOffer = {
  tokenId: "codex-row",
  from: "adaptive",
  to: "all",
};

function openModal(profileOffer: CodexProfileOffer = offer) {
  const modal = new CodexInstallModal(fakeApp, {
    preview,
    profileOffer,
    tokenLabel: "Codex",
  });
  modal.open();
  return modal;
}

beforeEach(() => {
  svelteMockCalls.mount = [];
  svelteMockCalls.unmount = [];
});

describe("CodexInstallModal decisions", () => {
  test("confirming with the box ticked resolves { true, true } (R-09)", async () => {
    const modal = openModal();
    const decision = modal.waitForDecision();
    lastMountProps().onDecision({ confirmed: true, switchProfile: true });
    expect(await decision).toEqual({ confirmed: true, switchProfile: true });
  });

  test("confirming without the box resolves { true, false } (R-09)", async () => {
    const modal = openModal();
    const decision = modal.waitForDecision();
    lastMountProps().onDecision({ confirmed: true, switchProfile: false });
    expect(await decision).toEqual({ confirmed: true, switchProfile: false });
  });

  test("cancelling resolves { false, false } (R-12)", async () => {
    const modal = openModal();
    const decision = modal.waitForDecision();
    lastMountProps().onDecision({ confirmed: false, switchProfile: false });
    expect(await decision).toEqual({ confirmed: false, switchProfile: false });
  });

  test("a cancel with the box ticked drops the switch (R-09, R-12)", async () => {
    const modal = openModal();
    const decision = modal.waitForDecision();
    lastMountProps().onDecision({ confirmed: false, switchProfile: true });
    expect(await decision).toEqual({ confirmed: false, switchProfile: false });
  });

  // Esc, the X, a backdrop click and a programmatic close all land here.
  test("dismissal without a click resolves { false, false } (R-12, R-09)", async () => {
    const modal = openModal();
    const decision = modal.waitForDecision();
    modal.close();
    expect(await decision).toEqual({ confirmed: false, switchProfile: false });
  });

  test("a decision wins over the close it triggers", async () => {
    const modal = openModal();
    const decision = modal.waitForDecision();
    lastMountProps().onDecision({ confirmed: true, switchProfile: true });
    expect(await decision).toEqual({ confirmed: true, switchProfile: true });
  });

  test("a second decision after the first is ignored", async () => {
    const modal = openModal();
    const decision = modal.waitForDecision();
    const props = lastMountProps();
    props.onDecision({ confirmed: true, switchProfile: false });
    props.onDecision({ confirmed: false, switchProfile: false });
    expect(await decision).toEqual({ confirmed: true, switchProfile: false });
  });
});

describe("CodexInstallModal what the prompt is told", () => {
  test("the props carry the preview, the offer and the token label", () => {
    openModal();
    const props = lastMountProps();
    expect(props.preview).toBe(preview);
    expect(props.profileOffer).toBe(offer);
    expect(props.tokenLabel).toBe("Codex");
    expect(typeof props.onDecision).toBe("function");
  });

  test("no offer is passed through as null", () => {
    openModal(null);
    expect(lastMountProps().profileOffer).toBeNull();
  });
});

describe("CodexInstallModal lifecycle", () => {
  test("mounts on open and unmounts on close", () => {
    const modal = openModal();
    expect(svelteMockCalls.mount).toHaveLength(1);
    expect(svelteMockCalls.unmount).toHaveLength(0);
    modal.close();
    expect(svelteMockCalls.unmount).toHaveLength(1);
  });

  test("closing twice unmounts once", () => {
    const modal = openModal();
    modal.close();
    modal.close();
    expect(svelteMockCalls.unmount).toHaveLength(1);
  });
});
