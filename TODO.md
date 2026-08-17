<!-- project-tasks: prefix=OMC lastId=38 -->
# PROJECT TASKS

Updated: 2026-08-17 · Shipped: **2.1.0** · Open: 4 (P1: 0) · In review: 0 · In progress: 0 · Next release: none scheduled · Open items with no GitHub issue: 2 (both by design)

## Roadmap — after 2.0

**2.0.0, 2.0.1 and 2.1.0 all shipped 2026-08-17**, community scanner passed on 2.0.0, all four
release gates closed. The 2.0 roadmap is a record now and lives at the bottom of this file rather
than the top — it was the first thing this file showed long after it stopped describing anything to
do.

### 2.1.0, cut the same evening it was decided

Ships `OMC-035` (`expectedContent` on patch replace, `ADR-0019`) and the retirement of the
release-attached `.mcpb` (`OMC-031`). Tag `2.1.0` → `a52ff30`. **This file said hours earlier that
the next release would most likely be a patch triggered by a bug report; it was a minor triggered by
a feature merged the same day.** Kept rather than corrected, because the prediction was the honest
one at the time and being wrong about it is the information.

**Four things the cut measured, none of which a test could have told us.**

`version.ts`'s two-phase rewrite (`OMC-032`) ran for real for the first time, both phases under
`DRY_RUN=1` first. It works, and phase one's clean-tree preflight means an in-flight edit has to be
stashed around it.

`OMC-031` is confirmed on a published release rather than only in CI: `2.1.0`'s assets are exactly
`main.js` and `manifest.json`, and the notes carry the line pointing at the in-plugin export.

**`version.ts` does not touch `CHANGELOG.md`, and nothing notices** — now `#476`. The released
content would have stayed under `[Unreleased]` with every check green, since nothing in the gate or
in `release.yml` reads that file. Caught by hand because the dry run listed three files.

**No human verification ran before this cut, and that was a decision, not an oversight.** 2.0 held
three; 2.1.0 held none. Weighed at the gate and taken deliberately: the feature is off by default,
so a client that never sends `expectedContent` sees no change at all. The residual risk was named at
the time and is unchanged — the settings checkbox is a Svelte component that `check:svelte`
type-checks and no test covers, so nobody has looked at it in a running vault.

**No next release is scheduled, and that is the accurate statement rather than an omission.** There
is no 2.1 feature queued. Everything open is hygiene, verification discipline, or one design item
nobody has committed to. The next release will most likely be a patch triggered by a bug report
rather than by anything on this list, and planning as if a feature were coming would be inventing
one.

The open work sorts into three tracks. The tracks are not a sequence: nothing here blocks anything
else here. **Tracks 1 and 3 are both empty as of 2026-08-17.** Everything still open is Track 2:
it ships nothing to a user.

### Track 1 — silent-failure debt. Cleared 2026-08-17

Both entries closed the same day they were filed, and **both had a premise that did not survive
measurement** — recorded in their Done entries rather than quietly corrected. `OMC-034` was wider
than filed: the plugin's own `scripts/` was unchecked too, not just the root's. `OMC-028`'s stated
failure ("no compile error") was false, and the fix as planned would not have fixed the real one.

`bun run check` now reaches every `.ts` in the repo, and a field added to `SearchResult` fails inside
`mcp-apps` with the field's name in the message.

### Track 2 — verification and process. Ships nothing to a user

None of these reaches a user; they cost real hours when they bite, and two already have.

- `OMC-030` / `#468` — a vault verification can run against a stale build, and one did: the first `B3` run
  failed all four assertions against an Aug 11 `main.js` and read as a defect in new code. Down to
  one open half — relinking the Labs vault, a human step. Its "unexplained" half turned out to be a
  real defect and left as `OMC-038`.
- `OMC-038` / `#483` — **closed 2026-08-17**, the day it was split out. `prompts/list` cached a scan
  taken before the file was indexed and never re-checked, so a prompt could stay invisible for a
  whole session. Found by reading `OMC-030`'s "may have no close condition" half rather than
  believing it.
- `OMC-029` — measured figures written into comments are guarded by nothing. Deliberately has **no**
  mechanical fix and no issue: the defence is procedural and belongs in the habit.
- `OMC-036` / `#476` — **closed 2026-08-17**, same day it was filed. `version.ts` now refuses a cut
  whose `CHANGELOG.md` is not ready, and tolerates that one file being uncommitted so the notes and
  the bump land in the same commit.

### Track 3 — design. Cleared 2026-08-17, same day it was written down

