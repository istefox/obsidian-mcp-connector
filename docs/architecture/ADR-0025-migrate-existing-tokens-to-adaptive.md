# ADR-0025 — Migrating an existing MCP token to the `adaptive` profile

**Status:** Accepted — implementation deferred to a separate, later chain
**Date:** 2026-09-05
**Chain:** `migrate-existing-tokens-to-adaptive`
**SPEC:** `SPEC.md` (repo root), requirements R-01 … R-10
**Extends:** ADR-0023 §A2 (its rejection of migrating existing tokens is answered here, not overturned)
**Relates to:** ADR-0014 §7 and §10 (legacy mirror, settings seam), ADR-0016 (era asymmetry), ADR-0019 / ADR-0022 (phased opt-in — deliberately *not* followed)
**Produces no code:** this ADR and `docs/superpowers/plans/2026-09-05-migrate-existing-tokens-to-adaptive.md` are the whole output of this chain.

---

## Context

ADR-0023 D11 shipped R-11: a token id never seen in `toolLoading.profiles` resolves to
`NEW_TOKEN_POLICY` (`profile: "adaptive"`) instead of `DEFAULT_POLICY` (`profile: "all"`). Measured,
that moves a client's session-fixed `tools/list` cost from ~10.9k to ~3.7k tokens. It applies to new
tokens only.

ADR-0023 §A2 considered extending it to existing tokens and rejected it, with a reason worth quoting
because this ADR's whole job is to answer it: *"it silently changes behaviour for a working install
… A user whose workflow depends on a tool that `adaptive` leaves inactive would find it missing
after an update, with no message explaining why … 'recoverable if you know the mechanism exists' is
not a defence for changing something that worked."*

