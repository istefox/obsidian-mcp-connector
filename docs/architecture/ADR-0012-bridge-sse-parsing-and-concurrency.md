# ADR-0012: Bridge SSE parsing and concurrency

**Status:** Accepted
**Date:** 2026-07-14
**Deciders:** Stefano Ferri

---

## Context

`scripts/obsidian_mcp_bridge.py` is a stdlib-only Windows workaround
(`docs/windows-post-only-bridge.md`) that replaces `mcp-remote` for clients
where the official bridge hangs on connect. It is a stdio ⇄ HTTP adapter:
one line of JSON-RPC in on stdin, one POST out, one line of JSON-RPC out on
stdout. Today it does two things that are now wrong:

1. It calls `json.loads` directly on the raw HTTP response body. Since
   0.22.0 the plugin's server (`services/mcpServer.ts`, confirmed at read
   time around lines 155-169) answers with `text/event-stream` instead of
   `application/json` whenever the request targets `activate_tool` /
   `activate_tools` (`enableJsonResponse: !isActivateTool`), specifically so
   the `tools/list_changed` notification can ride along with the response.
   `json.loads` on an SSE body (`event: message\ndata: {...}\n\n`) always
   raises, so every activation call through this bridge fails with
   `-32000 non-JSON response` (issue #355, audit finding 2).
2. The stdin loop is strictly serial: it reads one line, POSTs, blocks up to
   30s waiting for the response, writes stdout, then reads the next line.
   Parallel tool calls from the client queue behind whichever call is
   slowest, instead of running concurrently.

The script has zero automated tests today (confirmed:
`find . -iname "*bridge*test*"` and a grep for `obsidian_mcp_bridge` across
`*.ts`/`*.md`/`*.json` return no test file and no production call site
outside docs).

This ADR is independent of Phase 1 (ADR-0010, registry disable states) and
Phase 2 (ADR-0011, self-healing inactive tool error) — those live on
separate branches and change the TypeScript plugin only. This ADR touches
only `scripts/obsidian_mcp_bridge.py` and its doc.

### Hard constraints (from SPEC.md, non-negotiable)

- Standard library only: `json`, `os`, `sys`, `urllib`, `threading` (plus
  `time` for the shutdown grace period). No `pip install`, ever — this is
  the bridge's entire reason to exist (a Windows user with a bare Python
  install and no package manager access must be able to run it unmodified).
- CLI contract unchanged: `python bridge.py <url> [token]`,
  `OBSIDIAN_BEARER_TOKEN` env fallback, same stdin/stdout/stderr channel
  usage.
- No plugin/server change, no `mcp-remote` change, no asyncio rewrite.

## Decision

Three coupled changes, all confined to `scripts/obsidian_mcp_bridge.py`:

### 1. SSE response parsing: a hand-rolled, pure `parse_sse()` function

Add `parse_sse(body: str) -> list[dict]`, a pure function with no I/O:
splits the body into lines using a regex that recognizes exactly the three
line endings the SSE spec defines (`\r\n`, `\r`, `\n` — not Python's
`str.splitlines()`, which also breaks on Unicode line/paragraph separators
and vertical-tab/form-feed characters that could theoretically appear
unescaped inside a JSON string value); buffers consecutive `data:` lines,
joining them with `\n` per the SSE multi-line-data rule, on dispatch (blank
line, or end of body for a server that omits the trailing blank line);
ignores `:`-comment lines and any other field (`event:`, `id:`, `retry:`) —
this bridge only needs the JSON-RPC payload, not SSE event metadata. A
`data:` block that fails to `json.loads` is dropped, not raised — one
malformed event does not lose the rest of a body that parses fine.

A second pure function, `route_sse_messages(messages, request_id) -> tuple[list[dict], dict | None]`,
splits the parsed messages into (notifications, response): the one message
whose `"id"` equals `request_id` is the response; everything else (id-less,
or — defensively — a different id) is a notification, kept in original
order. This directly satisfies the edge case "notification before response
in the body: both must be forwarded, notification first" — order is
preserved because `parse_sse` already returns messages in body order and
`route_sse_messages` only partitions, never reorders.

