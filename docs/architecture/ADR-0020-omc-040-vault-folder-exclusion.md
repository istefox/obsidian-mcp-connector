# ADR-0020: Vault-wide folder exclusion for the MCP tool surface

**Status:** Accepted
**Date:** 2026-08-19
**Deciders:** Stefano Ferri
**Issue:** OMC-040 / #499 (raised by discussion #493)

---

## Context

`search_vault_smart` accepts `includeFolders` / `excludeFolders` on its `filter` argument
(`searchVaultSmart.ts:19-24`). No other tool accepts anything comparable. A user who excludes a
folder from semantic search still hands every MCP client full access to it through
`search_vault_simple`, `get_vault_file`, `get_vault_files`, `list_vault_files`, `search_vault` or
`get_vault_overview`.

Discussion #493 reported exactly this. The author keeps therapy notes and financial details in the
vault and asked for a vault-wide or per-token exclusion list enforced across every tool that reads
or searches vault content. The distinction they draw is the whole point of this ADR: **a filter on
search results is not an access control.**

### What was measured, not assumed

- **No path policy exists anywhere on the tool surface.** `ToolScope` (`shared/types.ts:26-37`),
  the per-token allowlist and `userDisabled` are tool-*name* concepts. `resolveToolScope`
  (`resolveToolScope.ts:33-58`) and `isAllowedInScope` (`:98-104`) are pure name-set arithmetic.
  Nothing in the codebase restricts which *paths* a permitted tool may reach.

- **One exclusion primitive exists and covers 4 tools of ~50.** `createExclusionFilter`
  (`shared/isUserIgnored.ts:28-46`) wraps Obsidian's undocumented `metadataCache.isUserIgnored`.
  Consumers: the semantic indexer (`productionWiring.ts:105`), `search_vault_smart` at query time
  (`searchVaultSmart.ts:266`), `get_recent_files`, and `get_vault_overview` through a hand-rolled
  duplicate at `getRecentFiles.ts:44-92`. It **fails open** when the accessor is missing — correct
  for the convenience filter it is, wrong for an enforcement point.

- **`resolveTFile` is not the chokepoint it appears to be.** It covers 17 of roughly 30 path sites
  (`resolveTFile.ts:20-25`, callers across 15 tool files). Fourteen sites call
  `vault.getAbstractFileByPath` directly, including every write path. `showFileInObsidian.ts:28`
  resolves no `TFile` at all and its schema says the file is "Created if missing".

- **Twelve sites enumerate the vault wholesale**, ten via `vault.getMarkdownFiles()` and one via
  `vault.getFiles()` (`listVaultFiles.ts:25`, every extension, the broadest single leak).

- **Four link-graph reads name files the caller never supplied** — `getBacklinks.ts:42-67`,
  `findOrphanedNotes.ts:36-41`, `renameHeading.ts:131-137`. The last of these reads *and writes*
  backlinking files at `:141-144`.

- **`metadataCache.getTags()`** (`listTags.ts:31-38`) returns `Record<tag, count>` with no file
  attribution. Honouring an exclusion there is a rebuild, not a filter.

- **Prompts are a separate registry** that never touches `toolRegistry.dispatch`.
  `expandEmbeds` (`promptTransclusion.ts:185`, resolution at `:214`) transcludes arbitrary
  `![[...]]` targets vault-wide.

- **Three tools cannot be constrained by any path policy.** `execute_obsidian_command` takes an
  opaque command id and calls `app.commands.executeCommandById`, running arbitrary registered code
  in-process. `execute_dataview_query` delegates the whole enumeration to Dataview
  (`executeDataviewQuery.ts:109`). `execute_template` runs Templater JS against Templater's own
  raw `app`. **`list_bookmarks` is not in this set**: its items carry `path` strings and are
  filterable; only `search`-type items are opaque, and those hold the user's own query text rather
  than results.

- **`AsyncLocalStorage` works in Obsidian's renderer.** Measured on 2026-08-19 against the running
  Labs vault: `require("node:async_hooks")` resolves, and a store set with `als.run()` survives both
  a `setTimeout` and a promise continuation. This was the load-bearing unknown; it is now closed.
  Consistent with the bundle, which leaves `require("node:http")`, `require("node:crypto")` and
  friends as literals in the shipped `main.js`.

