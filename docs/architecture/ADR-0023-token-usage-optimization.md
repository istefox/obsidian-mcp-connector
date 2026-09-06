# ADR-0023 — Token usage optimization for the MCP tool surface

**Status:** Accepted (implementation pending)
**Date:** 2026-09-05
**Chain:** `token-usage-optimization-for-mcp-tool-su`
**SPEC:** `SPEC.md` (repo root), requirements R-01 … R-15
**Supersedes:** nothing
**Amends:** ADR-0018 §D5/D6 (conditionally, see D9), ADR-0014 (`DEFAULT_POLICY` semantics, see D11)
**Explicitly does not reopen:** ADR-0009

---

## Context

Every MCP client session pays for this server's tool surface twice over: once at connection, when
`tools/list` is pulled into the model's context and stays there for the whole session, and again on
every read-heavy tool call whose response is larger than the information it carries.

Measured 2026-09-05 against `main` (`b9ddacd`) and the Labs vault. These numbers are **prior art
from the interview session, restated here, not re-derived by this ADR**:

| Surface | Size | Est. tokens |
| --- | --- | --- |
| Full `tools/list` (49 tools, profile `all`) | 43.4 KB | ~10.9k |
| Live `tools/list`, profile `adaptive` (18 tools) | 15.0 KB | ~3.7k |
| `tool_catalog` response (49 entries) | 7.4 KB | ~1.9k |
| `search_vault_simple("the", limit 3)` — text | 12.3 KB | ~3.1k |
| `search_vault_simple("the", limit 3)` — MCP Apps `_meta` | 15.5 KB | ~3.9k |

Composition of the full `tools/list`: descriptions 13.1 KB, `inputSchema` 23.7 KB (of which 12.6 KB
is parameter descriptions spread over 139 params), annotations 2.8 KB.

**Re-measurement, 2026-09-05, against the shipped build (Task 9, R-12/R-13).** Same methodology
(bytes/4 estimator), Labs vault, over the live server on `feat/token-usage-optimization-for-mcp-tool-su`.
`tool_catalog`'s actual entry count and `tools/list`'s actual `all`-profile tool count are both **52**
at this build, not 49. The interview-session baseline's 49 was already stale against `main`
(`b9ddacd`) before this chain touched anything: three tools landed on `main` from unrelated work
between the interview session and this measurement, so the 49 → 52 denominator change is not an
effect of this chain and is not comparable as one. The byte/token deltas below are still a valid
"before vs. after this chain" comparison — they are not attributable to the tool-count drift, they
just happen to be measured against a denominator that also moved for a separate reason. The
`adaptive` profile stays at 18 tools, matching the baseline exactly (new tools ship inactive by
default under R-11, so they don't reach this row).

| Surface | Size | Est. tokens | vs. baseline |
| --- | --- | --- | --- |
| Full `tools/list` (52 tools, profile `all`) | 43.0 KB | ~10.7k | -0.4 KB / -0.2k (49-tool baseline; +3 unrelated tools since) |
| Live `tools/list`, profile `adaptive` (18 tools) | 14.1 KB | ~3.5k | -0.9 KB / -0.2k (-6%) |
| `tool_catalog` response (52 entries) | 7.0 KB | ~1.7k | -0.4 KB / -0.2k (49-entry baseline; +3 unrelated entries since) |

This chain's own effect (D6's schema-shape fix, D8's annotation/constraint slimming, and Task 6's
description shortening + `instructions` addition) is smaller in bytes than shown: part of the -0.4
KB is this chain's work, part is offset by the 3 unrelated tools' own schemas and descriptions
adding bytes of their own. The measurement isolates neither share; it only confirms the combined,
as-shipped total did not regress. This is the combined figure R-12 asked for: `instructions` is
never credited alone (see the R-10-alone risk note below).

**`search_vault_simple` re-measurement, 2026-09-06**, same methodology, live Labs vault server, the
same `("the", limit 3)` call as the baseline row. This is the one baseline row the 2026-09-05 pass
left unmeasured — capturing it needed a genuinely idle vault (Obsidian fully quit, `data.json`
backed up before edit, `all` ↔ `adaptive` toggled on the one live token only while the app was
closed, restored afterward) rather than the `tools/list`-only comparison the same-session pass
could do live:

