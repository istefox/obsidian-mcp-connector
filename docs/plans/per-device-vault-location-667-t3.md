**Requirement set:** none, ticket 3 of docs/plans/per-device-vault-location-667.md

# Implementation plan: per-device vault location record for the shared broker (#667)

**SPEC:** `docs/specs/per-device-vault-location-667.SPEC.md` (Approved 2026-11-09, Mode: auto), R-01 to R-11
**ADR outcome:** new ADR, `docs/architecture/ADR-0035-per-device-broker-location.md` (status Proposed,
pending this plan's approval; number from `next-id.sh adr`, `NEXT ADR-0035`). It meets all three
tests: it is hard to reverse, it would surprise a reader without context, and it is a real
trade-off. It also qualifies under the security-boundary override, because it changes what the broker
checks before it admits a route. It amends ADR-0021 (§ Storage, upgrades and copied vaults) and
ADR-0027 (the resolver's location comparison and the broker's admission rule).
**Suggested branch:** `fix/per-device-vault-location-667`. The checkout is on `chore/todo-sync-671`,
and the untracked SPEC belongs to this work.

## Registered from the SPEC (not reopened)

The per-device record keyed by route ID; `window.localStorage`, not `app.saveLocalStorage`; an empty
record is a silent first bind; the one-way migration of the legacy synced `dataPath` (cross-style
ignored, same-style differing prompts once, equal binds); `dataPath` never written again and an
existing value left alone; confirm-move and new identity write the device record only; one test
seam, the broker service's location logic with the record injected, and no Svelte test.

## Gap the SPEC does not name: the broker's ownership check (needs confirmation at the gate)

`ownsRegistration` in `brokerServer.ts` (lines 401-418) admits a registration only when the
`data.json` at the registered path holds `settings.dataPath === registration.dataPath`. With R-06
in place, a vault minted by this release has no `dataPath` and every registration gets `401`. A
synced vault carries the other device's path and gets `401` on every device except the one that wrote
it. That defeats R-01, R-02, R-04 and R-10. Changing it only on the plugin side cannot work.

Resolution (ADR-0035 D5): the broker drops the `dataPath` equality. Admission still needs the route
ID and a matching route credential in the file at the registered path, `isPluginDataPath` and every
owner and write-access check. The same-route-other-path `409` (around `brokerServer.ts:701`) is
unchanged and still catches two open copies. What we give up: the broker no longer refuses, on
its own, a copy whose original is closed. That check moves to the plugin, per device.

**User decision to confirm (ADR-0035 D6): bump `BROKER_PROTOCOL_VERSION` from 3 to 4.** Recommended.
Any open vault can host the broker. A version 3 host keeps the equality check, so it would refuse
this release's registrations with a bare `401`, which the vault reports as "for a reason this vault
cannot check". `probeBroker` (`discoveryBroker.ts:839-846`) reports a host whose `name` matches and
whose `version` differs as `incompatible`. After the bump, a mixed machine therefore gets the
existing "update the plugin in every open vault" message. The cost: until both vaults run this
release, the vault that is not hosting shows that notice. If the bump is declined, drop the version
change from Task 2 and the README health line from Task 6. Nothing else changes.

## Settled here (micro-decisions the SPEC leaves open)

1. **Path style** is read from text only, on both sides: the legacy string and the current canonical
   path. A drive letter (`/^[A-Za-z]:[\\/]/`) or a leading `\\` (UNC) is `windows`; a leading `/` is
   `posix`; anything else is `other`. "The other platform's style" means both values have a known
   style and the two styles differ. This lets the tests cover R-02 on macOS with a made-up
   `c:\…` string.
2. **A legacy value of style `other`** (the existing fixture `"synthetic-original-location/data.json"`
   at `discoveryBroker.test.ts:765`) counts as the same style and differing, so it prompts. That
   keeps the `test.each` at :755 valid and errs on the safe side.
3. **The 3.0.1 linked-folder fix stays in the migration branch.** With no local entry, a legacy
   value that `isLegacyLocation` recognizes as this vault's own file in the 2.11/2.12 form binds
   silently and records the current form locally. README :725 and the test at :719 rely on it.
4. **One pure classification** (`classifyLocation`) serves `startDiscovery` and
   `isLocationUnresolved`. That makes R-08 hold by construction, as `planMigration` does under
   ADR-0025. The async inputs (canonical path, local entry, legacy-form check) are gathered first and
   then passed in.
5. **The store is injected through an optional `locations` option** on `startDiscovery`'s
   `RuntimeOptions` and on the `opts` of `acceptDiscoveryMove`, `resetDiscoveryIdentity` and
   `isLocationUnresolved`. It defaults to `windowLocationStore()`. Callers (`main.ts:149`,
   `endpoint.ts:94`, `AccessControlSection.svelte:155/621/710`) pass nothing and need no change, as
   the SPEC requires.
6. **The store may throw, and the broker service catches.** `windowLocationStore()` reads
   `window.localStorage` lazily on every call. When `window` is missing, the storage is missing, or
   `getItem` or `setItem` is not a function, it throws. A value under the key that does not parse
   makes `get` throw. On `set`, a value that does not parse is replaced by a fresh map. Otherwise a
   corrupt key would make every later write fail. The broker service turns a thrown `get` into
   "no entry" and logs a thrown `set`. Neither stops registration. Log lines carry no path and no
   route ID, which matches the existing "ports only" rule at `discoveryBroker.ts:444`.
7. **Key:** `obsidian-mcp-connector:broker-locations`. Its value is a JSON object mapping route ID to
   the canonical path. It is not prefixed with the manifest ID: route IDs are random UUIDs, and a
   development build under another plugin ID that opens the same vault should see the same entry.
8. **`acceptDiscoveryMove` and `resetDiscoveryIdentity` log a failed record write and do not throw.**
   With a store that keeps failing, the user would see the prompt again after confirming. That is
   listed under Risks.
9. **Headless is unaffected.** `src/headless` imports nothing from `mcp-client-config` (checked
   2026-11-09), so the broker service is not in the headless bundle, which has no `window`.
10. **`isLocationUnresolved` keeps today's order of checks** (`discoveryBroker.ts:267-268`, where a
    route with no saved location returns `false` before the path is touched):
    1. Read the settings. No saved route means `false`.
    2. Read the local entry for the route ID and the legacy value. Neither one needs the current
       path. If both are absent, the route was never bound and the answer is `false`, as today.
    3. Only now resolve the canonical path. If that throws, the answer is `true` (fail closed).
       Otherwise the answer is `classifyLocation(...) === "changed"`.

    `startDiscovery` throws outright when the path cannot be resolved, so R-08's "same answer as the
    start" only applies when the path can be read.

