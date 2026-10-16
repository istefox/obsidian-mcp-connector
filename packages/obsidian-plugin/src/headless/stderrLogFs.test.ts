import { describe, expect, spyOn, test } from "bun:test";
import { routeConsoleToStderr } from "./stderrLogFs";

describe("routeConsoleToStderr", () => {
  test("log, info, debug and warn reach stderr and never stdout", () => {
    const out = spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const target = {} as Console;
      routeConsoleToStderr(target);
      target.log("X");
      target.info("count %d", 2);
      target.debug({ a: 1 });
      target.warn("w");
      expect(out).not.toHaveBeenCalled();
      expect(err.mock.calls.map((c) => c[0])).toEqual([
        "X\n",
        "count 2\n",
        "{ a: 1 }\n",
        "w\n",
      ]);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