`#445` and `#465` were filed here as unscheduled design and both closed within the day: the survey
fed `ADR-0019`, the ADR was written, and `OMC-035` implemented it (`ffca69f`, PR #473). The track
went from "would earn a minor if it lands" to merged without ever being scheduled, which is worth
noticing rather than tidying away — the estimate was wrong by the width of the whole track.

**It is on `main`, not in a release**, and this file's own `D5` entry is why that distinction is
written out rather than assumed. No release is scheduled, so the earliest a user sees this is
whenever the next one is cut.

**One thing does not close with it.** The guard is off by default, so it protects the clients that
opt in and nobody else until the next major flips `requireWritePreconditions`. That flip is a real
piece of future work with no entry anywhere, on purpose: it belongs to the next major's own
planning, not to a ledger item that would sit open for months. `ADR-0019` is where it is written
down.

### Not on any track

- `OMC-010` / `#416` — parked on an external trigger, see Parked below.
- `OMC-027` — decided, not a defect. The MCP Apps empty state names the vault rather than the query
  because the payload carries no query string. Kept as a record, not as work.

## Tracking — ledger ↔ GitHub issues

The two lists had drifted until the overlap was **one item out of nine**. Reconciled 2026-08-17; this
section exists so the next drift is visible rather than rediscovered.

| Ledger | Issue | State |
|---|---|---|
| `OMC-030` | `#468` | verification against a stale build |
| `OMC-034` | `#467` | **both closed 2026-08-17** — type-check coverage |
| `OMC-028` | `#466` | **both closed 2026-08-17** — the projector now fails when `SearchResult` grows |
| `OMC-010` | `#416` | both parked on the same external trigger |
| `OMC-027` | — | ledger-only **on purpose**: decided, not a defect |
| `OMC-029` | — | ledger-only **on purpose**: no actionable close condition, the defence is procedural |
| `OMC-035` | `#445` | **both closed 2026-08-17** — `ADR-0019` decided it, `ffca69f` shipped it, the issue closed with what diverged from its own proposal |
| — | `#465` | **survey done and consumed by `ADR-0019`** — closed 2026-08-17 |
| `OMC-036` | `#476` | **both closed 2026-08-17** — the guard ships with the dirty-`CHANGELOG.md` allowance the issue's proposal turned out to need |
| `OMC-037` | `#481` | **both closed 2026-08-17** — found while archiving a branch: any tag published a release |
| `OMC-038` | `#483` | **both closed 2026-08-17** — split out of `OMC-030` once the "unexplained" half turned out to have a mechanism |
| — | `#427` | **closed 2026-08-17** — it had been open a week after 2.0.0 shipped and `R-18` verified it |

**Which surface gets what.** An issue is for anything a contributor could hit, pick up, or reasonably
ask about — bugs, feature work, research with a close condition. The ledger is for verification
records, measured findings, decisions and process discipline, which is most of this file. An item
that is genuinely both goes in both, and this table is where that is checked.

**Two rules this table enforces.** When a release ships, close the issues it shipped — `#427` is the
cautionary case. And a finding recorded inside a **closed** ledger entry is lost: `OMC-034` spent a
day buried in `OMC-032`'s closure text before it became an entry and an issue of its own.

## Open items — the entries the roadmap's tracks point at

Two of these are deliberately **not** actionable and say so in their own text: `OMC-027` is a decided
non-defect and `OMC-029` has no mechanical fix by design. They are kept as records. The section used
to be titled "actionable now", which was false for both.

- [ ] `OMC-030` **P2** #468 A vault verification can silently run against the wrong build, and one
      did. The Labs vault carries a hand-copied `main.js`, not a `scripts/link.ts` symlink, so a
      fresh `bun run build` in the repo changes nothing there until someone copies it across.
      The first `B3` run on 2026-08-16 failed all four of its assertions for exactly this
      reason, and it read like a defect in freshly merged code. **The version string cannot
      catch it**: repo and vault both report `1.0.1` until the 2.0 cut, so `serverInfo.version`
      discriminates nothing. The `initialize` capabilities do — a build predating `e3dcd8c`
      answers `prompts.listChanged: true` and carries no `resources` key at all. **So every
      vault verification should read the capabilities first and pin which build answered**. `B3`
      and `R-18` both did, once burned, and `A2` did too. Nothing open still has to, but the next vault verification will. Replacing the copy with the symlink would
      fix it at the root but means deleting a directory holding `data.json` and `embeddings/`,
      which is its own risk and its own decision. **Also unresolved, recorded rather than
      explained**: in the 15:10 run `prompts/list` stayed frozen on its baseline and never saw
      the probe at all, while at 21:44 the identical action worked. Either the probe was not
      created where it was believed to be, or the instance was left in a bad state by swapping
      `main.js` under a running Obsidian. Until that is understood, confirm `prompts/list` sees
      the probe before concluding anything about notifications
      **UPDATE 2026-08-17 — the silent half is fixed, and its mechanism was in this repo, not in
      the vault.** `scripts/link.ts` decided with `existsSync(targetPath)`, which is true for any
      existing path including a plain directory, so running `bun run link` against a vault whose
      plugin directory is a copy printed **"Symlink already exists."** and did nothing. The tool
      whose only job is to guarantee the link claimed success in precisely the case where the link
      was absent — not silence, an active false claim, and the reason this stayed invisible.
      It now inspects with `lstat` and refuses: a copied directory is named as a copy, with
      `data.json` and `embeddings/` cited as the reason it will not act and `mv` given as the
      recovery step; a symlink pointing at a **different** checkout is refused too, which was
      equally silent before and equally stale-making. It never deletes. A refusal exits non-zero,
      which `main().catch(console.error)` previously made impossible.
      Verified by running the real script against four scratch vaults (absent / copy / correct
      link / foreign link → create, refuse, ok, refuse; exit 0/1/0/1), never against the Labs
      vault. Mutation-checked both ways. `readlink` may return a **relative** path and is resolved
      against the link's own directory, not the cwd — resolving against the cwd would refuse a
      perfectly good link.
      **UPDATE 2026-08-17 — the `prompts/list` mystery is not a mystery, and it is not about the
      vault.** It is a defect in plugin code, split out as `OMC-038` / `#483` and fixed there:
      `discoverPrompts` reads frontmatter out of `app.metadataCache`, which lags the vault, and the
      memoized lister is keyed on an epoch only a **vault** event advances — so a list served inside
      the indexing window omits the new prompt, caches that answer, and never re-checks, because
      indexing is not a vault event. Both guesses recorded above were unnecessary. Neither is
      refuted either: the mechanism reproduces the symptom exactly, nothing recovers what actually
      happened at 15:10, and the standing rule to confirm `prompts/list` sees the probe costs
      nothing and stays.
      **UPDATE 2026-08-17 — the recovery `link.ts` prints was half of one, fixed in `2912174`.** It
      named `mv` and stopped, and the two steps it skipped are the ones that lose data: the symlink
      makes the **repo root** the plugin directory, so `data.json` and `embeddings/` have to be
      copied *there*, not left behind in the vault. Both are gitignored at the root. Found by
      compiling the sequence by hand for a real vault; verified by running what the script prints,
      end to end, against a scratch vault.
      **And the Labs vault turned out to be on iCloud Drive** (`~/Library/Mobile Documents/
      com~apple~CloudDocs/Vaults/Labs`), which nothing in this repo recorded and which changes the
      advice. Two claims, not one: *certain* — the link's target is outside the synced container, so
      any other device on that vault finds a plugin folder it cannot resolve; *unverified* — whether
      iCloud leaves the link itself alone, which nothing here has measured and for which this
      machine has no precedent (no symlink exists anywhere in iCloud Drive, checked to depth 6).
      `link.ts` now detects it on the **create** path only and refuses pending `ALLOW_ICLOUD=1`,
      keeping the two claims separate in the message. The plugin directory is `mcp-tools-istefox`,
      the manifest id — not `obsidian-mcp-tools`, which is what a hand-written recovery guessed.
      **Still open, deliberately, and now this alone:** the Labs vault is still a copy, and moving
      that directory is a human step this script asks for rather than performs
      <!-- src:session opened:2026-08-16 updated:2026-08-17 -->
- [ ] `OMC-027` **P3** MCP Apps empty state names the vault, not the query. The implementation
      plan's task 6 step 2 specified that the empty state should name "the query"; the result
      payload carries only `vaultName`, never the query string — both projections are called as
      `(results, ctx.app.vault.getName())` — so the shipped empty state renders "No results
      found in `<vault>`." instead. SPEC R-10 requires only "an explicit empty state for zero
      results" and does not mention the query, so the requirement is met and the plan was
      stricter than the SPEC on a detail the data cannot support. Decided, not a defect. A
      follow-up would carry the query into the payload, touching the payload type, both
      projections, both tools, the renderer and its tests. **Observed in production 2026-08-16
      during `R-18`**: a zero-match query renders `No results found in Labs.` in Claude Desktop,
      so this is now a measured behaviour rather than a read of the code <!-- src:session opened:2026-08-16 updated:2026-08-16 -->
- [ ] `OMC-029` **P3** Measured figures written into comments are guarded by nothing. The
      generated-asset drift tests compare **identity** — is `searchResultsAppSource.ts` what
      the generator would produce from the shell and the bundle — and never the **content** of
      a hand-typed measurement. R-08's `main.js` delta went stale exactly this way: it was
      measured against task 4's stub page, survived unchanged through task 6's full view, and
      three copies of a wrong number passed every gate until a reviewer rebuilt and compared.
      There is no cheap mechanical fix (a test asserting a byte count would fail on every
      unrelated change), so the standing defence is procedural and belongs in the habit, not in
      CI: whenever a generated artifact changes, re-measure with a clean `bun run build` plus
      `stat` and sweep the repo for the previous figures <!-- src:session opened:2026-08-16 -->

## In Progress

_none_

## Parked — external trigger, nothing to do until it fires

- [ ] `OMC-010` **P3** #416 MCP Tasks: watch item only. **Trigger re-checked 2026-08-17 and it has NOT fired, in a sharper way than this entry assumed.** `modelcontextprotocol.io/extensions/client-matrix` tracks three official extensions — MCP Apps, OAuth Client Credentials, Enterprise-Managed Authorization — and **Tasks is not among them**: no column, no row, and the Tasks overview page points back at that same matrix. So it is not "no client declares it yet", it is "nobody's support is recorded anywhere". Implementing now would mean building against a spec no listed client is known to speak, with no way to verify one end-to-end call. Watch condition sharpened from "when the tiering page's client matrix moves" to **a Tasks column appearing there with at least one client checked**. The MCP Apps half moved to OMC-016 and shipped in 2.0.0 — and that matrix now lists **eleven** clients supporting `io.modelcontextprotocol/ui` (Claude web, Claude Desktop, VS Code Copilot, M365 Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor, Archestra.AI, PostHog Code), against the **one** `R-18` verified. Both of `R-18`'s host findings are host-specific: `_meta` forwarding and the refusal of `obsidian://`. On a client that follows the scheme the click would open the note and the URL encoding — recorded as untested by any means — would finally be exercised <!-- src:session opened:2026-08-05 updated:2026-08-17 -->

## Blocked / Decisions Needed

_none_

OMC-007 was the last entry here. It left on 2026-08-10 and closed the same day: what gated it was the `2026-07-28` lifecycle decision, OMC-008 made that decision additive, and the remaining work turned out to be one publish call. Nothing currently waits on a user decision or an external input.

## Standing notes — true until something changes

**Conformance tooling note.** The published CLI (`0.1.16`) has no 2026 scenarios at all — no
`draft` suite, no `server-stateless`. Those live only on the repo's `main` (`0.2.0-alpha.10`) and
must be run from source. Against the published suite we pass every scenario that applies to our
surface; the failures are fixture-dependent (it expects the reference server's `test_*` tools and
`test://` resources) or optional capabilities we chose not to implement: `logging/setLevel`,
`completion/complete` (that is #347, closed as not planned — this is the first visible cost of
that call) and resource subscriptions.

## Project Map

- **Entry point**: `packages/obsidian-plugin/src/main.ts` · shim `packages/obsidian-plugin/scripts/connectorShim.js`
- **Modules**: `src/features/mcp-transport` (HTTP, tokens, registry) · `src/features/mcp-tools` · `src/features/mcp-client-config` (`.mcpb`, shim source) · `src/features/adaptive-tool-loading` · `src/features/prompts` · `src/features/semantic-search` · `packages/shared`
- **Build & test**: `bun run check` is `tsc --noEmit && bun --filter '*' check` and now reaches **every** `.ts` in the repo — a root `tsconfig.json` covers `scripts/**`, and the plugin's `include` covers its own `scripts/**` (`OMC-034`). · `bun run build` · `bun run release` (build + zip, **no `.mcpb`** — that is a per-token export from inside the plugin) · test-cmd `bun run check && bun test && bun run format:check`, plus `bun run check:svelte` and `bun run test:mcpb` from `packages/obsidian-plugin`, plus `python3 -m unittest discover -s scripts` for the Windows bridge (a step in CI's `check-and-test` since 2026-08-17, so it blocks a merge) and `bun test scripts/` for the root scripts. `bun run test:conformance` is **not** in that gate: it runs nightly from `.github/workflows/conformance.yml`, so a hand run before merging a transport change is the only pre-merge conformance signal there is
- **Key ADRs**: ADR-0019 write preconditions across calls (decided, unscheduled) · ADR-0013 pure-Node `.mcpb` shim · ADR-0014 per-client tool profiles · ADR-0015 `tools/list` stability invariant · ADR-0010 split registry disable states · ADR-0016 two protocol eras on one endpoint · ADR-0017 `prompts.listChanged` split by era
- **Invariants**: transport is stateless and POST-only, `GET /mcp` is 405 by design · one endpoint serves both protocol eras, classified per request off a single body read, and a body carrying no `_meta` envelope claim is legacy · every settings write goes through `SettingsStore.updateSlice` under the process-wide mutex · a bearer token string never changes silently · the shim fails closed on an unknown token id · a polymorphic tool never declares an `outputSchema`

## 2.0 release record — Gates A–D, all closed 2026-08-17

Kept whole, below the open work rather than above it. The per-gate entries are the verification
record for 2.0: measurements, what was and was not exercised, and the traps found on the way. The
target statement below is preserved as written at the time.

Target: **MCP Apps as the headline, OMC-023 as what earns the major.**
Semver alone would say 1.1.0 — the 45 commits since tag `1.0.1` break nothing. Two of them move
the legacy `initialize` result, but only one is a retraction: ADR-0018 *adds* `resources` to a
reply that never carried it, which no client can break on. OMC-023 withdraws a claim already
made — `prompts.listChanged` from `true` to `false` — and that is the one place where the higher
number buys something: its entry is blocked on "a release that is allowed to move the legacy
reply", and this is that release.

Out of 2.0: OMC-010 (#416, parked, no client declares Tasks) and #445 (`expectedHash`,
unscheduled, @Madulone may prototype it).

A → B → C → D is dependency order, not calendar order: Gate A is independent of Gate C, and
Gate C is by far the longest piece.

### Gate A — verification debt. Blocks any release, 2.0 or not

