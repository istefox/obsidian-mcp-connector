# OMC-008 — Adopt MCP spec 2026-07-28 (SEP-2575) as an additive second era

**Topic slug:** omc-008-adopt-mcp-spec-2026-07-28

## Objective

Serve protocol revision `2026-07-28` alongside the existing `initialize`-handshake era on the same
endpoint, so that a client probing `server/discover` reaches the modern path while every currently
configured client keeps working unchanged.

The revision is not reachable through `initialize`. It is reached by probing `server/discover`, and
a client that finds no such handler falls back to the handshake. That fallback lives in the client,
not in this server: the reference client defaults to `mode='auto'` and degrades on its own. Adopting
the revision is therefore additive, and nothing about it requires removing `initialize`.

Removing `initialize`, `ping`, `logging/setLevel`, `resources/subscribe` and `resources/unsubscribe`
is a separate decision, expressed in the SDK as a single option (`legacy: 'reject'`). This work does
not take it. It records the condition under which it would later be taken.

## Scope

In scope:

- `server/discover`, answering with `supportedVersions`, capabilities that match the handlers
  actually registered, and server identity in the result's `_meta`.
- Per-request `_meta` envelope validation on the modern path: `protocolVersion` and
  `clientCapabilities` required, `clientInfo` optional and never required.
- Request routing between the two eras, with the existing legacy path left byte-for-byte unchanged.
- Instrumentation counting how much traffic each era serves, as the evidence that would later
  justify strict mode.
- The conformance suite wired into CI against an expected-failures baseline (closes OMC-022).

Out of scope, each for a stated reason:

- `legacy: 'reject'`. It breaks every client that does not probe `server/discover`, and no measured
  need exists. The trigger is recorded instead.
- `subscriptions/listen` and its acknowledgement and filter semantics. That is OMC-007, unblocked by
  this work but not performed by it.
- The `test_missing_capability` diagnostic tool the suite requires for its two client-capability
  checks. Shipping a fixture tool would put it in the tool list of every user's vault, which is a
  worse outcome than two red checks.
- MCP Apps (OMC-016) and Tasks (OMC-010), which ride `_meta` and are unaffected either way.

## Stack

Bun workspace monorepo, TypeScript, `@modelcontextprotocol/{core,server,node}@2.0.0`, `node:http`.
Verified present in the installed SDK: `createMcpHandler`, `isLegacyRequest`,
`classifyInboundRequest` from `@modelcontextprotocol/server`, `toNodeHandler` from
`@modelcontextprotocol/node`, and the `io.modelcontextprotocol/{protocolVersion, clientCapabilities,
clientInfo, serverInfo, logLevel, subscriptionId}` `_meta` keys from `@modelcontextprotocol/core`.

## Architecture

A request keeps entering through the existing HTTP server and its middleware chain: method and path,
Origin validation, bearer authentication, body cap. Both eras sit behind that chain, so
authentication and per-token identity are resolved once and apply to both.

After the chain, `isLegacyRequest` classifies the request. A request carrying no `_meta` envelope
claim — including `initialize`, 2025-era notification POSTs, and body-less GET or DELETE — routes to
the path that exists today, untouched. Everything else routes to a strict modern handler built with
`createMcpHandler(factory, { legacy: 'reject' })` and adapted to `node:http` by `toNodeHandler`.

Strict mode on the modern handler is deliberate and is not the same decision as strict mode on the
endpoint. The predicate has already separated the traffic, so the modern handler must never see
legacy traffic, and the SDK is explicit that the modern path owns the error answers for malformed
envelopes and header mismatches.

The factory the modern handler receives is the same per-request `McpServer` construction the
transport performs today. That construction already resolves a `ToolScope` from the calling token
and serves a shared registry, so per-token tool surfaces (ADR-0014) hold on both paths without a
second implementation.

Notifications on the modern path stay request-scoped. There is no back-channel at `2026-07-28`, and
none is needed: the two notifications this server emits — `activate_tool`'s
`notifications/tools/list_changed` and `search_vault_smart`'s progress — already ride the response
stream of the request that triggered them, through the SDK's own per-request notify channel.

## Data model

No change to any existing settings slice's meaning. One additive counter pair records how many
requests each era served, written through `SettingsStore.updateSlice` under the process-wide mutex
like every other settings write. The counter is diagnostic: nothing reads it to make a runtime
decision.

Counting rule: a request is counted at the point of classification, for whatever era it classified
as, however it is later answered. A request short-circuited before classification — the 413 over-cap
path, and anything the middleware chain rejects — counts as neither era. The trigger in R-17 is only
as meaningful as that rule.

## API

`server/discover` returns the supported versions, the server's capabilities, and identity under
`_meta['io.modelcontextprotocol/serverInfo']`. The capabilities it reports must correspond to
handlers that are actually registered — the suite calls the advertised methods and compares. Prompts
are served, so the prompts capability must appear in the discover result.

Requests on the modern path carry `_meta` with `io.modelcontextprotocol/protocolVersion` matching
the `MCP-Protocol-Version` header and `io.modelcontextprotocol/clientCapabilities`. A missing or
malformed envelope answers `-32602`; a header and body that name different revisions answer `-32020`;
an unsupported revision answers the unsupported-version error carrying the versions this server does
support.