Every clause of that objection is about the change being **unrequested, unexplained and
history-blind**. None of it argues that `adaptive` is wrong for an existing client. So the objection
is answerable without overturning it: make the change requested (an explicit per-token toggle),
explained (a preview before, a Notice after, a `list_changed` push to the wire), and history-aware
(seed the token's `promoted` list from what that token has actually called). What remains after
that is a user deliberately narrowing their own client, which this project already lets them do
today with the profile radio buttons in settings.

### Verified facts this ADR rests on

Read from the working tree on 2026-09-05, at `feat/token-usage-optimization-for-mcp-tool-su`
(post the ADR-0023 fix round). Line numbers are from that state.

- `TokenPolicy` is `{profile, promoted, allowed}` (`tokenPolicyStore.ts:23-27`). `normalizePolicy`
  (`:123-133`) rebuilds a stored entry from **exactly those three keys** — any fourth key in a
  `profiles[id]` entry is dropped. `normalizeProfiles` runs it over every entry on every
  `mergeState`, i.e. on every read and every write of the slice, and `tokenStore.withPolicyFor`
  runs it again at `ensureTokenStore` time on every plugin load.
- `mergeState` (`:155-167`) spreads the raw slice first (`...s`), so **unknown top-level keys in the
  `toolLoading` slice survive a write**; unknown keys *inside* a policy entry do not.
- `updateToolLoading` (`:229-272`) is the single write path. Inside one recipe it (a) applies the
  mutation, (b) prunes `profiles` entries whose token is gone, (c) recomputes the legacy mirror as
  `next.profile / next.promoted = profiles[ctx.mirrorId] ?? defaultPolicy()`. `ctx.mirrorId` is
  `tokens[0]` by position, derived from `updateSlice`'s own in-mutex snapshot.
- The settings panel already writes `profile` for **whichever token is selected, mirror included**:
  `AdaptiveToolLoadingSettings.svelte` `onProfileChange` → `savePolicy({profile})` →
  `updateTokenPolicy` → `updateToolLoading` → mirror recompute. A user has been able to set the
  mirror token to `core` or `adaptive` from settings since ADR-0014 shipped, and the legacy globals
  have followed every time.
- `recordCall(toolName, plugin)` (`toolLoadingManager.ts:184`) knows nothing about tokens. Its only
  production call site (`mcpServer.ts:396-397`) sits **inside `buildMcpServer(tokenId)`**, so the
  token id is already in lexical scope there and needs no plumbing to reach.
- Counter persistence is a trailing debounce (`RECORD_FLUSH_DELAY_MS = 2000`) over a module-level
  `WeakMap` keyed by plugin (`:98-121`), drained by `flushPendingCalls`, which merges the batch and
  fans auto-promotion out to every `adaptive` entry inside **one** `updateToolLoading` call.
- `TokenRecord` already carries `createdAt: number` (`tokenStore.ts:43-51`), defaulted to `0` for a
  malformed record by `parseTokens` (`:96`).
- The only server-initiated push that exists is `modernHandler.notify.toolsChanged()`
  (`mcpServer.ts:246-248`, wired to `ToolLoadingManager.onToolsPromoted`). It publishes onto the
  2026-era `subscriptions/listen` streams. `activate_tool`'s `list_changed`
  (`activateTool.ts:127-131`) is a different thing: a notification carrying the caller's own
  `relatedRequestId`, flushed on that call's POST response stream. It requires an in-flight request
  from that client and has no standalone form.
- `ToolLoadingState` is produced only by `mergeState` and is never written as an object literal
  anywhere in `src/` (grepped) — widening it breaks no call site.

---

## Decision

Eleven decisions. D1–D4 build the history and the gate, D5–D8 are the mutation, D9–D11 are the
visibility and the surface.

### D1 — `everCalled` lives beside `profiles`, not inside `TokenPolicy` (R-01)

The `toolLoading` slice gains two top-level keys, owned by `tokenPolicyStore`:

```
toolLoading.everCalled: Record<tokenId, string[]>   // first-seen order, deduped
toolLoading.everCalledSince: number                  // epoch ms, see D3
```

`TokenPolicy` is unchanged. The SPEC's data model put `everCalled` inside `profiles[tokenId]`; that
placement is rejected for three independent reasons, any one of which is sufficient:

1. **It would be silently erased.** `normalizePolicy` rebuilds an entry from exactly
   `{profile, promoted, allowed}`, and it runs on every `mergeState` — so a fourth key would be
   dropped by the very next slice write. Keeping it would mean widening `normalizePolicy`,
   `withPolicyFor`'s seed branch and every spread of a policy object, i.e. teaching the whole policy
   pipeline about a field that is not policy.
2. **It would put a write on the hot path into the mirror's source of truth.** Writing usage for a
   token with no `profiles` entry would *create* that entry. For the mirror token that flips
   `toolLoading.profile` from the `defaultPolicy()` fallback (`all`) to whatever the created entry
   says — the precise silent narrowing ADR-0014 §7 exists to prevent, triggered by ordinary traffic
   rather than by a decision. A sibling map cannot do this: it never touches `profiles`, so it can
   never move the mirror.
3. **It costs the test suite nothing.** `tokenStore.test.ts` and `toolLoadingManager.test.ts` assert
   `toEqual({profile, promoted, allowed})` on policy entries at eight sites (`:77`, `:289`, `:391`,
   `:426`, `:444`, `:525`, `:777`, `:825`). Those assertions encode the policy contract, which this
   feature has no reason to change.

`updateToolLoading`'s orphan sweep is extended symmetrically: an `everCalled[id]` whose token is
gone is deleted in the same recipe that prunes `profiles[id]`. `toSlice` drops an empty `everCalled`
map exactly as it already drops an empty `profiles` map, so a vault that never records a call stays
byte-identical.

### D2 — Usage is recorded on the existing call path, in the existing write, and never replaces the counters (R-01)

`recordCall` gains an optional third parameter: `recordCall(toolName, plugin, tokenId?)`. Optional,
so the ~14 existing test call sites and the settings UI's own `ToolLoadingManager` instance keep
compiling and keep recording nothing — only the transport knows who is calling. The production call
site already has `tokenId` in scope.

The pending batch gains a second map, `everCalled: Map<tokenId, Set<toolName>>`, alongside
`counts`. `flushPendingCalls` merges both inside the **same** `updateToolLoading` recipe: one
settings write per flush, as today. Three details are load-bearing:

- the early return becomes `if (counts.size === 0 && everCalled.size === 0) return;`
- the failure path restores **both** maps into `pending`, or a transient write failure drops history
  the migration later reads as "never called";
- `everCalled` is a set, so it converges: after a token's first call to a given tool, every later
  call is NO_CHANGE and writes nothing. Steady-state write volume is unchanged.

Recording rides the same gate the counters ride (`mcpServer.ts:392-395`): meta-tools and
adaptive-inactive calls are excluded. That is correct rather than incidental — a refused call did
not execute (ADR-0011), and meta-tools are always active so they never need seeding.

The global `counters` keep their shape, their meaning and their promotion role untouched. `everCalled`
answers a different question ("has *this client* ever used this tool", boolean, no threshold) and
must not be conflated with the vault-wide frequency signal (ADR-0014, "counters stay global").

### D3 — One vault-wide anchor, plus each token's existing `createdAt`; no per-token timestamp (R-02)

`everCalledSince` is written once, idempotently, at plugin load — from
`mcp-transport/services/setup.ts`, immediately after `ensureTokenStore`, which is already the place
that brings both slices to their current shape before the listener binds. Present ⇒ NO_CHANGE.

A token's effective observation start is **derived**, not stored:

```
anchor(token) = max(everCalledSince, token.createdAt)
```

`createdAt` already exists on every `TokenRecord`, so a per-token timestamp field would be a second
copy of a fact the data model holds — one more thing to seed, migrate and keep in sync. The `max`
matters: a token minted three days ago has three days of history, not however long the plugin has
been installed, and it must not inherit the vault's older anchor. A malformed record's `createdAt: 0`
degrades to the vault anchor, which is the correct fallback.

The eligibility service reads `mcpTransport.tokens[].createdAt` **structurally** through
`SettingsStore.readSlice`, not by importing `tokenStore` — the same one-directional convention
`tokenPolicyStore.tokenIdsIn` already follows for token ids, keeping `adaptive-tool-loading` free of
an import back into `mcp-transport`.

### D4 — The observation period is 14 days, and it is a heuristic, not a guarantee (R-02)

`MIGRATION_OBSERVATION_DAYS = 14` in `adaptive-tool-loading/constants.ts`, evaluated as
`now - anchor(token) >= 14 days`. Confirmed rather than adjusted, for a stated reason and with a
stated limit.

Two weeks covers two full weekly cycles, which is the dominant rhythm of the workflows this plugin
sits in: a weekday-only client and a weekend-only client both get one uninterrupted period plus a
repeat. One week would give neither a repeat, and a single unusual week would define the token's
whole history.

What 14 days does **not** buy: a tool used on a monthly cadence is invisible at 14 days and would
still be invisible at 30. No window fixes that, so the window is not where the safety lives. The
safety is the preview (D8), the reversibility (D7) and `activate_tool` as an in-band recovery. The
window's actual job is narrower — to stop a user from migrating a token on the same day the feature
lands, when `everCalled` is empty for a reason that has nothing to do with how they work.

Elapsed time is wall-clock, not active-usage time. A vault left unopened for a month becomes
eligible with an empty history, and the preview then honestly says every non-core tool would be
deactivated. That is the SPEC's own edge case, and the honest answer is better than a second hidden
gate (see A6).

### D5 — The migration mutation (R-03)

Two functions in `adaptive-tool-loading/services/`, both routed through `updateToolLoading`:

```
migrateTokenToAdaptive(plugin, tokenId) -> { deactivated: string[]; promotedAfter: string[] }
revertTokenToAll(plugin, tokenId)       -> void
```

`migrateTokenToAdaptive` sets, in one recipe:

- `profiles[id].profile = "adaptive"`
- `profiles[id].promoted = union(existing promoted, everCalled[id])`, preserving first-seen order
- `profiles[id].allowed` — **untouched.** The allowlist is a ceiling set by the vault owner
  (ADR-0014 §4); a profile change is not a mandate to move it.

An entry that does not exist yet is created from the policy that token currently *resolves* to
(`newTokenPolicy()`), not from `defaultPolicy()`, so materialising the entry cannot change the
token's own surface out from under the migration.

### D6 — Migrating the mirror token needs no special case, and is not an exception to ADR-0014 §7 (R-04, R-09)

R-04 requires that migrating the current mirror token also updates `toolLoading.profile` and
`toolLoading.promoted`. **It already does.** `updateToolLoading` recomputes the mirror from
`profiles[ctx.mirrorId]` at the end of every recipe, so a migration that writes `profiles[mirrorId]`
is mirrored by the same code that mirrors a profile radio click. The correct implementation is to
add nothing: no branch, no `isMirror` check, no second write. What the plan owes R-04 is a **test
pinning the behaviour**, not code producing it.

The SPEC frames this as a deliberate, scoped exception to ADR-0014's mirror-preservation guarantee.
That framing overstates it, and the accurate reading matters because an "exception" invites future
code to defend the invariant here — code that would break R-04 while looking like a fix.

ADR-0014 §7's guarantee is: *"A user who downgrades to an older plugin build then still reads a
working token and their real profile instead of silently reverting."* The operative words are
**their real profile**. The mirror's contract is to reflect the mirror token's actual policy. After
an explicit migration, the token's actual policy *is* `adaptive`, and a mirror still claiming `all`
would be the violation — a downgraded build would then serve a surface the user did not choose in
either direction.

What ADR-0014 §7 and ADR-0023 D11 actually protect against is a **fallback** writing `adaptive` into
the globals for a token whose entry is momentarily missing: nobody asked, nothing recorded the
intent, and the narrowing appears only on a downgrade. That is why
`updateToolLoading`'s `?? defaultPolicy()` and `withPolicyFor`'s seed branch must keep degrading to
`all`, and this ADR changes neither.

The distinction, stated once:

| | Unrequested narrowing (forbidden) | Explicit migration (this ADR) |
| --- | --- | --- |
| Origin | a `??` fallback on a missing entry | a toggle the user flipped |
| Recorded intent | none | `profiles[id].profile = "adaptive"`, persisted |
| Visible before | nothing | preview of exactly which tools go |
| Visible after | nothing | Notice + `list_changed` (D9, D10) |
| Reversible | only by re-editing settings, if you work out what happened | one toggle, D7 |

The existing profile radio buttons already produce the second column for the mirror token and have
since ADR-0014. This toggle is one more control of that class, not a new category of write.

### D7 — Reverting restores `all`, and discards nothing (R-05)

`revertTokenToAll` sets `profiles[id].profile = "all"` and stops. The mirror follows by the same
recompute as D6.

- `everCalled` is **structurally** safe: it lives outside `profiles` (D1), so no policy write can
  reach it. Reversibility here is a property of the data layout, not of remembering to preserve it.
- `promoted` is left as seeded, deliberately, and is inert under `profile: "all"` —
  `getActiveToolNames` returns every tool for `all` and never reads `promoted`. Unwinding it would
  require persisting a pre-migration snapshot to restore, which is new state for a rare path, and
  would be wrong anyway if the user edited the promoted list after migrating. The one visible
  residue is a token later switched to `core` by hand, which keeps the seeded entries; that is a
  wider surface than before, never a narrower one.

### D8 — Preview and effect are the same function (R-08, R-03)

One pure function, in the feature's services, used by both the settings preview and the migration
itself:

```
planMigration(allNames, policy, everCalled) -> { promotedAfter: string[]; deactivated: string[] }
```

`deactivated` is computed by running the existing `resolveToolScope` twice — once with the current
policy, once with `{profile: "adaptive", promoted: promotedAfter}` — and taking the set difference.
No reimplementation of profile expansion: `getActiveToolNames` stays the one place that knows what a
profile contains.

A preview computed by a second, parallel implementation is a preview that drifts from the effect, and
this codebase has already paid for that once — ADR-0014 §9 exported `isActiveFor` because
`tool_catalog` had grown a divergent copy of "is this tool active" and advertised tools the next call
refused. Same failure mode, prevented the same way.

`allNames` for the preview is the registry's **served** names (`listAll()` filtered on `enabled`), so
a user-disabled tool is not listed as something the migration will deactivate — it is already off,
by a switch that outranks the profile (ADR-0010).

### D9 — The Notice is raised by the UI layer; the service stays Obsidian-free (R-06)

`migrateTokenToAdaptive` returns the outcome and imports nothing from `obsidian`. The settings
component raises the `Notice` on success, with an explicit long duration so the recovery hint can be
read. This is the boundary `tokenStore.ts`'s own header states ("plain functions over
`PluginDataLike`, so the migration is testable against a fixture `data.json` with no Obsidian `App`
in sight") and the pattern every other settings component in this plugin already follows.

The Notice fires at the moment of migration, not at next launch, and names three things: the token's
label, the count of tools deactivated, and `activate_tool` as the way back. Exact wording is left to
implementation; those three elements are not.

A failed write raises the panel's existing error-Notice path instead, and nothing is announced —
`migrateTokenToAdaptive` resolves only after the write lands.

### D10 — `list_changed` is a modern-era broadcast; the legacy era gets nothing, structurally (R-07)

R-07 asks for a `list_changed` push "reusing the existing mechanism `activate_tool` already drives".
Taken literally that is not implementable, and the reason is structural rather than an omission:
`activate_tool`'s notification rides **the caller's own in-flight POST response stream** with that
call's `relatedRequestId`. A migration initiated from the settings tab has no caller and no in-flight
request. The legacy transport is stateless and POST-only, `GET /mcp` returns 405 by design
(ADR-0016), so there is no channel to push onto at all.

Decision, split by era, in the same shape ADR-0017 and ADR-0023 D9 already use:

- **Modern era (2026-07-28):** reuse `modernHandler.notify.toolsChanged()`, the fan-out already
  wired for issue #419's auto-promotion. `McpService` gains `notifyToolsChanged: () => void`,
  exactly mirroring the existing `notifyPromptsChanged`, and the settings component calls it through
  `plugin.mcpTransportState?.mcp` — the same access path the panel already uses to read
  `mcp.registry`. One line of new transport code.
- **Legacy era (2025-era):** nothing is delivered, and nothing can be. The Notice (D9) is the
  mitigation, and a legacy client re-lists on its next connection.

Two honest costs, both accepted:

- The fan-out is a **broadcast**. The SDK's bus cannot target one subscriber (documented at
  `toolLoadingManager.ts:130-136`), so every connected modern client re-lists. `tools/list` is
  resolved per token, so an unaffected client gets a byte-identical answer; the cost is one wasted
  round trip each, already accepted for #419.