### Prior art in this repository

**RFC #238 offered this and deferred it.** Its option B was a plugin-specific `excludeFolders`
setting; it was not rejected on the merits but parked as "B / C as follow-ups if real demand
emerges (haven't heard one yet)". Discussion #493 is that demand. What shipped was option A
(honour Obsidian's own list) plus D3 (filter at index time *and* query time, no destructive cache
mutation, physical cleanup only on manual rebuild).

**ADR-0018 Alternative J is the closer precedent.** It declined to expose vault notes through
`resources/*` because vault content on a surface where a token's policy does not apply "needs a
policy model designed from scratch and is a separate decision". §D14 below states what this ADR
does and does not do about that.

**`SECURITY.md` states the bearer token is the trust boundary** and puts content-side filtering
out of scope. This work moves part of that boundary inside the plugin, so that section is amended.

---

## Decision

**D1 — The enforcement seam is a guarded `App`, injected at the two composition roots.**
Every tool handler receives its `App` from one expression, `ctx.app` — 47 occurrences inside
`registerTools` (`features/mcp-tools/index.ts:193+`), and nothing else. There are exactly two
production construction sites: `src/composeToolRegistry.ts:76-80` for tools and `src/main.ts:75-77`
for prompts. `createGuardedApp` (new, `src/shared/guardedApp.ts`) wraps `vault`, `vault.adapter`,
`metadataCache`, `workspace` and `fileManager` — roughly thirty members — and hands the result to
those two sites.

The criterion that decides this over every alternative is not coverage today but coverage
tomorrow: **a tool written next year is covered by default, with no action by its author.** No
other candidate seam has that property, and every one of them fails silently when someone forgets.

**D2 — Every member is classified GUARDED, PASSTHROUGH, or denied by default.** PASSTHROUGH is
reserved for members that are provably path-free (`getName`, `configDir`, `on`/`offref`,
`onLayoutReady`). Anything unclassified throws on property access. Default-deny is load-bearing:
it converts "did we remember to guard `getFolderByPath`?", a review question nobody reliably wins,
into a runtime failure and a red test.

**D3 — The denial semantics is inherited, not authored.** An excluded path takes each tool's
*existing* not-found branch, verbatim. `getAbstractFileByPath` returns `null`, so `resolveTFile`
returns its existing `{ok: false, reason: "not_found"}` and all 17 call sites emit the message they
already emit. `vault.create` into an excluded folder throws the same ENOENT string Obsidian throws
for a missing parent folder, already modelled at `test-setup.ts:1078-1082`. There is no
per-tool refusal code anywhere in this feature, and there must never be: a distinguishable refusal
confirms the folder exists, which is precisely what the feature exists to hide.

This also dissolves what looked like a problem. `resolveTFile` takes a `Vault`, not an `App`, so it
cannot call `createExclusionFilter(app)`. It does not need to. It is handed the guarded `Vault`.

**D4 — A new dedicated setting, `mcpTools.excludedFolders: string[]`.** Not a reuse of Obsidian's
Files & Links → Excluded files. That list is a *display* preference: users put `attachments/` in it
to tidy their search results. Reusing it would make those folders unreachable over MCP for every
existing user, retroactively and without being asked. The two lists stay independent and both
apply where each is already honoured; see Consequences → Neutral for what that means in practice.

**D5 — Empty collapses to `undefined`, and the writer omits the key.** There is no third state
here. An empty exclusion list and no exclusion list are behaviourally identical, and encoding a
distinction with no semantic difference invites a consumer to branch on it wrongly. A vault that
never touches the feature keeps a byte-identical `data.json`, the same discipline as `toSlice`
dropping an empty `profiles` map (`tokenPolicyStore.ts:143-146`). One rule for every consumer:
`normalizeExcludedFolders(x) === undefined` means inert. Nobody writes `.length > 0`.

**D6 — `normalizeExcludedFolders` runs on every read, not only on write.**
`normalizeMaxTextOutputKB` is applied at write time with a `?? DEFAULT` at read; that is fine for a
display ceiling and not fine here. A hand-edited or downgrade-round-tripped `data.json` can hold
`["../"]`, `[42]`, or a bare string where an array belongs. The normalizer takes `unknown`, is
total, and never throws.

Entry rules, in order: drop non-strings; trim; fold `\` to `/`; collapse repeated slashes; strip
leading and trailing slashes; **drop any entry with a `.` or `..` segment rather than resolving
it**; drop empties. List rules: dedupe preserving first-seen order; **never prune nested entries**;
cap at 256; empty result becomes `undefined`.

Two of those deserve their reason stated. Resolving a traversal entry would produce a rule that
matches nothing, which is silent false security; dropping it makes the entry visibly vanish from
the settings list, which the user can see and fix. And pruning `a/b` because `a` covers it is a
matching no-op but a data-loss action: the user who later removes `a` silently loses protection on
`a/b`. That is the same reasoning `CommandPermissionsSettings.svelte:419-456` gives for never
auto-removing stale entries.

**D7 — Fail-closed, deliberately inverting the project default.** ADR-0014 §1 establishes that a
partially-written record must degrade to prior behaviour so a client is never locked out.
**This feature inverts that, and the inversion is the decision.** The policy provider has three
states: `unknown` (no successful settings read yet this session) denies everything; `active(list)`
enforces; a read failure retains the previous state and logs `logger.error` once per transition.

One escape hatch keeps it proportionate: if the **first** successful read of the session returned
an empty list, a later read failure retains the empty list. Nothing is being protected, and locking
out a user who never touched the feature is pure harm with no benefit.

The justification is asymmetry of blast radius. Fail-closed costs "MCP looks like an empty vault
until the next successful read" — loud, obvious, self-healing, reversible. Fail-open costs "the
therapy notes went to an LLM because `data.json` was briefly unreadable" — silent and irreversible.
When one failure mode is recoverable and the other is not, the choice is not close.

It follows that the new list **must not** be routed through `createExclusionFilter`. Its
`() => false` degradation (`isUserIgnored.ts:35-43`) is correctly fail-open for the Obsidian setting
it governs. Two predicates, OR'd, with opposite failure postures.

**D8 — Two disclosure rules, deliberately different, and the difference is written down here so
nobody harmonises them later.** A tool that takes a path must not reveal that anything exists: its
answer for an excluded path is byte-identical to its answer for a path that was never there. The
three dispatch-level refusals (§D9) **do** reveal that a policy is in force. They reveal no folder
name and no count.

The threat model is "the agent must not read the folder", not "the agent must not know a policy
exists" — the user configured that policy deliberately, and a refusal that says nothing produces an
agent that retries forever. Without this paragraph, someone reasonably concludes that the
path-taking refusals should be informative too, and reopens the hole.

The same rule forbids a hidden-item count anywhere. Tools that report totals must count the
filtered set, which they do automatically because the facade filters at source. An
"N results hidden" affordance is a disclosure and must never be added.

**D9 — Three tools are disabled while the exclusion list is non-empty.**
`execute_obsidian_command`, `execute_dataview_query` and `execute_template`. Each reaches vault
content by a route the facade cannot follow: arbitrary in-process code from an opaque id,
Dataview's own index, and Templater JS holding Templater's raw `app`. Without this, "that folder is
unreachable" is false the moment a client calls the first of them.

The refusal is a fourth branch in `dispatch` (`toolRegistry.ts`), placed **inside** the
`isActiveFor` block at `:583-587` and **before** `schema.assert` at `:588-590`, preserving the
existing gates-run-before-validation property, and leaving the allowlist refusal (`:615-623`) and
the adaptive-inactive refusal (`:629-644`) strictly ahead of it — those name a more actionable
remedy. Returned, not thrown, flat `{content: [{type: "text", text}], isError: true}`, matching
the two branches beside it.

**`list_bookmarks` stays enabled.** Its items carry `path` strings and filter cleanly; only
`search` items are opaque, and those contain the user's query rather than any result. Disabling it
would buy nothing and remove a working tool.

**D10 — `getTags()` is rebuilt, not filtered.** Both consumers reach it through `getTagCounts(app)`
(`listTags.ts:31-38`, used at `:43` and `getVaultOverview.ts:66`), so guarding the one method covers
both with no call-site edits. With an empty list, delegate to native `getTags()` so output stays
byte-identical forever. With a non-empty list, iterate the already-guarded `getMarkdownFiles()` plus
`getFileCache` per file. A tag appearing only inside an excluded folder must be **absent**, never
present with a count of zero: a zero-count entry is a disclosure.

The rebuild will not match Obsidian's native aggregation in every edge case — nested tags,
case-merging, frontmatter tags with and without a leading `#`, occurrence count versus file count.
Gating on a non-empty list bounds the exposure to users who opted in, and a parity test against
native on an empty list bounds the divergence. It does not remove it, and the `list_tags`
description says so.

**D11 — The request scope is `AsyncLocalStorage`, entered at both dispatch points.** The guarded
`App` is built once at composition and closes over its policy, so the policy must be
request-scoped or phase 2 is a rewrite. `runWithPolicy` is entered in `toolRegistry.dispatch` and
in `promptRegistry.dispatch`; the facade reads the current store synchronously.

**A mutable module-level "current policy" is forbidden.** Phase 1 is vault-wide, so the bug is
invisible today and lands exactly when phase 2 ships: two tokens interleaving at an `await` read
each other's policy. Availability was the one open risk in the plan and it is measured (see
Context).

