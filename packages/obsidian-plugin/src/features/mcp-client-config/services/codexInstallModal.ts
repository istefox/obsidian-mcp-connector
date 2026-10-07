/**
 * Obsidian Modal hosting the Codex install preview (ADR-0028 D1, D8).
 *
 * Same settle-once pattern as `ExcludedFoldersConsentModal`: a button
 * click and the `onClose` it triggers cannot resolve twice, and every
 * dismissal (Esc, the X, a backdrop click, a programmatic `close()`)
 * resolves to "do not install, do not switch". A profile switch is only
 * ever part of a confirmed install.
 *
 * The caller must `await` the decision OUTSIDE any `updateSlice` recipe:
 * `globalSettingsMutex` is non-re-entrant, so awaiting a human inside it
 * freezes every settings write in the plugin for as long as the modal is
 * open.
 */

import { Modal, type App } from "obsidian";
import { mount, unmount } from "svelte";
import CodexInstallPrompt from "../components/CodexInstallPrompt.svelte";
import type { CodexInstallPreview } from "./codexConfig";
import type {
  CodexInstallDecision,
  CodexProfileOffer,
} from "./codexInstallFlow";

const CANCELLED: CodexInstallDecision = {
  confirmed: false,
  switchProfile: false,
};

export class CodexInstallModal extends Modal {
  private readonly opts: {
    preview: CodexInstallPreview;
    profileOffer: CodexProfileOffer;
    tokenLabel: string;
    /** Where a user-config target came from, shown in the preview (D5). */
    homeSource?: "CODEX_HOME" | "default";
  };
  private component?: ReturnType<typeof mount>;
  private resolved = false;
  private resolveFn?: (decision: CodexInstallDecision) => void;
  private readonly decision: Promise<CodexInstallDecision>;

  constructor(
    app: App,
    opts: {
      preview: CodexInstallPreview;
      profileOffer: CodexProfileOffer;
      tokenLabel: string;
      homeSource?: "CODEX_HOME" | "default";
    },
  ) {
    super(app);
    this.opts = opts;
    this.decision = new Promise((resolve) => {
      this.resolveFn = resolve;
    });
  }

  /** Settles exactly once: on a click, or on any dismissal. */
  waitForDecision(): Promise<CodexInstallDecision> {
    return this.decision;
  }

  private settle(decision: CodexInstallDecision) {
    if (this.resolved) return;
    this.resolved = true;
    this.resolveFn?.(decision);
  }

  private handleDecision = (decision: CodexInstallDecision) => {
    // A switch without a confirmed install is no switch at all
    this.settle({
      confirmed: decision.confirmed,
      switchProfile: decision.confirmed && decision.switchProfile,
    });
    this.close();
  };

  onOpen() {
    this.component = mount(CodexInstallPrompt, {
      target: this.contentEl,
      props: {
        preview: this.opts.preview,
        profileOffer: this.opts.profileOffer,
        tokenLabel: this.opts.tokenLabel,
        homeSource: this.opts.homeSource,
        onDecision: this.handleDecision,
      },
    });
  }

  onClose() {
    // Resolve BEFORE unmounting, so a caller awaiting a dismissed modal
    // gets an answer rather than hanging. Cancel changes nothing.
    this.settle(CANCELLED);
    if (this.component) {
      void unmount(this.component);
      this.component = undefined;
    }
    this.contentEl.empty();
  }
}
