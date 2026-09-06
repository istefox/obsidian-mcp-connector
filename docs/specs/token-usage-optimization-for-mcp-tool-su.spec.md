# SPEC: Token usage optimization for MCP tool surface

**Topic slug:** token-usage-optimization-for-mcp-tool-su

## Objectives

Reduce the token cost the MCP Connector imposes on every client session and on every read-heavy
tool call, measured this session against the live registry and a real vault, without breaking any
currently configured client (Claude Desktop, Claude Code, mcp-remote bridge, `.mcpb` bundles).

Baseline, measured 2026-09-05 against `main` (`b9ddacd`) and the Labs vault:

| Surface | Size | Est. tokens |
|---|---|---|
| Full `tools/list` (49 tools, profile `all`) | 43.4 KB | ~10.9k |
| Live `tools/list`, profile `adaptive` (18 tools) | 15.0 KB | ~3.7k |
| `tool_catalog` response (49 entries) | 7.4 KB | ~1.9k |
| `search_vault_simple("the", limit 3)` — text | 12.3 KB | ~3.1k |
| `search_vault_simple("the", limit 3)` — MCP Apps `_meta` | 15.5 KB | ~3.9k |

Breakdown of the full `tools/list`: descriptions 13.1 KB, `inputSchema` 23.7 KB (of which 12.6 KB
is parameter descriptions across 139 params), annotations 2.8 KB.

## Scope

This ADR sections work by certainty/risk, per the user's explicit choice at interview (one broad
ADR, not split chains). Three tiers:

- **Mechanical (in scope, implement now):** R-01 through R-08 below. No client-visible contract
  break beyond additive fields; existing callers unaffected.
- **Needs-spike (in scope, spike-then-decide):** R-09, R-10. A verification task runs first; the
  ADR records the finding either way, implementation proceeds only if the spike confirms
  feasibility.
- **Product-default-change (in scope, implement with phased-opt-in posture):** R-11. Follows the
  same non-breaking posture as ADR-0019/ADR-0022 — existing tokens are never silently changed.
- **Deferred (explicitly out of scope, documented for the record):** the dual-emit
  `structuredContent` question (ADR-0009). See "Deferred" section.

### In scope — mechanical

1. `search_vault_simple` per-file match cap (`maxMatchesPerFile`, default 5) plus a
   `moreMatches: true` flag on truncated files.
2. Drop `match.start`/`match.end` character offsets from `search_vault_simple`'s response; `line`
   is the only field any consumer reads.
3. Flatten Dataview `Link` objects to plain path strings in `execute_dataview_query` and
   `search_vault` (dataview mode); drop the redundant `idMeaning` field.
4. Trim `tool_catalog`: omit `call_count` when it is `0`, tighten the first-sentence truncation
   rule.
5. Shorten the 16 tool descriptions currently over 350 characters, removing implementation trivia
   (internal API paths, issue/RFC references, scope notes) that does not aid tool selection.
6. Normalize ArkType-generated JSON Schema: collapse const-union `anyOf` arrays into a plain
   `enum`, unwrap single-member `anyOf` wrappers (affects optional booleans across the registry).
   Explicitly linked to issue #508 (`search_and_replace` `dry_run` intermittent validation
   rejection) — after this fix ships, re-test #508's repro; if resolved, close #508 with a
   reference to this ADR.
7. Reduce annotation/constraint verbosity: omit annotation fields that duplicate MCP spec
   defaults, simplify the base64 pattern constraint on `create_vault_binary_file`.

### In scope — needs-spike

8. **Capability-detection spike for MCP Apps `_meta` gating (ADR-0018 amendment candidate).**
   Verify whether `clientCapabilities` (or an equivalent per-request signal) is actually readable
   on the modern (2026-07-28) era before a `tools/call` response is built, and whether it reliably
   distinguishes a client that declared `io.modelcontextprotocol/ui` support. On the legacy era, no
   equivalent signal exists (no per-request capability handshake) — the spike must state this
   explicitly rather than attempt a workaround. **If the spike confirms feasibility** on the modern
   era: implement gating so the `_meta` search payload is omitted for the legacy era and for modern
   clients that never declared the capability. **If not feasible**: the ADR records why, and this
   candidate stays deferred, unimplemented.
9. **Speculative server `instructions` field.** Add a `instructions` string to `buildMcpServer`'s
   `McpServer` construction, centralizing conventions currently repeated per-tool description
   (vault-relative paths, 0-indexed lines, `errorCode` response shape). Low cost, no known
   regression risk (an ignoring client simply does not use it) — implemented directly, not gated
   behind a spike, per the user's explicit choice.

### In scope — product-default-change

