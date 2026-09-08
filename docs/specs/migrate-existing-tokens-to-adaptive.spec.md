# SPEC — Migrate existing MCP tool tokens to adaptive profile

**Topic slug:** migrate-existing-tokens-to-adaptive

## Objectives

ADR-0023 (token usage optimization) shipped R-11: a token id never seen in
`toolLoading.profiles` now resolves to profile `adaptive` instead of `all`, but only for
tokens created after that change. Every token that existed before it keeps `all` forever —
ADR-0023's own Alternative A2 measured this as the single largest remaining session-token
saving in the whole optimization effort (~10.9k → ~3.7k tokens per client) and rejected
migrating existing tokens for now, on the grounds that it would silently narrow a working
installation's tool surface with no error and no obvious recovery path.

This SPEC defines a mechanism that removes that objection: an explicit, reversible, per-token
opt-in that a user drives from settings, with enough visibility and history-aware seeding that
narrowing a token never surprises whoever configured it. It does not mandate ever flipping a
default — the saving is unlocked only by a user who deliberately asks for it.

## Scope

**In scope for this SPEC and its ADR:**
- The opt-in mechanism itself: a per-token settings toggle, its preconditions, and what it does
  to a token's `toolLoading.profiles[id]` entry when flipped.
- A new per-token usage-history data point (`everCalled`) needed to seed a migrated token's
  `promoted` list from what that specific token has actually called, not a vault-wide proxy.
- The mirror-token special case (ADR-0014's legacy-global mirror) and why an explicit opt-in on
  that specific token is exempt from ADR-0014's "never silently narrow a downgraded plugin's
  reader" guarantee.
- The silent-failure mitigations: an Obsidian Notice, a `notifications/tools/list_changed` push,
  and a minimum observation period before the toggle becomes available at all.
- The settings UI shape: per-token toggle, countdown state, and a preview of what would be
  deactivated.
- A roadmap-level implementation plan for a **future**, separate chain.

**Out of scope (deferred to the future implementation chain, not decided here beyond what the
ADR needs to size the plan):**
- Exact copy/wording of the Notice and settings strings.
- The precise persisted shape of `everCalled` beyond "a per-token set of tool names", and its
  interaction with `toolLoading`'s existing multi-slice write mutex.
- Any code change. This chain produces `SPEC.md`, the ADR, and a plan document; it stops before
  Step 5 (implementation).

## Stack

No new stack elements. Everything here extends the existing `packages/obsidian-plugin` feature
set: `features/adaptive-tool-loading/` (policy storage, promotion), `features/mcp-transport/`
(token store, HTTP transport), and the Svelte settings UI under the plugin's settings feature.

## Architecture

### Current state (context, not a decision made here)

- `tokenPolicyStore.ts`: `DEFAULT_POLICY` (`profile: "all"`) vs `NEW_TOKEN_POLICY`
  (`profile: "adaptive"`, ADR-0023 R-11). `readPolicy` resolves a missing
  `profiles[id]` entry to `NEW_TOKEN_POLICY` for a live token; `updateToolLoading`'s legacy
  mirror recompute still resolves to `DEFAULT_POLICY` for the mirror token
  (`tokens[0]`, per `MirrorContext.mirrorId`), preserving ADR-0014's "a downgraded pre-1.0
  build must never see a silently narrowed profile" guarantee.
- `toolLoadingManager.ts`: `promotedFor`/`setPromoted` (both mirror- and non-mirror-agnostic
  since the ADR-0023 fix round closed on 2026-09-05), `flushPendingCalls`'s auto-promotion
  loop, driven by **global**, not per-token, call counters (`toolLoading.counters`) — "how
  often a tool is used is a property of the vault, not of the client" (ADR-0014).
- `tokenStore.ts`: `withPolicyFor` (seeds a policy only at `ensureTokenStore` time), `addToken`
  (mints a secondary token, never seeds a `profiles` entry), `revokeToken` (recomputes
  `ctx.mirrorId` by position, never reseeds).

### New state (this SPEC's requirements)

1. **Per-token usage tracking (`everCalled`).** A new field on each token's policy entry,
   `profiles[id].everCalled: string[]` (or equivalent set-shaped structure), populated
   alongside the existing global counters every time a call is recorded for that token — never
   replacing the global counters, which remain the vault-wide promotion signal they are today.
   Starts empty for every token as of the release that ships this field; there is no backfill
   from history that predates it.

2. **Migration eligibility gate — observation period.** A token becomes eligible for the
   opt-in toggle only after a minimum period (default 14 days, exact value an ADR decision, not
   fixed by this SPEC) has elapsed since the token's `everCalled` tracking started (i.e. since
   the release that ships this feature reached that installation) — not since the toggle itself
   was touched. Toggling on, off, and on again on the same token never resets this clock.

3. **The opt-in toggle.** Per token, in settings: an explicit, user-driven, fully reversible
   switch. Flipping it on:
   - Sets `profiles[id].profile = "adaptive"`.
   - Seeds `profiles[id].promoted` from the union of the token's existing `promoted` list (if
     any) and every tool name present in `profiles[id].everCalled` at the moment of migration —
     every tool the token has actually used stays active; only tools it has genuinely never
     called narrow.
   - If the token being migrated is the current mirror token, also recomputes the legacy
     global mirror fields (`toolLoading.profile`, `toolLoading.promoted`) to match — the
     explicit, informed, reversible nature of this opt-in is what distinguishes it from the
     silent narrowing ADR-0014's guarantee exists to prevent; that guarantee protects against
     an *unrequested* change, not a user's own deliberate one.
   Flipping it off at any later time reverses this exactly: `profiles[id].profile = "all"`
   (and the mirror fields, if applicable), with no loss of the accumulated `everCalled` history.