- "Has an active connection" is not observable from the settings tab. The call is unconditional and
  is a no-op when nothing is listening.

### D11 — The toggle lives in the policy panel and is derived from `profile`; no new persisted flag (R-08)

Placement: `AdaptiveToolLoadingSettings.svelte` (the policy panel, scoped to the selected token),
not the token row in `AccessControlSection.svelte`. ADR-0014 §10 put policy editing in the panel and
left the row showing profile as read-only text precisely so a single writer owns each field; a
migrate toggle in the row would be a second control writing `profile` from a second component. The
SPEC's "token list" phrasing describes where the user perceives the feature, and the panel is already
mounted against the row they selected.

State: the toggle **is** `profile === "adaptive"`. No `migrated: boolean` is persisted. A second flag
would have to agree with `profile` forever, across the radios, `updateTokenPolicy`, the mirror
recompute and a hand-edited `data.json` — this codebase's most expensive recurring bug class is
exactly a second field that must agree with a first one. A user who sets the radio to `adaptive` by
hand gets today's unseeded behaviour and a toggle that reads "on", which is accurate: their profile
is adaptive.

The panel renders three states per selected token:

1. **Under observation** — toggle disabled, "Ready in N days", N from D3/D4.
2. **Eligible, off** — toggle enabled; flipping it opens a confirmation listing the exact
   `deactivated` names from D8 before anything is written.
