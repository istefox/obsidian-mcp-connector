# ADR-0016: Adopt MCP spec 2026-07-28 (SEP-2575) as an additive second era

**Status:** Accepted
**Date:** 2026-08-08
**Deciders:** Stefano Ferri
**Issue:** OMC-008 (closes OMC-022)

---

## Context

Protocol revision `2026-07-28` is not reachable through `initialize`. A client probes
`server/discover`; a client that finds no such handler falls back to the handshake. That
fallback lives in the client — the Python SDK's v2 `Client` defaults to `mode='auto'` and
degrades on its own — so adopting the revision is additive by construction, and nothing
about it requires removing `initialize`.

This server today serves one era. `SUPPORTED_PROTOCOL_VERSIONS`
(`packages/obsidian-plugin/src/features/mcp-transport/constants.ts`) tops out at
`2025-11-25`, the middleware answers 400 to any header value outside that list, and the
per-request `McpServer` in `mcpServer.ts` is connected to a stateless
`NodeStreamableHTTPServerTransport`. Measured today against a headless harness, the
`server-stateless` conformance scenario scores **7/27**: three `-meta-invalid-400`
variants, `-unsupported-version-400`, `-header-mismatch-400`, `-error-jsonrpc-id`, and
`-server-honors-notification-filter` (the last passing vacuously — no subscription surface
exists, so nothing can leak).

### What the installed SDK actually provides

Verified by reading `node_modules/@modelcontextprotocol/{core,server,node}@2.0.0`, not from
memory:

- `Server`'s constructor installs a `server/discover` handler only when
  `modernProtocolVersions(this._supportedProtocolVersions).length > 0`
  (`server/dist/mcp-DXXb3Vv3.mjs:733`). The default supported list is the handshake list,
  so a hand-constructed instance answers `-32601` to `server/discover`.
- The modern leg of `createMcpHandler` calls the package-internal
  `installModernOnlyHandlers(server, SUPPORTED_MODERN_PROTOCOL_VERSIONS)`
  (`server/dist/index.mjs:1287`) on whatever instance the factory returned: it appends
  `2026-07-28` to that instance's supported list and registers the discover handler.
  Nothing else calls it.
- `_ondiscover` (`mcp-DXXb3Vv3.mjs:1034`) returns
  `{ supportedVersions: modernProtocolVersions(...), capabilities:
  discoverAdvertisedCapabilities(getCapabilities()), instructions? }`.
  `discoverAdvertisedCapabilities` is `{ ...capabilities }` — the declared set verbatim,
  `listChanged`/`subscribe` bits included. Server identity is **not** in the discover
  result body: the 2026 encode seam stamps `io.modelcontextprotocol/serverInfo` into every
  outbound result's `_meta` (`_outboundServerInfo`).
- The whole envelope validation ladder is SDK-owned and lives in `classifyRequestBody`
  (`server/dist/src-CX2iR2pK.mjs:5101`): a malformed envelope behind a present claim →
  `-32602` with `data.envelope`; a modern header without a claim → `-32602` naming the
  missing keys; a header/body revision disagreement → `-32020` via `crossCheckMismatch`;
  a legacy-classified request on a strict endpoint → `UnsupportedProtocolVersionError`
  carrying `{ supported, requested }` (`modernOnlyStrictRejection`, `:5227`). All at HTTP
  400. `clientInfo` is absent from every "missing" branch — it is never required.
- `isLegacyRequest(request, parsedBody?)` is documented as *the entry's own classification
  step exported as a predicate*, running the same code, so a hand-wired router cannot
  disagree with the entry. Its `parsedBody` argument is required — not merely faster —
  when the request's own body has already been read, because the internal clone then
  throws.
- `CreateMcpHandlerOptions.legacy` takes `'stateless' | 'reject'` only. There is no
  handler-valued option; the documented user-land pattern is `isLegacyRequest` in front of
  a `legacy: 'reject'` handler.