| Surface | Size | Est. tokens | vs. baseline |
| --- | --- | --- | --- |
| `search_vault_simple("the", limit 3)` — text only | 3.9 KB | ~1.0k | -8.4 KB / -2.1k (-68%) |
| `search_vault_simple("the", limit 3)` — with MCP Apps `_meta` | 8.8 KB | ~2.2k | -6.7 KB / -1.7k (-43%) |

The drop is dominated by D1's `maxMatchesPerFile` cap and D2's removal of the unread
`match.start`/`match.end` offsets, not by the `_meta` gating decision (D9): this call rides the
legacy, stateless era, which keeps attaching `_meta` unconditionally by design (see D9), so the
`_meta` row's reduction comes entirely from the same per-match trimming as the text-only row.

**R-13 confirmed live**, same session: `search_vault_simple("the")` against a vault file with more
than 5 matches (`03 Risorse/prompts/ricerca-caratteristiche-antivibranti.md`) returns exactly 5
entries under `matches` for that file plus `"moreMatches": true`, and no result anywhere in the
payload carries `match.start`/`match.end` — R-01/R-02 confirmed on the shipped build, not just in
unit tests. `tools/list` and `tool_catalog` were inspected live over HTTP (not only measured for
size) and match the shipped shape: `instructions` present on `initialize`, `_meta.ui` extension
capability declared, 2026-07-28-era `server/discover` untouched by this chain.

Two facts shape everything below.

**The session-fixed cost dominates.** `tools/list` is paid once but survives the whole conversation,
and at profile `all` it is ~10.9k tokens before the user has asked anything. The `adaptive` profile
already cuts that to ~3.7k — a 66% reduction that exists today, is fully tested, and is simply not
the default for a new token.

**The per-call cost is dominated by fields nobody reads.** `search_vault_simple` returns the same
result twice: 12.3 KB of text plus 15.5 KB of MCP Apps `_meta`, and the `_meta` copy is attached
unconditionally on success (ADR-0018 §D5/D6) whether or not the client can render a `ui://` view.
Inside the text copy, every match carries `{start, end}` character offsets that no consumer reads.

This work was scoped at interview as one broad ADR rather than split chains, sectioned by
certainty. That structure is preserved below: mechanical changes are decided outright, two items
are decided *conditionally on a spike whose result this ADR records*, and one product default
changes under a phased-opt-in posture.

### Verified facts this ADR rests on

Every claim about an installed package was read from `node_modules` on 2026-09-05, per the
project's standing rule never to assert SDK state from memory. Load-bearing findings:

- `@modelcontextprotocol/sdk@1.30.0` — `ServerOptions.instructions?: string` exists
  (`dist/esm/server/index.d.ts:15`), and is emitted **only** from `_oninitialize`
  (`dist/esm/server/index.js:268`, inside the `initialize` result). `getClientCapabilities()`
  returns `this._clientCapabilities` (`:274`), populated **only** at `:261`, also inside
  `_oninitialize`.