**D12 — Consent is a version, gated once, and never disables the protection.**
`excludedFoldersConsent: { version: number; acceptedAt: string }`. A boolean cannot express "you
agreed, but to an older set of terms"; the modal enumerates specific consequences, and if a later
release changes them, a bumped `EXCLUDED_FOLDERS_CONSENT_VERSION` re-prompts exactly once. The bump
rule is documented at the constant: **only when the set of consequences changes, never for
wording.** Without that rule someone bumps it for a typo, re-nags every user, and trains them to
click through.

Consent fires on the transition from inert to active, not on every folder added: the consequences
are identical for one folder or ten, and a user who has clicked "I understand" six times is not
reading the seventh. A stale version shows a banner and **never deactivates the policy** —
silently deactivating on upgrade would fail open, which §D7 forbids.

Consent and the first folder are written by **one** `updateSlice` recipe. Two writes would let a
crash between them leave policy-without-consent, the exact state the gate exists to prevent. The
`await` on the human is **outside** the recipe: `globalSettingsMutex` is non-re-entrant
(`settingsLock.ts`), and awaiting a dialog inside it would freeze every settings write in the
plugin for as long as the modal is open.

**D13 — Matching is case-sensitive, and the stale-entry marker is what makes that safe.** The
string matched against is `TFile.path`, exactly what Obsidian stores, and the settings picker
supplies it verbatim from `Vault.getAllFolders()`.

