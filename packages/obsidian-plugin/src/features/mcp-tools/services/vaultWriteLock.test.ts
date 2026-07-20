import { describe, expect, test } from "bun:test";
import { withVaultWriteLock } from "./vaultWriteLock";

describe("withVaultWriteLock", () => {
  test("serializes concurrent sections in acquisition order", async () => {
    const events: string[] = [];
    const first = withVaultWriteLock(async () => {
      events.push("first:start");
      // Yield twice — without the lock the second section would
      // interleave into this window.
      await Promise.resolve();
      await Promise.resolve();
      events.push("first:end");
    });
    const second = withVaultWriteLock(async () => {
      events.push("second:start");
      events.push("second:end");
    });
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("returns the section's value", async () => {
    const value = await withVaultWriteLock(async () => 42);
    expect(value).toBe(42);
  });

  test("a rejection propagates but does not break the queue", async () => {
    const failing = withVaultWriteLock(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    // The next acquirer still runs.
    const after = await withVaultWriteLock(async () => "ok");
    expect(after).toBe("ok");
  });
});