3. **On** — toggle enabled; flipping it off runs D7 immediately (a widening needs no confirmation).

---

## Alternatives considered

### A1 — Put `everCalled` inside `profiles[tokenId]`, as the SPEC's data model states (rejected)

One per-token map instead of two, and migration reads policy and history from one object.

**Rejected** on three counts, developed in D1. `normalizePolicy` rebuilds an entry from exactly three
keys and runs on every read and every write, so the field would be erased almost immediately unless
the whole policy pipeline is taught about it. Creating an entry to hold usage would move the legacy
mirror for the mirror token — turning ordinary traffic into the silent narrowing ADR-0014 §7
forbids. And eight `toEqual` assertions across `tokenStore.test.ts` and `toolLoadingManager.test.ts`
pin the three-key policy shape, which this feature has no reason to change. The SPEC explicitly
deferred the persisted shape to this ADR.

### A2 — Store a per-token `everCalledSince` timestamp (rejected)

The SPEC offers this as the alternative to a vault-wide anchor.

**Rejected:** `TokenRecord.createdAt` already records when a token started existing, and
`max(vaultAnchor, createdAt)` derives the same answer with nothing new to seed, migrate, prune or
keep in sync. A stored per-token timestamp would need a seeding rule for tokens that predate the
feature (which is exactly the vault anchor), reproducing the vault-wide field inside every entry.