- `toNodeHandler(handler)` returns `(req, res, parsedBody?)` and forwards `req.auth` as the
  handler's pass-through `authInfo`. `McpServerFactory` receives
  `{ era, authInfo?, requestInfo? }`.
- The 2026 wire registry (`src-CX2iR2pK.mjs:3910`) admits `tools/*`, `prompts/*`,
  `resources/*`, `completion/complete`, `server/discover`, `subscriptions/listen`, and the
  notifications `progress`, `message`, `cancelled`, the three `list_changed` variants,
  `resources/updated`, `subscriptions/acknowledged`. `initialize`, `ping`,
  `logging/setLevel`, `resources/subscribe` and `resources/unsubscribe` are absent — the
  five removed methods.
- `REQUIRED_CLIENT_CAPABILITIES_BY_METHOD` is `{}` (`src-CX2iR2pK.mjs:452`). No spec method
  carries a static client-capability requirement, so the suite's two
  `test_missing_capability` checks are unreachable without shipping a fixture tool.
- `IncompleteResult` does not appear anywhere in the installed SDK, although the suite's
  stream check refers to it. Modern-path stream behaviour is therefore measured against a
  running server, never inferred from the SDK's surface.
- `LATEST_PROTOCOL_VERSION` is `2025-11-25` in both `core@2.0.0` and the TypeScript SDK's
  main branch. It is the `initialize` offer and by construction can never name
  `2026-07-28`. It says nothing about modern-era support and must not be used to reason
  about it.

## Decision

Serve both eras on the same endpoint, behind the same middleware chain, from one server
factory.

### 1. Routing lives in user land, in `mcpServer.handleRequest`

After the HTTP chain resolves a token id, `handleRequest` reads the body once (it already
does), then calls `isLegacyRequest(toWebRequest(req, parsedBody), parsedBody)`. Legacy
classification keeps today's path byte-for-byte; everything else goes to a strict modern
handler.

Routing sits in `mcpServer.ts` rather than `httpServer.ts` because that is where the single
body read already happens. Moving it up would widen `RequestHandler` to carry a parsed body
and churn ~30 test call-sites for no behavioural gain.

A body that fails `JSON.parse` short-circuits to legacy without constructing a `Request` at
all. `toWebRequest(req, undefined)` would try to read the stream `readBodyWithCap` has
already drained; the SDK classifies unparseable bodies as legacy anyway, so the
short-circuit is both safe and identical to the entry's own answer.

### 2. The modern handler is strict; the endpoint is not

`createMcpHandler(factory, { legacy: 'reject', responseMode: 'auto' })`. Strict mode on the
handler and strict mode on the endpoint are different decisions. The predicate has already
separated the traffic, so the modern handler must never see legacy traffic — `'reject'`
makes a routing bug loud instead of silently double-serving 2025 requests through a second,
differently-configured stateless transport. The endpoint stays permissive because the
legacy branch exists in front of it.

One handler is built per `McpService`, wrapped once by `toNodeHandler`, and closed in
`destroyMcpService`. It allocates an event bus; building one per request would be waste.

### 3. The protocol-version rung splits by era, and only the legacy half stays in `runMiddleware`

`2026-07-28` joins `SUPPORTED_PROTOCOL_VERSIONS`, without which every modern request is
rejected at 400 before it can be classified.

`checkProtocolVersion` keeps rejecting a header naming a **pre-2026 revision this server
does not serve** — unchanged, in the same position in the chain, before auth. A header
naming a **2026-era revision** (lexicographic `>= "2026-07-28"`, the SDK's own
`isModernProtocolVersion` rule, reimplemented here because the helper is not a public
export) is **deferred**: only classification can tell whether the SDK's ladder owns the
answer, and the ladder's answer carries `{ supported, requested }` where this server's
`buildProtocolVersionErrorBody` carries neither. A deferred header that then classifies
legacy is answered by that same helper after classification, so no
`unsupported-version-400` answer is lost.

