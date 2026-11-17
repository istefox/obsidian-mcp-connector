Status: Approved (2026-11-09)
Mode: auto

# SPEC — Per-device vault location record for the shared broker (#667)

## Destination

An approved SPEC that stops a vault synced between devices from raising "Vault location changed"
on every device, ready for `/workplan`. Reaching the end of the work means: syncing `data.json`
never invalidates another device's broker route, while a real move or a real copy on one device is
still detected.

## Objectives

The broker route saves the absolute `data.json` path in the synced `data.json` and compares it with
the local path at every start. On a vault synced between macOS and Windows the two paths can never
match, so each device reads the other's save as a move or copy, drops its broker route, and
confirming the move re-saves a path that syncs back and breaks the other device. The user-visible
goal: open the same synced vault on a second device and have the broker route register with no
prompt; keep the prompt only for a move or copy that actually happened on that device.

## Scope and non-goals

In: where the broker route's saved location lives, how a start decides between first bind, same
location, move and copy, the one-way migration of the existing synced `dataPath`, and the Access
Control actions that write the location.

Out: the `.mcpb` shim's own `dataPath` argument, the Web Worker of #664, the cause of #666, a new
"synced to another device" button, pruning old location entries.

## Decisions

- **The saved location moves out of the synced `data.json` into a per-device record keyed by the
  route ID.** Keying by route ID is what keeps a same-machine copy detectable (it carries the same
  route ID but sits at another path), lets a new device bind silently, and lets a move on the same
  device still prompt once. Rejected: keep the path in the synced file and add a per-device key
  inside it — the synced file is still rewritten by every device, so devices keep invalidating each
  other. Rejected: a third "this vault is synced" button — it asks the user to resolve a state the
  plugin can classify itself, and it leaves the root cause in place.
- **The record lives in `window.localStorage`, not in `app.saveLocalStorage`.** The Obsidian typings
  show `saveLocalStorage` is vault-scoped, so a copied vault would read an empty store and the copy
  would go undetected. Rejected: a file outside the vault — it needs a per-OS path choice and
  gains nothing while `window.localStorage` works. User mandate for the choice.
- **An empty local record is a silent first bind** when `data.json` has no legacy `dataPath` to
  compare with. A copy made after the device's store was cleared goes undetected; accepted by the
  user as rare. Rejected: always prompt on a new device — it brings back the nuisance of #667.
- **Migration reads the legacy synced `dataPath` once and never writes it again.** With no local
  entry for the route: a legacy path in the other platform's style (drive letter or UNC versus a
  leading `/`) is ignored and the device binds silently; a legacy path in the same style that
  differs from the current one prompts once and, when confirmed, saves only locally; an equal path
  binds silently. The plugin stops writing `dataPath` into `data.json` and leaves an existing one
  untouched, so a downgrade still reads what it wrote. Rejected: delete the field after migration —
  it breaks a downgrade on the device that wrote it.
- **Confirming a move and rotating the identity both write the per-device record, nothing else.**
  A confirmed move keeps the route and credential; a new identity writes the record for the new
  route ID.
- **One test seam: the broker service's location logic, with the device record injected.** No
  Svelte test, because the UI only calls functions that already exist.

## Constraints

- **Settings writes go through the sliced store and its mutex; the per-device record is not a
  setting** — origin: existing CLAUDE.md architecture note (`data.json` is shared by every feature).
- **A bearer token or route credential never changes silently** — origin: CLAUDE.md gotcha. No
  path in this work may rotate either without the explicit "new identity" action.
- **The `.mcpb` shim must stay backward compatible and fail closed on an unknown token id** —
  origin: CLAUDE.md gotcha. It does not read the broker's location, and this work must not change
  its `data.json` read contract.
- **Community-plugin review lints `src/**`** — origin: platform. Direct `window.localStorage` use
  must pass it. Checked 2026-11-09: the published Obsidian plugin guidelines and the
  eslint-plugin README name no rule against `localStorage` (the only related rule is
  `prefer-get-language`). Not checked: the scanner itself, only run at release.

## Stack

TypeScript in the plugin's `mcp-client-config` feature (broker service) and the Access Control
Svelte section that calls it. Tests with `bun test`.

## Data model

