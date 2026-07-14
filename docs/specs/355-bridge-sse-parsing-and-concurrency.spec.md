# SPEC — Bridge SSE parsing and concurrency

Source: GitHub issue #355 (parallel-tool-call audit 2026-07-14, finding 2; PROJECT.md Phase 3)
Independent of Phases 1-2 (client-side script only).

## Objectives

1. Make `scripts/obsidian_mcp_bridge.py` parse `text/event-stream` POST response
   bodies: extract the JSON-RPC response from `data:` lines and forward any
   server-emitted notifications (`notifications/tools/list_changed`) to stdout.
   Today `json.loads` on the raw SSE body makes EVERY `activate_tool` /
   `activate_tools` call through the bridge fail with `-32000 non-JSON response`
   (the server chooses SSE from the request body alone since 0.22.0 — see
   `mcpServer.ts:166-169`).
2. Stop serializing requests: handle each incoming JSON-RPC request in its own
   thread so parallel tool calls from the client no longer queue behind one slow
   call's 30 s window.
3. Update `docs/windows-post-only-bridge.md` to describe both behaviors.

## Scope

In:
- `scripts/obsidian_mcp_bridge.py` only. Standard library only (json, os, sys,
  urllib, threading) — this constraint is the bridge's reason to exist.
- Response handling: branch on the response `Content-Type`.
  `application/json` → current path. `text/event-stream` → parse SSE: for each
  `data:` payload that is a JSON-RPC message, write notifications to stdout as they
  are extracted and write the message carrying the request's `id` as the response.
  Multi-line `data:` continuation per the SSE spec; ignore `event:`/`id:`/comment
  lines.
- Concurrency: one worker thread per incoming request line; notifications
  (id-less messages) may stay on the main thread. All stdout writes go through a
  single lock, one complete JSON line per write. `negotiated_version` handling must
  be thread-safe; `initialize` is answered before the client sends anything else, so
  it may simply be handled synchronously before threading starts.
- Per-request timeout stays 30 s but applies per thread, not to the whole queue.
- Logging stays on stderr via the existing `log()` helper (stdout is the JSON-RPC
  channel). Type hints and Google-style docstrings on all new/changed functions.

Out:
- Any plugin/server change.
- The mcp-remote path and the `.mcpb` generator — untouched.
- asyncio rewrite; threads are sufficient for a single-user bridge.
- pip dependencies of any kind.

## Stack

Python 3 standard library, single file. Windows is the primary target platform
(the bridge exists because mcp-remote hangs there); must also run on macOS for
testing. Repo tests run under bun; Python-side tests use a plain
`scripts/test_obsidian_mcp_bridge.py` runnable with `python3 -m unittest` (no
pytest dependency in this repo).

## Architecture

The bridge is a stdio ⇄ HTTP adapter: stdin lines → POST → stdout lines. The SSE
parser and the message-routing logic (notification vs response) should be pure
functions taking bytes/str and returning parsed messages, so they are unit-testable
without sockets. The threaded loop composes them.

## Data model

None.

## API / Interfaces

CLI contract unchanged: `python bridge.py <url> [token]`, token also via
`OBSIDIAN_BEARER_TOKEN`. JSON-RPC over stdio unchanged except that server
notifications extracted from SSE responses now appear on stdout (valid per MCP;
clients already handle unsolicited notifications).

## UI flows

None.

## Edge cases

- SSE body containing the notification BEFORE the response (the server emits
  `tools/list_changed` with the activation call's `relatedRequestId`, then the
  result): both must be forwarded, notification first.
- SSE body with only a response and no notification (future SSE-mode calls).
- Empty body with HTTP 202 (client-to-server notifications): current silent path
  stays.
- Out-of-order completion under threading: responses may interleave across
  requests — correct, JSON-RPC correlates by `id`; but each stdout line must stay
  atomic (lock held for the full line + flush).
- A thread's POST failing (URLError/timeout) emits the existing `-32000` error for
  that id only; other in-flight requests are unaffected.
- stdin EOF: stop accepting new requests, let in-flight threads finish (daemon
  threads + join with a short grace period), then exit 0.
- Malformed SSE (no valid `data:` JSON): emit `-32000 non-JSON response` as today,
  including the HTTP status for diagnosis.

## Success criteria

- [ ] Unit tests for the SSE parser: notification+response body, response-only
      body, multi-line data, CRLF vs LF, malformed body.
- [ ] Unit test: routing writes notification then response, in order, as separate
      lines.
- [ ] Concurrency test: two simulated slow requests complete in ~max(t1, t2), not
      t1+t2 (mock transport, no real sockets).
- [ ] Manual smoke against a live plugin: `activate_tools` through the bridge
      succeeds and the client re-lists tools (was: guaranteed `-32000`).
- [ ] `docs/windows-post-only-bridge.md` updated: SSE handling, threading model,
      unchanged CLI contract.
- [ ] Existing repo test suite untouched and green.