10. New MCP tokens (never seen in `toolLoading.profiles`) default to `profile: "adaptive"` instead
    of `"all"`. `DEFAULT_POLICY` in `tokenPolicyStore.ts` is the fallback used ONLY when a token id
    has no entry in `profiles` — an existing token already has an entry (even if it mirrors `"all"`
    today) and is never touched. Same non-breaking posture as ADR-0019/ADR-0022's phased opt-in:
    nothing that works today for an existing vault stops working.

### Deferred (out of scope, documented)

- **ADR-0009 dual-emit `structuredContent` for `get_vault_file`/`get_vault_files`.** The MCP spec's
  published roadmap (2026-08-22) explicitly names `tools/call` content/structuredContent duality as
  a target for redesign in the next protocol cycle. Reopening ADR-0009 now risks doing work that
  the upstream redesign invalidates. Decision: wait for upstream, do not touch ADR-0009 in this
  chain. Revisit when the MCP spec publishes a revision addressing this.

## Architecture

No new features, layers, or dependencies. All changes are localized edits inside
`packages/obsidian-plugin/src/features/mcp-tools/`, `mcp-apps/`, `mcp-transport/`, and
`adaptive-tool-loading/`, following existing patterns (`responseBuilders.ts`,
`normalizeInputSchema` in `toolRegistry.ts`, `tokenPolicyStore.ts`).

The capability-detection spike (R-09) is investigation, not a new subsystem: it reads
`ctx.authInfo`/request `_meta` already available inside `buildMcpServer`'s per-request closures in
`mcpServer.ts`, and reports findings inline in the ADR — no scaffolding survives the spike unless
it confirms feasibility.

## Data model

No persisted schema changes. `data.json`'s `toolLoading.profiles` shape is unchanged; only the
fallback value (`DEFAULT_POLICY`) used for an ABSENT entry changes (R-11).

## API (tool contract changes)

- `search_vault_simple`: new optional parameter `maxMatchesPerFile` (integer, default 5). Response
  shape: each file result gains `moreMatches: boolean` (true when truncated); `matches[].match`
  (the `{start, end}` object) is removed. This is a breaking change to the exact response shape
  for any consumer that reads `match.start`/`match.end` — see Edge cases.
- `execute_dataview_query`, `search_vault` (dataview mode): Dataview `Link` values in results now
  serialize as the plain `path` string instead of `{path, embed, type, display}`; `idMeaning` is
  removed from `search_vault`/`execute_dataview_query`'s TABLE-mode output where present. Breaking
  change to exact response shape for any consumer parsing the Link object's sub-fields.
- `tool_catalog`: entries with `call_count: 0` omit the field entirely (additive-compatible for any
  reasonable consumer; a consumer requiring the literal `0` would break, judged acceptable — no
  known consumer does this since the field exists purely for informational display).
- All other mechanical items (R-05 through R-08) change only tool `description`/`inputSchema`
  string content, not response shape or parameter names — no breaking change.
- New MCP token default profile (R-11): affects only `tools/list` size for a token with no prior
  `profiles` entry. No API shape change.
- `instructions` field (R-10): additive, top-level `McpServer` constructor option — no existing
  field renamed or removed.

## Edge cases

- A client that currently parses `search_vault_simple`'s `match.start`/`match.end` breaks silently
  (wrong field access, not a crash) after R-02 ships. No known client does this (verified: no
  in-repo consumer reads these fields beyond deriving `line`), but this is an assumption about
  external clients, not a fact — flagged explicitly, accepted as a risk by the user's choice to
  remove the fields.
- A file with exactly `maxMatchesPerFile` matches must NOT set `moreMatches: true` (off-by-one
  boundary — the flag means "there were more than the cap", not "there were at least the cap").
- The capability-detection spike (R-08) must explicitly test the legacy era's absence of a
  per-request capability signal, not just the modern era's presence of one — a spike that only
  confirms the modern era leaves the legacy behavior unspecified.
- New-token default (R-11) must be verified against a token that exists in `mcpTransport.tokens`
  but has no `toolLoading.profiles` entry — the exact "orphaned token" shape `resolveToolScope.ts`
  already documents as falling back to `DEFAULT_POLICY`.
- Dataview Link flattening (R-03) must handle a `Link` embedded inside a nested structure (e.g. a
  list of outlinks inside a TABLE cell), not just top-level Link values — `execute_dataview_query`
  can return arbitrarily nested Dataview result shapes.
- Shortened descriptions (R-05) must not remove information a client needs to call the tool
  correctly — only remove information that helps tool *selection* but not tool *invocation*
  (e.g. removing "Implements RFC #68" is safe, removing "the underlying error is surfaced verbatim"
  from `execute_dataview_query` may not be).

