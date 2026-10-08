# ADR-0015: The `tools/list` stability invariant and adaptive tool loading

**Status:** Accepted
**Date:** 2026-08-03
**Deciders:** Stefano Ferri

---

## Context

MCP revision `2026-07-28` states a stability requirement on the advertised tool set
(`server/tools`, Capabilities):

> Servers that declare the `tools` capability **MUST** respond to `tools/list` requests
> with the set of tools currently available to the requesting client. This set **MAY** be
> empty and **MAY** change over time (see List Changed Notification), but **MUST NOT** vary
> per-connection or as a side effect of other requests on the connection. The set **MAY**
> vary by the authorization presented on the request — for example, returning only the
> tools the caller's granted scopes permit — since credentials are per-request input, not
> connection state.

`server/resources` states the identical rule for `resources/list`.

The second half is the one ADR-0014 was built on and needs no defence. The first half
raises a real question about adaptive tool loading, because our advertised set genuinely
does change over time and in response to other calls:

- a tool crosses the promotion threshold once the vault-wide call counters reach it, which
  happens because of earlier `tools/call` requests;
- `activate_tool` and `activate_tools` widen the set outright;
- `activate_tool` with `persist: false` widens it for the process lifetime without writing
  anything to disk.

The previous protocol revision had no such clause, so nothing forced the question before.
#407 recorded it as "our registry state is process-global rather than connection-scoped,
so it most likely is [satisfied]". That is an assumption standing in for a decision, on a
clause whose whole purpose is to forbid a shape that resembles ours from a distance.

## Decision

### 1. The invariant is satisfied, because no input to the tool set is derived from the connection

`resolveToolScope(tokenId, policy, allNames, session)` is a pure function
(`features/adaptive-tool-loading/resolveToolScope.ts`). Its four inputs are:

| Input | Keyed to | Survives the connection? |
| --- | --- | --- |
| `tokenId` | the bearer presented on **this** request | n/a — it is per-request input |
| `policy` (`profile`, `promoted`, `allowed`) | the token id, in `data.json` | yes |
| `allNames` | the vault's registered tools | yes |
| `session` (`persist: false` promotions) | the token id, in `SessionPromotions` | yes, for the process lifetime |

Nothing reads a socket, a session id, or any per-connection accumulator — the transport
has none to read, being stateless and POST-only. `SessionPromotions` is the one piece of
in-memory mutable state and it is a `Map` keyed by **token id**
(`features/adaptive-tool-loading/sessionPromotions.ts`), which is exactly the shape the
clause permits: it is a property of the credential, not of the connection carrying it.

The operational test is: **two different connections presenting the same token at the same
instant get the same answer, and closing a connection changes nothing.** Both hold.

### 2. Changing over time is explicitly permitted, and is the mechanism we are actually on the hook for

The clause forbids *varying per connection*, not *changing*. The same sentence says the set
**MAY** change over time and points at the List Changed Notification as the way that change
is made legitimate. Counter-driven promotion is therefore not a violation of the stability
rule; it is a use of the escape hatch, and the obligation it creates is a notification
obligation.

### 3. That notification obligation is where the real gap is, and it is not the clause we started from

