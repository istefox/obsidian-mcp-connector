/**
 * The Transformers.js bundle as one self-contained function (ADR-0036).
 *
 * In a source checkout (`bun test`, the headless build) there is none and
 * this is `null`: `loadTransformers()` then imports the package the usual
 * way. The desktop build replaces this whole module (see `bun.config.ts`)
 * with the library pre-bundled as a CommonJS factory:
 *
 *   function (module, exports, require) { ...Transformers.js + ORT... }
 *
 * The factory closes over nothing outside its three parameters. That is
 * what lets the same single copy serve two callers: the main thread calls
 * it, and the embedding worker is started from its source text
 * (`Function.prototype.toString`), so main.js carries the library once.
 */
export type TransformersFactory = (
  module: { exports: unknown },
  exports: unknown,
  require: unknown,
) => void;

export const transformersFactory: TransformersFactory | null = null;