The alternative reading — move the whole rung below classification — reorders 400 and 401
for unauthenticated callers and changes an observable status code for no gain. The split
keeps every legacy-era case byte-identical.

### 4. One factory, both eras

The per-request `McpServer` construction is extracted to `buildMcpServer(tokenId)` and
called by both branches: the legacy branch directly, the modern branch through the
`McpServerFactory`. `ToolScope` resolution, the registry wiring, the counter recording and
the prompt handlers therefore exist once. Per-token tool surfaces (ADR-0014) and the
`tools/list` stability invariant (ADR-0015) hold on both paths because there is only one
implementation of them.

The token id reaches the factory as pass-through `AuthInfo`:
`req.auth = { token: "", clientId: tokenId, scopes: [] }`, read back as
`ctx.authInfo?.clientId`. The bearer **secret** deliberately does not travel into handler
context — the identity downstream of auth is the token id, never the string
(ADR-0014 §2), and a future handler that logged its context must not be able to leak a
credential.

`buildMcpServer` closes nothing. The legacy branch keeps its own `finally` teardown; on the
modern branch the SDK entry owns the instance lifecycle.

### 5. Notifications stay request-scoped on both eras

`responseMode: 'auto'` upgrades a modern response to SSE when the handler emits a related
message before its result — which is exactly what `activate_tool` and `search_vault_smart`
do through `ctx.mcpReq.notify`. The `bodyTargetsSseNotificationTool` pre-inspection stays
legacy-only. There is no back-channel at `2026-07-28` and none is needed.

Both notification methods are in the 2026 wire registry, but that is a schema fact, not a
delivery fact: the SSE upgrade is verified against a running server before this is
considered done.

### 6. `server/discover` is not hand-written

The advertisement is whatever the instance's declared capabilities are. The current
declaration is `{ tools: { listChanged: true }, prompts: {} }`; both are honoured by
registered handlers, so the discover result is truthful as-is and prompts appears without
any extra work. Hand-writing the handler would create a second source of truth that drifts
the first time a capability is added.

### 7. Per-era counters are diagnostic and batched

`mcpTransport.eraCounters = { legacy: number, modern: number }`, incremented in memory and
flushed through `SettingsStore.updateSlice` under the process-wide mutex — the same
batching discipline `ToolLoadingManager` already uses, because a settings write per request
is a disk write per request. Nothing reads the counter to make a runtime decision. It is
surfaced read-only in the transport settings section so the trigger below can be observed
rather than guessed at.

### 8. `legacy: 'reject'` on the endpoint is a recorded future decision, not this one

It breaks every client that does not probe `server/discover`, and no measured need exists.

**Trigger:** the legacy-era counter stays at zero across a stated observation period — two
consecutive minor releases, or 60 days of use, whichever is longer — on a vault with the
user's real client set configured. Until then the five removed-method conformance checks
(`initialize`, `ping`, `logging/setLevel`, `resources/subscribe`, `resources/unsubscribe`
must be absent) stay red **by choice, not by defect**: they measure the removal this ADR
declines to perform.

### 9. Conformance runs nightly against an expected-failures baseline, not on every PR

The harness moves into the repository. The suite is run from source at a pinned ref — the
published CLI (0.1.16) has no 2026 scenarios — against a YAML baseline naming every
expected red check and its reason. An unexpected red fails the job; a baseline entry that
starts passing is a signal to remove it.

The job lives in its own workflow (`.github/workflows/conformance.yml`), triggered on a
nightly `schedule` and on `workflow_dispatch`, never on `push` or `pull_request`. Running
it per-PR means a clone, install and from-source build of an external pre-release
repository on every commit, and this repo pays for its Actions minutes. The suite is a
regression alarm on a surface that changes rarely, not a merge gate; nightly is the
proportionate cadence for it.

Target: **≥18/27** on `server-stateless`, with 5 removed-method checks red by design, 2
subscription checks deferred to OMC-007, and 2 `test_missing_capability` checks declared
unreachable.

