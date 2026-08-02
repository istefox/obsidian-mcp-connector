# Per-client tool profiles via multiple bearer tokens

**Topic slug:** per-client-tool-profiles-issue-348

Closes [#348](https://github.com/istefox/obsidian-mcp-connector/issues/348). Baseline: 0.28.2.

## Objective

Let one vault serve a different tool surface to each MCP client, decided by the bearer token
the client presents. A consultation client (claude.ai) gets the 13-tool Core set; a writing
client (Cowork) gets the full set. Today the tool-loading profile is a single global value in
`toolLoading`, and the server never reads `clientInfo` — with the stateless per-request
transport it could not read it reliably anyway, since `initialize` arrives on a different
request from the ones that follow.

The token is the only client identity available on every request. MCP revision `2026-07-28`
states this directly for `tools/list`: the set *"MAY vary by the authorization presented on the
request — for example, returning only the tools the caller's granted scopes permit — since
credentials are per-request input, not connection state."* So this is a sanctioned pattern, not
a local invention, and it needs no protocol work: the connector's current 2025-era wire already
carries the bearer on every request.

Two outcomes: per-session token cost tuned per client, and selective per-client revocation.

## Scope

In scope:

- Multiple labeled bearer tokens, each with its own tool-loading policy.
- Per-token `profile` (`all` / `core` / `adaptive`) and per-token `promoted` list.
- An optional per-token allowlist that caps what that token can ever reach.
- Token-aware `tools/list`, `tools/call` gating, and `tool_catalog`.
- Settings UI to add, label, regenerate, revoke tokens, and edit each one's policy.
- Per-token "Copy config" for the existing client-family generators.
- Migration of an existing single-token vault, with the token string preserved.

Out of scope:

- Any change to the MCP protocol revision the server speaks (#407 Phase 2 stays unscheduled).
- OAuth, scopes, or any credential mechanism other than the existing bearer.
- Per-token `notifications/tools/list_changed` fan-out. Already solved by construction: the
  notification rides the activation call's own POST response stream with that call's
  `relatedRequestId` (ADR-0011, ADR-0012), so it reaches exactly the caller and nobody else.
- Per-token call counters. Frequency is a property of the vault, not of the client.
- Changing the `all` / `core` / `adaptive` profile definitions or `CORE_SET` membership.

## Stack

Unchanged from the repo baseline: TypeScript on Bun, Svelte settings UI, MCP SDK v2
(`@modelcontextprotocol/server` + `@modelcontextprotocol/node`), settings persisted to
`data.json` through `SettingsStore` slices, tests with `bun test`.

## Architecture

### Identity resolution

`runMiddleware` currently takes a single expected token and returns `{ ok }`. It becomes a
match against the token list and returns the matched token's **id** on success. Matching
compares against every entry with the existing constant-time `compareTokens` and keeps the
last match rather than returning on the first hit, so response time does not disclose a
token's position in the list. A miss stays a 401 with no hint about which of the N failed.

The check order in `runMiddleware` (path/method → origin → protocol version → auth) is
unchanged.

### Filtering site

Filtering happens at the `mcpServer` boundary, per request. `handleRequest` gains the token id
resolved by the middleware, loads that token's policy, resolves an active set once, and uses it
for both `tools/list` and the `tools/call` gate.

The tool registry keeps owning global truth — `userDisabled`, adaptive disable state, the
composed tool set — and gains no concept of a token. Per-token filtering is a pure function of
(global registry, token policy), which keeps `composeToolRegistry` running once and leaves the
split registry from ADR-0010 untouched.

### Precedence

Four layers, strongest first:

1. **`userDisabled`** — the settings-level kill switch from ADR-0010. A tool disabled here is
   invisible to every token, whatever its policy says.
2. **Per-token allowlist** (`allowed`) — when set, the ceiling. A tool outside it is never
   listed and never dispatched for that token, and `activate_tool` refuses it.
3. **Per-token profile + promoted** — the starting surface and its in-band widening.
4. **Meta-tools** — `tool_catalog`, `activate_tool`, `activate_tools` stay always-active for
   every token, exactly as today, so an in-band promotion path always exists.

The issue proposed "profile as a hard ceiling that activation cannot exceed". That is rejected:
`core` exists precisely so `activate_tool` can widen it on demand, and a ceiling at the profile
boundary would make activation a no-op for every core token, i.e. the feature that makes `core`
usable at all. The ceiling is the separate, optional `allowed` list, which defaults to unset —
so unless the user opts in, activation behaves exactly as it does today.

### Refusal path

An `activate_tool` / `activate_tools` call naming a tool outside the calling token's allowlist
returns the recoverable error shape introduced by ADR-0011 (#354), naming the token's limit as
the reason rather than reporting the tool as unknown. A `tools/call` on such a tool takes the
same path.

## Data model

Credentials stay in the transport slice, policy stays in the tool-loading slice, joined by id.
Auth keeps owning secrets, so revocation and the middleware never reach into tool-loading code,
and the tool-selection UI never writes into the auth slice.

```
mcpTransport: {
  bearerToken: string        // legacy mirror of the default token (see Migration)
  tokens: [
    { id: string,            // stable, never reused, generated on create
      label: string,         // user-facing, e.g. "claude.ai"
      token: string,         // the secret, base64url, generateToken()
      createdAt: number }
  ]
}

toolLoading: {
  profile: "all"|"core"|"adaptive"   // legacy mirror of the default token's profile
  promoted: string[]                 // legacy mirror of the default token's promoted
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

A `profiles` entry missing for a live token resolves to the default policy (`profile: "all"`,
empty `promoted`, `allowed: null`). An orphan can therefore never fail closed into a client that
cannot reach anything.

### Migration

Runs once, on load, idempotent:

- The existing `mcpTransport.bearerToken` becomes `tokens[0]` with `id: "default"`,
  `label: "Default"`, and **the same token string**. Any other outcome breaks every configured
  client, every generated `.mcpb` bundle, and the Windows bridge.
- The existing global `toolLoading.profile` / `promoted` are copied into
  `profiles["default"]`, with `allowed: null`.
- `mcpTransport.bearerToken` and `toolLoading.profile` / `promoted` keep being written,
  mirroring the default token. A user who downgrades to an older plugin build then still reads a
  correct token and profile instead of silently reverting to `all` and losing their promoted
  list. The mirror is maintained on every write to the default token's policy.
- A vault with no `bearerToken` yet (first run) mints one token as today and writes it in the
  new shape plus the mirror.

## API

No new MCP methods. Behavioral changes to existing ones, all scoped to the calling token:

- **`tools/list`** — returns the token's active set. Meta-tools always present.
- **`tools/call`** — a tool outside the token's active set takes the ADR-0011 recoverable-error
  path; a tool outside its allowlist reports the token limit as the reason.
- **`activate_tool` / `activate_tools`** — write into the calling token's `promoted` list, not
  the global one. Refused for tools outside that token's allowlist. The
  `notifications/tools/list_changed` they emit is unchanged and already reaches only the caller.
- **`tool_catalog`** — scoped to the calling token: `active` / `inactive` / `promoted` reflect
  that token's policy, and a tool excluded by its allowlist is reported as unavailable for this
  token rather than merely inactive. Call counts stay global, since counters are.

Internal signature changes: `runMiddleware(req, tokens) -> { ok, tokenId } | { ok: false, status }`;
`handleRequest(req, res, tokenId)`; registry `list()` and the dispatch gate take a resolved
active set.

## UI flows

One token list in the transport settings section. The existing `AdaptiveToolLoadingSettings`
panel is reused, scoped to the selected row, rather than duplicated per token.

```
Tokens
  ● Default        [all      ▾]  43 tools  ⧉  ×
  ○ claude.ai      [core     ▾]  13 tools  ⧉  ×
  ○ Cowork         [adaptive ▾]  18 tools  ⧉  ×
                                    [+ Add token]

─ claude.ai ────────────────────────────
  Profile: Core
  Limit to specific tools  [ off ]
  (on → the existing tool checklist, scoped to this token)
```

- **Add** — mints a token, prompts for a label, defaults to `profile: "all"`, `allowed: null`.
  Disabled at 10 tokens.
- **Select a row** — swaps the policy panel below to that token's profile, promoted list, and
  allowlist toggle.
- **Copy config (⧉)** — moves onto each row and emits client config carrying that row's token.
  The client-family choice (Claude Desktop, `.mcpb`, raw JSON) is unchanged; adding a token is
  how a client gets its own surface.
- **Regenerate** — mints a new secret in place, keeping id, label and policy, so rotating a
  leaked token does not mean rebuilding its tool selection.
- **Revoke (×)** — confirmation dialog naming the label and stating that every client configured
  with it, including generated bundles, stops working and the string is not recoverable.
  Disabled when one token remains.

## Edge cases

- **Last token** — cannot be deleted; the control is disabled. Deleting it would leave a running
  server that nothing can authenticate against.
- **Revoking the token in active use** — permitted (with confirmation); in-flight requests
  finish, the next one 401s. This is the intended security behavior.
- **Deleting a token** — its `profiles` entry is deleted with it. A leftover entry for a
  non-existent id is inert and pruned on next write.
- **Duplicate labels** — allowed; the id is the identity, the label is cosmetic.
- **Allowlist listing a tool that no longer exists** — silently ignored when resolving the
  active set, not an error, same tolerance the `promoted` list already has.
- **Allowlist that excludes a meta-tool** — meta-tools are always active regardless; the
  allowlist cannot lock a token out of `tool_catalog` or `activate_tool`.
- **Empty allowlist (`[]`)** — distinct from `null`: the token reaches meta-tools only. Legal,
  and the UI must make it visibly different from "no limit".
- **A token whose profile is `adaptive`** — auto-promotion writes into that token's `promoted`
  list, driven by the global counters. Two adaptive tokens promote the same tool at the same
  threshold, independently.
- **Concurrent writes** — every mutation goes through `SettingsStore.updateSlice` and the
  process-wide settings mutex, as today. A token added in the UI while a request is being served
  is picked up on the next request; there is no cached token list to invalidate.
- **Migration re-run** — detects `tokens[]` already present and does nothing.
- **`.mcpb` bundle and Windows bridge** — both embed a token string. Regenerating or revoking
  invalidates them; the confirmation copy says so.

## Success criteria

- [ ] R-01 — A request bearing a token in the list authenticates and is served that token's tool
      surface; a request bearing an unknown token gets 401 with no indication of which token
      failed.
- [ ] R-02 — Bearer matching compares against every configured token without an early exit, using
      the existing constant-time comparison.
- [ ] R-03 — `tools/list` returns a set derived from the calling token's profile, promoted list,
      and allowlist, with meta-tools always present.
- [ ] R-04 — A `tools/call` for a tool outside the calling token's active set returns the
      ADR-0011 recoverable error rather than "Unknown tool".
- [ ] R-05 — `activate_tool` and `activate_tools` write into the calling token's `promoted` list
      only; another token's surface is unchanged by the promotion.
- [ ] R-06 — When a token's `allowed` list is set, `activate_tool` on a tool outside it is
      refused with an error naming the token's limit, and the tool never appears in that token's
      `tools/list`.
- [ ] R-07 — When `allowed` is `null` (the default), activation behaves exactly as in 0.28.2.
- [ ] R-08 — A tool disabled via `userDisabled` is invisible to every token regardless of profile
      or allowlist.
- [ ] R-09 — `tool_catalog` reports active/inactive/promoted scoped to the calling token, and
      reports an allowlist-excluded tool as unavailable for that token.
- [ ] R-10 — Frequency counters remain global; adaptive auto-promotion fires per token against
      those shared counts.
- [ ] R-11 — Migrating a 0.28.2 vault preserves the bearer token string byte-for-byte and carries
      the global profile and promoted list into the default token's policy.
- [ ] R-12 — After migration, `mcpTransport.bearerToken`, `toolLoading.profile` and
      `toolLoading.promoted` continue to mirror the default token on every write to it.
- [ ] R-13 — Migration is idempotent: running it against an already-migrated `data.json` changes
      nothing.
- [ ] R-14 — A vault with no configured profile behaves exactly as 0.28.2 does with no profile
      configured (all tools).
- [ ] R-15 — The settings UI lists tokens with label, profile, active tool count, copy-config and
      revoke, and can add a token up to a cap of 10.
- [ ] R-16 — Selecting a token in the list scopes the existing adaptive tool-loading panel to
      that token's policy; there is one implementation of the tool checklist, not N.
- [ ] R-17 — Copy config on a token row emits client configuration carrying that row's token, for
      each existing client family.
- [ ] R-18 — Regenerating a token mints a new secret while preserving its id, label, profile,
      promoted list and allowlist.
- [ ] R-19 — Revoking a token requires a confirmation naming the label and stating that
      configured clients and generated bundles stop working; the control is disabled when one
      token remains.
- [ ] R-20 — Unit tests cover N-token bearer matching, migration, active-set resolution from
      profile plus allowlist, and the refusal path for an out-of-allowlist activation.
- [ ] R-21 — Migration is verified against a real pre-upgrade 0.28.2 `data.json`, asserting the
      token string is unchanged and the policy carried over and stayed mirrored.
- [ ] R-22 — A smoke test runs two tokens with different profiles against a real client and
      confirms each connection lists a different tool set.
- [ ] R-23 — README documents the token list and per-token profiles, including that revoking
      breaks configured clients; CHANGELOG carries an entry under the next version.
