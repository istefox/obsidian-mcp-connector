# ADR-0014: Per-client tool profiles via multiple bearer tokens

**Status:** Proposed
**Date:** 2026-07-31
**Deciders:** Stefano Ferri

---

## Context

One vault serves every MCP client the same tool surface. `toolLoading.profile` is a
single global value (`all` / `core` / `adaptive`), applied once at composition time by
`applyAdaptiveFilter()` and baked into the shared `ToolRegistry`'s `adaptiveDisabled`
Set. A user who wants claude.ai on the 13-tool Core set and Cowork on the full set has
no way to express that: the last profile written wins for everyone.

The server cannot read `clientInfo` to tell clients apart. The transport is stateless
per request (`sessionIdGenerator: undefined`, a fresh `McpServer` + transport per POST —
see `mcpServer.ts`), so `initialize` arrives on a different HTTP request from the calls
that follow and nothing correlates them. The bearer token is the only client identity
present on **every** request.

MCP revision `2026-07-28` states this is a sanctioned shape for `tools/list`: the set
*"MAY vary by the authorization presented on the request — for example, returning only
the tools the caller's granted scopes permit — since credentials are per-request input,
not connection state."* No protocol work is needed; the connector's current 2025-era
wire already carries the bearer on every request (`checkAuth` in `middleware.ts`).

Two outcomes are wanted: per-session token cost tuned per client, and selective
per-client revocation (today, rotating the one token breaks every configured client at
once).

Three existing decisions constrain the design:

- **ADR-0010** split the registry's single `enabled` Set into `adaptiveDisabled` and
  `userDisabled`. `userDisabled` is the user's kill switch and must stay above anything
  an MCP client can influence.
- **ADR-0011** gave `dispatch()` a three-way branch whose middle case returns a
  recoverable `isError: true` result naming the recovery call, instead of the opaque
  `Unknown tool`. Any new refusal must reuse that shape, not invent a second one.
- **ADR-0013** ships a `.mcpb` bundle whose Node shim resolves port and token from
  `data.json` at spawn time, reading `mcpTransport.bearerToken` literally.

Backward compatibility is not negotiable: the existing bearer token string must survive
byte-for-byte, or every configured client, every generated `.mcpb`, and the Windows
bridge break at once.