## Alternatives considered

**A. `legacy: 'reject'` on the endpoint now, one era only.**
Rejected: it removes `initialize` from a server whose entire installed base reaches it that
way — every configured Claude Desktop, Cursor and Cline client, plus every already
distributed `.mcpb` bundle, stops working the moment the plugin updates. The conformance
score would jump by five checks and the product would break. The decision is recorded with
a measurable trigger instead of taken blind.

**B. Plain `createMcpHandler(factory)` with the SDK's default stateless legacy fallback,
no user-land routing.**
Rejected: the SDK's fallback constructs its own streamable transport with only
`sessionIdGenerator: undefined`. It has no equivalent of `bodyTargetsSseNotificationTool`,
so `activate_tool` would answer JSON and its `notifications/tools/list_changed` would have
nowhere to go — a silent regression of ADR-0011's activation contract on the path that
serves every current client. The 405-on-GET behaviour mcp-remote depends on, and the 413
handling for chunked over-cap bodies, would also move under SDK control. Routing in user
land keeps the legacy path exactly as it is.

**C. Hand-write a `server/discover` handler on the existing `McpServer` and skip
`createMcpHandler` entirely.**
Rejected: `server/discover` is the visible tip of the revision, not the revision. The
per-request `_meta` envelope validation, the `-32602`/`-32020` ladder, the
`{ supported, requested }` error data, the `io.modelcontextprotocol/serverInfo` stamping on
every outbound result, and the modern wire codec's method registry would all have to be
reimplemented against a spec this project does not own. `installModernOnlyHandlers` is
package-internal precisely because the discover handler is meant to be installed by the
serving entry, not by hand.

**D. Move the whole protocol-version rung below classification (the SPEC's literal
reading).**
Rejected as written, adopted in part. Below classification the rung necessarily runs after
auth, which flips an unauthenticated request with a bad version header from 400 to 401 —
an observable status-code change, asserted today in `middleware.test.ts`'s end-to-end
order test, bought for nothing. Splitting the rung by era achieves the same goal (the SDK's
ladder owns the modern answers) with zero change to any legacy-era case.

**E. Serve the modern era on a separate path, e.g. `/mcp/2026`.**
Rejected: `server/discover` is a probe against the endpoint the client is already
configured for. A client that has to be told a different URL to find the modern era has
already been reconfigured, which is the exact cost this additive adoption exists to avoid.
It would also duplicate the middleware chain and split the per-token identity resolution in
two.

**F. Ship the `test_missing_capability` diagnostic tool the suite wants, for +2 checks.**
Rejected: it would appear in `tools/list` in every user's vault, in every client's tool
picker, forever. A fixture tool in a shipped product to satisfy a test harness is a worse
outcome than two red checks that are honestly explained in the baseline.

**G. Write per-era counters on every request.**
Rejected: a `data.json` read-modify-write under the process-wide mutex per request would
serialize the transport behind disk I/O and make the counter the slowest thing in the hot
path — for a number nothing reads at runtime. Batched in memory, flushed on a debounce and
at teardown, matching `ToolLoadingManager`.

**H. Run the conformance suite as a step inside `ci.yml`, on every push and PR.**
Rejected on cost. Each run is a git clone, a dependency install and a from-source build of
an external pre-release repository, on a repo that pays for its Actions minutes, to
re-measure a surface that changes only when the transport does. The accepted trade is
stated in Consequences: a regression is caught on the next nightly rather than on the PR
that introduced it, and the pre-merge signal is a local `bun run test:conformance` on any
change that touches the transport.

## Consequences

### Positive

- A client probing `server/discover` reaches the modern path today; every currently
  configured client keeps working with no re-export, no reconfiguration, and no change to
  the bytes on the legacy path.
- The envelope ladder, the discover advertisement, the unsupported-version error data and
  the `serverInfo` stamping are all SDK-owned. This project writes routing, not protocol.