Both functions take/return plain data (str in, list[dict] out; list[dict] +
id in, tuple out) — no sockets, no threads, no stdout — so they are
unit-testable in isolation, per SPEC's Architecture section.

The glue that calls these lives in the per-request handler: branch on the
response's `Content-Type` header (stripped of any `; charset=...`
parameter); `application/json` keeps today's single `json.loads`;
`text/event-stream` decodes the body as UTF-8, calls `parse_sse` then
`route_sse_messages`, writes each notification then the response. If no
message in the body carries the request's id (empty parse, or events
present but none match), that is the "malformed SSE" edge case and gets the
existing `-32000 non-JSON response (HTTP <status>)` error — same message
text and shape as today's catch-all, so no new error vocabulary is
introduced.

### 2. Concurrency: one `threading.Thread` per incoming request line

The main thread only reads stdin and dispatches; it never blocks on a POST
itself (except for `initialize`, see below). For every stdin line that
parses as a JSON-RPC **request** (has a non-null `"id"`), the main thread
starts a daemon `threading.Thread` running `handle_request(...)` and moves
on to the next stdin line immediately — this is what makes parallel client
calls actually run in parallel instead of queueing. Lines that are
**notifications** (no `"id"`, client-to-server) are POSTed synchronously on
the main thread and the response is discarded (SPEC: "notifications may
stay on the main thread" — they get an empty 202 today and don't need
concurrency).

The per-request 30s `urlopen` timeout is unchanged in value; it now applies
per thread instead of to a shared serial queue, which is exactly SPEC's
"per-request timeout stays 30s but applies per thread, not the whole
queue." A thread's `URLError`/timeout emits `-32000` for that id only —
every other in-flight thread is unaffected, matching the current
single-request error isolation.

On stdin EOF (client closed the pipe / process is shutting down), the main
loop stops accepting new lines and joins every started thread against a
**single shared deadline** (`time.monotonic() + 35s`, not 35s per thread) —
this bounds total shutdown time to ~35s regardless of how many requests
were in flight, rather than summing per-thread grace periods. All worker
threads are `daemon=True`, so if a thread somehow outlives the join budget
(e.g. a DNS resolution hang that bypasses the socket timeout on some
platform), the process still exits 0 instead of hanging forever — daemon
threads never block interpreter shutdown.

### 3. Serialized stdout, synchronous `initialize`

