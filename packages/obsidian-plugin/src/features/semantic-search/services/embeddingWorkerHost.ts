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
import { wrapSentenceEmbedding } from "./sentenceEmbeddingPipeline";
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
  /** A message from the worker that could not be read. */
  onmessageerror?: (() => void) | null;
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
  /**
   * How long a model load may go without a word from the worker, progress
   * events included. Default 5 min: a download that stalls ends there.
   */
  loadStallTimeoutMs?: number;
  /**
   * How long a worker may take to answer one call. Default 30 min: a call
   * is 8 texts at most, about a minute on the machine measured, and a
   * false timeout costs a crash. Past it the worker counts as dead.
   */
  callTimeoutMs?: number;
  /** Most workers alive at once. Default 1. */
  poolSize?: number;
  /** How long a spare worker may sit idle before it is released. */
  idleReleaseMs?: number;
  /**
   * Loads the same model on the main thread. Given, the pipeline moves
   * there for good once its workers stop coming back, instead of failing
   * every call; absent, those calls are rejected.
   */
  fallback?: () => Promise<PipelineFn>;
  /** Called when a worker could not even boot after the first one did. */
  onWorkerUnavailable?: () => void;
};

const DEFAULT_BOOT_TIMEOUT_MS = 30_000;
const DEFAULT_LOAD_STALL_TIMEOUT_MS = 300_000;
const DEFAULT_CALL_TIMEOUT_MS = 1_800_000;
const DISPOSE_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_RELEASE_MS = 60_000;
/** A call that took this many workers down with it is rejected. */
const MAX_CRASHES_PER_JOB = 2;
/** Worker crashes in a row, no call answered in between, before giving up. */
const MAX_CONSECUTIVE_CRASHES = 3;

type Job = {
  id: number;
  query: boolean;
  /** How many workers died while running it. */
  crashes: number;
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

/** A worker being started, and the way to give up on it. */
type Starting = {
  ready: Promise<Session>;
  /** Terminates the worker if it is not up yet. No effect afterwards. */
  cancel: (err: Error) => void;
};

function startSession(opts: WorkerPipelineOpts): Starting {
  let cancel: (err: Error) => void = () => {};
  const ready = new Promise<Session>((resolve, reject) => {
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
    let settled = false;
    const session: Session = { worker, onCrash: null, onResult: null };

    const bootTimer = setTimeout(() => {
      fail(new WorkerBootError("embedding worker did not start in time"));
    }, opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS);

    // Armed once the worker booted, pushed back by every message from it:
    // a load is allowed to be long, not to be silent.
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const stallMs = opts.loadStallTimeoutMs ?? DEFAULT_LOAD_STALL_TIMEOUT_MS;
    const stopStallTimer = (): void => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = null;
    };
    const armStallTimer = (): void => {
      stopStallTimer();
      stallTimer = setTimeout(() => {
        fail(new Error("embedding worker stopped answering while loading"));
      }, stallMs);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bootTimer);
      stopStallTimer();
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      reject(err);
    };

    const failed = (detail: string): void => {
      if (!booted) {
        fail(
          new WorkerBootError(`embedding worker failed to start: ${detail}`),
        );
      } else if (!loaded) {
        fail(new Error(`embedding worker failed while loading: ${detail}`));
      } else {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        session.onCrash?.(new Error(`embedding worker crashed: ${detail}`));
      }
    };
    worker.onerror = (event) => failed(event.message ?? "unknown error");
    // A result that cannot be read is a call that will never be answered.
    worker.onmessageerror = () => failed("unreadable message");

    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "booted") {
        booted = true;
        clearTimeout(bootTimer);
        armStallTimer();
        worker.postMessage({
          type: "load",
          model: opts.model,
          options: opts.options,
          env: opts.env,
        });
      } else if (message.type === "progress") {
        armStallTimer();
        opts.onProgress?.(message.info);
      } else if (message.type === "loaded") {
        loaded = true;
        settled = true;
        stopStallTimer();
        resolve(session);
      } else if (message.type === "load-error") {
        fail(new Error(message.message));
      } else {
        session.onResult?.(message);
      }
    };
    cancel = fail;
  });
  return { ready, cancel };
}

