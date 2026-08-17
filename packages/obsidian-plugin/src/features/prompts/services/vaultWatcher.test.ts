import { describe, expect, test, beforeEach, mock } from "bun:test";
import {
  mockApp,
  resetMockVault,
  fireMockVaultEvent,
  fireMockMetadataEvent,
} from "$/test-setup";
import { createVaultWatcher } from "./vaultWatcher";

beforeEach(() => {
  resetMockVault();
});

function makeFile(path: string) {
  return { path } as { path: string };
}

describe("createVaultWatcher", () => {
  test("notifier called once on create event for Prompts/ md file", () => {
    const notifier = mock(() => {});
    const app = mockApp();
    createVaultWatcher(app, notifier);
    fireMockVaultEvent("create", makeFile("Prompts/foo.md"));
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  test("notifier not called for Prompts/ non-md file", () => {
    const notifier = mock(() => {});
    const app = mockApp();
    createVaultWatcher(app, notifier);
    fireMockVaultEvent("create", makeFile("Prompts/foo.canvas"));
    expect(notifier).not.toHaveBeenCalled();
  });

  test("notifier not called for md file outside Prompts/", () => {
    const notifier = mock(() => {});
    const app = mockApp();
    createVaultWatcher(app, notifier);
    fireMockVaultEvent("create", makeFile("Notes/foo.md"));
    expect(notifier).not.toHaveBeenCalled();
  });

  test("notifier not called for md file in Prompts/ subdirectory", () => {
    const notifier = mock(() => {});
    const app = mockApp();
    createVaultWatcher(app, notifier);
    fireMockVaultEvent("create", makeFile("Prompts/sub/foo.md"));
    expect(notifier).not.toHaveBeenCalled();
  });

  test("notifier called on rename from Prompts/ to Archive/", () => {
    const notifier = mock(() => {});
    const app = mockApp();
    createVaultWatcher(app, notifier);
    fireMockVaultEvent("rename", makeFile("Archive/foo.md"), "Prompts/foo.md");
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  test("notifier called on rename from Notes/ to Prompts/", () => {
    const notifier = mock(() => {});
    const app = mockApp();
    createVaultWatcher(app, notifier);
    fireMockVaultEvent("rename", makeFile("Prompts/foo.md"), "Notes/foo.md");
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  test("notifier called on delete event for Prompts/ md file", () => {
    const notifier = mock(() => {});
    const app = mockApp();
    createVaultWatcher(app, notifier);
    fireMockVaultEvent("delete", makeFile("Prompts/bar.md"));
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  // The metadata cache is a second emitter, and the only one that says a file
  // has become READABLE (#483). It is fired separately from the vault on
  // purpose: the gap between the two is the defect these guard.
  test("notifier called when a Prompts/ md file finishes indexing", () => {
    const notifier = mock(() => {});
    const app = mockApp();
    createVaultWatcher(app, notifier);
    fireMockMetadataEvent("changed", makeFile("Prompts/foo.md"));
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  test("notifier not called when a file outside Prompts/ finishes indexing", () => {
    const notifier = mock(() => {});
    const app = mockApp();
    createVaultWatcher(app, notifier);
    // Every indexed file in the vault reaches this listener, so the filter is
    // the whole cost story: a large vault re-indexing must not re-scan prompts
    // once per file.
    fireMockMetadataEvent("changed", makeFile("Notes/foo.md"));
    fireMockMetadataEvent("changed", makeFile("Prompts/sub/foo.md"));
    expect(notifier).not.toHaveBeenCalled();
  });

  test("stop() prevents subsequent events from calling notifier", () => {
    const notifier = mock(() => {});
    const app = mockApp();
    const watcher = createVaultWatcher(app, notifier);
    watcher.stop();
    fireMockVaultEvent("create", makeFile("Prompts/foo.md"));
    fireMockVaultEvent("delete", makeFile("Prompts/foo.md"));
    fireMockVaultEvent("rename", makeFile("Prompts/foo.md"), "Notes/foo.md");
    // The metadata listener is registered on a different emitter, so it needs
    // its own `offref` and would survive a `stop()` that forgot it.
    fireMockMetadataEvent("changed", makeFile("Prompts/foo.md"));
    expect(notifier).not.toHaveBeenCalled();
  });
});
