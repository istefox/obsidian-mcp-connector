**Requirement set:** none, ticket 1 of docs/plans/per-device-vault-location-667.md

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

### Task 1 — Broker admission tests without the location equality (R-01, R-02, R-06, R-10)
Owner: tester
Files: packages/obsidian-plugin/src/features/mcp-client-config/services/brokerServer.test.ts
Tests: brokerServer.test.ts
Signatures:
- startBrokerServer — existing, `(opts: { port: number; pluginId: string }) => Promise<BrokerServer>`, unchanged
- BROKER_PROTOCOL_VERSION — `export const BROKER_PROTOCOL_VERSION = 4` (asserted through the health body, only if the bump is confirmed)
Red: yes
Depends: none
Ticket: 1

Add tests against the real `startBrokerServer`, using the file's `writeVault`, `routeSettings` and
`registerRoute` helpers.

The first test seeds a vault whose stored `codexDiscovery` has no `dataPath` key and asserts that the
registration is admitted (`200`) and forwards. The second seeds a `dataPath` naming another
platform's path (`c:\\users\\x\\vault\\.obsidian\\plugins\\<id>\\data.json`) and asserts the same.
Together they are the synced-from-another-device case. The third reuses the two-vault fixture of
"a copied route cannot overwrite or unregister the existing owner" (:886), with neither file holding
`dataPath`, and asserts that the copy still gets `409` while the original is registered. Before Task
2, this third test fails at the original's own registration (`401`). If the bump is confirmed, add a
fourth: the health endpoint answers `{"name":"obsidian-mcp-discovery-broker","version":4}`.

Keep `routeSettings` writing `dataPath` by default so every existing test still covers a file
written by older versions. Check with a grep for `registerRoute(` that no existing test relies on a
stored-path mismatch to get its `401`. The `wrongPaths` loop at :1051 fails through
`isPluginDataPath` and stays valid. Run `bun test brokerServer` and record which new tests are red.
The first two must be red before Task 2 runs.

Sub-tasks:
- [x] In `describe("registration ownership")` (`brokerServer.test.ts:981`), add "admits a registration whose saved settings hold no `dataPath`": `writeVault` with `routeSettings(dataPath(), { dataPath: undefined })` (dropped by `JSON.stringify`), `registerRoute` resolves and a `/v1/<routeId>/mcp` request reaches the transport.
- [x] Add "admits a registration whose saved `dataPath` is another platform's path": override `dataPath: "c:\\users\\x\\vault\\.obsidian\\plugins\\<id>\\data.json"`, same assertions as the case above.
- [x] Next to "a copied route cannot overwrite or unregister the existing owner" (:886), add the same two-vault case with both vault files seeded without `dataPath` (`vaultTarget` (:232) takes no settings, so rewrite each file through `writeVault` with `routeSettings(file, { dataPath: undefined })` after it): the original registers, the copy's `registerRoute` rejects with `HTTP 409`.
- [x] Only if ADR-0035 D6 is confirmed: add a health test asserting the literal body `{"name":"obsidian-mcp-discovery-broker","version":4}` (the assertion at :388 reads the constant, so it never goes red).
- [x] Grep `registerRoute(` and `dataPath:` in the file for a test that gets its `401` from a stored-path mismatch. The reject `test.each` row "was saved at another location" (:997, `{ dataPath: "synthetic/copy/data.json" }`) does, and turns red with Task 2: take it out of the reject table, since the second new case covers its admitted counterpart, and name it in the report. The `wrongPaths` loop (:1060) fails through `isPluginDataPath` and stays.
- [x] `bun test brokerServer`: the report lists the new cases that are red (the first two with `HTTP 401`, the third at the original's own registration, the health case with `version: 3`), and every pre-existing case green.

### Task 2 — Drop `dataPath` from the broker's ownership check (R-01, R-02, R-06, R-10)
Owner: coder
Files: packages/obsidian-plugin/src/features/mcp-client-config/services/brokerServer.ts
Tests: brokerServer.test.ts, discoveryBroker.test.ts
Signatures:
- ownsRegistration — `async function ownsRegistration(registration: BrokerRegistration, credential: string, pluginId: string): Promise<boolean>`, body only
- BROKER_PROTOCOL_VERSION — `export const BROKER_PROTOCOL_VERSION = 4` (only if confirmed)
Red: no
Wave: 1
Depends: Task 1
Ticket: 1

Depends on Task 1's red tests. Remove the `settings.dataPath === registration.dataPath` clause from
`ownsRegistration` and rewrite its doc comment ("whose saved settings name both the route and this
canonical `data.json` path"). The new rule: the file at the registered path, which has already
passed the data file checks, holds this route ID and the credential. Leave the same-path
replacement logic and the `409` near :701 unchanged.

If the bump is confirmed, set `BROKER_PROTOCOL_VERSION` to 4 and add to its doc comment: "Version
4: admission no longer compares a saved `dataPath` (ADR-0035)". The registration schema
(`type.unit(BROKER_PROTOCOL_VERSION)`, :132) and the probe follow the constant.

Then run the "registration with a real broker" and "broker hosting" describes of
`discoveryBroker.test.ts`. They must stay green, because the plugin still writes `dataPath` until
Task 4.

R-10 depends on this task. The manual two-device check itself is in Task 6.

Sub-tasks:
- [x] Remove `settings.dataPath === registration.dataPath &&` from `ownsRegistration` (`brokerServer.ts:401-418`); `grep -n "settings.dataPath" brokerServer.ts` returns nothing.
- [x] Rewrite the doc comment above `ownsRegistration` (:394-400) to the new rule: the file at the registered path, past the data file checks, holds this route ID and the credential.
- [x] Leave the same-path eviction and both `409` branches (:704-720) as they are: `git diff` shows no hunk there.
- [x] Only if ADR-0035 D6 is confirmed: `BROKER_PROTOCOL_VERSION = 4` at :37 with the line "Version 4: admission no longer compares a saved `dataPath` (ADR-0035)" in its doc comment; the schema at :132 and the health body at :640 keep reading the constant.
- [x] `bun test brokerServer` is green, Task 1's new cases included.
- [x] The "registration with a real broker" and "broker hosting" describes of `discoveryBroker.test.ts` stay green, and `bun run check` passes.

## Build result (2026-11-09)
BUILD · DONE
Files: brokerServer.ts, brokerServer.test.ts, discoveryBroker.test.ts, README.md, this plan
Tests: 4178 pass, 0 fail (full command green), 5 new cases, 1 (coverage)
Review: sonnet, safe
Coverage: not run, the plan names no SPEC
Dispatch: Round 0 (red): tester — Task 1
INFO: tiered coder low sonnet/medium, Task 2 size: 1 files, low size 2
INFO: ADR-0035 D6 (BROKER_PROTOCOL_VERSION 3 to 4) adopted as the plan's recommended default; not separately confirmed by the user