Which way each option fails is worth stating plainly, because the intuitive summary is wrong.
Case-insensitive matching only ever hides *more*, so it cannot leave a folder exposed; its cost is
over-hiding, and on a case-sensitive vault it makes "hide `Journal` but not `journal`"
inexpressible. Case-sensitive matching has the sharper failure: on macOS, where the filesystem is
usually case-insensitive, a user who hand-types `journal` while the folder is `Journal` gets no
protection at all, and the settings page lists the entry as though it were working.

That failure is accepted only because it is **visible**. An entry naming no existing folder renders
separately, marked as not found in this vault, and is **never auto-removed** — and a case typo is
precisely the case that marker catches, since `journal` is not in `getAllFolders()`. The picker and
the marker are therefore part of the security design, not polish. Cut either one for scope and the
feature ships a lie: `journal/therapy` looks protected and is not.

**D14 — This ADR does not reopen ADR-0018 Alternative J.** That alternative was declined because a
vault-content policy model did not exist. One exists now, and it is enforced on the `App` handed to
the tool and prompt surfaces — so exposing vault notes through `resources/*` becomes *mechanically*
possible where before it was not. It does not become decided. `resources/read` would need the
resource registry to consume the same guarded `App`, and listing vault notes still needs an answer
to what a per-token tool allowlist means on a surface that has no tool names. That remains a
separate decision, and ADR-0018 §Alternative J stands until something supersedes it.

