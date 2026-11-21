/**
 * The plugin's side of an embedding worker (ADR-0036).
 *
 * `createWorkerPipeline` starts a worker, has it load one model and returns
 * a `PipelineFn` whose calls run over there, so a WASM forward pass no
 * longer blocks Obsidian's renderer (#664). To its callers it is the
 * pipeline Transformers.js would have returned.
 *
 * The queue lives here, not in the workers: each worker runs one call at a
 * time and a search query goes ahead of the document batches still waiting.
 *
 * One worker serves searches. Document batches left waiting, as a rebuild
 * that sends several files at once leaves them, make the pipeline start
 * more workers, one after the other up to `poolSize`, each with its own
 * copy of the model; they are released again once they sit idle. A call
 * is never tied to a worker that is still starting: whichever worker is
 * ready first takes the head of the queue.
 */
import { logger } from "$/shared/logger";
import type {
  EmbedTensor,
  PipelineCallOpts,
  PipelineFn,
  ProgressCallback,
} from "./embedder";
import type {
  HostMessage,
  WorkerEnv,
  WorkerMessage,
} from "./embeddingWorkerProtocol";

/** A `Worker`, as far as the host uses it. */
export type WorkerLike = {
  postMessage(message: HostMessage): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerMessage }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
};

/**
 * The worker never got as far as taking a model: the constructor threw, its
 * script failed, or it stayed silent. The caller answers it by running
 * every model on the main thread from then on. A model that fails to load
 * in a worker that did boot is an ordinary error, which the caller answers
 * for that one load only.
 */
export class WorkerBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerBootError";
  }
}

export type WorkerPipelineOpts = {
  spawn: () => WorkerLike;
  model: string;
  options: { device: string; dtype?: string };
  env: WorkerEnv;
  onProgress?: ProgressCallback;
  /** How long a worker may take to evaluate the library. Default 30 s. */
  bootTimeoutMs?: number;
  /** Most workers alive at once. Default 1. */
  poolSize?: number;
  /** How long a spare worker may sit idle before it is released. */
  idleReleaseMs?: number;
};

const DEFAULT_BOOT_TIMEOUT_MS = 30_000;
const DISPOSE_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_RELEASE_MS = 60_000;

type Job = {
  id: number;
  query: boolean;
  /** Already put back once after its worker died. */
  retried: boolean;
  input: string | string[];
  opts: PipelineCallOpts | undefined;
  sentence: boolean;
  resolve: (tensor: EmbedTensor) => void;
  reject: (err: Error) => void;
};

/** One started worker with its model loaded. */
type Session = {
  worker: WorkerLike;
  /** Called with the reason when the worker dies after it loaded. */
  onCrash: ((err: Error) => void) | null;
  onResult: ((message: WorkerMessage) => void) | null;
};

