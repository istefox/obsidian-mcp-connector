/**
 * Lazy loader for `@huggingface/transformers`.
 *
 * A static import evaluates Transformers.js and onnxruntime-web while the
 * plugin module loads, before `onload` runs: about 33 ms and 9 MB of heap
 * that a session without semantic search never uses. So the library runs
 * on the first call, and nothing is fetched at runtime.
 *
 * Two sources, one per build (ADR-0036):
 * - The desktop build pre-bundles the library as a factory function
 *   (`transformersFactory.ts`), the same copy the embedding worker starts
 *   from. Calling it here evaluates the library on the main thread.
 * - A source checkout and the headless build have no factory and take the
 *   `import()` below. A `require()` there would make the bundler pick the
 *   CommonJS build of the library instead of the ES module build.
 */
import {
  transformersFactory,
  type TransformersFactory,
} from "./transformersFactory";

type Transformers = typeof import("@huggingface/transformers");

let loading: Promise<Transformers> | undefined;

export function loadTransformers(): Promise<Transformers> {
  const factory = transformersFactory;
  return (loading ??= factory
    ? Promise.resolve().then(() =>
        instantiateTransformers<Transformers>(factory, require),
      )
    : import("@huggingface/transformers"));
}

/**
 * Runs a pre-bundled CommonJS factory and returns what it exported. The
 * `require` it receives resolves Node built-ins only: everything else is
 * already inside the factory.
 */
export function instantiateTransformers<T>(
  factory: TransformersFactory,
  nodeRequire: unknown,
): T {
  const module: { exports: unknown } = { exports: {} };
  factory(module, module.exports, nodeRequire);
  return module.exports as T;
}