A single module-level `threading.Lock` guards one critical section:
"serialize one JSON object to text, write it, flush." Every stdout write
(a request's response, an extracted notification, or a `-32000` error) goes
through this one `write_line()` helper. This is what keeps SPEC's "each
stdout line must stay atomic (lock held for the full line + flush)"
guarantee even though responses across different requests can now complete
and write in any order — JSON-RPC correlates by `id`, so interleaved
*complete* lines are correct; interleaved *partial* lines (impossible with
this lock) would corrupt the stream.

`initialize` is handled synchronously on the main thread, before any
worker thread is spawned, exactly as SPEC permits ("initialize is answered
before the client sends anything else"). This removes the need for a lock
around `negotiated_version`: it is written exactly once, synchronously,
before any thread that reads it exists to race with. Every later
`handle_request` call only reads the already-set value.

## Alternatives considered

**SSE parsing:**

1. *(Rejected)* **Third-party SSE client library** (e.g. `sseclient-py`).
   Would need `pip install`, which directly violates the hard
   "standard library only" constraint that is this bridge's reason to
   exist — a Windows user reaching for this script by definition cannot or
   does not want to manage Python packages.
2. *(Rejected)* **Require the server to stay JSON-only and treat SSE as a
   bug to fix upstream.** Out of scope (SPEC: "Any plugin/server change" is
   explicitly out), and it would not close issue #355 today — the server
   already ships 0.22.0's SSE behavior; this bridge has to interoperate
   with it as it exists now, not with a hypothetical future server.
3. *(Chosen)* **Hand-rolled minimal SSE parser using `re.split` line
   segmentation + a `data:` buffer**, implementing only the subset of the
   spec this bridge's traffic actually uses (comment lines, `data:`
   multi-line accumulation, blank-line dispatch). ~25 lines, zero
   dependencies, directly testable as a pure function.

**Concurrency model:**

1. *(Rejected)* **`concurrent.futures.ThreadPoolExecutor` with a fixed pool
   size.** A bounded pool reintroduces partial serialization for any burst
   of concurrent calls larger than the pool size — exactly the symptom this
   change exists to remove — and its graceful-shutdown API
   (`shutdown(wait=..., cancel_futures=...)`) is no simpler than the raw
   `Thread` + shared-deadline-join approach chosen. A single-user local
   bridge (SPEC: "threads are sufficient for a single-user bridge") will
   not see enough concurrent in-flight calls for unbounded thread creation
   to be a real resource problem.
2. *(Rejected)* **asyncio rewrite** (`asyncio` + `loop.run_in_executor` for
   the blocking `urllib` calls). Explicitly excluded by SPEC. Also a worse
   fit for the Windows-primary target than threads: `asyncio`'s
   `ProactorEventLoop` (the Windows-default loop) does not support
   `loop.add_reader` on pipes, so reading `sys.stdin` asynchronously on
   Windows needs a separate thread anyway (`run_in_executor` on a
   blocking `readline`) — asyncio would add an event loop on top of a
   thread that is still doing the actual stdin blocking read, for no
   concurrency benefit over plain threading.
3. *(Chosen)* **One `threading.Thread` per incoming request line**, daemon,
   joined at EOF against a shared deadline. Matches SPEC's explicit design
   ("handle each incoming JSON-RPC request in its own thread") and the
   single-user scale assumption.

**Stdout serialization:**

1. *(Rejected)* **Dedicated writer thread + `queue.Queue`** consumed by one
   writer, all workers push completed lines instead of writing directly.
   Fully decouples I/O from worker threads, but adds another thread with
   its own shutdown protocol (sentinel value, join) for no measurable
   benefit at this scale — a `dumps()` + `write()` + `flush()` critical
   section is microseconds long, so lock contention is not a real cost.
2. *(Chosen)* **Single global `threading.Lock`** held for the full
   "serialize + write + flush" of one line. Simplest correct option;
   directly implements SPEC's atomicity requirement.

**`negotiated_version` / `initialize` handling:**

1. *(Rejected)* **Keep `negotiated_version` as a shared mutable cell guarded
   by its own lock**, acquired on every POST (read) and once (write).
   Correct, but adds lock-acquisition overhead to every single request for
   a value that in the real MCP handshake is written exactly once, at the
   very start, before any concurrent traffic exists.
2. *(Chosen)* **Handle `initialize` synchronously, before threading
   starts.** SPEC explicitly sanctions this simplification; it removes the
   lock entirely for this piece of state — reads never race a write because
   the one write happens-before any thread that could read it is created.

## Consequences

### Positive

- Closes issue #355: `activate_tool` / `activate_tools` through the bridge
  succeed instead of a guaranteed `-32000 non-JSON response`; the client
  can act on the `tools/list_changed` notification the server sends
  alongside the activation result, so re-listing tools after activation
  works end-to-end through this bridge too — completing, for bridge users,
  the recovery loop ADR-0011 designed on the server side.
- Parallel tool calls no longer serialize behind one slow 30s call; N
  concurrent calls complete in roughly `max(t_1..t_N)` wall-clock time
  instead of `sum(t_1..t_N)`.
- Zero new dependencies; the script remains a single stdlib file a Windows
  user can drop in and run with nothing to install — the property that
  justifies this bridge's existence is preserved.
- `parse_sse` and `route_sse_messages` are pure, unit-testable functions,
  closing the script's current zero-test gap without needing sockets or a
  running plugin instance.
- Notifications now reach stdout at all, for the first time — previously
  impossible because the server's plain-JSON path never carried them and
  the bridge could not parse the SSE path that does.

### Negative

- More moving parts than the previous linear loop: thread lifecycle, a
  stdout lock, and a bounded shutdown join all need to be reasoned about
  together. A bug in thread bookkeeping could leak a thread or delay
  shutdown; mitigated by `daemon=True` (never blocks process exit) and the
  shared-deadline join (bounds total wait regardless of thread count).
- Thread creation is unbounded per burst of concurrent requests — acceptable
  for the stated single-user scale, but this is not a design that would
  scale to a shared/multi-tenant deployment of this script (it isn't one,
  and SPEC explicitly rules that concern out of scope).
- Client-to-server notifications are POSTed synchronously on the main
  thread (SPEC-sanctioned simplification), so a hung notification POST
  head-of-line-blocks the stdin loop for up to `REQUEST_TIMEOUT_SECONDS`
  (30s): no new request thread can be spawned for lines the client sends
  after that notification until the POST resolves. Low-probability trigger
  (requires a stalled server on a fire-and-forget message) and bounded by
  the timeout, but it is a known exception to the "parallel calls never
  queue behind one slow call" property, which strictly holds for requests
  only. If it ever bites in practice, the fix is mechanical: spawn
  notifications on daemon threads exactly like requests.
- Stdout line ordering across *different* requests is no longer strictly
  request-order (responses can interleave when calls run concurrently and
  finish out of order). This is correct per JSON-RPC (clients correlate by
  `id`, not by line position) and is explicitly called out as acceptable in
  SPEC's edge cases, but it is a real behavior change from the old
  strictly-serial script that anyone informally scraping the bridge's
  stdout log by line order would notice.
- The hand-rolled SSE parser implements only the subset of the SSE format
  the plugin's `StreamableHTTPServerTransport` actually emits today (plain
  `data:` lines, blank-line-terminated events, no `retry:`/`id:` semantics
  needed). It is an implicit coupling to the SDK's current output shape,
  not a contract either side has committed to — if a future SDK upgrade
  changes SSE framing in a way this subset doesn't cover, the parser would
  need a matching update. Flagged in the module docstring as a maintenance
  note, not fixed here (fixing it would mean implementing the full SSE spec
  for a single local producer, which is not proportionate).