/** One place in the pool: a worker, or one being started, and its call. */
type Slot = {
  session: Session | null;
  starting: Promise<void> | null;
  /** Gives up on the worker being started. Set while `starting` is. */
  cancelStart: ((err: Error) => void) | null;
  running: Job | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Ends a call the worker does not answer. Set while `running` is. */
  callTimer: ReturnType<typeof setTimeout> | null;
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
  s.worker.onmessageerror = null;
  s.worker.terminate();
}

export async function createWorkerPipeline(
  opts: WorkerPipelineOpts,
): Promise<PipelineFn> {
  // The first start is awaited: a worker that cannot boot rejects here,
  // where the caller can still choose the main thread.
  const first = await startSession(opts).ready;

  let disposed = false;
  let nextId = 1;
  // Lowered when a spare worker fails to start or dies: the machine has
  // shown how many copies of the model it can hold.
  let maxSize = Math.max(1, Math.floor(opts.poolSize ?? 1));
  const idleReleaseMs = opts.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
  const slots: Slot[] = [];
  const queries: Job[] = [];
  const documents: Job[] = [];
  let consecutiveCrashes = 0;
  // Set once the workers are given up on: no worker is started after
  // that, and with none left the calls run here, one at a time.
  let onMainThread = false;
  const main: {
    loading: Promise<PipelineFn> | null;
    pipe: PipelineFn | null;
    sentence: PipelineFn | null;
    running: Job | null;
  } = { loading: null, pipe: null, sentence: null, running: null };

  const moveToMainThread = (cause: Error): void => {
    if (onMainThread) return;
    onMainThread = true;
    logger.warn(
      "semantic-search: embedding workers given up on, running on the main thread",
      { model: opts.model, message: cause.message },
    );
    for (const slot of [...slots]) {
      if (slot.starting) {
        slot.cancelStart?.(cause);
        remove(slot);
      } else if (!slot.session) {
        remove(slot);
      }
    }
  };

  const runOnMainThread = async (job: Job): Promise<void> => {
    main.running = job;
    try {
      if (!main.pipe) {
        main.loading ??= opts.fallback!();
        try {
          main.pipe = await main.loading;
        } finally {
          main.loading = null;
        }
        if (disposed) {
          void main.pipe.dispose?.();
          return;
        }
      }
      let run = main.pipe;
      if (job.sentence) {
        main.sentence ??= wrapSentenceEmbedding(main.pipe);
        run = main.sentence;
      }
      job.resolve(await run(job.input, job.opts));
    } catch (err) {
      job.reject(toError(err));
    } finally {
      main.running = null;
      pump();
    }
  };

  const stopIdleTimer = (slot: Slot): void => {
    if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
  };

  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const stopCallTimer = (slot: Slot): void => {
    if (slot.callTimer !== null) clearTimeout(slot.callTimer);
    slot.callTimer = null;
  };

  const remove = (slot: Slot): void => {
    stopIdleTimer(slot);
    stopCallTimer(slot);
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
      stopCallTimer(slot);
      slot.running = null;
      if (message.type === "result") {
        consecutiveCrashes = 0;
        job.resolve({
          data: message.data,
          ...(message.dims ? { dims: message.dims } : {}),
        });
      } else {
        job.reject(new Error(message.message));
      }
      pump();
    };
    s.onCrash = (err) => crashed(slot, err);
  };

  /** The one place a dead worker is handled, whatever killed it. */
  const crashed = (slot: Slot, err: Error): void => {
    logger.warn("semantic-search: embedding worker crashed", {
      message: err.message,
      workers: slots.length,
    });
    const job = slot.running;
    stopCallTimer(slot);
    slot.running = null;
    slot.session = null;
    consecutiveCrashes += 1;
    if (slots.length > 1 || onMainThread) {
      // One of several died, most likely for want of memory: stop
      // asking for that many.
      remove(slot);
      maxSize = Math.max(1, slots.length);
    }
    // Its call goes back to the head of the queue, for another worker or
    // a fresh one. A call that keeps killing its worker fails alone.
    if (job) {
      job.crashes += 1;
      if (job.crashes < MAX_CRASHES_PER_JOB) {
        (job.query ? queries : documents).unshift(job);
      } else {
        job.reject(err);
      }
    }
    if (opts.fallback && consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      moveToMainThread(err);
    }
    pump();
  };

  const start = (slot: Slot): void => {
    // Progress goes nowhere here: the downloader that listened to the
    // first load has long reported "ready".
    const attempt = startSession({ ...opts, onProgress: undefined });
    slot.cancelStart = attempt.cancel;
    slot.starting = attempt.ready.then(
      async (s) => {
        slot.starting = null;
        slot.cancelStart = null;
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
        slot.cancelStart = null;
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
        } else if (opts.fallback) {
          // No worker at all, and none to be had: the queue runs on the
          // main thread from here on.
          remove(slot);
          if (err instanceof WorkerBootError) opts.onWorkerUnavailable?.();
          moveToMainThread(toError(err));
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
      slot.callTimer = setTimeout(() => {
        // Nothing can be asked of a worker that is stuck in a call: it is
        // terminated, and handled as any other dead worker.
        slot.callTimer = null;
        live.onResult = null;
        live.onCrash = null;
        live.worker.onmessage = null;
        live.worker.onerror = null;
        live.worker.onmessageerror = null;
        live.worker.terminate();
        crashed(slot, new Error("embedding worker crashed: no answer in time"));
      }, callTimeoutMs);
      live.worker.postMessage({
        type: "run",
        id: job.id,
        input: job.input,
        ...(job.opts ? { opts: job.opts } : {}),
        sentence: job.sentence,
      });
    }
    if (onMainThread) {
      if (slots.length === 0 && !main.running) {
        const job = queries.shift() ?? documents.shift();
        if (job) void runOnMainThread(job);
      }
    } else if (queries.length > 0 || documents.length > 0) {
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
      cancelStart: null,
      running: null,
      idleTimer: null,
      callTimer: null,
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
        crashes: 0,
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
  pipe.concurrency = () => (onMainThread ? Math.max(1, slots.length) : maxSize);
  pipe.sentenceEmbedding = (input, callOpts) => submit(input, callOpts, true);
  pipe.dispose = async () => {
    if (disposed) return;
    disposed = true;
    const err = new Error("embedding worker pipeline was disposed");
    const lost = [
      ...slots.flatMap((s) => (s.running ? [s.running] : [])),
      ...(main.running ? [main.running] : []),
      ...queries,
      ...documents,
    ];
    queries.length = 0;
    documents.length = 0;
    const live = slots.flatMap((s) => (s.session ? [s.session] : []));
    // A worker still starting is terminated where it stands: its load may
    // never end, and the plugin's unload waits on this call.
    const starting = slots.flatMap((s) => (s.starting ? [s.starting] : []));
    for (const slot of slots) {
      slot.cancelStart?.(err);
      stopIdleTimer(slot);
      stopCallTimer(slot);
      slot.running = null;
      slot.session = null;
    }
    slots.length = 0;
    for (const job of lost) job.reject(err);
    // A main-thread load still in flight is not waited for: it releases
    // itself in `runOnMainThread` once it lands.
    const loadedHere = main.pipe;
    main.pipe = null;
    main.sentence = null;
    await Promise.all([
      ...live.map(closeSession),
      ...starting,
      ...(loadedHere?.dispose ? [loadedHere.dispose()] : []),
    ]);
  };

  // The first worker takes its handlers now, so a crash while idle is seen.
  const primary = newSlot();
  primary.session = first;
  bind(primary, first);
  return pipe;
}