Every modern-era request also carries the SEP-2243 standard request headers: `Mcp-Method` on every
call, and `Mcp-Name` mirroring `params.name` (or `params.uri` for `resources/read`) on `tools/call`,
`prompts/get` and `resources/read`. The SDK derives neither from the body and rejects before any
handler runs when one is missing.

## UI flows

One read-only line in the transport settings section reporting how many requests each era has
served, so the trigger condition below can be observed rather than guessed at.

## Edge cases

The body is read once. The existing transport already drains the request body under a cap before
handing it to the SDK; the classifier accepts a pre-parsed body for exactly this reason, and both
the predicate and the chosen handler must be fed from that single read. A second read returns an
empty stream and produces a parse error instead of a routed request.

`2026-07-28` is absent from this project's `SUPPORTED_PROTOCOL_VERSIONS`. The middleware answers 400
to an unsupported `MCP-Protocol-Version` before any routing happens, so until that list is extended
every modern request is rejected before it can reach the modern handler.

The protocol-version error body added by OMC-018 must not preempt the modern path. It answers
`-32020` for a header the middleware rejects; on the modern path those same rejections belong to the
SDK's validation ladder, which produces richer error data than this server's own helper does.

The `.mcpb` shim is unchanged and keeps speaking the handshake era. Bundles already distributed must
continue to work, and no re-export may be required by this change.

`IncompleteResult` does not exist in the installed SDK, although the suite's stream check refers to
it. What the modern path does with a response stream carrying a notification is therefore measured
against a running server, never inferred from the SDK's surface.

## Success criteria

- [ ] R-01 — A request carrying a valid `_meta` envelope is served by the modern path, and a request
      without one is served by the existing path with byte-identical behaviour to before this change.
- [ ] R-02 — `server/discover` answers with `supportedVersions`, capabilities matching the registered
      handlers, and server identity under `_meta['io.modelcontextprotocol/serverInfo']`.
- [ ] R-03 — The prompts capability appears in the discover result, and every capability it advertises
      is honoured when the corresponding method is called.
- [ ] R-04 — A request whose `_meta` is absent, or which omits `protocolVersion` or
      `clientCapabilities`, is rejected with `-32602` and HTTP 400.
- [ ] R-05 — A request whose `_meta` omits `clientInfo` is served normally; `clientInfo` is never
      required.
- [ ] R-06 — An unsupported protocol revision answers the unsupported-version error carrying this
      server's supported versions and echoing the requested one.
- [ ] R-07 — `2026-07-28` is present in this project's supported-version list, so a modern request
      passes the middleware instead of being rejected at 400 before routing.
- [ ] R-08 — The request body is read exactly once per request and shared between the classifier and
      whichever handler serves it.
- [ ] R-09 — Per-token tool surfaces resolve identically on both paths: a token's `tools/list` returns
      the same set whether reached through the handshake era or the modern one.
- [ ] R-10 — `activate_tool` still delivers `notifications/tools/list_changed` on the calling
      request's own response stream when reached through the modern path, verified against a running
      server.
- [ ] R-11 — `search_vault_smart` still delivers progress notifications when reached through the
      modern path, verified against a running server.
- [ ] R-12 — An already-distributed `.mcpb` bundle continues to work with no re-export.
- [ ] R-13 — The `server-stateless` conformance scenario reaches at least 18 of 27 checks, with the
      two `test_missing_capability` checks declared unreachable and the two subscription checks
      deferred to OMC-007. **Measured: 26/28, exit 0, baseline satisfied.** This requirement was
      written expecting the five removed-method checks to be red by design as well; they pass, so
      the baseline is four entries rather than nine. See R-17 and ADR-0016 §8, §9.
- [ ] R-14 — No conformance check that passes today regresses, and the full project gate stays green:
      type check, unit tests, Prettier, Svelte check, and the `.mcpb` smoke test.
- [ ] R-15 — The headless conformance harness lives in the repository rather than a scratch
      directory, and CI runs the suite against an expected-failures baseline that names each expected
      red check and why.
- [ ] R-16 — Per-era request counters are recorded through `SettingsStore.updateSlice` and surfaced
      read-only in the transport settings section.
- [ ] R-17 — The ADR records `legacy: 'reject'` as a future decision whose trigger is the legacy-era
      counter (`services/eraCounters.ts` → `mcpTransport.eraCounters`) staying at zero over a stated
      observation period: two consecutive minor releases or 60 days of use, whichever is longer.

      The second half of this requirement as originally written — that the five removed-method checks
      stay red until then, by choice rather than by defect — was a prediction, and measurement
      falsified it. All five pass. The conformance suite only ever probes the modern era, where the
      SDK's 2026 wire registry does not admit `initialize`, `ping`, `logging/setLevel`,
      `resources/subscribe` or `resources/unsubscribe` and answers `404`/`-32601`; a legacy client
      carries no envelope, classifies legacy, and keeps being served by the legacy transport.
      Measured: `initialize` with a modern `_meta` envelope → HTTP 404 + `-32601`; without one →
      HTTP 200 and the legacy handshake (`protocolVersion: "2025-06-18"`,
      `serverInfo: {name: "mcp-connector", version: "1.0.1"}`).

      The requirement is therefore satisfied by the ADR recording the prediction, the measurement
      and the reason it changed — not by deleting the falsified claim. `legacy: 'reject'` remains a
      future decision with the trigger above, but it is now a decision about which clients this
      server refuses to serve, with no conformance score attached to it.
