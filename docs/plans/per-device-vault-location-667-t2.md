**Requirement set:** none, ticket 2 of docs/plans/per-device-vault-location-667.md

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

### Task 3 — Per-device location seam: declarations and red tests (R-01, R-02, R-03, R-04, R-05, R-06, R-07, R-08, R-09)
Owner: tester
Files: packages/obsidian-plugin/src/features/mcp-client-config/services/deviceLocations.ts, packages/obsidian-plugin/src/features/mcp-client-config/services/discoveryBroker.ts, packages/obsidian-plugin/src/features/mcp-client-config/services/discoveryBroker.test.ts, packages/obsidian-plugin/src/test-setup.ts
Tests: discoveryBroker.test.ts
Signatures:
- DeviceLocationStore — `export type DeviceLocationStore = { get(routeId: string): string | null; set(routeId: string, dataPath: string): void }`
- DEVICE_LOCATIONS_KEY — `export const DEVICE_LOCATIONS_KEY = "obsidian-mcp-connector:broker-locations"`
- windowLocationStore — `export function windowLocationStore(): DeviceLocationStore`
- PathStyle — `export type PathStyle = "windows" | "posix" | "other"`
- pathStyle — `export function pathStyle(file: string): PathStyle`
- LocationVerdict — `export type LocationVerdict = "bind" | "same" | "changed"`
- classifyLocation — `export function classifyLocation(input: { local: string | null; legacy: string | undefined; current: string; legacyIsOwnFile: boolean }): LocationVerdict`
- RuntimeOptions.locations — `locations?: DeviceLocationStore` (new optional field on `startDiscovery`'s options)
- acceptDiscoveryMove — `export async function acceptDiscoveryMove(plugin: DiscoveryPlugin, opts?: { dataPath?: string; locations?: DeviceLocationStore }): Promise<void>`
- resetDiscoveryIdentity — `export async function resetDiscoveryIdentity(plugin: DiscoveryPlugin, opts?: { dataPath?: string; locations?: DeviceLocationStore }): Promise<void>`
- isLocationUnresolved — `export async function isLocationUnresolved(plugin: LocatedPlugin, opts?: { dataPath?: string; locations?: DeviceLocationStore }): Promise<boolean>`
Red: yes
Depends: none
Ticket: 2

**Declarations (the tester owns the signatures).** Create `deviceLocations.ts` with the types,
the constant and stub bodies that compile and throw `new Error("not implemented")`. In
`discoveryBroker.ts`, change only the signatures: add the optional `locations` field to
`RuntimeOptions` and to the three `opts` types. Leave every body as it is. `bun run check` must
pass after this task, or the red tests below never run.

**`test-setup.ts`.** Install a deterministic in-memory `window.localStorage` (`getItem`, `setItem`,
`removeItem`, `clear`, `length`, `key`) with `Object.defineProperty(window, "localStorage", { configurable: true, … })`.
That way `bun test` behaves the same whether Bun ships a native, partial or missing `localStorage`
(not verified, see Risks). Bun runs every test file in one process, so a file that reaches the
default store clears it in its own `beforeEach`.

**`discoveryBroker.test.ts`.** Add a `memoryStore(initial?)` helper that counts writes, and a
`throwingStore({ get?, set? })` helper. In `beforeEach`, give `fakeOpts` a fresh `memoryStore` for
the test. Give the real-broker `start()` helper (:877) the same store for every vault in one test,
because those vaults stand for one device.

Inline options objects bypass `start()` and must carry that same store instance too:

- `copyOpts` in "a copied vault that claims the original's route is refused until it is made
  independent" (:1626-1633). It needs the store `ownRuntime` was started with. Without it, the copy
  falls to the empty default store and binds, and `locationChanged` at :1639 is no longer `true`.
- `movedOpts` (:584). It spreads `fakeOpts`, so it inherits the store already, but check.
- Any other options literal passed to `startDiscovery`, `acceptDiscoveryMove`,
  `resetDiscoveryIdentity` or `isLocationUnresolved` in the file. Find them all with a grep.

Then add a `describe("per-device location record")` covering:

- `pathStyle`: drive letter (both slash directions, either case), UNC, leading `/`, a relative
  string, and the empty string.
- R-01: no entry and no legacy value. Start is `connected`, the store holds the current path, the
  stored settings have no `dataPath`, no notice.
- R-02: no entry, legacy value `c:\…` while the current path is POSIX (and the reverse when
  `process.platform === "win32"`). Start is silent, no `conflict`, no notice, the store is written,
  and the legacy value is unchanged.
- R-03: no entry, legacy value POSIX and different. One notice, `locationChanged: true`. After
  `acceptDiscoveryMove` through `replaceWith`, the store holds the current path, the stored
  `dataPath` is unchanged, and a further start is silent with no new notice.
- R-04: entry equal to the current path. Start is silent with each of these legacy values: absent,
  equal, other style, same style differing.
- R-05: entry differing, same route ID. `locationChanged: true` and one notice.
- R-06: after first bind, accept-move and reset, the stored settings have no `dataPath` when none
  was there, and keep a seeded legacy value byte-identical.
- R-07: accept-move keeps the route ID and `accessToken`. Reset mints new ones and the store gets an
  entry for the new route ID with the current path, while the old entry stays.
- R-08: `isLocationUnresolved` agrees with `startDiscovery`'s `locationChanged` on every case of
  R-01 to R-05 (a `test.each` over a shared case table). It follows the order in micro-decision 10.
  With a local entry or a legacy value present and an `opts.dataPath` whose parent cannot be
  resolved, it returns `true`. With a saved route and neither of them, it returns `false` without
  touching the path, as today.
- R-09: a store whose `get` throws behaves as empty and logs one warning (`captureLogLines`, as at
  :1879) that contains no path and no route ID. A store whose `set` throws still ends `connected`.
  `windowLocationStore()` with `window.localStorage` redefined to throw, to be missing, or to hold
  invalid JSON under `DEVICE_LOCATIONS_KEY` behaves the same way. After a `set`, invalid JSON is
  replaced by a valid map.
- `classifyLocation`: the full truth table, `legacyIsOwnFile` included.

**Update stale assertions** (the observable contract changes from "`dataPath` saved in
`data.json`" to "path saved in the device record"):

- :635 `storedSettings(plugin).dataPath` `toBeString()` becomes `toBeUndefined()` plus a store
  assertion;
- :733 `toBe(linked.currentPath)` becomes the store holding `linked.currentPath`, with the stored
  value still `linked.legacyPath`;
- :752 stays as written;
- :1454 now reads the route's path from the store, not from `storedSettings(...).dataPath`.

Run `bun test discoveryBroker` and list the red tests in the report.

Sub-tasks:
- [x] Create `services/deviceLocations.ts` with `DeviceLocationStore`, `DEVICE_LOCATIONS_KEY`, `PathStyle`, `LocationVerdict`, and `windowLocationStore`, `pathStyle`, `classifyLocation` as stubs that throw `new Error("not implemented")`.
- [x] In `discoveryBroker.ts`, add `locations?: DeviceLocationStore` to `RuntimeOptions` (:98) and to the `opts` types of `resetDiscoveryIdentity` (:236), `acceptDiscoveryMove` (:249) and `isLocationUnresolved` (:265): `git diff` touches signature lines only, and `bun run check` passes.
- [x] In `src/test-setup.ts`, install the in-memory `window.localStorage` (`getItem`, `setItem`, `removeItem`, `clear`, `length`, `key`) through `Object.defineProperty(window, "localStorage", { configurable: true, … })`; `bun test` boots. If `defineProperty` throws, say so in the report (the Risks fallback).
- [x] In `discoveryBroker.test.ts`, add `memoryStore(initial?)` (counts writes) and `throwingStore({ get?, set? })`; a store created fresh in the `beforeEach` at :232 is returned as `locations` by `fakeOpts()` (:160) and passed by `start()` (:877) to every vault of one test.
- [x] Pass that store to every inline options literal: `copyOpts` (:1630) gets the store `ownRuntime` was started with, `movedOpts` (:584) is checked to inherit it from `fakeOpts`, and a grep for `startDiscovery(`, `acceptDiscoveryMove(`, `resetDiscoveryIdentity(` and `isLocationUnresolved(` finds no other literal without it.
- [x] Add `describe("per-device location record")` with the `pathStyle` cases, the full `classifyLocation` truth table (`legacyIsOwnFile` included) and one case per R-01, R-02, R-03, R-04, R-05, R-06 and R-07 as the prose lists them.
- [x] Add the R-08 `test.each` over the shared case table plus its fail-closed and never-bound cases, and the R-09 cases (throwing `get` logs one warning without path or route ID through `captureLogLines`, throwing `set` ends `connected`, `windowLocationStore()` over a throwing, missing and invalid-JSON `window.localStorage`, invalid JSON replaced after a `set`).
- [x] Update the stale assertions at :635, :733 and :1454 (leave :752), then run `bun test discoveryBroker` and list the red tests in the report.

### Task 4 — Per-device record and classification bodies (R-01, R-02, R-03, R-04, R-05, R-06, R-07, R-08, R-09)
Owner: coder
Files: packages/obsidian-plugin/src/features/mcp-client-config/services/deviceLocations.ts, packages/obsidian-plugin/src/features/mcp-client-config/services/discoveryBroker.ts
Tests: discoveryBroker.test.ts
Signatures:
- windowLocationStore — `export function windowLocationStore(): DeviceLocationStore`
- pathStyle — `export function pathStyle(file: string): PathStyle`
- classifyLocation — `export function classifyLocation(input: { local: string | null; legacy: string | undefined; current: string; legacyIsOwnFile: boolean }): LocationVerdict`
- startDiscovery — `export async function startDiscovery(plugin: DiscoveryPlugin, opts: RuntimeOptions): Promise<DiscoveryRuntime>`, body only
Red: no
Wave: 2
Depends: Task 2, Task 3
Ticket: 2

Depends on Task 2, because once this task stops writing `dataPath` the real-broker tests need the
relaxed admission, and on Task 3 for the declarations and red tests. Write the bodies in
`deviceLocations.ts` following micro-decisions 1, 2, 6 and 7.

In `discoveryBroker.ts`:

- `mintSettings()` no longer takes or sets `dataPath`. `updateSettings` already merges onto the
  stored object, so a legacy `dataPath` survives every write unchanged (R-06).
- Add a private `locate(plugin, opts)` that works in the order of micro-decision 10:
  1. Read the settings with `readSettings`.
  2. Read the local entry for the route ID (a thrown `get` is logged and becomes `null`) and the
     legacy value.
  3. Resolve the canonical path.
  4. Run `isLegacyLocation` only when it can change the answer.

  It returns `classifyLocation`'s verdict together with the route ID and the canonical path.
  It also reports the never-bound case (no entry, no legacy value) before step 3, so
  `isLocationUnresolved` can answer `false` without the path.
- `isLocationUnresolved` returns `false` with no saved route, `false` for a never-bound route
  without resolving the path, `true` when the path then throws (the existing fail-closed rule), and
  `verdict === "changed"` otherwise.
- `startRuntime` replaces the saved-path block (:570-590). `changed` raises the existing
  conflict status and notice with the same wording. `bind` records the current path through the
  store (a thrown `set` is logged and the start goes on). `same` writes nothing. None of them calls
  `updateSettings`.
- `acceptDiscoveryMove` stops writing `dataPath`. If no settings exist it mints, as today, and in
  both cases it records the route ID with the current path.
- `resetDiscoveryIdentity` mints through `updateSettings` without `dataPath` and records the new
  route ID with the current path.
- Update the doc comments of `canonicalDataPath`, `isLocationUnresolved` and `isLegacyLocation`
  where they say the path is "saved with its route" or "Read from the saved settings".

`DiscoverySettings.dataPath` stays as an optional read-only field, parsed by `parseSettings`. Its
only reader is `locate`.

Sub-tasks:
- [x] Write `pathStyle`, `classifyLocation` and `windowLocationStore` in `deviceLocations.ts` per micro-decisions 1, 2, 6 and 7 (lazy `window.localStorage` read, throw when unavailable, `get` throws on invalid JSON, `set` replaces it with a fresh map); the `pathStyle`, `classifyLocation` and `windowLocationStore` cases of `describe("per-device location record")` pass.
- [x] Make `mintSettings()` (`discoveryBroker.ts:206`) mint without `dataPath` and update its callers at :239, :253 and :349; the R-06 cases pass.
- [x] Add the private `locate(plugin, opts)` in the order of micro-decision 10, with `opts.locations ?? windowLocationStore()`, a thrown `get` logged without path or route ID and read as `null`, and the never-bound result returned before the path is resolved.
- [x] Rewrite `isLocationUnresolved` (:263-276) on `locate`; the R-08 `test.each`, fail-closed and never-bound cases pass.
- [x] Replace the saved-path block of `startRuntime` (:570-590): `changed` keeps the existing conflict status and notice text, `bind` calls `locations.set` (a thrown `set` is logged and the start goes on), `same` writes nothing, and no `updateSettings` call is left in the block; the R-01 to R-05 and R-09 cases pass.
- [x] Make `acceptDiscoveryMove` (:247) and `resetDiscoveryIdentity` (:234) record the route ID (the new one after a reset) with the current path, logging a failed `set` without throwing; the R-03 and R-07 cases pass.
- [x] Update the doc comments of `canonicalDataPath`, `isLocationUnresolved` and `isLegacyLocation`: `grep -n "saved with its route\|Read from the saved settings" discoveryBroker.ts` returns nothing.
- [x] `bun test discoveryBroker` and `bun test brokerServer` are green, and `bun run check` passes.

### Task 5 — Call-sites and the rest of the suite (R-08)
Owner: tester
Files: packages/obsidian-plugin/src/features/mcp-client-config/services/endpoint.test.ts
Tests: endpoint.test.ts, discoveryBroker.test.ts, brokerServer.test.ts, routeLifecycle.test.ts, codexInstallFlow.test.ts
Signatures:
- isLocationUnresolved — `export async function isLocationUnresolved(plugin: LocatedPlugin, opts?: { dataPath?: string; locations?: DeviceLocationStore }): Promise<boolean>`
- resolveClientEndpointDetails — existing, `(plugin: EndpointPlugin) => Promise<ClientEndpoint | null>`, unchanged
Red: no
Depends: Task 2, Task 3, Task 4
Ticket: 2

Update the tests and call-sites that assert the old behaviour. A grep on 2026-11-09 for
`dataPath`, `codexDiscovery`, `isLocationUnresolved`, `acceptDiscoveryMove` and
`resetDiscoveryIdentity` under `packages/obsidian-plugin/src` found these sites:

- `endpoint.test.ts:125-207`, `located()` and the cases that use it: it seeds
  `codexDiscovery.dataPath` and goes through the default store. Add `window.localStorage.clear()`
  to its `beforeEach`. All four cases still hold:
  - the `elsewhere()` cases (no entry, a same-style legacy value that differs) stay unresolved
    under R-03;
  - the own-path cases are resolved (legacy equal, so the route binds);
  - "fails closed when the vault's own location cannot be read" (:203) has a legacy value, so it
    reaches step 3 of micro-decision 10 and still answers `null`.

  The `plugin()` cases with no `codexDiscovery` hold no saved route and are unaffected. Add one
  case: an entry for `routeId` equal to the vault's own path, seeded into `window.localStorage`
  under `DEVICE_LOCATIONS_KEY`, with a legacy value elsewhere. The resolver returns a URL (R-04
  through the resolver).
- `AccessControlSection.svelte:155, 621, 710`, `main.ts:149`, `index.ts:101-110`: these are
  read-only checks and need no edit. Confirm with `bun run check:svelte`.
- `mcpbDownload.test.ts` and `autoWrite.test.ts` mention `dataPath` for the `.mcpb` shim's own
  argument, which the SPEC leaves out of scope. Confirm with a grep that neither reads
  `codexDiscovery`, then leave them as they are.
- `connectorShimSource.ts` and `scripts/connectorShim.js`: `dataPath` is the shim's argument and
  `codexDiscovery` is never read (checked). They stay unchanged, and `test:mcpb` confirms it.

Then run the full gate (TEST-CMD below), not only the touched files.

Sub-tasks:
- [x] Add `window.localStorage.clear()` to the `beforeEach` of `describe("resolveClientEndpoint while the vault location is unresolved")` (`endpoint.test.ts:113`); the `elsewhere()` `test.each` (:169) and the cases at :183, :194 and :203 stay green.
- [x] Add the R-04 resolver case: an entry for `routeId` equal to the vault's own path seeded under `DEVICE_LOCATIONS_KEY`, a legacy `dataPath` elsewhere, and `resolveClientEndpointDetails` returns a URL.
- [x] Grep `codexDiscovery` in `mcpbDownload.test.ts` and `autoWrite.test.ts`. `autoWrite.test.ts:490` does seed `codexDiscovery.dataPath` to drive the unresolved-location path: run `bun test autoWrite` and report the result, with no edit, since that file is not on this task's `Files:`.
- [x] Grep `codexDiscovery` in `scripts/connectorShim.js` and `connectorShimSource.ts` (no hit), and `bun run test:mcpb` passes.
- [x] `bun run check:svelte` passes, and `git diff --stat` shows no change to `AccessControlSection.svelte`, `main.ts` or `index.ts`.
- [x] Run the full TEST-CMD and record its result in the report.


## Build result (2026-11-09)
BUILD · DONE
Files: deviceLocations.ts (new), discoveryBroker.ts, discoveryBroker.test.ts, endpoint.test.ts, test-setup.ts, this plan
Tests: 4283 pass, 0 fail (full command green), 84 red-phase cases now green, 1 R-03 guard case, 1 (coverage) case
Review: sonnet, safe; 2 MINOR and 1 NIT fixed in the tree, no open finding
Coverage: not run, the plan names no SPEC
Dispatch: Round 0 (red): tester — Task 3
DEFER untriaged: discoveryBroker.test.ts, the windowLocationStore "throws when the storage ..." tests assert only that it throws, not why
DEFER untriaged: deviceLocations.ts, get reads a non-string entry for a route as no entry; the plan states no contract
DEFER untriaged: features/mcp-client-config/services/autoWrite.test.ts:490 reaches the default window.localStorage store without clearing it, so a leaked entry for the same route ID could change it
INFO: tiered coder low sonnet/medium
INFO: ADR-0035 D6 (BROKER_PROTOCOL_VERSION 3 to 4) was adopted in ticket 1 as the plan's recommended default; not separately confirmed by the user