### Neutral

- CLI contract, bearer token handling (arg or `OBSIDIAN_BEARER_TOKEN`), the
  30s per-request timeout value, and Windows/macOS support are unchanged.
- `docs/windows-post-only-bridge.md`'s "Limits" section currently states
  the bridge "does not carry server-initiated notifications, because the
  plugin's stateless server never sends any" — this becomes false for the
  SSE/activation path and is corrected as part of this change (plan Task
  5). `README.md`'s shorter description of the bridge does not repeat this
  claim and needs no edit (confirmed by grep).
- `scripts/test_obsidian_mcp_bridge.py` is the first Python test file in
  this repo. It runs via `python3 -m unittest`, deliberately outside
  `.claude/test-cmd` (which stays `bun test`, unchanged, per this feature's
  constraints) — documented at the top of the test file itself and in the
  plan, so it isn't accidentally wired in later out of habit.
- Adding optional `argv`/`stdin` parameters to the internal `main()`
  function (defaulting to `sys.argv`/`sys.stdin` when omitted) is an
  internal refactor for test dependency-injection only; it does not change
  the external CLI contract — the real process still reads `sys.argv` and
  `sys.stdin` exactly as before when launched normally.

## References

- SPEC.md (repo root, gitignored local artifact) — Objectives, Scope, Edge
  cases, Success criteria for this feature.
- `PROJECT.md` — Phase 3, "Bridge SSE parsing and concurrency".
- GitHub issue #355 (2026-07-14 parallel-tool-call audit, finding 2).
- `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts`
  (read at ADR time, ~lines 155-169) — `enableJsonResponse: !isActivateTool`,
  the server-side change that makes SSE responses appear for
  `activate_tool`/`activate_tools`.
- `docs/architecture/ADR-0011-self-healing-inactive-tool-error.md` — the
  server-side recovery flow this bridge change lets bridge users actually
  complete (activation notification now reaches them).
- `docs/windows-post-only-bridge.md` — user-facing doc updated alongside
  this ADR (plan Task 5).
- `scripts/obsidian_mcp_bridge.py` — file this ADR governs.

## Non-goals (out of scope, unaffected)

- The `mcp-remote` path and the `.mcpb` generator.
- Any plugin/server-side change (`mcpServer.ts` and the SSE decision it
  makes are consumed as given).
- An asyncio rewrite.
- Adding pip dependencies of any kind.