## Tasks

### Task 6 — README, CHANGELOG, ADR amendments and the manual two-device check (R-10, R-11)
Owner: coder
Files: README.md, CHANGELOG.md, docs/architecture/ADR-0021-shared-local-discovery-broker.md, docs/architecture/ADR-0027-shared-broker-for-all-clients.md, docs/architecture/ADR-0035-per-device-broker-location.md
Tests: discoveryBroker.test.ts
Signatures:
- DEVICE_LOCATIONS_KEY — `"obsidian-mcp-connector:broker-locations"` (named in the README only if the troubleshooting row tells users to clear it; otherwise not named)
Red: no
Wave: 3
Depends: Task 2, Task 4
Ticket: 3

**README (R-11).** In the moved and copied vaults passage (:572-579), say that the bound location
is kept per device, in Obsidian's local storage and not in the synced `data.json`. Opening a synced
vault on another device is not a move, and the broker route registers with no prompt. A move or a
copy on the same device still raises **Vault location changed**. The first start after the update,
on a device whose vault has an older saved location of the same platform style at another path,
prompts once. Replace the now false sentence "Legacy settings bind to their current location on
first upgraded use…" (:579) with the per-device equivalent. Keep the :725 troubleshooting row and
add one for #667's symptom (synced vault, prompt on every device) that names the fixing release.
If the bump is confirmed, change the health example at :604 to `"version":4` and add that every open
vault needs this release, as ADR-0033's README note does.

**CHANGELOG.** Add a `### Fixed` entry under `## [Unreleased]`, together with the bump's
"update every open vault" note if confirmed.

**ADR amendments.** Add an "Amended by ADR-0035" blockquote to ADR-0021 (§ Storage, upgrades and
copied vaults) and ADR-0027 (Context :164-165 and the admission rule), using the format both
already use, and add ADR-0035 to their Status lines. Set ADR-0035's Status to "Accepted and
implemented" in the closing commit of the work. Its D6 records the outcome of the bump decision.

**R-10, manual check (no-test).** Use two devices, macOS and Windows, that share one vault through
Obsidian Sync, with this build on both:

1. Open the vault on device A and wait for **Connected**.
2. Let `data.json` sync to device B, open the vault there and wait for **Connected** with no
   notice.
3. Reload the plugin on A and check that it is still **Connected** with no notice.
4. On A, copy the vault to another folder and open the copy: **Vault location changed** appears.

Record the outcome on #667 before closing it.

**Proposed local note (`CLAUDE.md` is gitignored, `git ls-files CLAUDE.md` is empty, so this is a
local edit for the parent session):** a section "Decisions from the per-device vault location
chain (ADR-0035)" with these points:

- the bound location lives in `window.localStorage`, keyed by route ID, never in `data.json`;
- `dataPath` in `codexDiscovery` is read-only legacy input and is never written;
- the broker admits on route ID and credential and no longer compares `dataPath`;
- `classifyLocation` is the one function behind start and `isLocationUnresolved`;
- `BROKER_PROTOCOL_VERSION` is 4 (if confirmed).

Sub-tasks:
- [ ] Rewrite the README moved and copied vaults passage (:572-579) as the prose states, replacing the sentence "Legacy settings bind to their current location on first upgraded use…": `grep -n "Legacy settings bind" README.md` returns nothing.
- [ ] Keep the 3.0.1 troubleshooting row (:725) and add a row for #667's symptom (synced vault, prompt on every device) naming the fixing release; only if ADR-0035 D6 is confirmed, change the health example (:604) to `"version":4` and add the "every open vault needs this release" note.
- [ ] Add a `### Fixed` block with the #667 entry under the empty `## [Unreleased]` of `CHANGELOG.md` (:6), with the bump's "update every open vault" note if D6 is confirmed.
- [ ] Add an "Amended by ADR-0035" blockquote to ADR-0021 § Storage, upgrades and copied vaults (:66), in the format of its :7 blockquote, and name ADR-0035 on its Status line (:3).
- [ ] Add an "Amended by ADR-0035" blockquote to ADR-0027 for Context :164-165 and the admission rule, and name ADR-0035 on its Status line (:3).
- [ ] Set ADR-0035's Status to "Accepted and implemented" and record the D6 outcome, in the closing commit of the work.
- [ ] Run the R-10 manual check, steps 1 to 4, on a macOS and a Windows device sharing one synced vault, and record the outcome on #667 before it is closed.
- [ ] Hand the proposed `CLAUDE.md` section to the parent session in the report, with no edit to `CLAUDE.md`.

