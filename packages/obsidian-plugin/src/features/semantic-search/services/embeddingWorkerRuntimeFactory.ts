/**
 * `embeddingWorkerRuntime.ts` as one self-contained function (ADR-0036).
 *
 * `null` in a source checkout. The desktop build replaces this module (see
 * `bun.config.ts`) with that file bundled as a CommonJS factory, for the
 * same reason and by the same mechanism as `transformersFactory.ts`: the
 * embedding worker is started from the function's source text, so the
 * function must close over nothing.
 */
export type WorkerRuntimeFactory = (
  module: { exports: unknown },
  exports: unknown,
) => void;

export const embeddingWorkerRuntimeFactory: WorkerRuntimeFactory | null = null;