## Success criteria

- [ ] R-01 — `search_vault_simple` accepts an optional `maxMatchesPerFile` parameter (default 5);
      a file with more matches than the cap returns exactly `maxMatchesPerFile` matches plus
      `moreMatches: true`.
- [ ] R-02 — `search_vault_simple`'s response no longer includes `match.start`/`match.end`; `line`
      is retained.
- [ ] R-03 — `execute_dataview_query` and `search_vault` (dataview mode) serialize Dataview `Link`
      values as plain path strings, including when nested inside arrays/objects in the result
      value; the redundant `idMeaning` field is removed from TABLE-mode output.
- [ ] R-04 — `tool_catalog` omits `call_count` when it is `0`; first-sentence truncation for
      inactive-tool descriptions is verified against at least one multi-sentence description.
- [ ] R-05 — All 16 tool descriptions previously over 350 characters are shortened to remove
      implementation trivia, verified by re-running this session's measurement script and
      confirming description byte count decreases without removing invocation-relevant
      information (manual review, `no-test: requires human judgment on which detail is
      invocation-relevant vs. selection-only, not mechanically checkable`).
- [ ] R-06 — `normalizeInputSchema` (or equivalent) collapses const-union `anyOf` arrays into
      `enum` and unwraps single-member `anyOf` wrappers; `index.test.ts`'s full-registry test
      confirms no tool's `inputSchema` still contains a const-union `anyOf` or a single-member
      `anyOf`.
- [ ] R-07 — Issue #508's repro (`search_and_replace` with `dry_run: true`/`false`) is re-tested
      after R-06 ships; the ADR records the outcome either way
      (`no-test: outcome depends on external reporter re-testing or a repro being reproduced
      in-house, not solely on this repo's own test suite`).
- [ ] R-08 — Annotation fields matching MCP spec defaults are omitted from at least the tools
      identified in this session's analysis; `create_vault_binary_file`'s base64 pattern
      constraint is simplified or removed without weakening actual input validation (the arktype
      runtime check, not just the advertised JSON Schema, still rejects non-base64 input).
- [ ] R-09 — A capability-detection spike determines, with evidence, whether per-request client
      capability is readable before a modern-era `tools/call` response is built; the finding
      (feasible or not) is recorded in the ADR
      (`no-test: a research finding recorded in documentation, not an assertable code behavior`).
      If feasible, MCP Apps `_meta` payload is gated by declared `io.modelcontextprotocol/ui`
      support on the modern era; the legacy era's unconditional-attach behavior is explicitly
      addressed (either left unchanged with a stated reason, or changed with a stated mechanism).
- [ ] R-10 — `buildMcpServer` sets a non-empty `instructions` string centralizing at least the
      vault-relative-path, 0-indexed-line, and `errorCode` conventions currently repeated across
      multiple tool descriptions.
- [ ] R-11 — A newly-created MCP token (no prior `toolLoading.profiles` entry) resolves to
      `profile: "adaptive"`; an existing token with a `profiles` entry (including one that already
      reads `"all"`) is unaffected by this change, verified by a test that seeds an existing
      `"all"` entry and confirms it still resolves to `"all"` after the change.
- [x] R-12 — Before/after measurement: re-run this session's `tools/list` and
      `search_vault_simple` measurement script against the shipped code; the CHANGELOG entry and
      final chain report state the measured KB/token reduction for each shipped candidate
      (`no-test: a reporting obligation on the measurement script's output, not an assertion the
      test suite itself makes`).
- [ ] R-13 — Manual end-to-end verification against the Labs vault: `search_vault_simple` against
      a file with more than 5 matches shows `moreMatches: true`; `tool_catalog` and `tools/list`
      are inspected live and confirmed to match the shipped shape
      (`no-test: manual verification against a real vault, not automatable in the unit/integration
      suite`).
- [x] R-14 — A CHANGELOG entry under the next `## [Unreleased]` (or the release section active at
      commit time) lists every shipped candidate from this ADR with its measured savings
      (`no-test: a documentation deliverable, not a test-asserted behavior`).
- [ ] R-15 — The full gate passes: `bun run check && bun test && bun run format:check`, plus
      `bun run check:svelte` and `bun run test:mcpb` from `packages/obsidian-plugin`.

## Non-goals

- ADR-0009's dual-emit `structuredContent` decision is not reopened (see Deferred).
- No new SDK features (Tasks, Elicitation, Completions) are adopted — confirmed out of scope per
  this session's SDK/spec status check.
- No change to the per-token allowlist, `userDisabled`, or adaptive-inactive mechanisms beyond the
  new-token default (R-11).