- [x] `A1` OMC-024 in a real vault. **Done 2026-08-15 in the Labs vault, behaviour asserted and
      UI observed.** Two tokens driven on different eras: `default` took 3 legacy calls, a second
      token 2 modern ones, and the counters came back `default legacy 26 · modern 0`,
      `ookNoFmFPLPg legacy 0 · modern 2` against a global `legacy 48 · modern 4`. So the two rows
      disagree, and the global exceeds their sum by 22 legacy and 2 modern — that gap is the
      pre-split history belonging to no token, which is the prediction OMC-024 made when it
      refused to attribute it, now measured rather than argued (the 2 orphan modern calls are the
      hand-built probes of 2026-08-09). All five scripted checks green, `sum(byToken) <= global`
      included. **All three `eraLabel()` branches
      (`AccessControlSection.svelte:122-130`) are now drawn**, which the two-token setup alone
      could not do: a follow-up modern call on `default` forced the mixed state and the row
      renders `adaptive 16 tools 2025 · 26 + 2026-07-28 · 1` in full at that pane width, no
      ellipsis and no overlap with the tool count. The rendered string matches what `data.json`
      held, character for character. **Still not exercised:** the pre-existing-vault shape (no
      `eraCountersByToken` key at all) — it edits `data.json`, so it moved to A2's checklist with
      a backup step rather than being run against a live vault mid-verification. **Run and
      passed 2026-08-16 as part of `A2`**; see there
- [x] `A2` **`.mcpb` smoke test on Claude Desktop. Done 2026-08-16**, outstanding since OMC-008.
      **The mechanical half**: `bun run test:mcpb` green on `main` at `e3dcd8c`, all four checks
      including the #412 built-in-Node regression guard.
      **The half no harness reaches** was satisfied by `R-18`'s own traffic, which nobody
      planned: the connector is installed in Claude Desktop as a local `.mcpb` extension with
      **"Use Built-in Node.js for MCP" ON** — the default, and the exact path that failed in
      #412 — and both search tools returned real vault data through it. That is the stated pass
      criterion, "a tool call returns data", not "shows as running".
      **A false alarm worth keeping, because it will recur.** The installed bundle's
      `server/index.js` hashes `6a0056d1…` while `scripts/connectorShim.js` hashes `72fe569e…`,
      which reads as a stale bundle and is not one: `generateMcpb()` substitutes three
      placeholders — `__OBSIDIAN_MCP_VAULT_PATH__`, `__OBSIDIAN_MCP_CONFIG_DIR__`,
      `__OBSIDIAN_MCP_TOKEN_ID__` — so a shipped shim can never hash equal to its own source.
      Diff, do not hash: a freshly exported bundle differed from the source in exactly those
      three lines and nowhere else, which is how "the installed extension is current" was
      actually established. A reinstall was therefore not needed and was not done.
      **A1's tail, run here with the plugin stopped on both sides of the edit** (it writes
      `data.json` from memory on unload, so an edit made while it runs is silently reverted):
      backed up `data.json`, removed `mcpTransport.eraCountersByToken`, restarted. The token row
      renders `Default · adaptive · 17 tools` with **no era label at all** — the correct
      `eraLabel()` branch for absent counters — the global `Requests served` still reads
      `2025 era 80 · 2026-07-28 era 46` from `eraCounters`, and the server answers `initialize`
      and `prompts/list` normally. Nothing dereferences the missing map. Backup restored and the
      restore survived a reload.
      **Not exercised**: Claude Desktop's `mcp-server-*.log` was never read, so the shim's own
      stderr under the built-in-Node loader remains unobserved (it is not written on that path
      by design); and no fresh install was performed, since the installed bundle was proven
      current — an install-from-scratch on a machine that has never had it is still untested
- [x] `A3` `bun run test:conformance` by hand. **Done 2026-08-15 on `main` at `6c8e182`:
      `Passed: 26/28, 2 failed, 2 warnings`, exit 0, and the four red checks are exactly the
      four in `expected-failures.yml`.** No transport regression from OMC-007 or OMC-024, which
      is what this run existed to rule out. The two FAILUREs are the capability pair, the two
      WARNINGs the list-changed pair; both pairs need a shipped fixture tool this project
      refuses to ship (ADR-0016 Alternative F)
- [x] `A4` Close #407. **Done 2026-08-15, closed as completed.** All three of its Phase 2 open
      problems were verified rather than assumed. The Windows bridge needs nothing:
      `obsidian_mcp_bridge.py` contains zero `_meta` occurrences and negotiates through
      `initialize`, so it classifies legacy on every request; its held-open
      `subscriptions/listen` connection becomes necessary only when the legacy era is retired,
      which ADR-0016 §8 already gates behind a measured trigger that is nowhere near firing
      (`legacy 22 · modern 2`). `search_vault_smart` progress rides the same untouched legacy
      path and stays unverified on the modern era on purpose. The `tools/list` invariant is
      confirmed in writing by ADR-0015 §1, not by assumption. One record correction went with
      the close: #407 claimed the `relatedRequestId` mechanism was "retired" by Phase 2. It was
      not — the legacy era still uses it, and `notify.toolsChanged()` sits alongside it

### Gate B — OMC-023, the only change that requires the major

- [x] `B1` Decide: honour or retract. **Done 2026-08-15 — ADR-0017, and the answer is
      neither of those two.** The choice is three-way once the eras are separated, and
      "honour on both" is architecturally impossible: the legacy transport is POST-only with
      `GET /mcp` at 405 by design, so a vault file event has no request in flight to ride, and
      no deferred-notification queue exists (`flushPendingCalls` is persistence, not a queue).
      Decided: **modern declares `listChanged: true` and honours it, legacy declares `false`.**
      What made it decidable was checking that the prompt set is genuinely dynamic — prompts
      are vault files under `Prompts/`, `vaultWatcher.ts` already watches
      create/delete/rename/modify and invalidates an `epoch` cache in `prompts/index.ts` — so
      `listChanged: true` was a true claim that was never wired, not a false one. SDK facts
      verified by reading `@modelcontextprotocol/server@2.0.0`: `:1550` `?? true` means an
      explicit `false` survives, `:164` gates delivery on that same bit, and
      `notify.promptsChanged()` exists as the exact twin of the `toolsChanged()` OMC-007 wired
      at `mcpServer.ts:137`
- [x] `B2` Implement ADR-0017. **Done 2026-08-15, code and unit tests; observed end-to-end on
      2026-08-16 by `B3`.** `buildMcpServer` takes `promptsListChanged` (default `false`, the legacy
      shape) and the two call sites are the era discriminant; `McpService.notifyPromptsChanged`
      wraps `modernHandler.notify.promptsChanged()`; the prompts feature schedules a debounced
      re-scan on any watcher event and publishes only when the canonicalised list differs.
      `eraRouter.test.ts`'s full-body `initialize` pin now reads `prompts: { listChanged: false }`
      — that assertion IS the record of what OMC-008's Invariant 1 forbade and 2.0 allowed.
      Conformance re-run: 26/28 unchanged, baseline still four entries.
      **Two things the mutation checks taught, both kept in comments:** counting notifications
      does not pin the debounce, because the list comparison already collapses a burst on its own
      (deleting the timer reset left a notification-counting assertion green) — the re-scan is the
      cost the debounce avoids, so the test counts `getMarkdownFiles` calls instead; and
      `resetMockVault()` clears the registered vault-event handlers, so a test that resets the
      mock mid-run unhooks the watcher it is exercising. **Remaining**: no unit test can see the
      notification reach a client, and no shipping client opens a `subscriptions/listen` stream —
      a hand-built listen client against a real vault is the only way, in the shape of A1's
      script. That is `B3` below. **`B3` ran on 2026-08-16 and B2 is now verified end to end**:
      the notification was watched arriving at a client, and the debounced comparison was
      watched staying silent on a change no client could see <!-- src:session opened:2026-08-15 updated:2026-08-16 -->
- [x] `B3` **Watch the notification actually arrive. Done 2026-08-16 against the Labs vault**,
      plugin built from `main` at `e3dcd8c`, port 27200, token `default`, three hand-built
      `subscriptions/listen` streams held open at once. Every assertion the entry asked for was
      observed, and the notification reached a client for the first time.
      **The ack**: first frame on the stream is `notifications/subscriptions/acknowledged`,
      echoing `{"promptsListChanged":true}` with subscription id `100`. **The create**: exactly
      one `notifications/prompts/list_changed`, carrying `_meta` subscription id `100` — the
      ack's own id, so it is addressed to that subscription rather than broadcast. **The
      delete**: exactly one, twice over (21:45:35 and 21:48:21). **The comparison**: a body edit
      that changed the file on disk but changed no field a client can see — no name, no
      description, no argument declaration — produced **nothing**, though the `modify` event
      fired. That is the one place a per-event implementation would have failed, and the only
      way to reach it.
      **A bystander subscribed to `toolsListChanged` received nothing while all of this
      happened**, and its filter was genuinely honored (`{"toolsListChanged":true}` in its own
      ack), so the silence is routing rather than an inert subscription.
      **Correction to this entry's own procedure, found by running it**: "save the same file
      again unchanged" cannot test anything. Obsidian does not write an unmodified file, so
      `Cmd+S` fires no vault event and the resulting silence is vacuous. The body-edit case
      above replaces it and is strictly stronger.
      **Unplanned observation worth keeping**: a stream asking for `resourcesListChanged` acks
      with `"notifications":{}` — `honoredSubset` narrows the requested filter against declared
      capabilities, and `resources.listChanged` is `false` (ADR-0018), so the server tells the
      client honestly that it will deliver nothing rather than accepting a subscription it
      cannot serve.
      **Assertion 4, the legacy era, is structural and was measured as such**: `GET /mcp`
      answers 405 and a legacy `initialize` against the running vault returns
      `prompts.listChanged: false`. There is no stream for a notification to ride, which is
      stronger than observing that none arrived.
      **Not exercised**: a renamed prompt (a distinct watcher event from create/delete); two
      prompt subscribers at once; any real host, since none opens this stream — which is why the
      verification had to be the client <!-- src:session opened:2026-08-15 updated:2026-08-16 -->

### Gate C — OMC-016 / #427, the feature that carries the number

The spike on `spike/427-mcp-apps-ui-resource` already proved Claude Desktop reads and renders
a `ui://` resource from this connector. Hard requirements, already measured: declare
`capabilities.extensions` with `io.modelcontextprotocol/ui` (the generic `resources`
capability alone does nothing), mime type exactly `text/html;profile=mcp-app`, and complete
the `ui/initialize` → `ui/notifications/initialized` handshake or the host leaves the iframe
blank.