SPEC.md (`Per-client tool profiles via multiple bearer tokens`, issue #348) fixes the
data model, the filtering site, the precedence order and the legacy mirror. This ADR
records those with their rationale and decides what SPEC left open: the exact
registry/dispatch seam, where the migration runs and how the mirror stays in sync, how
the settings UI is decomposed, and how `activate_tool`'s in-session (`persist: false`)
promotion survives in a multi-token world.

---

## Decision

### 1. Credentials in the transport slice, policy in the tool-loading slice, joined by id

```
mcpTransport: {
  bearerToken: string          // legacy mirror of tokens[0].token (see §7)
  tokens: [
    { id: string,              // stable, never reused, generated on create
      label: string,           // user-facing, e.g. "claude.ai"
      token: string,           // the secret, base64url, generateToken()
      createdAt: number }
  ]
}

toolLoading: {
  profile: "all"|"core"|"adaptive"   // legacy mirror of tokens[0]'s profile
  promoted: string[]                 // legacy mirror of tokens[0]'s promoted
  counters: Record<string, number>   // GLOBAL, not per token
  profiles: {
    [tokenId]: {
      profile: "all"|"core"|"adaptive",
      promoted: string[],
      allowed: string[] | null       // null = no ceiling (default)
    }
  }
}
```

Secrets stay where auth already owns them, policy stays where the tool-loading feature
already owns it, and the two are joined by an opaque id. Revocation and the middleware
never reach into tool-loading code; the tool-selection UI never writes into the auth
slice. The alternative — one `tokens[]` array carrying both secret and policy — is
rejected in §Alternatives E.

A `profiles` entry missing for a live token resolves to `DEFAULT_POLICY`
(`profile: "all"`, `promoted: []`, `allowed: null`). This is load-bearing: an orphaned
or partially-written record can never fail closed into a client that reaches nothing,
and a half-applied migration degrades to today's behaviour rather than to a lockout.

Counters stay global. Call frequency is a property of the vault, not of the client; two
adaptive tokens promote the same tool at the same threshold, independently.

### 2. Identity resolution: match every token, no early exit, list read per request

`runMiddleware(req, tokens)` replaces `runMiddleware(req, bearerToken)` and returns the
matched token's id:

```ts
export type MiddlewareResult =
  | { ok: true; tokenId: string }
  | { ok: false; status: 400 | 401 | 403 | 404 | 405 };

function checkAuth(headers, tokens): AuthResult {
  const presented = /* Bearer <...> or 401 */;
  let matched: string | null = null;
  for (const t of tokens) {
    // No break: comparing against all N keeps response time independent of a
    // token's position in the list.
    if (compareTokens(presented, t.token)) matched = t.id;
  }
  return matched === null
    ? { ok: false, status: ERROR_CODES.UNAUTHORIZED }
    : { ok: true, tokenId: matched };
}
```

Last match wins (deterministic if two entries ever carry the same secret). An empty or
unreadable token list matches nothing and 401s — auth fails closed. The check order
(path/method → origin → protocol version → auth) is unchanged, and a miss stays a bare
401 with no hint about which of the N failed.

`compareTokens` is unchanged, including its pre-existing early length check: it leaks
the token's byte length, not its position or content. Widening that to a fixed-time
length-independent compare is out of scope for a loopback-only server.

`HttpServerConfig.bearerToken: string` becomes
`resolveTokens: () => Promise<readonly TokenRecord[]>`, called once per request. There
is deliberately **no** in-memory token cache: a token added, regenerated or revoked in
the settings UI takes effect on the next request with nothing to invalidate, which also
removes the transport restart that `handleRegenerate()` performs today. The cost is one
`loadData()` per request; see §Consequences (negative). A `resolveTokens` rejection is
logged and treated as an empty list — a transient read failure 401s rather than
authenticating anyone.

The `createServer` callback becomes async (`void (async () => { … })().catch(…)`). The
awaited read happens before the body is touched: no `data` listener is attached, so the
`IncomingMessage` stays paused and no bytes are lost, and the `Content-Length` cap still
runs before the handler.

### 3. The filtering seam: an opaque `ToolScope`, resolved per request

Filtering happens at the `mcpServer` boundary. The registry keeps owning global truth —
`userDisabled`, the composed tool set, schemas and annotations — and gains no concept of
a token. What it gains is one optional parameter carrying an already-resolved set:

```ts
// $/shared/types.ts — cross-cutting, so neither the transport imports a feature
// nor a feature imports the transport for a three-field type.
export type ToolScope = {
  /** Opaque policy key (the bearer token's id). The registry never dereferences it. */
  id: string;
  /** Tool names servable to this caller, meta-tools included. */
  active: ReadonlySet<string>;
  /** Hard ceiling, or null for none. Meta-tools bypass it. */
  allowed: ReadonlySet<string> | null;
};
```

- `list(scope?: ToolScope)` — filters by `isServed(schema) && (!scope || scope.active.has(name))`.
- `dispatch(params, context)` — `HandlerContext` gains `scope?: ToolScope`. The registry
  reads it for the gate and forwards the whole context to handlers, which is how the
  meta-tools get their caller's policy without a second plumbing path.
- `isAdaptiveInactive(name)` becomes `isInactive(name, scope?)`: true iff the tool is
  registered, not user-disabled, and would not execute — because of the adaptive flag or
  because the scope excludes it. `mcpServer`'s `recordCall` gate keeps its ADR-0011
  meaning ("did not execute ⇒ do not count") with the rename as the only change.

`list()`'s memo is restructured. Today `listCache` is invalidated by every disable-state
change; with a per-request scope it would be wrong or useless. It splits in two:

- `entriesCache` — the expensive part (`toJsonSchema()` + `normalizeInputSchema` +
  annotations + output schemas) for **every** registered tool, invalidated only by
  `register`/`setAnnotations`/`setOutputSchemas`.
- `list(scope?)` — a filter over `entriesCache`, ~45 entries, per call.

Per-token listing therefore costs an array filter, not a schema re-derivation, and the
memo no longer depends on mutable state that a future flag could desync.

Scope resolution is a pure function of (policy, all registered names, session
promotions), reusing the already-tested `ToolLoadingManager.getActiveToolNames`:

```ts
active = getActiveToolNames(allNames, { profile, promoted: [...promoted, ...session] });
if (allowed !== null) {
  active = filter(active, (n) => allowed.has(n) || ALWAYS_ACTIVE_TOOLS.includes(n));
}
```

An allowlist entry naming a tool that no longer exists is ignored by the intersection —
the same tolerance `promoted` already has. `userDisabled` is never consulted here: the
registry re-applies it in `list()` and `dispatch()`, so a user-disabled tool is
structurally invisible to every scope (R-08) without the scope layer having to remember
to check.

`handleRequest(req, res, tokenId)` resolves the scope **lazily and once**, behind a
memoized promise, so `initialize`, `prompts/*` and malformed requests pay nothing:

```ts
let scopePromise: Promise<ToolScope> | undefined;
const getScope = () => (scopePromise ??= resolveToolScope(plugin, tokenId, registry, session));
```

### 4. Precedence, and the allowlist — not the profile — as the ceiling

Four layers, strongest first:

1. **`userDisabled`** (ADR-0010) — invisible to every token, whatever its policy says.
2. **Per-token `allowed`** — when set, the ceiling. Never listed, never dispatched,
   `activate_tool` refuses it.
3. **Per-token `profile` + `promoted`** — the starting surface and its in-band widening.
4. **Meta-tools** (`tool_catalog`, `activate_tool`, `activate_tools`) — always active for
   every token, exactly as today, so an in-band promotion path always exists.

Issue #348 proposed the profile itself as a hard ceiling that activation cannot exceed.
Rejected (§Alternatives A): `core` exists *precisely* so `activate_tool` can widen it on
demand; a ceiling at the profile boundary makes activation a no-op for every core token,
i.e. it removes the mechanism that makes `core` usable. The ceiling is the separate,
optional `allowed` list, which defaults to `null` — so unless the user opts in,
activation behaves exactly as in 0.28.2 (R-07).

### 5. In-session promotion stays per token

`activate_tool`'s default is `persist: false`: the tool becomes available immediately and
stays so until the plugin reloads, implemented today by clearing the shared registry's
adaptive flag. That flag is global; leaving it in place would let one client's
exploratory activation widen every other client's surface, breaking R-05.

A `SessionPromotions` map (`Map<tokenId, Set<string>>`) is created in
`createMcpService()` and passed into `composeToolRegistry`, which wires the activation
handlers to it in place of today's `enableInRegistry: (name) => registry.enableByName(name)`.
`resolveToolScope` unions it into `promoted`. `persist: true` additionally writes
`profiles[tokenId].promoted`. The `persist` argument therefore keeps its exact documented
meaning, per token, and no tool-schema text changes. Entries for revoked ids are
unreachable (ids are never reused) and die with the process.

Consequently `applyAdaptiveFilter()` — whose only job was translating the global profile
into the registry's adaptive flags — is **deleted**, along with its call in
`composeToolRegistry` and its barrel export. Its logic survives as the scope resolver.
The registry's adaptive-flag API (`enable`, `disable`, `enableByName`, `disableByName`,
`setAdaptiveDisabled`) is deliberately kept even though no production writer remains:
removing it is an ADR-0010 contract change with its own test surface, and folding that
into an auth-touching change would make this diff harder to audit for no functional gain.