### A3 — Flip the default for existing tokens later, with a stated trigger (ADR-0019 / ADR-0022's posture) (rejected)

This project's precedent for a changed default is opt-in now, flip later:
`requireWritePreconditions` defaults off and flips in the next major (ADR-0019 §3), and ADR-0022
follows it. Applying it here would eventually deliver the full saving to every install.

**Rejected**, and this is the ADR's most deliberate divergence from precedent. Those two ADRs flip a
*guard* — the failure mode of the flip is a refused write with an explicit, instructive error that
names its own recovery. This flip's failure mode is a tool that is silently absent from
`tools/list`, with no error, no wire signal, and a recovery the user must already know exists. That
is the whole of ADR-0023 §A2's objection, and it does not weaken with time or with a trigger written
down in advance. There is also nothing to evaluate the trigger against: this plugin collects no
telemetry, so "adoption looks fine" would be an assumption, not a measurement. The opt-in is
permanent, and the saving for an existing token stays on the table unless someone asks for it.

### A4 — Seed `promoted` from the global counters instead of a new per-token field (rejected)

`toolLoading.counters` already records which tools this vault uses, and needs no new data model.

**Rejected:** the counters are vault-wide by design (ADR-0014: "how often a tool is used is a
property of the vault, not of the client"). Seeding from them would keep tool X active for a client
that has never called it merely because another client did — which defeats the point of migrating,
since the narrowing is exactly what the saving is made of. It also cannot see a tool called once or
twice: a counter below `PROMOTION_THRESHOLD` is indistinguishable from zero for this purpose. R-01's
new field exists because the question is per client and the threshold is one.

### A5 — Snapshot the pre-migration policy so revert restores it exactly (rejected)

Turning the toggle off would restore `promoted` to its pre-migration content, not just `profile`.

**Rejected:** it persists a snapshot to serve a rare path, and it is wrong in the case it looks most
useful — a user who promoted a tool *after* migrating would lose it on revert. The seeded entries are
inert under `profile: "all"` (`getActiveToolNames` ignores `promoted` there), so the residue is
invisible unless the user later selects `core` by hand, where it can only widen the surface. Leaving
`promoted` alone is both less state and the safer direction.

### A6 — Gate eligibility on recorded activity (N calls, or a non-empty `everCalled`) instead of, or on top of, elapsed time (rejected)

It would prevent the "eligible with empty history" case that D4 accepts.

**Rejected:** it makes the toggle's availability depend on traffic, so a light user's toggle never
appears and no message explains why — a hidden second gate, which is the same class of unexplained
behaviour this whole ADR exists to remove. And it is unnecessary: with an empty `everCalled` the
preview says every non-core tool will be deactivated, in the confirmation dialog, before anything is
written. The SPEC's own edge case reaches the same conclusion — the mechanism already produces the
honest answer, so it needs no special-casing.

### A7 — Keep a per-token connection registry so `list_changed` can be pushed to the migrated client alone (rejected)

It would satisfy R-07 literally, on both eras, and avoid waking unrelated clients.

**Rejected:** the legacy transport is stateless and POST-only on purpose (ADR-0016, and CLAUDE.md's
first architecture bullet). A registry of live client connections is precisely the session state that
design refuses to keep, and adding it for a settings-tab notification would put a permanent
architectural cost against an occasional convenience. The modern era already has the mechanism, the
legacy era already has the Notice, and era-asymmetric behaviour with a written reason is this
project's established answer (ADR-0017, ADR-0023 D9).

### A8 — Put the toggle in the token row in Access Control (rejected)

The SPEC describes the feature as living in the token list, and the row is where a user looks for
per-token controls.

**Rejected:** the row and the panel would both write `profile`, from two components, in two
features. ADR-0014 §10 made the row's profile read-only text for exactly that reason. The panel is
already scoped to the selected row, so the perceived location is unchanged; only the writer stays
single.

### A9 — Migrate every existing token in one action ("migrate all") (rejected)

One click instead of one per token, for a user with several configured clients.

**Rejected:** it re-creates the blast radius the per-token opt-in exists to bound. Each token is a
different client with a different workload and a different `everCalled` set, and a single
confirmation cannot honestly preview N different deactivation lists. Nothing prevents a user from
flipping three toggles; nothing recovers a user who flipped one that meant three.

---

## Consequences

### Positive

- The largest remaining saving in the ADR-0023 effort (~10.9k → ~3.7k session-fixed tokens, ~66%)
  becomes reachable for existing installs, without any install changing behaviour unasked.
- The seeding rule means a migrated token loses only tools it has **never** called in the observation
  window. For a typical client that is most of the registry and none of its workflow.
- R-04 costs no code: the mirror follows because `updateToolLoading` already mirrors every policy
  write. One test pins it.
- Reversibility is structural, not procedural — `everCalled` lives outside `profiles`, so no policy
  write can destroy it (D1, D7).
- Preview and effect cannot drift: one function serves both (D8), the fix ADR-0014 §9 already applied
  to `isActiveFor`.
- The per-token usage history is reusable beyond this feature (it is the first per-client usage
  signal the plugin has) without touching the vault-wide counters that answer a different question.

### Negative

- **Two new persisted keys in a slice shared with every feature.** `everCalled` grows with the number
  of distinct tools each token has called — bounded by the registry size (~52 names) per token, so
  tens of kilobytes at the worst configured maximum of 10 tokens, but it is real growth in
  `data.json` that only the orphan sweep ever shrinks.
- **The legacy era gets no `list_changed`, ever** (D10). A connected 2025-era client keeps serving a
  stale `tools/list` for the rest of its session after a migration. The Notice is the only signal,
  and it is in Obsidian, not on the wire.
- **The modern-era push is a broadcast** (D10): every connected client re-lists, not just the
  migrated one.
- **A 14-day window does not see a monthly-cadence tool** (D4). Such a tool will be deactivated by a
  migration and recovered only through `activate_tool` or the promoted-list UI. This is the residual
  form of ADR-0023 §A2's objection, and it is bounded by the preview rather than eliminated.
- **Wall-clock eligibility can be reached with an empty history** (D4) — an unopened vault becomes
  eligible on schedule. The preview tells the truth ("all N tools would be deactivated"), which
  relies on the user reading it.
- **The toggle and the profile radios both set `adaptive`,** by different routes and with different
  seeding. Two controls whose end states can coincide is a documented compromise (D11), not an
  elegant one.
- The largest saving is still unclaimed for any user who never opens the settings tab. That is the
  deliberate price of A3.

### Neutral

- No wire-protocol change. No new MCP tool, no new endpoint, no capability change. The only
  wire-visible effect is an existing notification, unchanged.
- `TokenPolicy`, `normalizePolicy`, `resolveToolScope`, `getActiveToolNames`, `DEFAULT_POLICY` and
  `NEW_TOKEN_POLICY` are all untouched. ADR-0023 D11's two-constant split stands exactly as shipped.
- `recordCall`'s new parameter is optional, so every existing call site — production, tests and the
  settings UI's own manager — compiles and behaves identically.
- `ToolLoadingState` is widened, which is free: it is produced only by `mergeState` and never written
  as a literal anywhere in `src/`.
- `updateToolLoading` remains the single write path into the slice, and one flush remains one write.
- The `.mcpb` shim's `data.json` read contract is unaffected: it reads named fields from
  `mcpTransport`, and both new keys are in `toolLoading`.
- ADR-0023 §A2 is not overturned. Its objection stands as written against an *unrequested* migration;
  this ADR only removes the conditions that made it apply.

---

## References

- `SPEC.md` (repo root) — requirements R-01 … R-10
- ADR-0014 — per-client tool profiles; §4 the allowlist ceiling, §7 the legacy mirror and its two
  writers, §9 `isActiveFor` and the drifted-copy failure, §10 the settings seam
- ADR-0016 — two protocol eras on one endpoint; the stateless POST-only legacy transport
- ADR-0017 — era-asymmetric `list_changed`, the precedent D10 follows
- ADR-0019 §3, ADR-0022 — opt-in-now/flip-later posture, deliberately not followed (A3)
- ADR-0023 §D11 and §A2 — new tokens default to `adaptive`; the rejection this ADR answers
- ADR-0010 — `userDisabled` as the outermost off switch (D8's preview filter)
- ADR-0011 — the recoverable inactive-tool error, `activate_tool` as the recovery path (D9)
- `packages/obsidian-plugin/src/features/adaptive-tool-loading/tokenPolicyStore.ts` —
  `normalizePolicy`, `mergeState`, `toSlice`, `updateToolLoading`, the mirror recompute
- `packages/obsidian-plugin/src/features/adaptive-tool-loading/toolLoadingManager.ts` —
  `recordCall`, `flushPendingCalls`, `getActiveToolNames`, `onToolsPromoted`
- `packages/obsidian-plugin/src/features/adaptive-tool-loading/resolveToolScope.ts` — scope
  resolution reused by the preview
- `packages/obsidian-plugin/src/features/mcp-transport/services/tokenStore.ts` — `TokenRecord.createdAt`,
  `withPolicyFor`, `ensureTokenStore`
- `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.ts` — `buildMcpServer`,
  the `recordCall` site, `notifyPromptsChanged`, `modernHandler.notify.toolsChanged`
- `packages/obsidian-plugin/src/features/adaptive-tool-loading/components/AdaptiveToolLoadingSettings.svelte`
  — the existing profile writer the toggle joins
- Issue #419 — the auto-promotion fan-out D10 reuses