- [x] `C1` A real `resources` capability, not the spike's shortcut. **Done 2026-08-16.**
      `buildMcpServer(tokenId)` declares `resources: { subscribe: false, listChanged: false }`
      and `extensions: { "io.modelcontextprotocol/ui": ... }` explicitly, from the single
      construction site, on both eras. `ResourceRegistryClass`, shaped like
      `PromptRegistryClass`, serves `resources/list` and `resources/read` against one static
      `ui://mcp-connector/search-results` entry; `resources/templates/list` is left to the
      SDK, which answers `{resourceTemplates: []}` once the capability is declared. R-14 holds:
      grepped, no vault path appears in either response
- [x] `C2` The handshake via `@modelcontextprotocol/ext-apps` instead of hand-rolled
      `postMessage`. **Done 2026-08-16.** The view bundles the `./app-with-deps` entry (1.7.5),
      self-contained, no `zod/v4`, no SDK v1. Measured `main.js` delta from a clean
      `bun run build`: 2,649,591 B → 3,011,578 B, **+361,987 B, +13.66%**, below the +20%
      Alternative G trigger, so ext-apps was kept rather than falling back to a hand-written
      handshake
- [x] `C3` `search_vault_smart` / `search_vault_simple` results as a ranked, clickable list
      with score and line anchor. **Done 2026-08-16.** Both tools' `content` array is
      byte-identical to the pre-change output (golden-bytes test, R-06); the structured row
      payload rides the result's own `_meta` under `io.github.istefox.mcp-connector/searchResults`,
      success branch only, capped at 50 rows with excerpts clipped to 400 characters. The view
      renders one list, omits absent fields (`score`, `line`, `heading`) without branching on
      which tool produced the row, and click-out opens
      `obsidian://open?vault=...&file=...`, degrading to a shown vault-relative path when
      `openLink` is unavailable or refuses. **Not yet observed rendering in a real host — that
      is `R-18` below**
- [x] `R-18` **The view in Claude Desktop, against a live vault. Done 2026-08-16, all nine
      checks run against the Labs vault** (81 notes, plugin from `main` at `e3dcd8c`, token
      `default`, `search_vault_smart` session-activated for the run because the adaptive profile
      had it at 2 calls of 3).
      **The decisive unknown is settled: Claude Desktop DOES forward the tool result's `_meta`
      to the view.** Real vault paths and real excerpts rendered, so the payload arrived intact.
      **ADR-0018 Alternative D (`structuredContent`) is therefore retired as a contingency** —
      it existed for the case that just failed to happen.
      Per check: (1) `tools/list` carries `_meta.ui.resourceUri` on both search tools, in both
      the nested and the legacy flat form, with no `outputSchema`; (2) the host fetched the
      resource — proven by the render, since nothing else produces that page; (3) a real-height
      iframe with a ranked list, not a card and not a strip; (4) payload intact, above; (5)
      `search_vault_smart` rows carry heading, `score 0.30`, `line 16`, and the simple tool's
      rows carry none of them, with no branching on which tool produced the row; (6) a
      zero-match query renders `No results found in Labs.` — the vault, not the query, which is
      OMC-027's decision seen in production; (7) **the click does NOT open Obsidian: Claude
      Desktop refuses the `obsidian://` scheme, and the row degraded to revealing the
      vault-relative path**, which is the designed fallback and is host policy this project
      cannot change from the package; (8) the theme followed a dark→light switch with no reload
      and no re-run of the search; (9) a 2025-era client gets `content[0].text` in the shape it
      always had, no `structuredContent`, no `outputSchema` — it also receives the pointer and
      the payload in `_meta`, which it ignores, so search responses are heavier for every client
      including the ones that render nothing.
      **Not exercised, and each for a stated reason.** The `obsidian://` URL encoding was never
      tested at all: check 7 was meant to exercise it through a path with a space, but the host
      refuses the scheme before any URL is built, so the encoding remains unverified by any
      means. The `index_building` branch of check 6 was measured at the connector (the tool
      returns `errorCode: "index_building"` with `filesIndexed/filesTotal`, and on `isError` the
      `_meta` payload key is correctly absent so the view falls back to `content[0].text`), but
      the semantic index finished rebuilding mid-session and the host-side rendering of that
      error was never seen. The 50-row cap and `truncated: true` were not reached. The vault
      name has no space in it, which the entry flagged as the first thing encoding gets wrong

### Gate D — the cut