4. **Silent-failure mitigations, both required, in this order:**
   - **Obsidian Notice** at the moment of migration (not only at next app launch): names the
     token and the count of tools deactivated, and points at `activate_tool` as the recovery
     path.
   - **`notifications/tools/list_changed`** pushed on the migrated token's active connection
     (reusing the existing mechanism `activate_tool` already drives), so a connected MCP client
     re-lists tools immediately rather than staying stale for the rest of its session.

5. **Settings UI.** For each token: while under the observation period, the toggle is disabled
   and shows a countdown ("Ready in N days"). Once eligible, the toggle is enabled and, before
   the user confirms turning it on, a preview lists exactly which tools would be deactivated
   (computed from `promoted ∪ everCalled` vs. the full tool set) — the same computation the
   actual migration performs, run ahead of time for display.

## Data model

- `toolLoading.profiles[tokenId]`: existing shape (`profile`, `promoted`, `allowed`) gains
  `everCalled: string[]`.
- Migration-eligibility timestamp: a new field recording when `everCalled` tracking began for
  that token (or a single vault-wide timestamp for when the release shipped, if per-token
  timestamps prove unnecessary at ADR time — an ADR decision, not fixed here).

## API

No new MCP-facing tool or endpoint. The toggle and preview are settings-UI-only (Svelte,
`SettingsStore.updateSlice`, following the project's existing sliced-write convention). The
only wire-visible effect is the existing `notifications/tools/list_changed` notification, reused
unchanged.

## UI flows

1. User opens plugin settings, MCP Connector → token list.
2. A token past its observation period shows an enabled "Migrate to adaptive" toggle.
3. Turning it on shows a preview ("These N tools will be deactivated for this token: …") before
   confirming.
4. On confirmation: policy updated, Notice shown in Obsidian, `list_changed` pushed if the token
   has an active connection.
5. The toggle can be turned off at any time, reverting the token to `all` with no data loss.

## Edge cases

- Token created via `addToken` (secondary, non-mirror) with no seeded `profiles` entry at all:
  resolves through the same `readPolicy` fallback as any other missing entry; the observation
  clock starts the same way as for any other tracked token.
- Token is the mirror and gets migrated: legacy global mirror fields are updated too (see
  Architecture point 3) — this is the one deliberate exception to ADR-0014's mirror-preservation
  invariant, justified by the explicit, informed, reversible nature of the user's own action.
- Token is later revoked while migrated: no special handling needed — revocation already drops
  the policy entry entirely regardless of profile.
- `everCalled` is still empty when the observation period ends (a token that has genuinely never
  been used since the update): the preview and Notice correctly show "0 tools deactivated" or
  "all N tools deactivated", whichever is true — no special-casing needed, the mechanism already
  produces the honest answer either way.

## Success criteria

- [ ] R-01 — A new per-token `everCalled` field is defined and populated on every recorded tool
      call for that token, without changing the existing global counters' behavior or shape.
- [ ] R-02 — A token only becomes eligible for the migration toggle after the ADR-decided
      minimum observation period has elapsed since `everCalled` tracking started for it, anchored
      to that start date, never to the toggle's own on/off history.
- [ ] R-03 — Turning the toggle on sets the token's profile to `adaptive` and seeds `promoted`
      from the union of its existing `promoted` list and its `everCalled` set.
- [ ] R-04 — Turning the toggle on for the current mirror token also updates the legacy global
      mirror fields (`toolLoading.profile`/`promoted`) to match.
- [ ] R-05 — Turning the toggle off at any time reverts the token's profile to `all` (and the
      mirror fields, if applicable) without discarding its accumulated `everCalled` history.
- [ ] R-06 — Migrating a token emits an Obsidian Notice naming the token and the count of tools
      deactivated, and names `activate_tool` as the recovery path.
- [ ] R-07 — Migrating a token with an active connection pushes
      `notifications/tools/list_changed` on that connection immediately, not only at next
      reconnect.
- [ ] R-08 — Settings UI shows, per token: a disabled toggle with a countdown before eligibility,
      and an enabled toggle with a pre-confirmation preview of exactly which tools would be
      deactivated once eligible.
- [ ] R-09 — The ADR documents why migrating the mirror token on explicit user request does not
      violate ADR-0014's mirror-preservation guarantee, distinguishing an explicit, reversible,
      user-driven change from the unrequested silent narrowing that guarantee was written to
      prevent. (no-test: this is a design-record obligation the ADR itself must state in prose,
      not a runtime behavior a test can assert)
- [ ] R-10 — This chain produces `SPEC.md`, the architecture ADR, and a roadmap-level
      implementation plan sized for a later, separate implementation chain; no production code
      is written in this chain. (no-test: this is a process/scope obligation about this chain's
      own deliverables, not a runtime behavior a test can assert)
