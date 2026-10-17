/**
 * transformers.js, on Node, hands `InferenceSession.create` a file path
 * (and file paths in `externalData`) because the native onnxruntime-node
 * it expects reads them itself. The headless bundle runs the CPU
 * onnxruntime-web build in its place, which would `fetch()` a string as
 * a URL. This reads the bytes first.
 *
 * Two hooks let the headless server shape what the shared semantic search
 * code does without that code knowing:
 *
 * - `beforeCreate` runs before every session is created. The server uses
 *   it to make sure the ONNX runtime files are on disk, which the first
 *   model load needs before onnxruntime-web asks for them.
 * - `afterRun` is awaited after every inference run, and the runs of one
 *   session are made one at a time. Inference runs on the main thread, so
 *   a run holds up the event loop for as long as it takes. Running them
 *   one at a time with a turn for the event loop in between keeps the
 *   server answering other requests while a vault is indexed.
 */

type Session = {
  create: (source: unknown, options?: unknown) => Promise<unknown>;
};

export type SessionHooks = {
  beforeCreate?: () => Promise<void>;
  afterRun?: () => Promise<void>;
};

/** Set by the semantic search wiring. Read when a session is created or run. */
export const sessionHooks: SessionHooks = {};

type Runnable = { run?: (...args: unknown[]) => Promise<unknown> };

/**
 * Make `session.run` take one call at a time, each followed by
 * `sessionHooks.afterRun`. A failed run does not stop the ones queued
 * behind it.
 */
function serializeRuns(session: unknown): unknown {
  const target = session as Runnable | null;
  if (typeof target?.run !== "function") return session;
  const run = target.run.bind(target);
  let tail: Promise<unknown> = Promise.resolve();
  target.run = (...args: unknown[]) => {
    const result = tail.then(() => run(...args));
    tail = result.then(
      () => sessionHooks.afterRun?.(),
      () => sessionHooks.afterRun?.(),
    );
    return result;
  };
  return session;
}

export function patchInferenceSession<T extends { InferenceSession: Session }>(
  ort: T,
  readFile: (path: string) => Promise<Uint8Array>,
): T {
  const session = ort.InferenceSession;
  const create = session.create.bind(session);
  session.create = async (source, options) => {
    await sessionHooks.beforeCreate?.();
    const bytes = typeof source === "string" ? await readFile(source) : source;
    const opts = options as { externalData?: unknown } | undefined;
    if (opts && Array.isArray(opts.externalData)) {
      const externalData = await Promise.all(
        opts.externalData.map(async (entry: { data?: unknown }) =>
          typeof entry.data === "string"
            ? { ...entry, data: await readFile(entry.data) }
            : entry,
        ),
      );
      return serializeRuns(await create(bytes, { ...opts, externalData }));
    }
    return serializeRuns(await create(bytes, options));
  };
  return ort;
}