- One `buildMcpServer` means per-token tool surfaces and the `tools/list` invariant cannot
  drift between eras — there is no second implementation to drift.
- The conformance suite becomes a recurring, automated signal with an explicit annotated
  baseline, instead of a number someone measures by hand in a scratch directory.
- The `legacy: 'reject'` decision now has a trigger and a counter that will fire it, rather
  than an argument that recurs every release.

### Negative

- Two serving paths exist on one endpoint, with different response-mode machinery
  (`bodyTargetsSseNotificationTool` vs `responseMode: 'auto'`). A future change to
  notification delivery has to be made twice or consciously scoped to one era.
- The protocol-version rung is split across two sites — `checkProtocolVersion` for
  pre-2026 revisions, the era router for deferred modern ones. The rule is crisp but it is
  a rule someone has to read before touching either site.
- `isModernProtocolVersion` is reimplemented locally as `version >= "2026-07-28"` because
  the SDK does not export it. If the SDK ever changes the era boundary from a lexicographic
  ISO-date comparison, this copy goes stale silently. It sits next to
  `SUPPORTED_PROTOCOL_VERSIONS`, which is already a project-owned copy for the same reason.
- **A conformance regression is caught by the next nightly run, not by the PR that caused
  it.** Nothing blocks a merge on the suite. The mitigations are the expected-failures
  baseline (which makes a nightly failure readable rather than a wall of red) and a local
  `bun run test:conformance` before merging any transport change — a discipline, not an
  enforcement.
- **The baseline file is maintained by hand and can rot.** It is the only artifact carrying
  *why* each red check is red, and nothing regenerates it. Pasting a failing run's output
  back into it would convert a statement of intent into a snapshot of whatever is currently
  broken. Every edit is deliberate and carries a reason.
- The nightly job depends on a network clone of an external repository at a pinned
  pre-release ref, built from source. It is the first scheduled workflow in this project and
  the first to depend on a third-party repo at build time.
- `AuthInfo.token` is populated with the empty string. It is a pass-through field the SDK
  never inspects, but it is a shape that looks wrong to a reader who does not know why.

### Neutral

- The conformance score moves from 7/27 to ≥18/27. Nine checks stay red on purpose and the
  baseline says which and why; the score is not expected to reach 27 under this ADR.
- `SUPPORTED_PROTOCOL_VERSIONS` gains a modern revision, but the `initialize` handshake
  still offers `2025-11-25` at most: the SDK keeps the two lists structurally separate, and
  the instance-level modern version is appended by the entry, per request, on the modern
  branch only.
- `ci.yml` is unchanged by this work. The per-PR gate stays what it is today; the
  conformance workflow is additive and independent.
- The `.mcpb` shim is untouched and keeps speaking the handshake era. Its `data.json` read
  contract is unaffected.
- `subscriptions/listen` remains unimplemented. This work unblocks OMC-007; it does not
  perform it. Two conformance checks stay red for that reason.
- MCP Apps (OMC-016) and Tasks (OMC-010) ride `_meta` and are unaffected either way.

## References

- `SPEC.md` (repo root) — OMC-008 requirements R-01 … R-17
- `docs/superpowers/plans/2026-08-08-omc-008-adopt-mcp-spec-2026-07-28.md`
- ADR-0011 — self-healing inactive-tool error (`activate_tool`'s notification contract)
- ADR-0014 — per-client tool profiles (per-token `ToolScope` at the mcpServer boundary)
- ADR-0015 — the `tools/list` stability invariant and adaptive loading
- `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts` —
  `createMcpHandler`, `isLegacyRequest`, `CreateMcpHandlerOptions`, `McpServerFactory`
- `node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs:5101` —
  `classifyRequestBody`, the envelope validation ladder
- `node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs:733,1034` — discover
  handler installation and `_ondiscover`
- `node_modules/@modelcontextprotocol/node/dist/index.d.mts:224,249,271` —
  `NodeMcpRequestHandler`, `toNodeHandler`, `toWebRequest`