- **Per-device location record:** a map from route ID to the canonical `data.json` path last bound
  on this device, held under one namespaced key of the device's `window.localStorage`. Never
  synced, never inside a vault-scoped store.
- **Synced settings:** the route ID and credential stay. The saved path becomes read-only legacy
  input: read for migration, never written.
- **Path style:** each path is classified Windows-style (drive letter or UNC) or POSIX-style
  (leading `/`). Classification is text-only and does not depend on the running platform, which is
  compared against separately.

## API / interfaces

The broker's existing location functions keep their names and callers (start, accept a move, reset
identity, is the location unresolved). Their behaviour changes as in Decisions; the Access Control
section and the endpoint resolver need no new call.

## UI flows

The existing "Vault location changed" notice and its two actions (confirm a move, make this copy
independent) stay, with the same wording. They appear only for a same-device move or copy, or a
legacy same-style path that differs. No new control.

## Edge cases

- Same vault synced to a second device of the same OS but another path: legacy-path migration
  prompts once, then never again, since the confirmation is saved locally only.
- Local store unreadable (throws, or unavailable): treated as empty, so a silent bind; the failure
  is logged. A write failure does not stop the route from registering; the bind repeats next start.
- Copy on the same device: same route ID, different path, local entry present: prompt, as today.
- Two vaults on one device: distinct route IDs, distinct entries, no clash.
- Entries of deleted vaults stay in the local record; accepted.
- Windows paths keep their lowercase canonical form, so a case-only difference is no move.

## Test seams

One seam: the broker service's location logic in its existing colocated test file, with the device
record replaced by an in-memory stand-in. It covers path-style classification, first bind, same
location, move, copy, legacy migration (cross-style, same-style differing, equal), store failures,
and that confirm-move and reset write only the device record. The real sync between two devices
and the live `window.localStorage` sharing across vaults are checked by hand, because no test seam
reaches them.

## Success criteria

- [ ] R-01 — With no local entry and no legacy saved path, a start binds the current location
  silently, registers the route, and records the path in the device record only.
- [ ] R-02 — With no local entry and a legacy saved path in the other platform's style, a start
  binds silently, no conflict status and no notice.
- [ ] R-03 — With no local entry and a legacy saved path in the same style that differs from the
  current one, a start reports the location change once; confirming a move saves the path in the
  device record only and the next start is silent.
- [ ] R-04 — With a local entry equal to the current path, a start registers the route with no
  prompt, whatever the legacy saved path holds.
- [ ] R-05 — With a local entry that differs from the current path (same route ID), a start reports
  the location change, as a same-device move or copy did before.
- [ ] R-06 — No code path writes `dataPath` into the synced settings, including first bind,
  confirm-move and new-identity; an existing legacy value is left unchanged.
- [ ] R-07 — Confirming a move keeps the route ID and credential; making the copy independent
  mints a new route ID and credential and records the current path for the new route ID.
- [ ] R-08 — The unresolved-location check returns the same answer as the start for every case in
  R-01 to R-05, and still fails closed when the current location cannot be read.
- [ ] R-09 — An unreadable or throwing device store behaves as an empty one and logs the failure;
  a failing write does not stop route registration.
- [ ] R-10 — A synced `data.json` that reaches a second device, with the plugin there already
  bound, does not take the broker route down on its next start (manual check on two devices,
  macOS and Windows, since no test seam reaches real sync and `window.localStorage` sharing)
  (no-test: needs two real devices and Obsidian Sync, which no automated seam reaches).
- [ ] R-11 — The README section on moved and copied vaults states that the location is kept per
  device and that a synced vault is not a move (no-test: documentation obligation checked by
  review).

## Not yet specified

_none_

## Out of scope

- The `.mcpb` shim's `dataPath`: a separate argument with its own backward-compatibility rule.
- Web Worker for semantic search (#664) and the unconfirmed cause of #666: separate decisions.
- A "synced to another device" button: the plugin classifies the case itself.
- Pruning entries of deleted vaults from the device record: negligible size.
- Replies to the reporters: posted after the fix ships, through the humanize pass.

## Domain terms

- **Route ID:** the id of this vault's broker route, minted once and synced; the key of the
  per-device record.
- **Legacy saved path:** the `dataPath` field that older plugin versions wrote into the synced
  settings.