function startSession(opts: WorkerPipelineOpts): Promise<Session> {
  return new Promise<Session>((resolve, reject) => {
    let worker: WorkerLike;
    try {
      worker = opts.spawn();
    } catch (err) {
      reject(
        new WorkerBootError(
          `embedding worker could not be created: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    let booted = false;
    let loaded = false;
    const session: Session = { worker, onCrash: null, onResult: null };

    const bootTimer = setTimeout(() => {
      fail(new WorkerBootError("embedding worker did not start in time"));
    }, opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS);

    const fail = (err: Error): void => {
      clearTimeout(bootTimer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      reject(err);
    };

    worker.onerror = (event) => {
      const detail = event.message ?? "unknown error";
      if (!booted) {
        fail(
          new WorkerBootError(`embedding worker failed to start: ${detail}`),
        );
      } else if (!loaded) {
        fail(new Error(`embedding worker failed while loading: ${detail}`));
      } else {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        session.onCrash?.(new Error(`embedding worker crashed: ${detail}`));
      }
    };

    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "booted") {
        booted = true;
        clearTimeout(bootTimer);
        worker.postMessage({
          type: "load",
          model: opts.model,
          options: opts.options,
          env: opts.env,
        });
      } else if (message.type === "progress") {
        opts.onProgress?.(message.info);
      } else if (message.type === "loaded") {
        loaded = true;
        resolve(session);
      } else if (message.type === "load-error") {
        fail(new Error(message.message));
      } else {
        session.onResult?.(message);
      }
    };
  });
}

/** One place in the pool: a worker, or one being started, and its call. */
type Slot = {
  session: Session | null;
  starting: Promise<void> | null;
  running: Job | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * Has the worker release its ONNX sessions (ADR-0032), then terminates it
 * either way: that frees the WASM heap with it.
 */
async function closeSession(s: Session): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
    s.onCrash = () => {
      clearTimeout(timer);
      resolve();
    };
    s.onResult = (message) => {
      if (message.type !== "disposed") return;
      clearTimeout(timer);
      resolve();
    };
    s.worker.postMessage({ type: "dispose" });
  });
  s.worker.onmessage = null;
  s.worker.onerror = null;
  s.worker.terminate();
}

export async function createWorkerPipeline(
  opts: WorkerPipelineOpts,
): Promise<PipelineFn> {
  // The first start is awaited: a worker that cannot boot rejects here,
  // where the caller can still choose the main thread.
  const first = await startSession(opts);

  let disposed = false;
  let nextId = 1;
  // Lowered when a spare worker fails to start or dies: the machine has
  // shown how many copies of the model it can hold.
  let maxSize = Math.max(1, Math.floor(opts.poolSize ?? 1));
  const idleReleaseMs = opts.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
  const slots: Slot[] = [];
  const queries: Job[] = [];
  const documents: Job[] = [];

  const stopIdleTimer = (slot: Slot): void => {
    if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
  };

  const remove = (slot: Slot): void => {
    stopIdleTimer(slot);
    const at = slots.indexOf(slot);
    if (at !== -1) slots.splice(at, 1);
  };

  const toError = (err: unknown): Error =>
    err instanceof Error ? err : new Error(String(err));

  const bind = (slot: Slot, s: Session): void => {
    s.onResult = (message) => {
      if (message.type !== "result" && message.type !== "run-error") return;
      const job = slot.running;
      if (!job || job.id !== message.id) return;
      slot.running = null;
      if (message.type === "result") {
        job.resolve({
          data: message.data,
          ...(message.dims ? { dims: message.dims } : {}),
        });
      } else {
        job.reject(new Error(message.message));
      }
      pump();
    };
    s.onCrash = (err) => {
      logger.warn("semantic-search: embedding worker crashed", {
        message: err.message,
        workers: slots.length,
      });
      const job = slot.running;
      slot.running = null;
      slot.session = null;
      if (slots.length > 1) {
        // One of several died, most likely for want of memory: stop
        // asking for that many, and give its call to the others once.
        remove(slot);
        maxSize = slots.length;
        if (job && !job.retried) {
          job.retried = true;
          (job.query ? queries : documents).unshift(job);
        } else {
          job?.reject(err);
        }
      } else {
        // The only worker: its call fails, and the next one starts a
        // fresh worker. The weights are in the browser cache by then.
        job?.reject(err);
      }
      pump();
    };
  };

  const start = (slot: Slot): void => {
    // Progress goes nowhere here: the downloader that listened to the
    // first load has long reported "ready".
    slot.starting = startSession({ ...opts, onProgress: undefined }).then(
      async (s) => {
        slot.starting = null;
        if (disposed || !slots.includes(slot)) {
          await closeSession(s);
          return;
        }
        slot.session = s;
        bind(slot, s);
        pump();
      },
      (err: unknown) => {
        slot.starting = null;
        if (disposed) return;
        if (slots.some((o) => o !== slot && (o.session || o.starting))) {
          // A spare that would not start: carry on with the workers
          // there are, and stop asking for more.
          remove(slot);
          maxSize = slots.length;
          logger.warn("semantic-search: spare embedding worker not started", {
            message: toError(err).message,
            workers: slots.length,
          });
        } else {
          // No worker at all: the call at the head of the queue fails,
          // and the one after it tries again.
          (queries.shift() ?? documents.shift())?.reject(toError(err));
        }
        pump();
      },
    );
  };

  /** A worker with nothing to do: release it later if it is a spare. */
  const rest = (slot: Slot): void => {
    stopIdleTimer(slot);
    if (slots.length < 2) return;
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      if (slot.running || slots.length < 2 || disposed) return;
      const live = slot.session;
      slot.session = null;
      remove(slot);
      if (live) void closeSession(live);
    }, idleReleaseMs);
  };

  const pump = (): void => {
    if (disposed) return;
    while (queries.length > 0 || documents.length > 0) {
      const slot = slots.find((s) => s.session && !s.running);
      const live = slot?.session;
      if (!slot || !live) break;
      const job = queries.shift() ?? documents.shift();
      if (!job) break;
      stopIdleTimer(slot);
      slot.running = job;
      live.worker.postMessage({
        type: "run",
        id: job.id,
        input: job.input,
        ...(job.opts ? { opts: job.opts } : {}),
        sentence: job.sentence,
      });
    }
    if (queries.length > 0 || documents.length > 0) {
      if (!slots.some((s) => s.session || s.starting)) {
        // The only worker died: any call brings a new one.
        const cold = slots[0] ?? newSlot();
        start(cold);
      } else if (
        // Only document batches left waiting are worth another copy of
        // the model, and one worker is started at a time.
        documents.length > 0 &&
        slots.length < maxSize &&
        !slots.some((s) => s.starting)
      ) {
        start(newSlot());
      }
    }
    for (const slot of slots) {
      if (slot.session && !slot.running && slot.idleTimer === null) rest(slot);
    }
  };

  const newSlot = (): Slot => {
    const slot: Slot = {
      session: null,
      starting: null,
      running: null,
      idleTimer: null,
    };
    slots.push(slot);
    return slot;
  };

  const submit = (
    input: string | string[],
    callOpts: PipelineCallOpts | undefined,
    sentence: boolean,
  ): Promise<EmbedTensor> => {
    if (disposed) {
      return Promise.reject(
        new Error("embedding worker pipeline was disposed"),
      );
    }
    return new Promise<EmbedTensor>((resolve, reject) => {
      // `priority` is the host's own: it does not cross to the worker.
      const { priority, ...rest } = callOpts ?? {};
      const job: Job = {
        id: nextId++,
        query: priority === "query",
        retried: false,
        input,
        opts: callOpts ? rest : undefined,
        sentence,
        resolve,
        reject,
      };
      (job.query ? queries : documents).push(job);
      pump();
    });
  };

  const pipe: PipelineFn = (input, callOpts) => submit(input, callOpts, false);
  pipe.acceptsPriority = true;
  pipe.concurrency = () => maxSize;
  pipe.sentenceEmbedding = (input, callOpts) => submit(input, callOpts, true);
  pipe.dispose = async () => {
    if (disposed) return;
    disposed = true;
    const err = new Error("embedding worker pipeline was disposed");
    const lost = [
      ...slots.flatMap((s) => (s.running ? [s.running] : [])),
      ...queries,
      ...documents,
    ];
    queries.length = 0;
    documents.length = 0;
    const live = slots.flatMap((s) => (s.session ? [s.session] : []));
    // A worker still starting closes itself once it is up.
    const starting = slots.flatMap((s) => (s.starting ? [s.starting] : []));
    for (const slot of slots) {
      stopIdleTimer(slot);
      slot.running = null;
      slot.session = null;
    }
    slots.length = 0;
    for (const job of lost) job.reject(err);
    await Promise.all([...live.map(closeSession), ...starting]);
  };

  // The first worker takes its handlers now, so a crash while idle is seen.
  const primary = newSlot();
  primary.session = first;
  bind(primary, first);
  return pipe;
}
