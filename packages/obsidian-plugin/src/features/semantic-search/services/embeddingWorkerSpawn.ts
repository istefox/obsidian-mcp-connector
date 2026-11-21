/**
 * Starts an embedding worker from the two factories the desktop build puts
 * into main.js (ADR-0036). The worker's script is their source text, taken
 * with `Function.prototype.toString`, in a Blob: main.js stays the plugin's
 * only file, and nothing is evaluated from a string on the main thread.
 */
import type { WorkerLike } from "./embeddingWorkerHost";
import { embeddingWorkerRuntimeFactory } from "./embeddingWorkerRuntimeFactory";
import { transformersFactory } from "./transformersFactory";

/**
 * Electron reports `process.type === "worker"` in a worker with Node
 * integration, and Transformers.js then takes neither its browser branch
 * nor its renderer one. The first line makes the worker look like the
 * renderer the library is built for here, so both threads run the same
 * code path.
 */
export function buildWorkerSource(
  transformersSource: string,
  runtimeSource: string,
): string {
  return [
    "try{Object.defineProperty(process,'type',{value:'renderer',configurable:true})}catch(e){}",
    "var lib={exports:{}};",
    `(${transformersSource})(lib,lib.exports,require);`,
    "var runtime={exports:{}};",
    `(${runtimeSource})(runtime,runtime.exports);`,
    "runtime.exports.startEmbeddingWorker(lib.exports,self);",
  ].join("\n");
}

/**
 * The spawn function for this build, or `null` when it has no factories
 * (a source checkout, the headless build) or no `Worker`.
 */
export function embeddingWorkerSpawner(): (() => WorkerLike) | null {
  const library = transformersFactory;
  const runtime = embeddingWorkerRuntimeFactory;
  if (!library || !runtime) return null;
  if (typeof Worker === "undefined" || typeof Blob === "undefined") return null;

  let source: string | null = null;
  return () => {
    source ??= buildWorkerSource(
      Function.prototype.toString.call(library),
      Function.prototype.toString.call(runtime),
    );
    const url = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" }),
    );
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    // Revoked once the worker has shown it fetched its script, or failed
    // to: revoking right after the constructor can race that fetch.
    const revoke = (): void => URL.revokeObjectURL(url);
    worker.addEventListener("message", revoke, { once: true });
    worker.addEventListener("error", revoke, { once: true });
    // A worker that stayed silent is terminated by the host: the URL goes
    // then, at the latest.
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      revoke();
      terminate();
    };
    return worker as unknown as WorkerLike;
  };
}
