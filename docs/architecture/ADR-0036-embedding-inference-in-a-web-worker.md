# ADR-0036: Run WASM embedding inference in Web Workers started from main.js, with a small pool for rebuilds

- **Status:** Accepted and implemented (2026-11-21)
- **Date:** 2026-11-21
- **Scope:** Where the semantic-search embedding models run when their backend is WASM, how the
  worker is built into `main.js` and started, how queries and document batches share it, how many
  workers a rebuild may use, and what the indexer does with them (#664)
- **Builds on:** [ADR-0032](/docs/architecture/ADR-0032-release-the-instance-at-unload.md) (the
  pipeline's `dispose` contract) and
  [ADR-0034](/docs/architecture/ADR-0034-embeddinggemma-sentence-embedding.md) (the
  `sentenceEmbedding` path, which now crosses to the worker)
- **Design credit:** the shape of this decision, a worker behind the `PipelineFactory` seam, queries
  ahead of rebuild work, a main-thread fallback, identical vectors and a pool sized from cores and
  memory, is the plan @marcoaperez wrote on #664 on 2026-11-10. It was implemented in-house.

## Context

A full EmbeddingGemma rebuild runs its inference on Obsidian's renderer main thread. EmbeddingGemma
is pinned to WASM on every machine, and one chunk takes about 2.3 s (25 to 26 chunks per minute
measured on an M4 Max, #664). For the hours a rebuild lasts, the UI does not repaint and the MCP
HTTP server and the shared broker, which live on the same thread, do not answer.

PR #671 made a rebuild resumable: a checkpoint flush every 5 minutes, a `start()` that skips files
already on disk, and progress in the log. It did not move the work, so the freeze stayed.

Three constraints shape the solution:

- **The plugin is one file.** Obsidian installs `main.js`, `manifest.json` and `styles.css`. A
  worker script cannot ship as a fourth file, and the community-plugin review scans `main.js` for
  code evaluated from strings.
- **The index must not be rebuilt for this.** Vectors from the worker have to be the vectors the
  main thread produced, or every user pays another multi-hour rebuild.
- **Headless mode and WebGPU must not change.** The headless build runs under Node with no
  `Worker` of this kind, and on WebGPU the GPU already does the work off the main thread.

## Decision

### 1. WASM inference runs in a worker, chosen behind the `PipelineFactory` seam

`createWorkerPipelineFactory` (`workerPipelineFactory.ts`) wraps `realPipelineFactory` and is what
`productionWiring.ts` hands to every `ModelDownloader`. For each model load it decides:

- the model resolves to **WASM** (EmbeddingGemma always, MiniLM and E5 on a machine with no WebGPU
  adapter): the pipeline is a proxy to an embedding worker;
- the model resolves to **WebGPU**: `inner` is called and the path is the one from before;
- the build **cannot spawn a worker** (a source checkout, the headless build): `inner`, as before.

The indexer, the chunker and the store do not know which one they got. The proxy is a `PipelineFn`
with the same call shape, the same `dispose` (ADR-0032) and the same `sentenceEmbedding` (ADR-0034).

### 2. One copy of the library in `main.js`, as a function, and a worker started from its source

The build has two stages (`bun.config.ts`). Stage 1 bundles Transformers.js and onnxruntime-web as
one CommonJS bundle. Stage 2 puts that bundle into `main.js` wrapped as a real function,
`function (module, exports, require) { ... }`, through a virtual module that replaces
`transformersFactory.ts`. The worker's own runtime (`embeddingWorkerRuntime.ts`) is built the same
way into `embeddingWorkerRuntimeFactory.ts`.

- The **main thread** calls the factory when it needs the library (`loadTransformers`).
- The **worker** is started from a Blob whose text is the two factories' source, read with
  `Function.prototype.toString` (`embeddingWorkerSpawn.ts`).

So `main.js` carries the library once and stays the plugin's only file. Measured locally with Bun
1.4.5, `main.js` grew from 2,567,715 to 2,579,137 bytes (+0.44%).

Nothing is evaluated from a string on the main thread: no `eval`, no `new Function`, no library
kept as a string literal. The only text that becomes code is the source of functions already in
`main.js`, and it becomes code in the worker, through the `Worker` constructor.

Electron reports `process.type === "worker"` inside a worker with Node integration, and
Transformers.js then takes neither its browser branch nor its renderer one. The worker script's
first line sets `process.type` to `"renderer"`, so both threads run the same code path of the
library.

**The build proves the worker can start.** The worker's script is text cut out of `main.js`, and a
second bundler pass that hoisted a helper out of either function, or rewrote its `require`, would
break it in Obsidian only, where §5 answers with the main thread and one warning in the log: #664
again, silently. So a production build ends with `checkWorkerSource`
(`scripts/workerSourceCheck.ts`): it finds the two functions in the `main.js` just written, takes
their source text as `Function.prototype.toString` would return it, assembles it with the same
`buildWorkerSource` the plugin uses, and runs it in an empty `node:vm` context. The build fails
unless the library evaluates and the runtime posts `booted`. It proves the start, not a model load:
that needs Electron and the weights.

The release workflows pin Bun 1.4.2. A production build with that version passes the check and
writes a `main.js` byte for byte equal to the one Bun 1.4.5 writes (2026-11-21).
The release build (`release.yml`, the plugin's `release` script) is the same `--prod` build, so the
check runs on the file that ships.

### 3. Vectors are identical, and the index revision does not change

The worker runs the same library build, the same WASM binaries (`ORT_WASM_PATHS`, one constant
shared with `onnxEnv.ts`), the same dtype and the same ONNX environment the main thread would have
set (`workerEnvFor`). Results cross as transferred `Float32Array` buffers.

Two different things back the claim, and they are not interchangeable:

- `embeddingWorkerHost.test.ts` runs the real worker runtime in process over `structuredClone` and
  shows the **transport** is bit-preserving. It uses a fake model, so it says nothing about the
  model.
- The **real-model** equality was measured in the Labs vault on 2026-11-21: EmbeddingGemma q8, two
  texts at 512 tokens, worker against the forced main-thread fallback, 1,536 floats, 0 differing
  bits. With the pool, eight batches answered by up to four workers against the same eight run one
  after the other on one worker: 12,288 floats, 0 differing bits.

No index revision bump follows.

### 4. The host owns the queue, and a query goes first

Each worker runs one call at a time. The queue lives on the main thread
(`embeddingWorkerHost.ts`), in two lists: queries and documents. Whenever a worker is free it takes
the head of the queries, then the head of the documents.

`embed(texts, "query")` reaches the pipeline with `priority: "query"`. The option is the host's
own: it is set only for a pipeline that declares `acceptsPriority`, and it is removed before the
call crosses to the worker, so Transformers.js on the main thread never sees an option it does not
know.

A query therefore waits for at most the batch that is running on the first worker to free, never
for the rebuild's backlog.

### 5. Fallback to the main thread when the worker cannot boot or cannot load the model

A worker that fails to start, fails to evaluate the library, or does not report ready within the
boot timeout (30 s) raises `WorkerBootError`. The factory then loads the model with `inner`, logs a
warning, and stays on the main thread for the rest of the session: it does not try again on every
model load.

A model that fails to **load inside a worker that booted** is not a boot failure, and the worker
stays in use for the session. That one load is tried once more on the main thread, with a warning
in the log (Stefano's choice on 2026-11-21): a failure that belongs to the worker (its cache, its
memory) then costs a slow rebuild instead of a search that does not start, and a failure that
belongs to the network fails a second time and is reported as the main thread reports it.

A **load that goes silent** is ended. Once a worker has booted, five minutes without a message
from it, download progress included, fail the load and terminate the worker. A slow download keeps
reporting progress and is not cut; a stalled one no longer holds a worker, or the plugin's unload,
forever.

A **call that is never answered** is a crash. A worker that takes more than 30 minutes over one
call, or posts a message that cannot be read, is terminated and handled as below. The limit is
set wide on purpose. One call carries 8 texts at most (`EMBED_BATCH_SIZE`); two texts at 512 tokens
took 14.5 s on the test machine, so a full call is about a minute there, and the limit leaves room
for a machine some thirty times slower. A false timeout is expensive, since it counts as a crash
toward the rules below; a worker that is really stuck costs one slot for half an hour.

A **worker that crashes after it was ready** does not fail the rebuild:

- The call it was running goes back to the head of its queue and runs on another worker, or on a
  new one when it was the only worker. The weights are in the browser cache by then.
- A call that has taken two workers down is rejected, alone. One chunk that kills its worker must
  not push an hours-long rebuild onto the renderer.
- The pipeline moves to the main thread for the rest of its life when no worker can be started
  again, or after three crashes in a row with no call answered in between. It loads the same model
  through `inner` with the same options, runs the calls still queued one at a time, queries first,
  and logs a warning that names the model and the cause. EmbeddingGemma's calls go through the same
  `sentence_embedding` reader there as in the worker, so the vectors do not change mid-rebuild.
- When the restart failed because the worker could not boot at all, the factory also stops trying
  workers for the models loaded after that.

`dispose` terminates a worker that is still starting instead of waiting for it, and does not wait
for a main-thread load in flight either: the plugin's unload must not depend on a load that may
never end.

### 6. A pool for rebuilds, grown on demand

`poolSize` workers at most serve one model, each with its own copy of the model and its own WASM
heap. `workerPoolSize` gives `min(4, cores / 2, total memory / 4 GB)`, at least 1: 4 on 18 cores
and 36 GB, 4 on 8 cores and 16 GB, 2 on 8 GB with four cores or more, 1 on 4 GB or on two cores.
The pooled run in the measurements peaked at about 3.2 GB for four workers, about 0.8 GB each, so
4 GB of total memory per worker leaves the rest of the machine most of it.

- The first worker is the only one a search or a live edit ever uses.
- A further worker starts only while **document batches are waiting**, one at a time, and only
  after the previous one is ready. A query alone never starts one.
- A call is never tied to a worker that is still starting: whichever worker is ready first takes
  the head of the queue.
- A spare that sits idle for 60 s is released.
- A spare that cannot start, or that dies, lowers the pool to the workers that are left for the
  life of that pipeline. The call it was running goes back to the head of its queue once; a second
  loss fails it. A machine that cannot hold four copies of the model so finishes its rebuild with
  the copies it can hold.

Without `SharedArrayBuffer` (the renderer is not cross-origin isolated) each worker computes on one
thread, so the workers do not compete for the same cores.

### 7. The live rebuild runs several files at once, and the checkpoint is a barrier

`EmbeddingProvider.documentConcurrency?()` is a synchronous hint: how many document calls the
provider can run at once, now. It is 1 until the model is loaded in a pool, and reading it never
loads a model. A provider without it is treated as 1.

`runFiles` (`indexer.ts`) starts with one file and reads the hint again whenever a file ends, so a
rebuild widens from the second file on and a session start where every file is skipped never asks
for more than one. The batch size inside a file stays 8: changing it would change the padding and
could change the vectors.

The #671 checkpoint keeps its meaning. When one falls due, no new file starts, the files in flight
end, and only then the store is flushed. What reaches the disk is whole files, `filesDone` counts
files that ended, and with a limit of 1 the behaviour is the one from before, flush for flush.

The first failure stops new files, lets the ones in flight end, and is thrown. `stop()` waits the
same way.

The **low-power indexer stays at one file at a time**. That mode exists to stay out of the way, and
several workers at full load would not. It goes through the same `runFiles` with a limit of 1.

## Measurements (Labs vault, 2026-11-21, MacBook Pro, 18 cores, 36 GB, EmbeddingGemma q8)

| What | Result |
|---|---|
| Two texts at 512 tokens, in the worker | 14.5 s, longest main-thread timer gap 110 ms |
| Worker against forced main-thread fallback | 1,536 floats, 0 differing bits |
| Eight batches of two texts, one after the other | 102.6 s |
| The same eight, sent at once, pool of 4 (includes starting three spares) | 25.5 s, 4.0 times faster |
| Serial against pooled results | 12,288 floats, 0 differing bits |
| A query sent 1.5 s into the pooled run | answered in 1.3 s |
| Peak resident memory, all Obsidian helper processes, pooled run | about 3.2 GB |

| Plugin reloaded with three workers alive | every worker terminated |
| Main thread while four workers embedded for 111 s (worker-message probe) | longest gap 183 ms; idle baseline over 60 s, 152 ms |

One run each. The probe is a worker that posts a message every few milliseconds while the main
thread records when each arrives: unlike a timer, it is not throttled in a hidden window. It
covers inference only, not the indexer's own main-thread work between batches. The timer-gap figure is coarse: the window was in the background and its timers were
throttled. The speedup is what this machine gave; a machine with fewer cores or less memory gets a
smaller pool.

### A full rebuild through the indexer (same vault and machine, 587 notes, 2,127 chunks)

Started with no EmbeddingGemma index on disk, the plugin reloaded once in the middle.

| What | Result |
|---|---|
| Pool size seen by the indexer | 4, seven seconds after the start |
| First checkpoint (short notes) | 183 files, 330 chunks in 312 s, 63 chunks per minute |
| Plugin reloaded at 354 s | 202 files on disk; the next run logged `skippedUnchanged: 202` |
| Long notes, chunks near 496 tokens | 30 to 31 chunks per minute, against about 9 for one worker |
| Whole rebuild | about 65 minutes in two runs, no worker lost, no error |
| Renderer memory while it ran | 365 to 900 MB in the samples taken |

Two things this run showed:

- **The checkpoint barrier costs throughput on long notes.** A checkpoint waits for the files in
  flight, and a long note keeps it waiting while the other workers sit idle: checkpoints landed 5
  to 14 minutes apart, and the gain on long notes was about 3.3 times, not 4. Splitting one file's
  batches across workers would recover it, at the price of the whole-file rule in §7.
- **UI responsiveness was not measured.** The window was in the background for the whole run. A
  timer sampler there showed gaps of up to 2.1 s during the rebuild, and gaps of 6 s and 61 s
  afterwards with nothing running, so it measures the operating system's throttling of a hidden
  window and nothing else. The check that counts is a person using Obsidian during a rebuild.

## Alternatives considered

- **Ship the worker as a second file.** Rejected: Obsidian installs three fixed files, and the
  community-plugin updater would not deliver a fourth.
- **Keep the library as a string in `main.js` and `eval` it, or start the worker from it.**
  Rejected: a second copy of a 2 MB library, and string-evaluated code is exactly what the
  community-plugin review flags. The function form costs 9 KB and evaluates nothing from a string
  on the main thread.
- **Load the library in the worker from a CDN.** Rejected: the library version would no longer be
  the one in `main.js`, which breaks the identical-vectors guarantee and adds a network dependency
  to starting a search.
- **Yield to the event loop between chunks on the main thread.** Rejected: one EmbeddingGemma chunk
  is a single 2.3 s synchronous WASM call. Yielding between calls leaves the UI frozen two seconds
  out of every two and a bit.
- **Fan out inside the provider (split one file's batches across workers).** Rejected in favour of
  whole files in the indexer, Stefano's choice on 2026-11-21: files are the unit the #671
  checkpoint and resume already reason about, and a file is never half-written.
- **Size the pool from free memory.** Rejected: free memory at startup says little about a
  rebuild an hour later. Total memory is stable, and a spare that dies shrinks the pool instead.
- **Concurrent files in the low-power indexer.** Rejected for now: it contradicts what the mode is
  for. One line changes it.

## Consequences

- A rebuild no longer freezes Obsidian or the MCP server on a WASM model, and on a machine with
  cores and memory to spare it is several times faster.
- A pooled rebuild holds one copy of the model per worker. On the test machine that was about
  3.2 GB at peak across Obsidian's helper processes.
- Searches during a rebuild wait for one batch at most.
- The build has two stages. `transformersFactory.ts` and `embeddingWorkerRuntimeFactory.ts` are
  `null` in a source checkout and replaced by the build: `bun test` and the headless build take the
  plain `import()` and the main thread, as before.
- The worker depends on Electron giving a Blob worker Node integration (`require` for the Node
  built-ins the library asks for). If a future Electron removes it, the worker fails to boot and
  the fallback in §5 takes over, with a warning in the log.
- `documentConcurrency` is an optional member of `EmbeddingProvider`. A third provider that does
  not implement it is fed one file at a time.

## Not verified at the time of writing

- A machine with no WebGPU adapter, where MiniLM and E5 also run in the worker. The code path is
  the one EmbeddingGemma takes; no such machine was at hand.
- Windows and Linux.
- A worker crash in a real vault. The retry and the move to the main thread are covered by tests
  with a worker that has no thread, not by a worker that Electron killed.

## References

- Issue: #664, with @marcoaperez's design in the comment of 2026-11-10
- PR #671 (checkpoint, resume, progress), which this builds on and does not change in meaning
- Code: `packages/obsidian-plugin/bun.config.ts` (the two stages) and, under
  `packages/obsidian-plugin/src/features/semantic-search/services/`: `workerPipelineFactory.ts`,
  `embeddingWorkerHost.ts`, `embeddingWorkerRuntime.ts`, `embeddingWorkerSpawn.ts`,
  `embeddingWorkerProtocol.ts`, `transformersFactory.ts`, `transformersModule.ts`,
  `ortWasmPaths.ts`, `indexer.ts` (`runFiles`, `createRebuildCheckpointer`)
- Tests: `embeddingWorkerHost.test.ts`, `workerPipelineFactory.test.ts`, `queryPriority.test.ts`,
  `indexer.test.ts` ("concurrent files")
- [ADR-0032](/docs/architecture/ADR-0032-release-the-instance-at-unload.md),
  [ADR-0034](/docs/architecture/ADR-0034-embeddinggemma-sentence-embedding.md)