### 6. Migration runs in a dedicated module on the setup load path, policy first

`ensureTokenStore(plugin)` lives in `mcp-transport/services/tokenStore.ts` and is the
first thing `setup()` calls, replacing the inline first-run token mint. It handles all
three states in one idempotent pass and returns the live token list:

- **Fresh vault** — mints one token (`generateToken()`), id `default`, label `Default`,
  writes it in the new shape plus the mirror.
- **0.28.2 vault** — `mcpTransport.bearerToken` becomes `tokens[0]` with id `default`,
  label `Default`, and **the same token string**; the global
  `toolLoading.profile`/`promoted` are copied into `profiles["default"]` with
  `allowed: null`.
- **Already migrated** — a non-empty `tokens[]` short-circuits; both recipes return the
  slice unchanged (`updateSlice`'s NO_CHANGE convention) so nothing is written (R-13).

It runs before `startHttpServer` because a listener accepting requests against an empty
token list would 401 every client. It is a plain function over `PluginDataLike`, so it is
unit-testable against a fixture `data.json` without an Obsidian `App` (R-21).

The migration spans two slices and `SettingsStore.updateSlice` is per-key, so it is two
writes, not one. **Order: `toolLoading` first, `mcpTransport` second.** A crash between
them leaves a `profiles["default"]` entry that nothing reads (no `tokens[]` yet) and a
`data.json` that is still exactly a 0.28.2 vault — the runtime keeps working and the
migration simply re-runs on next load. The reverse order would leave a live token whose
policy is missing, which resolves to `all` and would silently widen a `core` user's
surface until the next successful load. Adding a multi-slice write API to
`SettingsStore` for this one caller is more surface than the ordering rule costs.

`ensureTokenStore` also recomputes the mirror on every load, so a hand-edited or
desynced `data.json` self-heals; when the values already agree, both recipes return
NO_CHANGE and no write happens. A `tokens: []` (hand-edited to empty) is treated as
absent and re-minted rather than left unauthenticable.

### 7. The legacy mirror has exactly two writers, and follows `tokens[0]`

`mcpTransport.bearerToken`, `toolLoading.profile` and `toolLoading.promoted` keep being
written, mirroring the first token. A user who downgrades to an older plugin build then
still reads a working token and their real profile instead of silently reverting to
`all` and losing their promoted list — and the ADR-0013 `.mcpb` shim and the Windows
bridge keep resolving a valid token with no change (R-12).

**The mirror source is `tokens[0]`, not the literal id `default`.** SPEC says "the
default token"; the id `default` is only what migration happens to name the first entry.
Defining the source positionally means revoking the migrated entry promotes the next one
into the mirror instead of leaving a downgraded plugin pointing at a dead secret.

The mirror is not maintainable by convention across a dozen call sites, so every write
to either slice funnels through one of two choke points, each recomputing the mirror
inside the same `updateSlice` recipe (atomic per slice):

- `tokenStore.ts` — `addToken`, `regenerateToken`, `revokeToken`, `renameToken`. Each
  recipe ends with `bearerToken = next.tokens[0].token`.
- `tokenPolicyStore.ts` (`adaptive-tool-loading`) — `updateToolLoading(plugin, mutate)`,
  which reads `tokens[0].id` from `updateSlice`'s own in-mutex snapshot, applies `mutate`,
  prunes `profiles` entries for ids not in the live list, then sets `profile`/`promoted`
  from `profiles[mirrorId]`. Every `ToolLoadingManager` mutator (`activateTool`,
  `activateTools`, `deactivateTool`, `resetAll`, `flushPendingCalls`) and the settings UI
  route through it; none of them writes the `toolLoading` slice directly any more.

Cross-slice reads cost nothing extra: `updateSlice` hands the recipe the whole `data.json`
snapshot it is already holding, as a second argument, so the request path stays at one
read per layer and a policy write stays at one read too.

Revocation is likewise two writes, `mcpTransport` first: the credential must die even if
the second write is lost, and a leftover `profiles` entry is inert and pruned on the next
policy write.

**Amendment (2026-08-02, during implementation).** Two claims above were wrong as
originally written and are corrected here, because both were load-bearing enough that
restoring them reintroduces a defect:

- The token list was originally read with a separate `loadData()` *before* `updateSlice`
  acquired the mutex, on the reasoning that the mutex is non-re-entrant. That read is
  necessarily outside the lock, so a revoke landing between it and the recipe makes
  `mirrorId` name an already-revoked token whose entry the recipe has just pruned — and
  the mirror is then computed from a missing entry and written over a correct one. The fix
  is the second recipe argument described above; do not reintroduce the pre-read.
- "A leftover `profiles` entry is inert" holds for the orphaned entry, **not** for the
  mirror. `ensureTokenStore`/`withPolicyFor` does not repair a stale mirror: it *seeds* a
  missing `profiles[tokens[0].id]` **from** it, so a lost sweep would burn the revoked
  token's surface into the surviving client permanently. `withPolicyFor` therefore seeds
  from the legacy globals only when no `tokens[]` existed (a genuine 0.28.2 upgrade); once
  tokens exist the globals are merely a mirror of a previous `tokens[0]` and a missing
  entry resolves to `{all, [], null}` like everywhere else.

`resetAll` splits along the same seam: counters are global and stay a global reset;
`promoted` is per token and resets only for the selected one.

### 8. Adaptive auto-promotion fans out per adaptive token

`flushPendingCalls` merges the debounced batch into the global `counters`, then, for
**each** `profiles` entry with `profile === "adaptive"`, promotes any tool at or above
`PROMOTION_THRESHOLD` into that entry's `promoted` (meta-tools excluded, as today). A
token with no `profiles` entry resolves to `all` and is never auto-promoted into. The
whole fan-out is one `updateToolLoading` call, so it is still one settings write per
flush (R-10).

### 9. The refusal path reuses ADR-0011's shape, allowlist first

`dispatch()`'s branch order becomes:

```
(a) served && (!scope || scope.active.has(name))              → execute
(b1) registered && !userDisabled && scope?.allowed
     && !allowed.has(name) && !ALWAYS_ACTIVE.includes(name)   → recoverable error: token limit
(b2) registered && !userDisabled && not active                → recoverable error: ADR-0011 text
(c) unregistered || userDisabled                              → ProtocolError Unknown tool
```

b1 must precede b2. b2's text instructs the caller to run
`activate_tools({"names":[…]})` and retry; for a tool the token's allowlist forbids that
is a dead-end loop, since the activation is refused too. b1 instead names the limit:

```
Tool '<name>' is not available to this client. The token's allowed-tools list does not include it. Ask the vault owner to change it in the plugin's token settings.
```

Both are returned, not thrown — same as ADR-0011, so they bypass the `McpError` wrapping
and the operator-facing error log, and neither counts as a call (R-04, R-06). The
user-disabled case keeps its opaque `Unknown tool` reply: the user's choice must stay
undiscoverable (ADR-0010).

`activate_tool` / `activate_tools` reuse the existing `not_allowed` outcome that ADR-0010
added for user-disabled tools, with the allowlist wording. `tool_catalog` gains a fourth
status, `unavailable`, for an allowlist-excluded tool — distinct from `inactive`, which
means "activatable". No tool declares an MCP `outputSchema` (enforced by
`mcp-tools/index.test.ts`), so widening the catalog's JSON payload is not a wire-contract
change.

### 10. The settings UI decomposes along the same seam as the data model

`SettingsTab.svelte` owns one piece of state, `selectedTokenId`, and passes it both ways:

- `AccessControlSection.svelte` (mcp-transport, credentials) renders the token list —
  label, profile as text, active tool count, per-row copy-config and revoke, plus
  **Add token** disabled at `MAX_TOKENS = 10` (R-15). It binds `selectedTokenId`.
- `AdaptiveToolLoadingSettings.svelte` (adaptive-tool-loading, policy) takes
  `tokenId` as a prop and renders the profile radios, the promoted list and the new
  "Limit to specific tools" toggle plus its checklist, scoped to that token (R-16).

There is one implementation of the checklist, mounted once against whichever token is
selected — no `{#each tokens}` around the panel. The row shows the profile as read-only
text rather than a second editing control, so a single writer owns each field.

An empty allowlist (`[]`) is legal and means "meta-tools only"; the panel renders it with
an explicit warning line so it is visibly different from "no limit" (`null`).

Per-row copy-config reuses the pure generators in `mcp-client-config/services/generators.ts`
through a new `CopyConfigMenu.svelte` that takes `{ url, token }`. `ClientConfigSection`
mounts it for the mirror token (its UX is unchanged) and each token row mounts it for its
own token, so the client-family list has one implementation too (R-17).

Regenerate mints a new secret in place, keeping id, label and policy, so rotating a
leaked token does not mean rebuilding its tool selection (R-18). Revoke requires a
confirmation naming the label and stating that configured clients and generated bundles
stop working and the string is not recoverable, and is disabled when one token remains
(R-19). Neither restarts the transport any more (§2).

### 11. A `.mcpb` bundle carries a token **id**, and an unknown id fails closed

The ADR-0013 shim reads `mcpTransport.bearerToken` from `data.json` at spawn time, which
after migration is the mirror — i.e. every generated bundle would silently be a
`tokens[0]` bundle. `generateMcpb()` gains a `tokenId`, substituted into the shim through
a third placeholder (`"__OBSIDIAN_MCP_TOKEN_ID__"`, guarded exactly like the existing
two), and `parseTransportFile(jsonText, tokenId)` resolves it:

- placeholder unset (**a bundle generated before 0.29.0, and nothing else**) →
  `mcpTransport.bearerToken`, i.e. today's behaviour, so previously generated bundles keep
  working;
- set and found in `tokens[]` → that token;
- **set and not found → a hard error** (`token '<id>' is no longer configured — re-export
  the .mcpb from Obsidian settings`), never a fallback to `bearerToken`.

The fallback is the security-relevant part: silently substituting the mirror token would
mean revoking a client's token hands that client the default token's surface instead of
cutting it off, which defeats the second of the two reasons this feature exists.

**Amendment (2026-08-02, during implementation).** The parenthetical above originally read
"(old bundle, or the mirror token)". That conflated two cases, and the second half
sanctioned exactly the substitution the paragraph above forbids. Corrected:

- **"Exported for the mirror token" is not a case.** `mcpTransport.bearerToken` is
  recomputed as `tokens[0].token` on every mutation (§7), so an id-less bundle follows
  **position**, not identity: revoking the first token silently re-points that bundle at
  the *new* first token, and a client whose credential was revoked keeps working with
  someone else's surface. That is the same defect the fallback rationale exists to
  prevent, reached from the export side instead of the resolution side.
- **The unset branch exists only for bundles generated before 0.29.0.** No 0.29 export
  path may emit one. `tokenId` is required on `McpbGeneratorInput` and `generateMcpb`
  throws on a blank one; `downloadMcpb` validates the id against the live `tokens[]` and
  refuses to write anything for an empty, unknown or unreadable one; and both `.mcpb`
  surfaces pass an id — the per-row button passes `token.id`, and **Download .mcpb** under
  *Quick setup for clients* resolves `tokens[0].id` at click time via
  `downloadMcpbForFirstToken`. The "Files to create or modify" table below already
  required this of `ClientConfigSection.svelte` (".mcpb download takes a `tokenId`"); the
  first implementation dropped it, which is how the defect arrived.
- **The legacy branch is a bounded compatibility hole, not a supported design.** A pre-0.29
  bundle still transfers to the next token when the first is revoked. It is kept only
  because removing it breaks every installed extension at upgrade, and it is acceptable
  only because the README and CHANGELOG instruct a one-time re-export. A later release may
  drop it once bundles predating 0.29.0 can be assumed gone.

---

## Alternatives considered

### Alternative A: the profile is a hard ceiling that activation cannot exceed

The shape proposed in issue #348: no separate allowlist, `core` simply means "these 13
and no more".

**Rejected.** `core` is not a permission boundary, it is a token-cost starting point;
`activate_tool` widening it on demand is the entire reason it is usable rather than
crippling. Under this alternative every core token's `activate_tool` returns "refused"
for every tool, and the meta-tools that exist to advertise promotable tools advertise
nothing reachable — the circular dead end ADR-0010's `ALWAYS_ACTIVE_TOOLS` comment
already warns about, reintroduced one layer up. A user who genuinely wants a ceiling
gets one, opt-in, via `allowed`, and pays nothing when they do not.

### Alternative B: a registry per token, or a token-aware registry

Either compose N registries (one per token, each with its own disable flags) or teach
`ToolRegistryClass` about token ids and keep an active set per token internally.

**Rejected.** `composeToolRegistry` registers ~45 tools, builds every ArkType JSON
Schema, and runs the tool-toggle filter; doing that per token multiplies plugin-load cost
and memory by the token count for a difference that is a set intersection. The
token-aware variant is worse in a different way: it drags auth identity into the layer
that owns global truth, so every registry mutator would need to decide whether it is
global or per token, and ADR-0010's two-flag model would gain a third dimension. Per-token
filtering is a pure function of (global registry, token policy); keeping it as one
resolved set passed in preserves `composeToolRegistry` running exactly once and leaves the
ADR-0010 split untouched.

### Alternative C: cache the token list in memory, invalidated by the settings UI

Read `tokens[]` once at `setup()` (as `bearerToken` is read today) and have the settings
UI push an invalidation after every mutation, removing the per-request `loadData()`.

**Rejected.** A missed invalidation is an authentication bug — a revoked token that keeps
working until the next Obsidian restart — and there are five mutation paths (add,
regenerate, revoke, rename, migration) plus a settings tab that can be destroyed and
recreated. The failure is silent and security-relevant, which is the worst combination to
trade for one file read on a loopback server whose requests already do vault I/O. Today's
code avoids the same trap by restarting the whole transport on regenerate; dropping the
cache lets us drop the restart too. If the read ever shows up in the bench harness
(`scripts/bench.ts`), a TTL of a few hundred milliseconds is a bounded follow-up that
keeps revocation eventually-correct without an invalidation protocol.

### Alternative D: identify the client from `clientInfo` on `initialize`

Read `clientInfo.name` during the handshake and key profiles off it, leaving one token.

**Rejected.** The transport is stateless per request; `initialize` arrives on a different
HTTP request from the calls that follow and there is no session id to correlate them
(`sessionIdGenerator: undefined`, forced by the SDK's "stateless transport cannot be
reused" constraint documented in `mcpServer.ts`). Correlating would mean introducing
sessions, i.e. re-litigating the transport architecture for a value the client asserts
about itself and can trivially spoof — which cannot support the revocation half of the
feature at all. The bearer is per-request, unforgeable, and already there.

### Alternative E: put the policy inside each `tokens[]` entry

One array, each element `{ id, label, token, createdAt, profile, promoted, allowed }`.
One slice, one write, no join, no orphans.

**Rejected.** It puts the secret and the tool-selection UI's write target in the same
record, so every profile change rewrites the slice holding the credentials, and the
tool-loading feature acquires write access to the auth slice. The blast radius of a bug
in the settings panel becomes "can corrupt the bearer token", and the migration would
have to move `toolLoading.profile` across slice boundaries instead of copying it within
one. The join by id costs one lookup with a documented default for a miss; the separation
is what lets `mcpTransport` remain the only slice that ever holds a secret.

### Alternative F: drop the session layer — every activation persists

`persist: false` would simply write to `profiles[tokenId].promoted` anyway, deleting the
`SessionPromotions` map.

**Rejected.** It silently redefines a documented tool argument: an exploratory activation
would become permanent, so a `core` token's surface only ever grows and the token-cost
saving decays to nothing over a few sessions. It also adds a settings write to a call
path that today has none. Keeping a per-token in-memory set is about thirty lines and
preserves the 0.28.2 contract exactly.

### Alternative G: per-token counters

Give each token its own `counters` map so adaptive promotion reflects that client's own
usage.

**Rejected** (and explicitly out of SPEC scope). Call frequency describes the vault's
work, not the client's identity; the same note-editing habit split across two clients
would reach the promotion threshold in neither. It also multiplies the hottest write in
the settings file by the token count. Two adaptive tokens promoting the same tool at the
same time against shared counts is the intended behaviour, not a defect.

### Alternative H: run the migration lazily, on the first authenticated request

Skip the load-path cost; migrate when a request first needs the token list.

**Rejected.** The first request has no token list to authenticate against yet, so it
would have to bypass auth to trigger its own migration, and a settings tab opened before
any client connects would race the request path for the same two slices. The load path
runs once, before the listener binds, with nothing to race.

---

## Consequences

### Positive

- One vault serves a different, independently revocable tool surface per client, which is
  the feature (R-01, R-03).
- Revocation is genuinely selective: rotating claude.ai's token leaves Cowork and every
  other configured client untouched — today it breaks all of them.
- Token add/regenerate/revoke no longer restart the HTTP transport. The port cannot drift
  on rotation, in-flight requests finish, and the next request sees the new list.
- `list()`'s memo stops depending on mutable disable state; the expensive schema
  derivation is cached once per registration instead of once per flag change, so a
  per-token `tools/list` is a filter over ~45 cached entries.
- Filtering becomes a pure function of (registry, policy) with no hidden global mutation:
  `applyAdaptiveFilter`'s side-effecting pass over the shared registry disappears, and
  with it the class of bug where one client's `activate_tool` widened everyone's surface.
- The refusal path is a strict extension of ADR-0011's recoverable shape, so clients that
  already self-heal on the inactive-tool error need no change, and the allowlist case
  gets a message that does not send them into a retry loop.
- The legacy mirror means a downgrade to 0.28.x is lossless, not just non-fatal: the old
  build reads a working token and the user's real profile and promoted list.
- Both mirrors have exactly two writers, both self-healing on load, so a hand-edited or
  half-written `data.json` converges instead of drifting.

### Negative

- One extra `data.json` read per request (the token list), plus a second on the first
  `tools/*` request of each POST (the policy). On a loopback single-user server whose
  handlers already read the vault this is small, but it is a new fixed cost on the hot
  path and it is not measured yet. `scripts/bench.ts` exists and should be run before and
  after (see Risks in the plan).
- The `createServer` callback becomes async. Nothing reads the request stream before the
  handler, so no bytes are lost, but the window between socket accept and body read now
  contains an await — a slow or failing `loadData()` delays every request, and a rejected
  one 401s a legitimate client.
- Auth's contract changes (`runMiddleware`, `HttpServerConfig`, `RequestHandler`), which
  touches roughly 20 test call-sites plus `scripts/bench.ts`. A mistake here locks the
  user out of their own server, which is why the migration lands first and the middleware
  change lands only after `ensureTokenStore` is tested.
- `data.json` grows a nested `profiles` map keyed by ids that must stay in step with
  `tokens[]`. Orphans are inert and pruned on the next policy write, but the invariant is
  now maintained by code rather than by structure (the price of Alternative E's rejection).
- The `.mcpb` shim gains a third placeholder and a resolution branch, i.e. more surface in
  the one component that runs outside Obsidian and outside the plugin's own test harness
  boundary. Old bundles keep working; new ones fail loudly if their token is revoked,
  which is correct but is a new failure mode users will see.
- `applyAdaptiveFilter.ts` and its test are deleted. Deleting files needs the operator's
  confirmation, and the registry keeps five adaptive-flag methods that no production code
  writes any more — a deliberate, documented loose end rather than a silent one.
- Settings UI complexity grows meaningfully (list + selection + policy panel + allowlist
  checklist + per-row copy menu), and `bun run check` is `tsc --noEmit`, which does not
  type-check `.svelte` files. The UI tasks need manual verification in a real vault.

### Neutral

- Counters stay global, so `tool_catalog`'s `call_count` is vault-wide for every token.
  Intended; stated in the tool's own description so it is not mistaken for per-client
  telemetry.
- Meta-tools bypass the allowlist by construction. A user cannot lock a token out of
  `tool_catalog` or `activate_tool`, even with `allowed: []`. That is the same invariant
  `ALWAYS_ACTIVE_TOOLS` already encodes, applied one layer up.
- Duplicate labels are allowed; the id is the identity and the label is cosmetic.
- The MCP protocol revision the server speaks is unchanged (#407 Phase 2 stays
  unscheduled). Per-token `notifications/tools/list_changed` needs no work: the
  notification rides the activation call's own POST response stream with that call's
  `relatedRequestId` (ADR-0011, ADR-0012), so it already reaches exactly the caller.
- `ToolScope.id` is the bearer token's id, but the registry treats it as an opaque key
  and never dereferences it. The name keeps the "the registry has no token concept"
  invariant literal at the type level.

---

## Files to create or modify

| File | Change |
|---|---|
| `packages/obsidian-plugin/src/shared/types.ts` | Add the cross-cutting `ToolScope` type. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/token.ts` | Add `generateTokenId()` (short base64url, from `randomBytes`). |
| `packages/obsidian-plugin/src/features/mcp-transport/services/tokenStore.ts` | **New** — `TokenRecord`, `ensureTokenStore` (mint + migrate + self-heal mirror, idempotent), `readTokens`, `addToken`, `regenerateToken`, `revokeToken`, `renameToken`, `staticTokenProvider` (tests/bench). Every recipe recomputes `bearerToken` from `tokens[0]`. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/tokenStore.test.ts` | **New** — migration from a 0.28.2 fixture (byte-for-byte token), idempotency, fresh-vault mint, empty/hand-edited `tokens[]`, mirror recomputation, revoke/regenerate invariants. |
| `packages/obsidian-plugin/src/features/mcp-transport/constants.ts` | Add `MAX_TOKENS = 10`. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/middleware.ts` | `runMiddleware(req, tokens)`; `checkAuth` matches all tokens with no early exit and returns `tokenId`; `MiddlewareResult` carries `tokenId`. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/middleware.test.ts` | N-token matching, no-early-exit, empty list, unknown token 401 with no hint. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/httpServer.ts` | `bearerToken` → `resolveTokens` provider; async request callback; pass `tokenId` to `requestHandler`; `RequestHandler` signature. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/httpServer.test.ts` | Update every `startHttpServer({ bearerToken })` call-site; add multi-token and resolver-failure cases. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/setup.ts` | Call `ensureTokenStore` first; wire `resolveTokens`; keep `state.bearerToken` as the mirror. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/setup.test.ts` | Existing `bearerToken` preservation assertions extended to `tokens[]`. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts` | `handleRequest(req, res, tokenId)`; lazy memoized scope; `registry.list(scope)`; `scope` on the dispatch context; `isInactive` rename at the `recordCall` gate; owns `SessionPromotions`. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.test.ts` | Two-token end-to-end: different `tools/list` per token; out-of-scope `tools/call` returns the recoverable error; counter gating unchanged. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts` | Split `listCache` into `entriesCache` + per-call filter; `list(scope?)`; `HandlerContext.scope`; `dispatch` branches b1/b2; `isAdaptiveInactive` → `isInactive(name, scope?)`. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.test.ts` | Scope-filtered `list`/`dispatch`, allowlist refusal precedence, `userDisabled` still wins, `isInactive` rename. |
| `packages/obsidian-plugin/src/features/adaptive-tool-loading/tokenPolicyStore.ts` | **New** — `TokenPolicy`, `DEFAULT_POLICY`, `readPolicy`, `updateToolLoading` (mirror + orphan prune choke point), `updateTokenPolicy`. |
| `packages/obsidian-plugin/src/features/adaptive-tool-loading/resolveToolScope.ts` | **New** — pure `(policy, allNames, session) → ToolScope`, reusing `getActiveToolNames` and applying the allowlist ceiling. |
| `packages/obsidian-plugin/src/features/adaptive-tool-loading/sessionPromotions.ts` | **New** — per-token in-memory promotion map. |
| `packages/obsidian-plugin/src/features/adaptive-tool-loading/toolLoadingManager.ts` | Mutators take a `tokenId` and route through `updateToolLoading`; `flushPendingCalls` fans auto-promotion out over adaptive `profiles` entries; `resetAll` splits global counters from per-token promotions. |
| `packages/obsidian-plugin/src/features/adaptive-tool-loading/applyAdaptiveFilter.ts` + `.test.ts` | **Deleted** (subsumed by scope resolution; operator confirmation required). |
| `packages/obsidian-plugin/src/features/adaptive-tool-loading/index.ts`, `types.ts` | Drop the `applyAdaptiveFilter` export; declare `profiles` on the settings interface. |
| `packages/obsidian-plugin/src/composeToolRegistry.ts` | Drop the `applyAdaptiveFilter` call; accept `SessionPromotions`; wire the activation handlers to session promotion instead of `enableByName`. |
| `packages/obsidian-plugin/src/features/mcp-tools/tools/activateTool.ts`, `activateTools.ts` | Take `scope`; allowlist refusal (`not_allowed`); persist into the calling token's policy; session promotion. |
| `packages/obsidian-plugin/src/features/mcp-tools/tools/toolCatalog.ts` | Take `scope`; status from the token's active set and promoted list; new `unavailable` status; counters stay global. |
| `packages/obsidian-plugin/src/features/mcp-tools/tools/*.test.ts` (3) | Scope-aware cases for all three meta-tools. |
| `packages/obsidian-plugin/src/features/core/components/SettingsTab.svelte` | Own `selectedTokenId`; pass it to both sections. |
| `packages/obsidian-plugin/src/features/mcp-transport/components/AccessControlSection.svelte` | Token list rows (label, profile, count, copy menu, regenerate, revoke), Add capped at `MAX_TOKENS`, no transport restart. |
| `packages/obsidian-plugin/src/features/adaptive-tool-loading/components/AdaptiveToolLoadingSettings.svelte` | `tokenId` prop; reads/writes through `tokenPolicyStore`; allowlist toggle + single checklist; empty-allowlist warning. |
| `packages/obsidian-plugin/src/features/mcp-client-config/components/CopyConfigMenu.svelte` | **New** — `{ url, token }` → the existing client-family buttons; mounted by both `ClientConfigSection` and each token row. |
| `packages/obsidian-plugin/src/features/mcp-client-config/components/ClientConfigSection.svelte` | Use `CopyConfigMenu`; `.mcpb` download takes a `tokenId`. |
| `packages/obsidian-plugin/src/features/mcp-client-config/services/mcpbGenerator.ts` (+ test) | `tokenId` input, third guarded placeholder. |
| `packages/obsidian-plugin/scripts/connectorShim.js` (+ `connectorShim.test.ts`, regenerated `assets/connectorShimSource.ts`) | `parseTransportFile(json, tokenId)`: unset → `bearerToken`; found → that token; set-and-missing → hard error. |
| `packages/obsidian-plugin/scripts/bench.ts` | `startHttpServer` call-site. |
| `README.md`, `CHANGELOG.md` | Token list, per-token profiles, revocation warning; entry under the next version. |

---

## References

- SPEC.md at repo root (`Per-client tool profiles via multiple bearer tokens`, 2026-07-31)
- GitHub issue #348
- MCP revision `2026-07-28`, `tools/list`: the returned set may vary by the authorization presented on the request
- ADR-0010: split registry disable states — `userDisabled` stays the top precedence layer; the adaptive flag API is kept but loses its production writer
- ADR-0011: self-healing inactive tool error — the recoverable-error shape the allowlist refusal extends; supersedes the `isAdaptiveInactive` name with `isInactive(name, scope?)`
- ADR-0012: bridge SSE parsing and concurrency — why the activation notification already reaches only the calling client
- ADR-0013: pure-Node `.mcpb` shim — the placeholder-substitution pattern the token id reuses, and the shim's `data.json` read
- `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts` — stateless per-request transport, the constraint that rules out `clientInfo` identity
- `packages/obsidian-plugin/src/shared/settingsStore.ts` — `updateSlice` NO_CHANGE convention and the process-wide settings mutex