Counters are vault-wide by deliberate decision (ADR-0014: *"how often a tool is used
describes the vault rather than the client"*), so every adaptive token crosses a promotion
threshold together. Client A's calls therefore change client B's `tools/list`.

On the current 2025-era wire, `notifications/tools/list_changed` rides the **caller's own
POST response stream** with that call's `relatedRequestId`. There is no fan-out and no
broadcast path — by design, because a POST-only transport has nowhere else to put it. So
when A's activity promotes a tool, **B is never told**, and B keeps serving a stale list
until it re-lists for some unrelated reason.

This is a gap in the `listChanged` contract, not in the per-connection clause. It is
pre-existing, it is not a security issue — B's stale list is a subset or superset of its
own entitlement, never another token's — and it is invisible today because
`notifications/tools/list_changed` is advisory. It is recorded here because the analysis
that clears us on the first question is what surfaces it, and because it has a known fix.

### 4. `subscriptions/listen` closes it, so adopting `2026-07-28` improves compliance rather than threatening it

Under the new revision a client opts into `toolsListChanged` on a long-lived
`subscriptions/listen` stream of its own. That stream is per-client and outlives the
request that opened it, so a promotion triggered by A reaches every subscribed client
including B. The mechanism the new revision mandates is the one that fixes our existing
gap. Phase 2 of #407 should treat this as a reason to adopt, not merely as migration cost.

### 5. Forward constraints

These are the shapes that *would* break the invariant. None exists today; all three are
easy to introduce by accident.

- **Never key tool-surface state to anything the connection supplies.** Not a session id,
  not a socket, not `clientInfo`, not a header other than `Authorization`. `clientInfo` is
  specifically called out by the spec as self-reported and not to be relied on for
  behaviour. The token id is the only admissible key — the recurring ADR-0014 §3 lesson,
  restated for a second surface.
- **Never let `tools/list` mutate anything that feeds `tools/list`.** Listing must stay a
  read. A "seen it, so promote it" heuristic on the list path would make the set a function
  of listing history, which is the side-effect half of the clause.
- **`cacheScope` must stay `private` on every response whose content depends on the
  bearer.** This is the same invariant enforced downstream: a `public` list may be served
  from a shared cache to a different token, which is per-caller variation reintroduced by
  an intermediary. Already recorded in ADR-0014 §3; repeated here because it is the
  enforcement arm of this decision and the two are read separately.

## Consequences

**Positive.** The question #407 left open is closed with a reason rather than a guess, and
the reason is checkable: it reduces to "every input to `resolveToolScope` is keyed to the
token or the vault", which a reviewer can verify against one file. Adopting `2026-07-28`
gains a concrete correctness argument beyond conformance.

**Negative.** Cross-client staleness is now a known, recorded defect rather than an unknown
one, and it stays unfixed until `subscriptions/listen` lands. Nothing in CI can detect a
future violation of the forward constraints; they are review discipline, like the ADR-0014
§3 shape they extend.

**Neutral.** No code changes. This ADR records a reading of a specification the connector
does not yet serve; if the `2026-07-28` text is amended before we adopt it, the reading has
to be re-checked rather than assumed to have survived.

## Alternatives considered

**Make counters per-token so one client's usage cannot move another's list.** This would
remove the cross-client staleness at the source. Rejected: it contradicts ADR-0014's
deliberate decision that call frequency describes the vault, and it would make a
freshly-added token start from zero and stay on the Core set indefinitely — the opposite of
what an adaptive profile is for. The staleness is better fixed by delivering the
notification than by removing the shared signal.

**Treat the clause as forbidding change and drop counter-driven promotion.** Rejected on
the text: the same sentence permits change over time explicitly. This would give up the
feature to satisfy a requirement that does not exist.

**Leave it as a comment on #407.** Rejected because that is what it already was. A reading
of a normative clause that licenses a whole feature is a decision, and decisions in this
repo live in `docs/architecture/`.

## Addendum 2026-10-08: what a mid-session list change costs a client's prompt cache

A forum user pointed out that Anthropic's prompt cache orders its prefix as tools, system
prompt, messages, so a client that re-sends a changed tool list rewrites the whole cached
prefix. That is a cost of the notification obligation in section 3, not a change to the
invariant, so it is recorded here.

**Measurement.** Headless Claude Code 2.1.294 on Haiku, against a mock server that answers
`activate_tool` with an SSE response carrying `notifications/tools/list_changed` and then
serves one more tool. Per-turn usage came from `--output-format stream-json`.

- Tool search on, the Claude Code default: the client re-listed (the mock saw a second
  `tools/list`) and the cache stayed intact, 100 to 300 tokens created per turn.
- Tool search off, so MCP schemas sit in the prefix: the turn after the refresh created
  42,779 tokens and read none. The unchanged control created about 71 and read about 42K.
  Adding the tool at the end of the list did not help, since the system prompt and the
  messages follow the tools block.

**Limits.** One run per variant, headless rather than interactive, a mock rather than the
plugin, and no other client measured. A whole-run cost ratio is not valid, because the
no-search run also paid one cold first turn.

**Decision.** No code change. Profile All never changes the list. Automatic promotion
sends no notification on the 2025 wire, and the 2026 fan-out in section 4 reaches only
clients that opted into `subscriptions/listen`. Only `activate_tool` and `activate_tools`
notify, and only when the model calls them. Dropping that notification would leave a
client that re-lists with no way to see the tool it just activated, which defeats
`activate_tool`. `activate_tools` already batches several tools into one refresh.

**Documented instead.** The README's Adaptive tool loading section carries the numbers and
the advice for long sessions on a client that keeps schemas in the prefix: use All, or
promote with `persist: true` and start a new conversation. If a client with schemas in the
prefix turns out to be common, revisit with a per-token option to skip the notification
rather than removing it.