**D15 — Three residuals are disclosed, not engineered around.** Each is named in the consent copy
and in `SECURITY.md`:

- **Downgrade.** An older build preserves `excludedFolders` (every recipe spreads `...current`) and
  does not enforce it. Not detectable from inside the plugin and not fixable from inside it either.
- **`show_file_in_obsidian`** becomes a no-op that still reports success, so a two-step probe
  reveals nothing was created. A weak signal, indistinguishable from a read-only vault, and the one
  place perfect indistinguishability is not reached.
- **Data at rest.** `embeddings/` holds `filePath` and `heading` for files indexed before their
  folder was excluded. The purge on list change is therefore required, not optional, and the index
  is filtered at both index time and query time — RFC #238's D3 discipline, extended to the new
  list.

**D16 — Phase 2 is per-token, additive, and union-only.** The field is
`mcpTools.tokenExcludedFolders: Record<tokenId, string[]>` — a sibling map in the same slice, not
inside `mcpTransport.tokens[]` (ADR-0014 Alternative E forbids the policy UI holding write access to
a secret) and not inside `toolLoading.profiles[tokenId]` (whose `updateToolLoading` choke point
exists to maintain a legacy mirror, and mirroring an exclusion list into a field an old build reads
but does not enforce is worse than not mirroring it).

The effective policy for a token is the **union** of the vault-wide list and that token's list.
A token may be more restricted than the vault, never less. The justification is the consent gate:
the vault-wide list is the user's statement about the whole vault, made once behind a dialog that
says "this applies to every client and every token". A token that could subtract would make that
sentence false retroactively, invalidating consent already given. The union rule is what keeps
phase 2 additive instead of a re-consent event.

Path exclusion enters ADR-0014 §4's precedence ladder as a new **layer 0**, above `userDisabled`.
Layers 1 to 4 all answer "is this tool servable"; layer 0 answers "is this path reachable", which
must hold even for a tool every other layer permits — including the always-active meta-tools. Those
take no paths today, so layer 0 does not bite them; the ladder still says so, or a future
path-taking meta-tool silently inherits an exemption.

---

## Alternatives considered

### A. Honour Obsidian's Files & Links → Excluded files everywhere, extending RFC #238 option A

Zero new UI, and every user who already configured that list is protected the moment they upgrade.
It is also the option RFC #238 actually chose for the semantic indexer, so there is precedent and a
working primitive.

**Rejected**, and the reason is what the list *means* rather than what it does. Obsidian's excluded
files is a display preference — the docs describe it as reducing noise in search and quick switcher.
Users put `attachments/`, `templates/` and archive folders in it for tidiness. Honouring it at the
tool surface would make those folders unreachable over MCP for every existing user, retroactively,
with no prompt and no changelog line they would think to read. A security control has to be
something the user chose *as* a security control.

### B. A tool→path-keys manifest checked in `dispatch`

The one seam that sees every `tools/call` in one place (`toolRegistry.ts:588-592`), with no facade
to write and no API surface to enumerate.

**Rejected as the primary seam.** The registry has no idea which argument keys are paths, and the
key names are not uniform — `path`, `paths`, `filename`, `templatePath` + `targetPath`, `from` +
`to`, `sourcePath`, `directory`, `folder`, `scope`. A manifest entry omitted for a new tool is a
silent, total bypass with no failing test, which is the exact failure mode §D1's criterion exists to
avoid. It also covers none of the twelve enumeration sites, the link graph, `getTags`, the
active-file family or `workspace.openLinkText`. As the only seam it would cover roughly 40% of the
surface.

**Retained in two narrower roles**, both real: the dispatch branch for the three unfilterable tools
(§D9), and a *test* oracle — a schema-drift assertion that every tool's string properties are
either a known path key or in a declared non-path allowlist, so a new tool with a `notePath`
argument fails the suite until someone classifies it. A manifest is the right shape for a test and
the wrong shape for an enforcement point.

### C. Inject a path predicate into `resolveTFile` and every direct call site

The smallest conceptual change, and it puts the check where a reader would look for it.