- [x] `D1` CHANGELOG entry for 2.0, in the user-facing register 1.0.0 and 1.0.1 already use:
      what changes for someone using the plugin, not what changed in the code. **Written
      2026-08-17** as `## [2.0.0] — 2026-08-17`: three Added (the MCP Apps search view, the
      additive `2026-07-28` era, the per-token request counters), one Changed (the
      `prompts.listChanged` retraction, which the entry states outright is why the number is 2.0
      rather than 1.1.0), four Fixed (#444 booleans, #430 auto provider, #419 cross-client
      staleness, #437 protocol-version error body). Derived from the 8 user-visible commits in
      `1.0.1..HEAD`; the other 22 are docs, CI and internal cleanups and are deliberately absent.
      **The MCP Apps entry does not promise the click opens the note** — `R-18` measured Claude
      Desktop declining the `obsidian://` scheme, so the entry says the client decides and
      describes the path-revealing fallback. A CHANGELOG must not promise what a verification
      disproved
- [x] `D2` Confirm `minAppVersion` stays `1.7.2`. Raising it strands users and nothing in 2.0
      requires it. **Confirmed 2026-08-17, by inspection rather than assumption**: the only
      Obsidian APIs newly referenced in `src/` across `1.0.1..HEAD` are `app.vault.adapter` and
      `app.vault.getName`, both long predating 1.7.2. Manifest still reads `1.7.2`
- [x] `D3` **2.0.0 is released, 2026-08-17.** Tag `2.0.0` → `0698be2`, `release.yml` run
      `32010559398` green on every step (build, `.mcpb` validation, attestation, create, publish),
      release published 08:29:36Z with three assets. `main.js` on the release is **3,011,578 B**,
      byte-identical to the local build, so the release bundle is the one that was measured and
      verified. No PR against `obsidian-releases` — the plugin is already in
      `community-plugins.json` as `mcp-tools-istefox`.
      **`bun run version major` did NOT complete it, and cannot on this repo any more.** It made
      the version commit and the tag, then its `git push origin main` was refused by the ruleset.
      Cut by hand around it; the procedure and the reason are `OMC-032`, **which closed the same day
      by rewriting the script into two phases — so this is the last release cut by hand, and the next
      one is the first test of the replacement**.
      **The published `.mcpb` is the pre-ADR-0013 npx/mcp-remote bundle, not the pure-Node shim
      this project ships from the plugin.** Found by inspecting the asset after publishing, on a
      3,577 B size that did not fit a 38 KB shim. Shipping since 2026-07-15, so not a 2.0.0
      regression; recorded as `OMC-031` rather than fixed here, and it is the one thing in this
      release nothing in the gate speaks for. **`OMC-031` closed it 2026-08-17 by retiring the
      asset, and corrected this framing: the divergence was deliberate, not forgotten**
- [x] `D4` **Passed on the 2.0.0 release, 2026-08-17.** The Obsidian scanner runs **on the release, never before**. Known constraints that
      have already failed a release: no `eslint-disable` on `obsidianmd/*` rules, and
      non-plugin code stays out of `src/` because the scanner lints `src/**` only
- [x] `D5` Post-release: tell @smollern (#406), @ottopichlhoefer (#430) and @Madulone (#352)
      that their work is in a release, not just on `main`. **All three posted 2026-08-17**, after
      2.0.1 rather than after 2.0.0, so that @smollern's reply could say all three of his findings
      shipped instead of two of three. @Madulone's says plainly that the cross-call half is in
      neither release and that #445 is unscheduled, rather than implying a date.
      **That reply went stale within hours**: `ADR-0019` and `OMC-035` merged the same day, so
      @Madulone was told "unscheduled" about something that is now on `main`. A follow-up on #352
      is owed, and it has to keep the same distinction the original made — merged, not released,
      with no release scheduled. The cost of being precise about a date is correcting it when the
      date moves.
      **Discussion comments cannot be written through REST.**
      `POST repos/{owner}/{repo}/discussions/{n}/comments` answers 404 even where the matching GET
      works; it takes the GraphQL `addDiscussionComment` mutation with the discussion's node id.
      An issue comment is `gh issue comment` as usual — #430 is an issue, #406 and #352 are
      discussions

## Superseded premises — kept rather than deleted

Both entries below were wrong in a way that mattered, and both are kept in the form ADR-0016 §8 uses: the falsified claim stays readable next to what replaced it, so the same reasoning does not get re-derived from scratch.

**The `2026-07-28` lifecycle break — resolved by OMC-008, and its central premise was wrong.**
This entry read: *"adopting the revision is a migration that breaks every configured client, not a
capability we add, and it cannot be half-done."* Measured against the shipped implementation, all
three clauses are false. The two eras coexist on one endpoint, chosen per request by whether the
body carries a `_meta` envelope claim, so a claim-less client is served exactly as before. The five
removed-method checks pass **without** retiring `initialize`: the suite only ever probes the modern
era, where the SDK's 2026 wire registry answers `404`/`-32601`, while a legacy client keeps its
handshake. `server-stateless` went 7/27 → 26/28 with no client reconfigured and no `.mcpb`
re-exported. Verified end-to-end against the Labs vault on 2026-08-09, where both eras served
traffic in the same session. See ADR-0016 §8, which records the falsified prediction rather than
deleting it. What it left open was OMC-007, closed on 2026-08-10.

**Correction to how OMC-018 was scoped.** That entry described the suite as wanting `-32602` for a
"malformed `_meta`", as if it were the same size of job as the `-32020`. Reading the checks
themselves (`sep-2575-request-meta-invalid-missing-meta`, `-missing-protocol-version`,
`-missing-client-capabilities`) says otherwise: what the suite calls malformed is `_meta` **absent**
or missing `protocolVersion`/`clientCapabilities`. Requiring those is the 2026 lifecycle itself, so
those three checks belong to OMC-008 and cannot move before it. The `-32602` branch OMC-018 did
ship — `_meta` present but not an object — is ordinary shape validation the suite never exercises.

## Done

- [x] `OMC-038` #483 `prompts/list` could return a list missing a prompt that demonstrably exists,
      and keep returning it for the whole session. Split out of `OMC-030`, whose text called this
      "recorded rather than explained" and "may not have a close condition". It has one.
      **Three reasonable pieces, one hole between them.** `discoverPrompts` reads frontmatter from
      `app.metadataCache.getFileCache` and skips any file whose cache is still null.
      `app.metadataCache` lags the vault: `vault.on("create")` fires when the file appears, the
      cache fills once the file has been indexed. And the memoized lister in `features/prompts/
      index.ts` is keyed on an epoch that **only a vault event** advances. So a `prompts/list`
      arriving inside the indexing window scans, correctly finds no frontmatter, omits the file —
      and caches that under the current epoch. Indexing completing is not a vault event, so the
      epoch never moves and the omission is permanent until some unrelated prompt file is touched.
      **The same hole has two more faces.** The debounced comparison can fire
      `notifications/prompts/list_changed` and not invalidate the memo, so a client that re-lists on
      the notification is told the set changed and then shown that it had not. And if the comparison
      itself runs before indexing it computes `next === lastNotified`, declines to notify, and is
      never re-scheduled — which is exactly the state `#468` described as "a silent notification
      path and a frozen list are indistinguishable". One cause, both symptoms. A third door is
      startup: `promptsSetup` runs from `onload()`, not behind `onLayoutReady`, so a list served
      while Obsidian is indexing at launch can freeze with no vault event anywhere to unstick it.
      **The fix is one listener**: `app.metadataCache.on("changed", ...)` in `vaultWatcher.ts`,
      behind the `isPromptFile` filter the vault hooks already use, unregistered from `stop()`.
      Checked against the installed typings (`node_modules/obsidian/obsidian.d.ts`, obsidian 1.13.1,
      read 2026-08-17): documented as "Called when a file has been indexed, and its (updated) cache
      is now available", and documented as **not** firing on rename — already covered by the vault
      rename hook, so this is the one event to add rather than the first of several. Nothing else in
      `src/` listened to `metadataCache`.
      **Why no test caught it.** Every existing prompt test sets the file and its metadata in the
      same breath, so the window does not exist in the harness. The three regression tests set them
      as separate steps with the list call in between; the mock `metadataCache` had `getFileCache`
      and no `on`/`offref`, so it got both, on a **separate** handler map from the vault's — one
      registry walked by event name would let a vault fire reach a metadata listener and erase the
      very gap under test. All three fail before the fix; the `offref` and the path filter were each
      mutation-checked.
      **What is not claimed.** This reproduces the 15:10 symptom of 2026-08-16 exactly, but nothing
      recovers what happened that afternoon, so it is not proven to have been that run's cause.
      `OMC-030`'s two guesses are unnecessary, not refuted <!-- src:session opened:2026-08-17 closed:2026-08-17 -->
- [x] `OMC-037` #481 Any tag pushed to this repo published a release. `release.yml` triggered on
      `tags: ["*"]` with the job gated only on `github.ref_type == 'tag'`, and that job creates a
      draft and then promotes it with `gh release edit --draft=false`. So `git push origin <tag>`
      published a real release named after the tag, built from whatever commit it pointed at, with
      nothing asking for confirmation.
      **Found by nearly doing it.** Archiving the retired `spike/427-mcp-apps-ui-resource` branch,
      the obvious move was a lightweight tag on `678afcf` so ADR-0018's and the OMC-016 spec's
      citations of that SHA stay resolvable. That tag would have published a release built from
      7 August code. Used `refs/archive/spike-427-mcp-apps-ui-resource` instead — a custom ref is
      neither `refs/heads/*` nor `refs/tags/*`, so Actions never sees it and it shows up in neither
      list. Verified after the push: no workflow ran and `2.1.0` is still the latest release.
      **The fix is deliberately NOT the one the issue proposed, and the reason is the direction of
      failure.** Narrowing the tag glob is the obvious move; GitHub's filter-pattern semantics are
      not the shell's, the documented cheat sheet could not be retrieved to confirm them, and a
      pattern that is too strict means a **real release silently never publishes**, discovered at
      the next cut. So the trigger stays broad and the enforcement is the job's first step, in
      bash, which fails the other way: a non-version tag gives a red run and no release, while every
      version tag always reaches the job.
      The guard runs before `checkout`, so nothing is fetched or built. `github.ref_name` is passed
      through `env` rather than interpolated into the script, since a ref name is
      attacker-influenceable text and `${{ }}` splices it in before bash sees it.
      Verified by running the **literal** script extracted from the parsed YAML, not a paraphrase:
      all **98** tags this repo has ever pushed are accepted, prereleases included
      (`0.4.0-alpha.1`, `0.4.0-beta.3`), and `archive/spike-427-…`, `latest`, `nightly`,
      `release-2.1.0`, `2.1` and `v2.1.0` are all refused. `v`-prefixed tags are refused on purpose:
      this project has never used one, so adopting that scheme should fail loudly rather than
      half-work.
- [x] `OMC-036` #476 `version.ts` cuts a release without touching `CHANGELOG.md`. Found during the
      `2.1.0` cut, hours after that cut nearly shipped its own notes under `[Unreleased]` with every
      check green — nothing in the gate or in `release.yml` reads that file.
      **The issue's own proposal was not enough, and implementing it is what showed why.** A pure
      refusal collides with phase one's clean-tree preflight: the heading would have to land on
      `main` first, through a PR that exists only to move it. So the guard ships with the one
      allowance that makes it usable — `CHANGELOG.md` is the single path phase one tolerates as
      uncommitted, and it rides the release commit. Phase two passes no allowance and stays strict,
      because it reads the committed tree to decide what to tag.
      Two exported pure functions, tested the way `verifyCommittedVersion` is: `checkChangelogReady`
      reports **every** problem rather than the first (missing `[Unreleased]`, notes left under it,
      no heading for the version being cut, a dated heading with nothing under it), and
      `blockingStatusPaths` decides which uncommitted paths block. Version labels are matched
      exactly, so `2.1.1` is not satisfied by a `## [2.1.10]` heading — the trap an unescaped-dot
      regex would have walked into.
      **No date validation and no generated prose**, on purpose: the notes are written by a human
      every time and this repo refuses rather than guesses.
      Verified against the real `CHANGELOG.md` rather than only fixtures: cutting `2.1.1` today is
      refused for the missing heading, cutting `2.1.0` passes, notes left under `[Unreleased]` are
      refused with **both** problems named. Mutation-checked both ways — a `checkChangelogReady` that
      never refuses turns 6 tests red, an inert `blockingStatusPaths` turns 3 red. Suite `scripts/`
      134 → 148.
- [x] `OMC-035` #445 Write preconditions across separate MCP calls. **Decided in `ADR-0019` and
      implemented the same day**, after the shape had been recorded as unscheduled — the schedule
      changed, not the design. `patch_vault_file` and `patch_active_file` accept an optional
      `expectedContent` on `operation: "replace"`, compared against the region as resolved inside
      `vault.process` (heading and block) or `processFrontMatter` (frontmatter), so nothing can
      interleave between the check and the splice.
      **Implementing it settled a question the ADR had not.** `patch_active_file`'s context type *is*
      `PatchArgs` and it forwards the whole args object into the same `applyPatch`, so the guard
      reached it whether or not anyone decided it should; leaving its schema alone would have meant a
      client's `expectedContent` validated away while a vault with the flag on refused the call for
      an argument that tool never advertised. Extended deliberately, and it follows the ADR's
      reasoning more strongly than the original scope did: the active file is the one the user is
      looking at, so it is the likeliest place for a replace to land on top of fresh human typing.
      **Text and not a hash**, because a model cannot digest bytes in its head — a hash would have to
      be emitted by the server, which is the read-side work `get_vault_file` cannot carry without an
      `outputSchema` it must never declare. The caller already holds what it read.
      Normalisation settled concretely: line endings, per-line trailing whitespace, then leading and
      trailing blank lines. **Interior blank lines and leading indentation stay significant**, with a
      test pinning it — a dropped paragraph break is a real edit, and forgiving it would forgive the
      thing the guard exists to catch. An absent `expectedContent` and an empty one are different:
      absent is unguarded, `""` expects an empty section. Refusal is `errorJson` with
      `stale_precondition` carrying `targetType`/`target`, and it names the recovery step and the
      likely cause (the user typing, or Sync) because that is the common case, not the rare one.
      `requireWritePreconditions` joins the `mcpTools` slice with a checkbox; that section's save
      moved from a hand-rolled load/spread/save to `SettingsStore.updateSlice` in the same change,
      since a hand-rolled spread is where one field clobbers the other once a slice holds two.
      **Mutation-checked both ways**: a `checkReplacePrecondition` that never refuses turns 7 tests
      red, a no-op normaliser turns 6. Suite 1863 → 1882, full gate green.
      **The honest cost stands**: opt-in protects the careful and not the default until the next
      major flips it, and nothing here measures the real read-to-write window — if it is seconds, as
      a pre-mortem suspected, this guards a case that rarely fires <!-- src:session opened:2026-08-17 closed:2026-08-17 -->
- [x] `OMC-034` #467 Root `scripts/` was type-checked by nothing, and **the gap was wider than the
      issue filed it as**. True as written: no root `tsconfig.json` existed and `bun run check` is
      `bun --filter '*' check`, which a filter over workspace packages cannot extend to the root. What
      the issue missed is that the plugin's own `tsconfig.json` pinned
      `"include": ["src/**/*.ts", "scripts/connectorShim.test.ts", "bun.config.ts"]`, so **most of
      `packages/obsidian-plugin/scripts/` was unchecked too** — measured with `tsc --listFiles`: 3 of
      its files were seen, including `connectorShim.js` pulled in through `allowJs`. Unchecked were
      `mcpb-smoke.ts` (the #412 regression guard), both generator scripts, `zip.ts`, `link.ts`,
      `bench.ts`, `buildAppHtml.test.ts` and `conformance/harness.ts`. `mcpb-smoke.ts` had gained 80
      lines that same morning in #462 and `bun run check` never looked at it.
      **Two hand attempts to pre-verify those files produced false negatives**, the second such pair
      in a day: `bunx tsc` with `--paths` on the command line dies with `TS6064` and checks nothing,
      and an `rg "^scripts/"` filter hid the error line. Only a real `tsconfig` could answer it.
      Shipped: a root `tsconfig.json` over `scripts/**/*.ts` (`types: ["bun"]` — `Bun.file`,
      `Bun.argv`, `import.meta.main` and the `$` tag all come from there), the plugin's `include`
      widened to `scripts/**/*.ts`, and root `check` becomes `tsc --noEmit && bun --filter '*' check`
      so the two-file check fails first. **One real error surfaced, and it was a genuine finding, not
      noise**: `zip.ts` imports `archiver` with no declarations (`TS7016`). Fixed with
      `@types/archiver@8.0.0`, matching the installed `archiver@8.0.0` exactly and joining the four
      `@types/*` devDependencies already there — not a `declare module` stub, which would have been
      silencing rather than fixing. Coverage measured: plugin `scripts/` 3 → **11** files,
      `svelte-check` 1397 → 1411, root `tsconfig` sees 2. **Proved by mutation in both new places**:
      a deliberate type error in `scripts/version.ts` and in `packages/obsidian-plugin/scripts/mcpb-smoke.ts`
      each turns `bun run check` red, and both files restored byte-identical
      <!-- src:session opened:2026-08-17 closed:2026-08-17 -->
- [x] `OMC-028` #466 Two findings from the OMC-016 gate 5.06 pass, and **(b)'s stated premise was
      wrong — measured before implementing it, not after.** The entry said a required field added to
      `SearchResult` would be "silently dropped with no compile error". Probed on the unfixed code by
      actually adding one: the build breaks in **eight** places. Every one of them is inside
      `semantic-search` or `mcp-tools` — the producers and their fixtures — and **none in
      `mcp-apps`.** So the real failure is narrower and nastier than "no error": you fix the eight,
      the build goes green, and nothing ever asks whether the payload should carry the new field. The
      projector is invisible in that change.
      **The planned fix would not have fixed it.** Aliasing `SmartSearchResult = SearchResult` makes
      the two provably one type, but an unread field is not an error, so the alias alone still raises
      nothing in `mcp-apps`'s source. Verified by probe: with the alias and without the guard below,
      the only `mcp-apps` errors are in **test fixtures**, which someone can satisfy by mechanically
      adding the field to the fixtures without ever opening the projector.
      Shipped: the alias (type-only import, so the file stays as pure as its header claims) **plus** a
      type-level assertion — `Unprojected = Exclude<keyof SearchResult, keyof SearchResultRow |
      NotProjected>` fed through `Assert<T extends true>`, which fails **in the source file** and puts
      the offending key name in the message (`Type '"probeNewField"' does not satisfy the constraint
      'true'`), emitting nothing at runtime. `NotProjected` is where "we looked and the view does not
      need it" gets recorded, so the guard forces a decision rather than forbidding one. No new
      runtime test: the existing fixtures already exercise assignability through the parameter type,
      and a second one would assert nothing the suite does not.
      **(a)** the unbound `catch` at `searchResults.html:300` now binds and logs, matching its sibling
      at `:336`. `SimpleSearchFile` two types above was checked and deliberately left alone: it is a
      genuine narrowing of the unexported `FileResult`, which carries a `match` field the projector
      does not want — a subset by design, not a copy. Regenerated with `bun run gen:mcp-app`; the
      drift test went red first, which is the guard working, and the decoded diff of
      `searchResultsAppSource.ts` is exactly the catch change and nothing else
      <!-- src:session opened:2026-08-16 closed:2026-08-17 -->
- [x] `OMC-032` `bun run version` could not cut a release and now can, in two commands with a human
      gate between them. It used to end in `git push -u origin main`, which `main` refuses: a ruleset
      requires a pull request and classic branch protection requires `check-and-test` and (since
      today) `bridge-tests`. Every tag before 2.0.0 points at a version commit pushed straight to
      `main` (`1.0.1` → `e2ebb20`, single parent, subject `1.0.1`), so the old shape worked when
      those were cut and the rules tightened afterwards; 2.0.0 and 2.0.1 were both cut by hand
      around the failure. **`bun run version <part>`** now preflights, bumps the three files, makes
      `chore/release-<version>`, commits with the version as the subject, pushes the branch and opens
      the PR through `gh` — falling back to printing the compare URL if `gh` is absent, since the
      branch is already pushed by then and that is the part a human cannot redo in a second.
      **`bun run version:tag`** tags `main` and pushes the tag, which is what `release.yml` triggers
      on. Neither command can push `main`.
      **The tag moved to phase two, and that is the substantive change rather than a reordering.**
      Tagging before the push meant the tag pointed at a pre-merge commit, which is the entire reason
      the manual recovery had to insist on a **merge commit** and why a squash would have orphaned
      the tag. Tagging after the commit is on `main` means it points at whatever `main` actually has,
      so **either merge method is now correct** and that constraint is gone. This deliberately
      supersedes the procedure this entry used to record.
      **A flaw in the new design, caught before it shipped:** phase two first read the version from
      the working copy and compared it against `HEAD`, which on a clean tree — which the preflight
      already insists on — is the same file, so the comparison could never fail. It now reads the
      version from the **committed** `package.json` and checks that all three files agree with it at
      the exact commit about to be tagged, which is the shape a partial merge or a hand-edit breaks.
      Preflights: clean tree, on `main`, and new here, `main` identical to `origin/main` — a stale
      local `main` would have shipped the wrong tree and nothing said so before. `FORCE=true` still
      overrides the first two.
      **`DRY_RUN=1` prints every mutating command and runs every read-only preflight for real**, and
      it is the only end-to-end evidence available short of a real cut. Four guards demonstrated
      against live state rather than asserted: a dirty tree refused; a non-`main` branch refused
      naming the branch; the full prepare path printed its seven commands and wrote nothing
      (`git status` empty afterwards); the tag phase refused with *"Tag 2.0.1 already exists
      locally"*; and on a `HEAD` where only `package.json` had been bumped it refused naming both
      disagreements at once, `manifest.json` and the missing `versions.json` key.
      Serialisation is untouched on purpose (two spaces for `package.json`/`manifest.json`, a tab for
      `versions.json`): the 2.0.1 bump had to replicate it by hand, so drift would surface as an
      unrelated diff in a release commit. `bump()` and `verifyCommittedVersion()` are pure and tested
      in `scripts/version.test.ts` (14 tests), mutation-checked — a `minor` that does not zero the
      patch turns 1 red, dropping the `package.json` comparison turns 2 red. **The module needs its
      `import.meta.main` guard to be importable at all**: without it, the test file's own import
      would cut a release. A CI step (`bun test scripts/`) was added because CI runs `bun test`
      inside each package and never at the root, so the new file would otherwise have run nowhere —
      the same trap the Python bridge suite was in this morning.
      **Two residual gaps, named rather than papered over.** Root `scripts/` is outside both
      packages' `tsconfig.json`, so `bun run check` does not type-check `version.ts`; it was checked
      by hand with `tsc --strict` (clean) and nothing keeps it that way. And **the real cut is
      untested** — every dry run is a dry run, and the next release is the first true exercise of
      this path <!-- src:session opened:2026-08-17 closed:2026-08-17 -->
- [x] `OMC-031` The `.mcpb` attached to every GitHub release was not the bundle this project
      ships, and is no longer attached at all. **The framing this entry opened with was wrong and
      is corrected here**: it said "two build paths produce a `.mcpb` and only one was migrated",
      which reads as an oversight. Commit `3ea4ec3` (2026-06-20) states the split as a decision in
      its own message — *"The CI/GitHub release bundle keeps the `${user_config.token}` placeholder
      for public downloaders who supply their own token"* — and the reasoning holds: a CI build has
      no vault path, no config dir and no token id, and `generateMcpb()` refuses an empty `tokenId`
      on purpose, because an id-less bundle resolves `bearerToken`, which tracks `tokens[0]`
      positionally, so a revocation would re-point the bundle at the next token (ADR-0014 §11).
      ADR-0013 could not reach the release asset and never tried to. So the question was whether the
      public-download, bring-your-own-token path is still worth serving, and three fresh
      measurements (2026-08-17) say no. **Nothing documents it**: every `.mcpb` instruction in the
      README starts at the token's row. **It opens a transport this server refuses**: `mcp-remote`
      begins with a GET SSE stream, and against the live vault `GET /mcp` → **405** while
      `POST /mcp` → **401**, so it is the method rung that rejects it, not auth — which is exactly
      why `obsidian_mcp_bridge.py` exists and says so in its docstring. **Almost nobody took it**:
      21 downloads against 3,971 for `main.js` on 1.0.1, 4/629 on 0.28.0, 0/17 on 2.0.1. A fourth
      cost stays untested rather than measured, and is not claimed: ADR-0013's Context reproduced
      `npx` missing from the `PATH` a GUI-launched Claude Desktop gives a spawned child, but whether
      Claude Desktop's own `mcp_config.command` resolution shares that failure was never checked.
      Shipped as: `scripts/build-mcpb.ts` deleted, `build:mcpb` gone from the plugin's `release`
      script, `release.yml` attaching `main.js` + `manifest.json` only with the attestation subject
      narrowed to `main.js` and the `mcpb validate` step removed, and a release-notes line naming
      where the real bundle comes from. Published releases through 2.0.1 are immutable and keep
      their asset; the README says so rather than pretending otherwise. **The guard is
      `mcpb-smoke.ts` check 0**, which fails on any plugin script other than `test:mcpb` mentioning
      `mcpb` and on `release.yml` naming a `*.mcpb` artifact outside a comment. It matches a
      filename (`[\w-]+\.mcpb`), not the bare extension, because the release body has to be able to
      say the word — a guard that forbade the word would be worked around instead of satisfied.
      Wiring check, not proof: a differently-named script publishing by another mechanism passes it.
      Mutation-checked both ways — re-adding `build:mcpb` red, re-adding the asset to `files:` red,
      reverting either green. `bun run release` measured to exit 0, produce the plugin zip and leave
      no `.mcpb` at the repo root. Recorded in ADR-0013, "Addendum (2.0.2)"
      <!-- src:session opened:2026-08-17 closed:2026-08-17 -->
- [x] `OMC-033` The Windows bridge corrupted every non-ASCII path and body, and the
      fix has been known and confirmed since 2026-07-26. @smollern root-caused it in discussion
      #406 against a Danish vault: `scripts/obsidian_mcp_bridge.py` reads `sys.stdin` and writes
      through `sys.stdout.write` (`main()` at :316-326, `write_message` at :216), both **text**
      streams, so on Windows they use the locale codepage rather than UTF-8. Claude Desktop sends
      UTF-8 down the pipe, so `ø` (`0xC3 0xB8`) is decoded as two cp1252 characters and arrives as
      `Ã¸`; a path lookup then fails as "File not found", and a written alias lands corrupted in
      the file. Re-sending a corrupted string doubles the corruption, which is what identified it
      as a single reinterpretation at the stdio boundary. **He applied
      `sys.stdin/sys.stdout.reconfigure(encoding="utf-8")` and confirmed it round-trips æ, ø, å, ü
      and Japanese vault-wide. That change was never made here**: grepped 2026-08-17, the repo
      contains no `reconfigure`, no `PYTHONUTF8` and no `PYTHONIOENCODING` anywhere. The two
      `decode("utf-8")` calls at :189 and :200 are on the HTTP response body and do not touch the
      stdio boundary. So 2.0.0 shipped with it, and #406's other two points did not: bug 2 needed
      no code change (`set_note_property` was the right tool) and bug 3 is the six-field boolean
      fix released in 2.0.0. **Do not tell @smollern his report is in a release until this is** —
      two of three is not three. **Fixed on `main` 2026-08-17; this entry closes when 2.0.1
      ships.** `force_utf8_stdio()` reconfigures `sys.stdin` and `sys.stdout` to UTF-8 and is
      called as the first statement of `main()`, before a byte is read; `sys.stderr` is
      deliberately left alone, so the diagnostic channel does not depend on the thing being
      diagnosed. A stream with no `reconfigure`, or one that refuses, is skipped with a log line
      rather than aborting the bridge — off Windows the default is already UTF-8. Four tests added
      (`ForceUtf8StdioTests`), 28 → 32, and they assert the **call**, not the platform: a test that
      merely round-tripped `ø` would pass with the fix deleted on every machine CI runs on.
      Mutation-checked both ways — deleting the call from `main()` turns 1 red, reconfiguring to
      `cp1252` instead turns 2 red. **Weakness to keep in view**: the bridge suite is stdlib
      `unittest`, run by `python3 -m unittest discover -s scripts`, and is deliberately outside
      `bun test` (issue #355) — so nothing in CI runs it, and this guard is a discipline rather
      than an enforcement. Worth a CI step of its own <!-- src:session opened:2026-08-17 updated:2026-08-17 --> **Released in 2.0.1 (tag `2.0.1` → `60d6e6c`), 2026-08-17**, and @smollern told the same day (2026-08-17).
      **That weakness is closed, 2026-08-17, and closing it turned on a fact the entry did not
      know.** `main` carries classic branch protection with exactly ONE required status check,
      `check-and-test` (read from `repos/istefox/obsidian-mcp-connector/branches/main/protection`;
      the three rulesets require a pull request and nothing else). So a new *job* would have run,
      reported, and blocked nothing — it would have reproduced the same "discipline rather than
      enforcement" gap in a new place. The suite therefore runs as a **step inside `check-and-test`**
      (`.github/workflows/ci.yml`, `python3 -m unittest discover -s scripts -v`), where a red run
      genuinely blocks the merge and no repository setting has to change for it to bite. Stdlib only,
      so there is nothing to install and no `actions/setup-python`.
      **The Windows leg followed the same day.** `bridge-tests` (`windows-latest`,
      `actions/setup-python@v7` pinned to 3.13, `python -m unittest discover -s scripts -v`) runs the
      suite where the bug lived. A job and not a step, unavoidably: one job has one runner and
      `check-and-test` is ubuntu. Python is pinned rather than taken from the runner image because a
      **required** check must not go red on every PR when GitHub bumps its preinstalled interpreter;
      the cost is that one version only is covered and the OS axis is what the job buys. Reviewed the
      suite for platform assumptions before writing it: no `/tmp`, no real sockets, no fork or
      signal, `pathlib` with forward slashes (which Windows accepts) and an explicit
      `read_text(encoding="utf-8")` on the one file it reads — ironically the very mistake it tests
      for. **What it proves and what it does not:** the four `ForceUtf8StdioTests` assert the
      `reconfigure` **call** against a recording stream, deliberately, so they are
      platform-independent and a green Windows run does **not** prove `ø` survives a real cp1252
      console. It proves the suite executes on Windows at all, which nothing checked before. Making
      it bite took a repository-settings change: `bridge-tests` added to `main`'s
      required-status-checks alongside `check-and-test`, after the job had reported once so the
      context name was real rather than guessed — a required check that never reports blocks every
      merge indefinitely
- [x] `OMC-024` Per-token era counters. **Implemented, and verified in a vault on both of the checks that were holding it open.** `eraCountersByToken` now sits alongside `eraCounters` in the `mcpTransport` slice, keyed by token id, and each token row in the transport settings says which era it is served on. Additive rather than the migration this entry originally asked for, and the original framing was wrong: the counts already on disk predate the split and belong to no token, so attributing them would invent data and dropping them would damage ADR-0016 §8's trigger, which reads the vault-wide legacy total. `sum(byToken) <= eraCounters` holds by construction. A revoked token's bucket is pruned in the counter's own recipe; an absent or malformed `tokens` key prunes nothing, so a boot that writes before `ensureTokenStore` seeds the list cannot wipe the map. **Both remaining checks are now done, so this closes.** Two tokens on different eras with disagreeing rows against a global that exceeds their sum: `A1`, 2026-08-15. A pre-existing vault with no `eraCountersByToken` key: `A2`, 2026-08-16 — the key removed with the plugin stopped, the token row rendering with no era label at all, the global `Requests served` still reading from `eraCounters`, and the server answering normally; backup restored (2026-08-16)
- [x] `OMC-016` #427 MCP Apps: a `ui://` resource surface for the two search tools, decided in `docs/architecture/ADR-0018-omc-016-mcp-apps-ui-resource.md`, SPEC archived at `docs/specs/omc-016-mcp-apps-ui-resource.spec.md`. `C1` the `resources` capability with every field explicit and `extensions: { "io.modelcontextprotocol/ui": … }` declared once at `buildMcpServer(tokenId)` for both eras; `C2` the `@modelcontextprotocol/ext-apps` handshake bundled from the view-side entry, `main.js` 2,649,591 → 3,011,578 B (+13.66%, trigger +20%); `C3` both search tools' rows riding the result's own `_meta`, `content` byte-identical to before. Merged as PR #454 (`e3dcd8c`), squashed, CI green, 1849 tests, conformance 26/28 baseline unmoved. **Closed 2026-08-16 by `R-18`**, which put the view in front of a human for the first time: it renders, and **Claude Desktop forwards the tool result's `_meta` to it**, so ADR-0018 Alternative D (`structuredContent`) never has to be built. Two things the run settled that no test could: the host refuses the `obsidian://` scheme, so the click degrades to revealing the vault-relative path — designed fallback, host policy, and it leaves the URL encoding untested by any means; and the theme follows a host switch with no reload. Full per-check measurements in `R-18` under Gate C (2026-08-16)
- [x] `OMC-023` The server advertised a prompts capability it did not honour, on both protocol eras. ADR-0017 settled it three ways rather than two: modern declares `prompts: { listChanged: true }` and honours it, legacy declares `false`, because a POST-only transport with `GET /mcp` at 405 structurally cannot deliver a notification with no request in flight. Shipped 2026-08-15 (PR #450 decision, #452 code); `eraRouter.test.ts`'s full-body `initialize` pin reads `false`, and that assertion IS the record of what a major release moved. **Closed 2026-08-16 by `B3`**, the only thing it was still open on: a hand-built `subscriptions/listen` client against the Labs vault saw `notifications/prompts/list_changed` arrive on a prompt create and on a delete, carrying the ack's own subscription id; saw nothing for a body edit that changed no field a client can see, which is the case the list comparison exists for and the only place a per-event implementation would have failed; and saw a `toolsListChanged` bystander stay silent throughout, with its filter genuinely honored. The legacy half stayed structural rather than observational — `GET /mcp` is 405 and a live legacy `initialize` returns `prompts.listChanged: false`, so there is no stream for a notification to ride. Conformance stayed 26/28. Full measurements in `B3` under Gate B (2026-08-16)
- [x] `OMC-026` #444 six boolean-shaped tool arguments across five tools rejected a genuine JSON boolean. `coerceBooleanParams` (`toolRegistry.ts:504-540`) repairs one direction only — a `"true"`/`"false"` string arriving where the ArkType schema says `"boolean"` — and these six declared the mirror shape, `type('"true" | "false"')`, which the guard never matches, so a real boolean reached `schema.assert()` uncoerced and threw. Retyped all six as `type("boolean")`, which covers both directions at once: a boolean validates directly, a string is coerced by the guard that now matches. `coerceBooleanParams` itself untouched — it was correct for what it claimed; the schemas were wrong. Root-caused by @smollern in discussion #406, who found it on `search_and_replace.dry_run`; reading the codebase turned one field into six, including `delete_vault_directory.recursive`, the destructive one. The four handler-level test files could not have caught this: they call handlers directly, below the registry, so they never traverse the coercion seam — hence the new `dispatch()` block in `toolRegistry.test.ts`, which is the only place that seam is exercised. Mutation-checked: reverting the fixture schema to the literal union turns 2 of the 4 new tests red. Defaults are not uniform across the six (`dry_run`/`includeNested`/`includeEmbeds`/`get_outgoing_links.includeUnresolved` default true, `recursive`/`get_backlinks.includeUnresolved` default false) and each was preserved individually. `inputSchema` is served fresh in every `tools/list`, so no client or `.mcpb` needs re-exporting, and an agent that memorised the string form keeps working through coercion — but the wire schema does change, so it earns a release-note line (2026-08-14)
- [x] `OMC-025` #430 `search_vault_smart` returned `{"results":[]}` for every query under `provider: "auto"` (the default), silently, whenever Smart Connections was installed. `wireSemanticSearch` cached the chooser's decision synchronously during `onload()`, before `this.smartSearch` was ever assigned — `isSmartConnectionsAvailable` always read `undefined` at selection time, so `"auto"` could never pick Smart Connections no matter how fast it loaded. Fixed by re-running the chooser once the binding actually lands: `refreshAutoProvider` (`semantic-search/index.ts`), called from `main.ts`'s existing `loadSmartSearchAPI` subscription. Not a bare re-run of the existing `state.chooser(state.settings)` pattern already used in two other places (`applySettings` on a settings change, `startRebuildFor`'s completion handler) — gated on `settings.provider === "auto"` specifically, because a bare call would have clobbered the DLC pending-provider guard for `embedding-gemma`/`multilingual-e5-base` (their chooser branches build against the DLC store regardless of readiness, and `NativeProviderImpl.isReady()` is unconditionally `true`). Confirmed the fix is real, not decorative: disabling the function's body flipped the new swap-identity test red while the other 17 stayed green. Deployed and verified in the Labs vault — `search_vault_smart` under `auto` now returns real Smart Connections results without any settings toggle needed to "unstick" it (2026-08-11)
- [x] `OMC-007` #419 cross-client `tools/list` staleness. An auto-promotion is a vault-wide change (ADR-0014 keeps counters global), so one client's traffic widens every adaptive token's list; a client that made no request of its own was never told and kept serving a stale list. `ToolLoadingManager` now signals a PERSISTED widening and `mcpServer.ts` publishes it through the 2026-era handler's `notify.toolsChanged()`, which the SDK's listen router fans out to every open `subscriptions/listen` stream that opted in. Signalled per widening, never per flush: past the threshold the counter stays past it, so signalling on the branch would have emitted a notification on every call, forever — there is a test pinning exactly that. Verified end to end with two concurrent streams on one service, one opted in and one not, and confirmed red with the wiring removed. **The prediction this entry carried was wrong**: the two conformance checks did NOT move. They drive fixture tools (`test_trigger_tool_change`, `test_trigger_prompt_change`) we refuse to ship for ADR-0016 Alternative F's reason, so nothing mutates the list inside their window and the delivery path is never exercised — same class as the two `test_missing_capability` entries. Baseline stays at four, `server-stateless` stays 26/28. Nothing a shipping client can observe yet either: no client speaks `2026-07-28` (Labs vault, 2026-08-09: `legacy 22 · modern 2`, and the two were hand-built probes) (2026-08-10)

- [x] `OMC-008` #407 adopt MCP spec `2026-07-28` as an additive second era (ADR-0016). Two eras on one endpoint, classified per request off a single body read; the legacy path is unchanged and no configured client or distributed `.mcpb` needed touching. `server-stateless` 7/27 → 26/28, baseline down to four entries. Conformance harness now in-repo under `scripts/conformance/`, run nightly by `.github/workflows/conformance.yml`, never per PR. Per-era request counters ship in the transport settings; `legacy: 'reject'` stays a future decision with a trigger. Merged as PR #439 (`88443d4`) on 2026-08-09. Follow-ups: OMC-023, OMC-024 (2026-08-09)
- [x] `OMC-022` Closed by OMC-008, which delivered all three missing pieces at once: the harness moved out of a scratchpad into `packages/obsidian-plugin/scripts/conformance/`, `run.sh` builds the suite from source at a pinned ref (`81eb1c3`, `0.2.0-alpha.10`), and `expected-failures.yml` makes the job a gate rather than a report — it exits non-zero the moment a failure appears that the baseline does not name. It is a **nightly** job (`.github/workflows/conformance.yml`, `schedule` + `workflow_dispatch`), never per PR: cloning and building the suite is Actions spend, so a hand run of `bun run test:conformance` before merging a transport change stays a discipline rather than an enforcement. Proven on a clean Linux runner by a `workflow_dispatch` on `main` — 26/28, baseline satisfied, exit 0, with the log showing the clone and `npm ci` actually ran rather than the step short-circuiting (2026-08-09)
- [x] `OMC-018` PR #437. Verified against `server-stateless` with a controlled baseline: the pre-fix commit and the fix were each served by the same headless harness, so the delta is attributable. 4/27 → 7/27. Two passes are real — `http-server-header-mismatch-400` (a version mismatch now answers 400 with `-32020`) and `http-server-error-jsonrpc-id` (every error response echoes the request id). The third, `server-honors-notification-filter`, is vacuous: it failed before only because the empty 400 body left the suite no frame to inspect, and we still do not implement `subscriptions/listen` (see OMC-007). The `-32602` checks did not move, by design — see the correction under Blocked (2026-08-08)
- [x] `OMC-019` PR #436. Split rather than resolved wholesale, which was the right call. `require("fs/promises")` became a static import: it only runs after the native dialog returns, so there is nothing left to guard lazily, and Bun's cjs output is byte-identical. `require("electron")` stays, now with the reasoning in the code — it runs unconditionally before we know the host, its `try`/`catch` is load-bearing (a top-level import would crash the file's whole suite instead of degrading), and dynamic `import()` is already documented as unreliable under Obsidian's loader. The reviewer finding is gone from `src/**` for the one that could move (2026-08-08)
- [x] `OMC-020` PR #435, the redundant non-null assertion on `startLine` dropped (2026-08-08)
- [x] `OMC-017` Done locally and not committable: `CLAUDE.md` is gitignored as of `2d74e95`, which is why the unattended agent correctly refused it. Four edits — `check:svelte` and `test:mcpb` added to Commands, the full-gate line extended, the Svelte gotcha rewritten now that CI type-checks it, and a wrong path corrected to `src/features/mcp-client-config/assets/connectorShimSource.ts` (2026-08-08)
- [x] `OMC-021` Closed with no dependency change, and the entry's own premise was wrong: `hono` is **not** transitive, it is a direct root dependency at `^4.12.25` with an override at `^4.12.23`, pinned precisely to control the version under `@modelcontextprotocol/node`. Provenance for the rest: `@hono/node-server@1.19.13` via `@modelcontextprotocol/node`, `adm-zip@0.5.17` and `sharp@0.34.5` via `@huggingface/transformers` (the former through `onnxruntime-node`), `brace-expansion@5.0.6` via `minimatch`. Every resolved version is far above the flagged `<0.6.0` range. In the shipped `main.js`: `@hono/node-server` is present, `adm-zip` and `brace-expansion` do not appear at all, and `sharp` is not bundled either — it is native and cannot be, so its hits are transformers' own guarded `toSharp()` call sites plus one HTML entity name (2026-08-08)
- [x] `OMC-012` Reviewer verdict for 1.0.1 (`e2ebb20`) read: **Completed**. Two Pass results that matter — the `main.js` GitHub artifact attestation verifies, closing out July's false positive, and the build reproduced the release `main.js` byte-for-byte. Behaviour flags (filesystem, shell, vault enumeration, clipboard, dynamic code) are the usual by-design ones. New findings became OMC-019/020/021 (2026-08-08)
- [x] `OMC-004` All three manual checks pass. The empty-allowlist warning renders and says explicitly that no ticks means meta-tools only, "not the same as no limit". The Tool loading panel follows the selected token row. R-22 verified over HTTP with both tokens: after promoting `show_file_in_obsidian` on `default` only, that token listed 17 tools and the second listed 16, the symmetric difference being exactly that tool — a promotion does not widen another client's surface. Caveat: R-22 was driven over raw HTTP rather than through a second GUI client (2026-08-08)
- [x] `OMC-011` Verified on the real artifact. The Labs vault was still on 1.0.0, which is why the installed extension was a hand-patched 1.0.0 — updated it through Obsidian's own community-plugin update, re-exported the `.mcpb` from the token row (1.0.1, `isEntryPoint` present, token id embedded), installed it in Claude Desktop, and with **Use Built-in Node.js for MCP left on** the connector reports "Server attivo, versione 1.0.1". The reinstall also removed `server/index.js.bak-412` on its own (2026-08-08)
- [x] `OMC-005` CI now type-checks Svelte (`check:svelte`, clean against all 11 components) and smokes the `.mcpb` bundle on both loaders (`test:mcpb`), built through the real `generateMcpb()`. The smoke also compares the shipped `server/index.js` against `connectorShim.js` byte-for-byte, so a stale generated asset fails loud. Proven to catch #412 by reverting `isEntryPoint()`: check 4 went red while check 3 stayed green. PR #429 (2026-08-06)
- [x] `OMC-014` The `constants.ts` comment now cites `@modelcontextprotocol/core/dist/internal.mjs`, verified present. The `mcpServer.ts` one dropped its citation instead of pointing at `PerRequestHTTPServerTransport`, which carries a near-identical message but is a transport we never import; the constraint now rests on the 0.4.0-alpha.2 smoke incident. PR #428 (2026-08-06)
- [x] `OMC-015` Labs vault plugin dir cleaned: 6 stale build backups and the pre-1.0.0 settings backup deleted, 12 MB, plus the probe fixture `Prompts/completion-probe.md`. The deleted builds for 0.28.1, 0.28.2 and 1.0.0 remain recoverable from the published releases (2026-08-06)
- [x] `OMC-013` #412 closed: Piter10k confirmed the fix on 2026-08-05 and the 1.0.1 release notice, with the re-export step, is posted on the issue (2026-08-06)
- [x] `OMC-009` #347 closed as not planned: the transclusion half shipped in #420, and the `completion/complete` half closes on expected value since the stub measurement was never run (2026-08-06)
- [x] `OMC-002` #412 answered with the verified mechanism, the 153 ms end-to-end result and the missing-stderr caveat (2026-08-05)
- [x] `OMC-001` `.mcpb` never started under "Use Built-in Node.js for MCP" — the cause was the shim's `require.main === module` guard, false under the host's `import()`, not the missing `compatibility` field this entry first blamed; `isEntryPoint()` replaces it (2026-08-05)
- [x] `OMC-003` README and ADR-0013 rewritten off the verified mechanism; the 0.27.3 addendum's wrong attribution is now marked as wrong rather than deleted (2026-08-05)
- [x] `OMC-006` Shim request deadline committed as `331f1e0`, gate green (2026-08-05)