- `@modelcontextprotocol/server@2.0.0` (the modern era's package, distinct from the SDK above) —
  exports `CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities"`
  (`@modelcontextprotocol/core/dist/internal.d.mts:41`). The modern era therefore carries client
  capabilities **in every request's `_meta` envelope**, not only at handshake.
- `McpRequestContext` (`createMcpHandler-CLhGwQTn.d.mts:3781`) — the object this project's factory
  receives — carries `era: 'legacy' | 'modern'`, `authInfo?`, `requestInfo?: Request`. It does
  **not** carry parsed client capabilities.
- `arktype@2.0.0-rc.30` — measured directly. `type("boolean")` used as an optional property emits
  `{"anyOf":[{"type":"boolean"}]}`, a **single-member `anyOf` wrapper**, not a plain
  `{"type":"boolean"}`. Verified against the real `searchAndReplaceSchema`: `dry_run` emits exactly
  that shape. 12 optional-boolean parameters across the tool registry are in this shape.

---

## Decision

Eleven decisions, grouped by the SPEC's three certainty tiers plus the deferral.

### Tier 1 — Mechanical (decided outright)

#### D1 — `search_vault_simple` caps matches per file (R-01)

Add optional `maxMatchesPerFile` (integer ≥ 1, default 5). A file with more matches than the cap
returns exactly `maxMatchesPerFile` matches and gains `moreMatches: true`.

The flag means *"there were more than the cap"*, never *"there were at least the cap"*. A file with
exactly `maxMatchesPerFile` matches must not set it. This off-by-one is the single most likely
defect in this ADR and is called out as its own test case.

Rationale: the measured 12.3 KB response came from `limit: 3` — three *files*. The per-file match
count is unbounded, so a single dense file can dominate a response whose caller asked for three
results. A cap is the only change here that bounds a previously unbounded dimension.

#### D2 — Drop `match.start` / `match.end` (R-02)

`matches[].match` (the `{start, end}` character-offset object) is removed. `line` is retained.

Grepped at design time across `packages/`, `scripts/` and `packages/shared`: the **only** reader is
`searchVaultSimple.test.ts:118` (`(m: { match: { start: number } }) => m.match.start`). That
assertion is updated in the same task that removes the field — see the staleness table in the plan.

This is a genuine breaking change to the exact response shape for an external consumer, accepted
knowingly (see Consequences, negative).

#### D3 — Flatten Dataview `Link` objects (R-03)

`execute_dataview_query` and `search_vault` (dataview mode) serialize a Dataview `Link` as its plain
`path` string instead of `{path, embed, type, display}`. `idMeaning` is dropped from TABLE-mode
output.

Flattening is **recursive**. A `Link` can sit arbitrarily deep inside a TABLE cell (a list of
outlinks is the common case), so a top-level-only transform would leave most of the cost in place
and — worse — produce a response where the same logical value is shaped two different ways
depending on nesting depth. Inconsistent is worse than verbose.

`idMeaning` currently passes through untouched, and `executeDataviewQuery.test.ts:105-121` asserts
exactly that pass-through. That test encodes the *old* contract and is updated in the same task.

#### D4 — Trim `tool_catalog` (R-04)

Omit `call_count` when it is `0`. Tighten the first-sentence truncation applied to inactive tools.

A consumer requiring the literal `0` would break. Judged acceptable: the field is informational
display only, and an absent count and a zero count carry identical meaning to any reasonable reader.

#### D5 — Shorten over-long tool descriptions (R-05)

Tool descriptions carrying implementation trivia — internal API paths, issue and RFC references,
scope notes — are shortened.

The governing rule, and the reason this item cannot be mechanized: **remove what aids tool
*selection* but not tool *invocation*.** Dropping "Implements RFC #68" is safe. Dropping
"the underlying error is surfaced verbatim" from `execute_dataview_query` is not — a caller uses
that to decide how to handle a failure. This is why R-05 carries `no-test`: no assertion can
distinguish the two, and a byte-count check alone would reward deleting the wrong sentence.

**A count discrepancy is recorded rather than resolved.** The SPEC says 16 descriptions exceed 350
characters. A static scan at design time found **13** top-level tool descriptions over 350 (largest:
`createVaultBinaryFile` 577, `renameHeading` 507, `searchVaultSmart` 472). The gap is most likely
methodology — the live measurement saw descriptions as emitted through the registry, the static scan
sees source literals, and the two differ wherever a description is composed rather than written. The
implementation resolves this against the **live registry**, which is the surface that actually costs
tokens; the number 16 is not treated as authoritative and neither is 13.

#### D6 — Normalize ArkType JSON Schema: collapse const-unions, unwrap single-member `anyOf` (R-06)

This extends the **existing** `normalizeInputSchema` in
`mcp-transport/services/toolRegistry.ts`, alongside its existing `dedupeUnionDescriptions` pass. It
does not create a parallel normalizer. One schema-shaping seam, not two.

Two transforms:
- `anyOf: [{const: "a"}, {const: "b"}, …]` → `enum: ["a", "b", …]`
- `anyOf: [X]` (single member) → `X` hoisted in place

Measured shape, not assumed: `type("boolean")` as an optional property emits
`{"anyOf":[{"type":"boolean"}]}`. 12 parameters across the registry are in this shape.

The const-union collapse currently has **no matching site in this registry** — the scan found zero
literal-union parameters. It is implemented anyway, as defense in depth in the same class as the
existing `additionalProperties: {}` strip (issue #63): a future contributor adding a union parameter
should get the compact form without having to know this ADR exists.

#### D7 — Issue #508 is re-tested after D6, and the outcome is recorded either way (R-07)

Issue #508 reports `search_and_replace` intermittently rejecting a valid `dry_run` argument.

**Hypothesis, stated as a hypothesis:** the single-member `anyOf` wrapper D6 removes may be
involved. `dry_run` is confirmed by direct measurement to emit `{"anyOf":[{"type":"boolean"}]}`, and
a strict client-side validator handling a one-member `anyOf` differently from a plain type
declaration is a plausible mechanism — it is the same class of defect as issue #63, where an
empty-object `additionalProperties` was rejected by a strict validator that accepted the equivalent
`true`.

**This is not a confirmed root cause.** Two things argue against overclaiming: the report says
*intermittent*, and a fixed schema shape is not intermittent; and no in-house repro exists. The
honest position is that D6 removes a credible contributing factor. If #508 survives D6, the wrapper
was not the cause and the investigation continues elsewhere. Either outcome is recorded in this ADR
and on the issue. #508 is **not** closed on the strength of the shape change alone.

**Outcome, recorded 2026-09-05 after D6 shipped (Task 4).** Direct measurement on the merged code:
the raw ArkType schema for `dry_run` still emits `{"anyOf":[{"type":"boolean"}],"description":"..."}`
before normalization; `normalizeInputSchema` (D6) now unwraps it to
`{"type":"boolean","description":"..."}`, confirmed against a scratch fixture exercising the same
code path `search_and_replace`'s registration goes through. This confirms D6's fix is real and
applied to `dry_run` specifically.

No in-house repro of the intermittent rejection itself was produced or attempted against a live
client (Claude Desktop / the `.mcpb` bridge) — the reporter's own investigation (see the issue
thread) already ran direct schema/validator checks, boolean coercion, and 5,000 concurrent calls
without reproducing it, and concluded the failing request's raw bytes are needed to go further.
Nothing in this task's scope changes that: the wrapper shape is fixed, but the report is
intermittent and a static shape fix does not by itself explain intermittent behavior. Per this
section's own criterion, **#508 is not closed.** The issue remains open, still waiting on the
reporter to supply the exact bytes of a failing request (MCP Inspector or Claude Desktop
`mcp*.log`) per the maintainer's last comment — no re-ping, this ADR update alone does not obligate
one. If the reporter later confirms resolution on a build containing this fix, close #508
referencing this section; if the reporter reproduces it again on this build, that rules the wrapper
out entirely and the investigation continues elsewhere.

#### D8 — Reduce annotation and constraint verbosity (R-08)

Omit annotation fields whose value equals the MCP spec default. Simplify the base64 pattern
constraint on `create_vault_binary_file`.

One deliberate exception. `toolAnnotations.ts` documents that `destructiveHint` is set explicitly on
every writer *including where it matches the spec default*, so the classification is reviewable in
one place rather than implied by omission. That is a decision about the source, not the wire.
Trimming happens at the **emission** seam, so the source keeps its explicit, reviewable table and
the wire stops paying for it. Deleting the explicit `destructiveHint: true` entries from the source
would be a different and worse change.

The base64 constraint must be simplified **without weakening validation**: the ArkType runtime check
(`string.base64`) still rejects non-base64 input. Only the advertised JSON Schema pattern is
simplified. The tool additionally catches a decode failure at `createVaultBinaryFile.ts:67`, so
validation is genuinely layered and not solely schema-advertised.

### Tier 2 — Needs-spike

#### D9 — MCP Apps `_meta` gating: gate on the modern era, leave legacy unchanged (R-09)

**The spike is resolved in this ADR.** Reading the installed packages answered it without needing
runtime scaffolding, so no spike code survives:

- **Modern era (2026-07-28): feasible.** `@modelcontextprotocol/server@2.0.0` re-exports
  `CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities"`. The modern
  transport carries client capabilities in **every request's `_meta` envelope**, so the signal is
  available per request, before a `tools/call` response is built. This is exactly the signal R-09
  asked for.
- **Legacy era (2025-era): not feasible, structurally.** This is not a gap to be worked around, it
  is a property of the transport. The legacy path is **stateless and POST-only**; `initialize`
  state is never available to a later request (CLAUDE.md, ADR-0016). The SDK's own
  `getClientCapabilities()` reads `_clientCapabilities`, populated only inside `_oninitialize`
  (`server/index.js:261`) — on a stateless transport that instance is gone by the next request.
  There is no per-request capability signal on the legacy era and there cannot be one without
  inventing state the transport deliberately does not keep.

**Decision:** gate the `_meta` payload on the modern era, on declared
`io.modelcontextprotocol/ui` support. Leave the legacy era attaching unconditionally, as today.

The legacy behaviour is left unchanged **with a stated reason**, which is what R-09 requires:
guessing is worse than paying. A heuristic (sniffing `clientInfo`, say) would silently withhold the
payload from a client that could have rendered it, turning a token optimization into a feature
regression that nobody can debug from the wire. Unconditional attach on legacy is a known,
bounded cost; a wrong guess is an unbounded and invisible one.

**Implementation constraint discovered at design time, and it is the hard part.** The payload is
attached *inside the tool*, not at the transport boundary: `searchVaultSimple.ts` and
`searchVaultSmart.ts` both call `withSearchResultsPayload(...)` directly, and the tool handler has
no access to `McpRequestContext`. `McpRequestContext` itself carries `era` and `requestInfo` but
**not** parsed capabilities, so even at the factory the envelope must be read from the request. The
gating signal therefore has to be threaded from the transport to the tool. This is real plumbing
across a layer boundary, not a conditional — and it is why D9 is sequenced late, behind the
mechanical work, and why it is the item most likely to be dropped if it proves invasive. The
fallback position (leave the payload unconditional on both eras) costs only the optimization and
breaks nothing.

#### D10 — Server `instructions`, with an era caveat that changes its value (R-10)

Set a non-empty `instructions` string on `buildMcpServer`'s construction, centralizing conventions
currently repeated across tool descriptions: vault-relative paths, 0-indexed lines, the `errorCode`
response shape.

Implemented directly rather than spiked, per the interview decision: an ignoring client simply does
not use it, so the regression risk is nil.

**The caveat is load-bearing and must not be lost.** `instructions` is emitted only from
`_oninitialize` (`sdk/dist/esm/server/index.js:268`). Per ADR-0016, `2026-07-28` is **not reachable
through `initialize`** — the modern era enters at `server/discover`, and `_ondiscover` deliberately
returns no `serverInfo`. So `instructions` reaches **legacy-era clients only**, and it is *added*
prose: it grows the legacy handshake and shrinks nothing by itself.

It pays for itself only if D5 then removes the now-centralized conventions from the individual tool
descriptions, where they are currently repeated ~49 times. **D10 without D5 is a net token
increase.** The two are sequenced together for that reason, and the measurement in R-12 must report
their combined effect rather than crediting D10 alone.

### Tier 3 — Product default change

#### D11 — New tokens default to `adaptive`; existing tokens are never touched (R-11)

A token id never seen in `toolLoading.profiles` resolves to `profile: "adaptive"` instead of
`"all"`. This is the single highest-leverage item in the ADR: it moves a new client from ~10.9k to
~3.7k session-fixed tokens, a 66% reduction, using a profile mechanism that already exists and is
already tested.

**This decision is dangerous in a way the SPEC's framing understates, and the danger is the whole
design.** `DEFAULT_POLICY` is not a single-purpose constant. It reads as "the default for a new
token", but at design time it serves **five** call sites in three semantically different roles:

| Site | Role | Must it change? |
| --- | --- | --- |
| `tokenPolicyStore.ts:173` (`readPolicy`) | a live token with no entry | **Yes** — this is R-11's target |
| `tokenStore.ts:169` (`withPolicyFor`, non-seed branch) | seeding a genuinely new token | **Yes** — R-11's target |
| `tokenPolicyStore.ts:226` (`updateToolLoading`, mirror recompute) | legacy-mirror fallback | **No** |
| `toolLoadingManager.ts:39` (`promotedFor`) | reading `promoted` off a missing entry | **No** |
| `toolLoadingManager.ts:52` (`setPromoted`) | base for a promotion patch | **No** |

The bottom three are **not** "what a new token gets". They are structural fallbacks that exist so a
half-written or orphaned record degrades to prior behaviour instead of crashing or locking a client
out — the invariant ADR-0014 states explicitly and `tokenPolicyStore.ts:29-34` documents in prose.
Changing the shared constant changes all five at once.

The concrete failure this would cause is not hypothetical. `tokenPolicyStore.ts:225-229` recomputes
the legacy mirror as `next.profiles[ctx.mirrorId] ?? defaultPolicy()`, and the surrounding comment
explains that `withPolicyFor` **seeds a missing entry from those globals on the next load**. If the
shared default flips to `adaptive`, a token whose entry is momentarily absent during a mirror
recompute has `adaptive` burned into the legacy mirror — and a downgraded 0.28.x plugin, which
reads only that mirror, then silently narrows a user's tool surface from `all` to `adaptive`. That
is precisely the "downgrading the plugin must not silently reset a user's profile" guarantee
ADR-0014 exists to hold, broken by a one-line constant change.

**Decision: introduce a separate `NEW_TOKEN_POLICY` for the new-token role. `DEFAULT_POLICY` keeps
`profile: "all"` and keeps its degradation meaning unchanged.** Only the two sites in the table
marked "Yes" adopt the new constant. This is more code than editing one constant, and it is the
correct amount of code: the two meanings were conflated only because they happened to coincide, and
R-11 is exactly the change that separates them.

`resolveToolScope.ts` needs **no change**. It receives an already-resolved `TokenPolicy` and never
consults a default. Naming it as a touch point is right for reading, wrong for editing.

**Post-review correction (2026-09-05): the table's "No" verdict for `toolLoadingManager.ts`'s
`promotedFor`/`setPromoted` was itself wrong, and has been superseded.** That verdict reasoned by analogy with
`tokenPolicyStore.ts:226`'s legacy-mirror fallback, treating "is this mirror-adjacent" as one
question with one answer. It isn't. `tokenPolicyStore.ts:226` writes the LEGACY GLOBAL
`toolLoading.profile`/`promoted` fields a downgraded 0.28.x build reads as its only policy source,
so it must keep degrading to `all` — that part of the table still holds. But `toolLoadingManager.ts`'s
`promotedFor`/`setPromoted` don't write those legacy fields at all; they read and write a specific
token's `profiles[id]` entry. A first implementation of R-11 special-cased them by "is `target` the
current mirror" (`defaultPolicy()` if so, `newTokenPolicy()` otherwise), reasoning that the mirror
token is the one plausibly migrated from legacy globals and so deserves the conservative default.
Review (both the `reviewer` subagent and, independently, a Codex second-opinion pass, per this
chain's Gate 5) found this wrong: "is currently the mirror" is a **positional** fact
(`tokens[0]`), not a stable proxy for "was legitimately seeded from legacy globals" — `tokenStore.ts`'s
`revokeToken` recomputes `ctx.mirrorId` against the post-revoke token list without reseeding
anything, so a genuinely new, never-configured token can become the mirror purely by outliving an
older one that was revoked, and would then wrongly get `all`. The corrected rule: a missing
`profiles[target]` entry in `toolLoadingManager.ts` always resolves to `newTokenPolicy()`, mirror or
not. By the time either mutator runs, the token that was actually migrated from 0.28.2 globals is
guaranteed to already have a real entry (seeded once, at `ensureTokenStore` time, by
`tokenStore.withPolicyFor`) — so this fallback is never legitimately reached for it, and reaching it
at all means either a genuinely new token (which must get `adaptive` under R-11 regardless of mirror
status) or a corrupted/hand-edited record, for which `adaptive` is also the safer failure direction
(recoverable via `activate_tool`; an accidental widening to `all` is not). The table's bottom two
rows should now read "No, but not for the reason given — see this note" rather than a bare "No".

### Deferred

#### D12 — ADR-0009's dual-emit `structuredContent` stays closed (SPEC "Deferred")

Not reopened. The MCP spec's published roadmap (2026-08-22) names `tools/call`
content/structuredContent duality as a target for redesign in the next protocol cycle. Work done now
against the current shape is work the redesign may invalidate, and this is the one item on the list
whose cost is paid twice if the guess is wrong. Revisit when a spec revision addressing it ships.

---

## Alternatives considered

### A1 — Flip `DEFAULT_POLICY` to `adaptive` in place (rejected)

The obvious one-line reading of R-11.

**Rejected:** it conflates three distinct roles behind one constant. As traced in D11, the legacy
mirror recompute at `tokenPolicyStore.ts:226` would burn `adaptive` into
`toolLoading.profile`, which a downgraded 0.28.x build reads as its only policy — silently narrowing
an existing user's tool surface on downgrade, breaking ADR-0014's explicit mirror guarantee. The
one-line change looks smaller and is strictly more dangerous.

### A2 — Migrate existing tokens to `adaptive` too (rejected)

Maximum token saving: every client, not only new ones, drops to ~3.7k.

**Rejected:** it silently changes behaviour for a working install, which this project has
repeatedly refused (ADR-0019, ADR-0022 phased opt-in; ADR-0014's mirror invariant). A user whose
workflow depends on a tool that `adaptive` leaves inactive would find it missing after an update,
with no message explaining why. The tool is recoverable via `activate_tool`, so this is not a
lockout — but "recoverable if you know the mechanism exists" is not a defence for changing something
that worked. The saving is real and is deliberately left on the table for existing tokens.

### A3 — Make `adaptive` the default by shrinking the `core` set instead (rejected)

Leave the default profile alone, reduce what `all` and `core` contain.

**Rejected:** it changes what tools *exist* for every client rather than what is *listed* for a new
one. Removing a tool from `core` is a capability change with a real chance of breaking a configured
workflow; switching a new token's default profile costs an already-recoverable listing. Same
headline saving, categorically worse blast radius.

### A4 — Gate the MCP Apps `_meta` payload with a client heuristic on both eras (rejected)

Sniff `clientInfo` or a header to guess renderer support, applying gating uniformly.

**Rejected:** a wrong guess silently withholds a payload from a client that could have rendered it,
producing a feature regression invisible on the wire and undebuggable from a bug report. The legacy
era genuinely has no capability signal (D9) and inventing a proxy for one trades a bounded, known
cost for an unbounded, silent one. Asymmetric behaviour across eras is the honest outcome here.

### A5 — Build a parallel schema post-processor rather than extending `normalizeInputSchema` (rejected)

A dedicated module for the new `anyOf` transforms.

**Rejected:** two schema-shaping seams drift. `normalizeInputSchema` already owns exactly this job —
`dedupeUnionDescriptions`, the `additionalProperties: {}` strip, the `type`/`properties` defaults —
and already deep-clones its input so mutation is safe. A second pass would double the places a
future contributor must know about, to no benefit.

### A6 — Strip parameter descriptions wholesale (rejected)

`inputSchema` is 23.7 KB, 12.6 KB of it parameter descriptions across 139 params — by far the
largest single line item. Deleting them all would beat every other item on this list combined.

**Rejected:** parameter descriptions are *invocation*-relevant, which is the exact line D5 draws.
A model that cannot see what `contextLength` means will guess, and a wrong guess produces a wrong
call that costs more tokens than the description saved. This is the clearest case in the ADR of a
large, easy saving that is not worth taking.

### A7 — Paginate `tools/list` (rejected)

The MCP spec supports cursor pagination on `tools/list`.

**Rejected:** it does not reduce total tokens, it splits them across round trips, and most clients
page eagerly to completion — so the session-fixed cost is unchanged while the handshake gains
latency. The adaptive profile (D11) already solves the real problem by listing *fewer* tools, not
the same tools in instalments.

### A8 — Compress or minify the `_meta` payload rather than gating it (rejected)

Keep unconditional attach, shrink the payload.

**Rejected:** the payload is already compact JSON, and the cost is not formatting — it is sending a
15.5 KB second copy of a result to a client that cannot render it. Halving a payload nobody reads
still sends a payload nobody reads. Gating addresses the actual waste; compression addresses its
symptom.

---

## Consequences

### Positive

- The session-fixed cost for a **new** client drops from ~10.9k to ~3.7k tokens (D11), roughly 66%,
  using a profile mechanism that already exists and is already tested. No new machinery.
- Per-call `search_vault_simple` cost becomes **bounded** in a dimension that was previously
  unbounded (D1). A dense file can no longer dominate a response the caller scoped to a few files.
- On the modern era, a client that cannot render `ui://` views stops receiving a 15.5 KB second copy
  of every search result (D9).
- `normalizeInputSchema` gains two transforms at the seam that already owns schema shaping (D6), and
  removes a credible contributing factor to issue #508 (D7).
- Conventions repeated across ~49 tool descriptions are stated once (D10 + D5).
- `DEFAULT_POLICY`'s three conflated meanings are separated (D11). The codebase ends up more honest
  about a distinction it was previously relying on by coincidence.

### Negative

- **Two genuine breaking changes to exact response shape**, both accepted knowingly:
  `match.start`/`match.end` removal (D2) and Dataview `Link` flattening (D3). An external consumer
  reading those fields breaks *silently* — wrong field access yielding `undefined`, not a crash.
  No in-repo consumer does (grepped), but external clients are an assumption, not a fact. This is
  the largest accepted risk in the ADR.
- `tool_catalog` consumers requiring a literal `call_count: 0` break (D4). Judged acceptable;
  no known consumer.
- D5 is irreducibly manual and carries a real chance of removing an invocation-relevant sentence.
  The `no-test` marker is honest, not a loophole: no assertion can catch this, so review must.
- **D10 alone is a net token increase.** It only pays off combined with D5. Shipping the two apart
  would make the measurement in R-12 misleading.
- D9 requires threading a capability signal from transport to tool across a layer boundary the
  current design does not cross — the payload is attached inside the tool handler. This is the most
  invasive change in the ADR relative to its saving.
- Behaviour is now **asymmetric across eras** for the `_meta` payload (D9). Anyone debugging a
  missing payload must first establish which era served the request.
- Existing tokens keep `all` (D11 / A2). The largest available saving is deliberately forgone for
  installs that already work.

### Neutral

- No persisted schema change. `toolLoading.profiles`' on-disk shape is untouched; only the fallback
  for an **absent** entry changes, and only at two of five sites.
- No new dependency, feature, layer, or subsystem. Every change is a localized edit inside existing
  feature directories, following the existing `services/` pattern.
- `resolveToolScope.ts` is unchanged (D11) — it consumes a resolved policy and never a default.
- The R-09 spike leaves no scaffolding: it was resolved by reading installed packages, so there is
  no code to remove either way.
- ADR-0009 is untouched (D12). ADR-0018 §D5/D6 is amended only if D9 ships; if D9 is dropped as too
  invasive, ADR-0018 stands unchanged.
- The 16-vs-13 over-long-description count is recorded as unresolved (D5) and settled against the
  live registry at implementation time.

---

## References

- `SPEC.md` (repo root) — requirements R-01 … R-15
- ADR-0009 — structured tool output (`structuredContent` dual-emit); **deferred, not reopened** (D12)
- ADR-0014 — per-client tool profiles; `DEFAULT_POLICY` semantics and the legacy-mirror invariant (D11)
- ADR-0016 — two protocol eras on one endpoint; `initialize` vs `server/discover` reachability (D9, D10)
- ADR-0018 — MCP Apps `ui://` resource surface; §D5/D6 payload attach, amended conditionally (D9)
- ADR-0019, ADR-0022 — phased-opt-in posture for a changed default (D11)
- Issue #508 — `search_and_replace` `dry_run` intermittent validation rejection (D6, D7)
- Issue #63 — Letta Cloud strict-validator rejection of `additionalProperties: {}`; the precedent
  for D6's defensive normalization and for D7's hypothesis
- `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts` —
  `normalizeInputSchema`, `dedupeUnionDescriptions`
- `packages/obsidian-plugin/src/features/mcp-tools/services/responseBuilders.ts` — shared response shapes
- `packages/obsidian-plugin/src/features/adaptive-tool-loading/tokenPolicyStore.ts` — `DEFAULT_POLICY`
- `packages/obsidian-plugin/src/features/mcp-transport/services/tokenStore.ts` — `withPolicyFor`
- `node_modules/@modelcontextprotocol/sdk@1.30.0` — `instructions`, `getClientCapabilities` (read 2026-09-05)
- `node_modules/@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/core` —
  `CLIENT_CAPABILITIES_META_KEY`, `McpRequestContext` (read 2026-09-05)
- `arktype@2.0.0-rc.30` — single-member `anyOf` emission, measured 2026-09-05