**Rejected.** Thirty-one hand-edited call sites, covering only named-file reads: nothing for
enumeration, the link graph, `getTags`, the active-file family or `openLinkText`. Worse,
`vault.getAbstractFileByPath()` used directly is an established local idiom with fourteen existing
sites, so the next tool written will use it and bypass the policy silently. It survives only as an
incidental consequence of §D1, where `resolveTFile` is handed the guarded `Vault` and needs no edit
at all.

### D. Per-tool filtering, tool by tool

Each tool learns about the policy and applies it in the way that suits its own shape, which yields
the best error message per tool.

**Rejected on two counts.** It is roughly fifty edits that must each be got right, and every future
tool is a new opportunity to forget. And the best-error-message argument is backwards: §D8 requires
the *absence* of a distinguishing message, so per-tool tailoring is not a benefit here, it is the
defect.

### E. Ship read and enumeration first, writes in a second release

Delivers something useful sooner, and writes are the smaller half of the request.

**Rejected.** Between the two releases a client can still write into a folder the settings UI
describes as hidden. A path policy that covers half is worse than none: the user believes the
folder is protected and behaves accordingly. If the scope had to shrink, the honest shape would be
to ship nothing and say so, not to ship a partial guarantee under a total-sounding name.

### F. Fail-open on a settings read failure, consistent with ADR-0014 §1

Consistency has real value. ADR-0014 §1's rule is load-bearing in four places, and a feature that
deviates creates an inconsistency someone will later "fix" without reading why.

**Rejected**, with the deviation stated loudly in §D7 for exactly that reason. The rule exists so a
half-written record never locks a client out of tools it should have. Here the same rule would
disclose the contents of a folder the user asked to hide, silently and irreversibly, because a file
read failed for a moment. The consistent choice and the correct choice diverge, and §D7 records
which one won and why.

### G. Write a value that makes an older build fail closed

The downgrade gap (§D15) is the worst property of the design. It could be closed by corrupting a
field the *old* build validates — `mcpTransport.tokens`, say — so that an older version refuses
every request rather than serving hidden folders.

**Rejected as data sabotage.** It fires on a legitimate rollback after a bug, and it locks the user
out of their own server with no diagnosable cause and no path back that does not involve editing
`data.json` by hand. A guardrail that bricks the product on rollback is not a guardrail. Recorded
here so the idea is not re-proposed as clever.

### H. Disable `list_bookmarks` alongside the other three

Simpler rule to state and to test: anything that can name a file gets disabled.

**Rejected on measurement.** `listBookmarks.ts:28-33` returns typed items whose file, folder,
heading and block variants all carry a `path` string, so they filter through the ordinary matcher.
Only `search` items are opaque, and a search bookmark holds the user's own query text, not results.
Disabling it removes a working tool and buys nothing. The rule stated in §D9 is therefore "what the
facade cannot follow", which is narrower and true, rather than "what can name a file", which is
broader and wrong here.

### I. A distinct skip reason for an excluded prompt transclusion

`promptTransclusion.ts` already has a `skipMarker(original, reason)` idiom with five reasons, and
adding `"excluded"` is one line and better diagnostics.

**Rejected, and flagged in the tests.** An excluded target must emit exactly
`<!-- prompt-transclusion: not expanded (not found) -->`. A distinct reason confirms the folder
exists to anyone who can read the rendered prompt, which is §D8's forbidden disclosure. This is the
instinctive move, which is why the test asserts the literal string and carries a comment saying why.

### J. Case-insensitive matching

Strictly safer on macOS and Windows, where the filesystem usually is. Matching more than asked is
the benign direction for an exclusion.

**Rejected, and not because it is unsafe.** It is the safer direction: matching more than asked
never leaves a folder exposed. It is rejected because it over-hides and removes expressiveness — on
a case-sensitive vault `Journal/` and `journal/` can be two genuinely different folders, and a
case-insensitive rule makes "hide one but not the other" impossible to state. §D13 takes the strict
reading, names the sharper failure it thereby accepts, and puts the mitigation in the UI, where a
case typo surfaces as an entry that resolves to nothing.

---

## Consequences

### Positive

