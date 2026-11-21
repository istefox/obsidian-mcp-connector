/**
 * Build-time proof that the embedding worker can start from the main.js
 * that was just written (ADR-0036).
 *
 * The worker's script is the source text of two functions inside main.js.
 * Nothing else checks that this text still stands on its own after the
 * bundler's second pass: a helper hoisted out of either function, or a
 * `require` rewritten to a module-scope one, would only fail in Obsidian,
 * where the plugin answers by running inference on the main thread again
 * (#664) with one warning in the log.
 *
 * So the two functions are cut out of main.js exactly as
 * `Function.prototype.toString` returns them, assembled by the same
 * `buildWorkerSource` the plugin uses, and run in an empty context. The
 * script has to evaluate the library and post "booted".
 */
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { buildWorkerSource } from "../src/features/semantic-search/services/embeddingWorkerSpawn";

/** Transformers.js and onnxruntime-web are well above this, minified. */
const LIBRARY_MIN_CHARS = 500_000;
/** The name the runtime bundle exports its entry point under. */
const RUNTIME_MARK = "startEmbeddingWorker";

export type WorkerFactories = { library: string; runtime: string };

/**
 * Finds the two factories by shape: the library is the one function of
 * three parameters that large, the runtime the smallest function of two
 * parameters that defines `startEmbeddingWorker`.
 */
export function extractWorkerFactories(mainJs: string): WorkerFactories {
  const file = ts.createSourceFile(
    "main.js",
    mainJs,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const libraries: string[] = [];
  let runtime: string | null = null;

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node)) {
      const text = mainJs.slice(node.getStart(file), node.end);
      if (
        node.parameters.length === 3 &&
        text.length >= LIBRARY_MIN_CHARS &&
        !text.includes(RUNTIME_MARK)
      ) {
        libraries.push(text);
        // Nothing inside the library is a factory.
        return;
      }
      if (
        node.parameters.length === 2 &&
        text.includes(RUNTIME_MARK) &&
        (runtime === null || text.length < runtime.length)
      ) {
        runtime = text;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  if (libraries.length !== 1) {
    throw new Error(
      `expected one Transformers.js factory in main.js, found ${libraries.length}`,
    );
  }
  if (runtime === null) {
    throw new Error("no embedding worker runtime factory in main.js");
  }
  return { library: libraries[0]!, runtime };
}

/**
 * Runs the worker script in a context that holds what an Electron worker
 * gives it and nothing of this process's module scope. Returns the types
 * of the messages it posted while starting.
 */
export function bootWorkerSource(source: string): string[] {
  const posted: string[] = [];
  const self = {
    onmessage: null as unknown,
    postMessage: (message: { type?: unknown }) => {
      posted.push(String(message?.type));
    },
  };
  const context = vm.createContext({
    self,
    require: createRequire(import.meta.url),
    // A copy: the script redefines `process.type`.
    process: {
      type: "worker",
      versions: { ...process.versions },
      env: {},
      platform: process.platform,
      arch: process.arch,
      release: { name: "node" },
    },
    console,
    navigator: { userAgent: "worker-source-check", hardwareConcurrency: 1 },
    URL,
    URLSearchParams,
    Blob,
    TextDecoder,
    TextEncoder,
    WebAssembly,
    fetch,
    Headers,
    Request,
    Response,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    crypto,
  });
  vm.runInContext(source, context, { filename: "embedding-worker.js" });
  if (typeof self.onmessage !== "function") {
    throw new Error("the worker script installed no message handler");
  }
  return posted;
}

/** Throws with the reason when the worker could not start from `mainJs`. */
export function checkWorkerSource(mainJs: string): {
  libraryChars: number;
  runtimeChars: number;
} {
  const { library, runtime } = extractWorkerFactories(mainJs);
  const posted = bootWorkerSource(buildWorkerSource(library, runtime));
  if (!posted.includes("booted")) {
    throw new Error(
      `the worker script never posted "booted" (posted: ${posted.join(", ") || "nothing"})`,
    );
  }
  return { libraryChars: library.length, runtimeChars: runtime.length };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun scripts/workerSourceCheck.ts <path to main.js>");
    process.exit(2);
  }
  try {
    const sizes = checkWorkerSource(await Bun.file(path).text());
    console.warn(
      `[worker-source] the embedding worker boots from ${path} ` +
        `(library ${sizes.libraryChars} chars, runtime ${sizes.runtimeChars} chars)`,
    );
  } catch (error) {
    console.error(
      "[worker-source] check failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}
