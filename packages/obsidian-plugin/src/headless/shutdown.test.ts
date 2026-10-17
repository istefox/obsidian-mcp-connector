import { describe, expect, test } from "bun:test";
import { createShutdown, SHUTDOWN_TIMEOUT_MS } from "./shutdown";

function harness(cleanup: () => Promise<void>) {
  const exits: number[] = [];
  const said: string[] = [];
  const timers: Array<{ fire: () => void; ms: number }> = [];
  const shutdown = createShutdown(cleanup, {
    exit: (code) => exits.push(code),
    say: (line) => said.push(line),
    startTimer: (fire, ms) => timers.push({ fire, ms }),
  });
  return { shutdown, exits, said, timers };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createShutdown", () => {
  test("a cleanup that never resolves is cut off when the timer fires", async () => {
    const { shutdown, exits, said, timers } = harness(
      () => new Promise<void>(() => {}),
    );
    shutdown();
    await settle();
    expect(exits).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(SHUTDOWN_TIMEOUT_MS);

    timers[0]?.fire();
    expect(exits).toEqual([0]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("did not finish");
  });

  test("cleanup that finishes in time exits without the timeout line", async () => {
    let cleaned = false;
    const { shutdown, exits, said, timers } = harness(async () => {
      cleaned = true;
    });
    shutdown();
    await settle();
    expect(cleaned).toBe(true);
    expect(exits).toEqual([0]);

    // The timer firing afterwards neither logs nor exits twice.
    timers[0]?.fire();
    expect(exits).toEqual([0]);
    expect(said).toEqual([]);
  });

  test("a failing cleanup is reported and still exits", async () => {
    const { shutdown, exits, said } = harness(async () => {
      throw new Error("boom");
    });
    shutdown();
    await settle();
    expect(said).toEqual(["Shutdown error: Error: boom"]);
    expect(exits).toEqual([0]);
  });

  test("a second signal does not run cleanup again", async () => {
    let runs = 0;
    const { shutdown, timers } = harness(async () => {
      runs++;
    });
    shutdown();
    shutdown();
    await settle();
    expect(runs).toBe(1);
    expect(timers).toHaveLength(1);
  });
});