- Every tool that reads, enumerates or writes vault content is covered, and a tool added later is
  covered without its author knowing this feature exists.
- No per-tool refusal code, and therefore no per-tool opportunity to leak a distinguishable error.
  The ~30 existing not-found branches become the policy's error surface for free.
- The `resolveTFile` call sites, all 17, are untouched.
- `getRecentFiles.ts:44-92`'s hand-rolled duplicate of `createExclusionFilter` becomes dead and is
  deleted, removing a second copy of logic that had already drifted from the shared one.
- Four duplicated folder-prefix matchers collapse to one shared helper for the two safe callers.
- Phase 2 per-token needs one line at the policy resolution point, because §D11 puts the policy in
  request scope from day one.
- The facade's default-deny gives the codebase a mechanical answer to "does this new Obsidian API
  need guarding", in the form of a failing test that names the member.

### Negative

- **A facade with a hole is a silent hole.** Default-deny plus the exhaustiveness test bound this;
  they do not eliminate it, because both are checked against `mockApp()` rather than Obsidian.
- **`mockApp()` is our model of Obsidian, not Obsidian.** A facade that is correct against the mock
  and wrong about real path normalization is green in CI and leaky in production. A manual
  end-to-end check in a real vault is part of the definition of done, permanently, not once.
- **`list_tags` and `get_vault_overview` change behaviour** for users with a non-empty list, by an
  amount bounded but not eliminated by §D10's parity test.
- **Three tools stop working** while any folder is hidden. For a user who lives in Dataview or
  Templater this is a real loss, disclosed at the consent gate rather than discovered later.
- **`rename_heading` no longer rewrites links inside excluded folders**, so a rename leaves stale
  links there. This is the correct trade — a heading rename must not silently edit a therapy note —
  and it is a behaviour change that belongs in the tool's description.
- **`find_orphaned_notes` reports more orphans**: a visible note whose only inbound link comes from
  an excluded note now qualifies.
- **Performance costs to measure, not assume**: a proxy hop per property access in per-file loops,
  and an O(E) filtered copy of `resolvedLinks` that `get_backlinks` reads twice. The link copy is
  memoised on a resolve epoch; both are benchmarked before shipping.
- **The downgrade gap cannot be closed** (§D15, Alternative G).

### Neutral

- `data.json` is byte-identical for any vault that never configures a folder (§D5).
- The existing test suite passing unchanged with an empty list is the acceptance criterion for the
  facade, and is the practical meaning of "no behaviour change when inert".
- `search_vault_smart`'s caller-supplied `filter.excludeFolders` keeps its current semantics and its
  current provider-side implementation. It is a convenience for the agent; this policy sits above it
  and does not replace it. The naming collision between the two is unfortunate and is addressed in
  the tool descriptions rather than by renaming a documented argument.
- `nativeProvider.startsWithFolder` and `smartConnectionsProvider`'s filter mapping keep their
  duplicated implementations on purpose: the first is on the hot path of a documented tool argument,
  the second forwards to a third-party matcher over a key that is not always a plain path.
  Normalising either could de-sync the two providers, and both are covered by the policy above them.
- Obsidian's own excluded-files list and this one remain independent, both applying where each is
  already honoured. Neither derives from the other, and the new seam deliberately does **not** also
  apply `isUserIgnored` — that would produce exactly the retroactive change §D4 refused.

---

## References

- Issue #499 — Vault-wide folder exclusion: no path policy reaches the tool surface (OMC-040)
- Discussion #493 — the originating request
- RFC #238 / PR #244 — Obsidian excluded-files support in the semantic indexer, options A and D3
- ADR-0014 — per-client tool profiles: §1 (fail-open default, inverted here in §D7), §4 (the
  precedence ladder that gains a layer 0 in §D16), Alternative E (why policy never lives inside a
  token record)
- ADR-0015 — the `tools/list` invariant, relevant to §D9's settings-derived tool set
- ADR-0018 — MCP Apps `ui://` resources, Alternative J (§D14)
- `SECURITY.md` — the trust-boundary and out-of-scope sections, amended by this work
- `docs/specs/` — the implementation plan and its R-NN success criteria
