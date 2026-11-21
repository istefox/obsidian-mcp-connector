import { describe, expect, test } from "bun:test";
import {
  instantiateTransformers,
  loadTransformers,
} from "./transformersModule";
import { transformersFactory } from "./transformersFactory";

describe("loadTransformers()", () => {
  test("resolves the library on demand and hands out the same module each time", async () => {
    const first = await loadTransformers();
    expect(typeof first.pipeline).toBe("function");
    expect(typeof first.env).toBe("object");
    expect(await loadTransformers()).toBe(first);
  });
});

// The desktop build swaps transformersFactory.ts for the pre-bundled
// library (ADR-0036). A source checkout must keep it null, or the tests
// and the headless build would stop loading the package itself.
describe("transformersFactory", () => {
  test("is absent in a source checkout", () => {
    expect(transformersFactory).toBeNull();
  });

  test("a factory is run as a CommonJS module and its exports returned", () => {
    const seen: unknown[] = [];
    const lib = instantiateTransformers<{ pipeline: string }>(
      (module, exports, nodeRequire) => {
        seen.push(exports === module.exports, nodeRequire);
        module.exports = { pipeline: "from-factory" };
      },
      "the-require",
    );
    expect(lib).toEqual({ pipeline: "from-factory" });
    expect(seen).toEqual([true, "the-require"]);
  });
});

// The point of the accessor: loading the plugin must not evaluate
// Transformers.js. Checked on the source, because a test process that has
// already imported it elsewhere cannot show absence at runtime.
describe("static imports of @huggingface/transformers", () => {
  test("only the lazy accessor names it", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const offenders = readdirSync(import.meta.dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => f !== "transformersModule.ts")
      .filter((f) =>
        /from\s+["']@huggingface\/transformers["']/.test(
          readFileSync(`${import.meta.dir}/${f}`, "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
