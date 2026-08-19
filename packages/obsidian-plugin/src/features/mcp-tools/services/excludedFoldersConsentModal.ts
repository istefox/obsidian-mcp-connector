/**
 * Obsidian Modal hosting the folder-exclusion consent prompt
 * (ADR-0020 §D12).
 *
 * Modelled on `command-permissions/services/commandPermissionModal.ts`,
 * the repo's only other Modal, down to the `resolved` flag that stops a
 * button click and the subsequent `onClose` from resolving twice.
 *
 * Two things differ from that one and both are deliberate.
 *
 * **Dismissal resolves to `"cancel"`, and cancel writes nothing.** Esc,
 * the X, a backdrop click and a programmatic `close()` all mean "leave
 * things as they are", which is the state the user already had. There is
 * no "declined" flag: recording a refusal would suppress the gate on the
 * next attempt, which inverts it.
 *
 * **The same component serves the later review**, in `mode: "review"`,
 * so the terms a user agreed to and the terms shown afterwards cannot
 * drift apart. A consent dialog whose text no longer describes what you
 * have is worse than no dialog.
 *
 * The caller must `await` the decision OUTSIDE any `updateSlice` recipe:
 * `globalSettingsMutex` is non-re-entrant, so awaiting a human inside it
 * freezes every settings write in the plugin for as long as the modal is
 * open.
 */

import { Modal, type App } from "obsidian";
import { mount, unmount } from "svelte";
import ExcludedFoldersConsentPrompt from "../components/ExcludedFoldersConsentPrompt.svelte";

export type ConsentDecision = "accept" | "cancel";

export interface ExcludedFoldersConsentModalOptions {
  /** The folder being added. Omitted in review mode. */
  folder?: string;
  /** "gate" asks for a decision; "review" only explains. */
  mode: "gate" | "review";
  /** Named in the downgrade warning, so it says a real version. */
  pluginVersion: string;
}

export class ExcludedFoldersConsentModal extends Modal {
  private readonly opts: ExcludedFoldersConsentModalOptions;
  private component?: ReturnType<typeof mount>;
  private resolved = false;
  private resolveFn?: (decision: ConsentDecision) => void;

  constructor(app: App, opts: ExcludedFoldersConsentModalOptions) {
    super(app);
    this.opts = opts;
  }

  /** Settles exactly once: on a click, or on any dismissal. */
  waitForDecision(): Promise<ConsentDecision> {
    return new Promise((resolve) => {
      this.resolveFn = resolve;
    });
  }

  private handleDecision = (decision: ConsentDecision) => {
    if (this.resolved) return;
    this.resolved = true;
    this.resolveFn?.(decision);
    this.close();
  };

  onOpen() {
    this.component = mount(ExcludedFoldersConsentPrompt, {
      target: this.contentEl,
      props: {
        folder: this.opts.folder,
        mode: this.opts.mode,
        pluginVersion: this.opts.pluginVersion,
        onDecision: this.handleDecision,
      },
    });
  }

  onClose() {
    // Resolve BEFORE unmounting, so a caller awaiting a dismissed modal
    // gets an answer rather than hanging. Cancel is the fail-safe
    // direction here for the plainest possible reason: it changes
    // nothing.
    if (!this.resolved) {
      this.resolved = true;
      this.resolveFn?.("cancel");
    }
    if (this.component) {
      void unmount(this.component);
      this.component = undefined;
    }
    this.contentEl.empty();
  }
}
