import { describe, expect, test } from "bun:test";
import { buildWorkerSource } from "../src/features/semantic-search/services/embeddingWorkerSpawn";
import { bootWorkerSource, extractWorkerFactories } from "./workerSourceCheck";

const RUNTIME =
  "function (module, exports) { exports.startEmbeddingWorker = function (lib, scope) {" +
  " scope.onmessage = function () {}; scope.postMessage({ type: lib.ready ? 'booted' : 'broken' }); }; }";

// Stands for a helper the bundler's second pass left outside the factory.
const hoistedHelper = () => true;

describe("bootWorkerSource", () => {
  test("a self-contained pair of factories boots", () => {
    const library =
      "function (module, exports, require) { exports.ready = typeof require('node:path').join === 'function'; }";
    expect(bootWorkerSource(buildWorkerSource(library, RUNTIME))).toEqual([
      "booted",
    ]);
  });

  test("a factory that reaches for a binding outside itself does not", () => {
    expect(hoistedHelper()).toBe(true);
    const library =
      "function (module, exports, require) { exports.ready = hoistedHelper(); }";
    expect(() => bootWorkerSource(buildWorkerSource(library, RUNTIME))).toThrow(
      "hoistedHelper is not defined",
    );
  });

  test("a runtime that installs no message handler is refused", () => {
    const runtime =
      "function (module, exports) { exports.startEmbeddingWorker = function () {}; }";
    expect(() =>
      bootWorkerSource(
        buildWorkerSource("function (module, exports, require) {}", runtime),
      ),
    ).toThrow("installed no message handler");
  });
});

describe("extractWorkerFactories", () => {
  const filler = `var pad = "${"x".repeat(500_000)}";`;
  const library = `function(e,t,r){${filler}t.ready=true}`;
  const runtime = `function(e,t){t.startEmbeddingWorker=function(l,s){}}`;

  test("returns both functions as their own source text", () => {
    const mainJs = `var a=1;var lib=${library};var rt=${runtime};module.exports={};`;
    expect(extractWorkerFactories(mainJs)).toEqual({ library, runtime });
  });

  test("a main.js without the factories is an error, not a pass", () => {
    expect(() => extractWorkerFactories("var a = 1;")).toThrow(
      "expected one Transformers.js factory",
    );
    expect(() => extractWorkerFactories(`var lib=${library};`)).toThrow(
      "no embedding worker runtime factory",
    );
  });
});
