# ADR-0035: Keep the broker route's location per device, and drop the location from the broker's ownership check

- **Status:** Accepted and implemented (2026-11-09)
- **Date:** 2026-11-09
- **Scope:** Where the shared broker route's bound `data.json` location is recorded, how a start classifies first bind, same location, move and copy, and what the broker checks before it admits a registration (#667)
- **Amends:** [ADR-0021](/docs/architecture/ADR-0021-shared-local-discovery-broker.md) (§ Storage, upgrades and copied vaults: "Discovery settings in the vault remain the durable owner of the route" and the canonical location recorded in them) and [ADR-0027](/docs/architecture/ADR-0027-shared-broker-for-all-clients.md) (the resolver "compares the location saved with the route", and the broker's admission rule)
- **Requirement set:** `docs/specs/per-device-vault-location-667.SPEC.md`

## Context

Every vault has a broker route: a route ID and a route credential, minted once and kept in
`data.json` under `mcpClientConfig.codexDiscovery`. Since 2.11 the same object also holds
`dataPath`, the canonical absolute path of that `data.json`. A start compares it with the vault's
current canonical path. Equal means the same vault. Different means a move or a copy, which raises
**Vault location changed** and blocks the route until **This vault was moved** or
**Make this copy independent** resolves it (`discoveryBroker.ts`, `startRuntime`).

`data.json` is synced along with the rest of the vault. A vault synced between macOS and Windows
carries one device's absolute path to the other, where it can never match. Each device reads the
other's save as a move or a copy, drops its broker route, and confirming the move writes a path
that syncs back and breaks the first device (#667).

The SPEC moves the saved location into a per-device record in `window.localStorage`, keyed by
route ID, stops writing `dataPath` and keeps an existing value as read-only legacy input. Those
decisions are recorded there with their rationale and are not reopened here.

One fact the SPEC does not name decides whether its decisions can work at all. The broker admits a
registration only when the `data.json` at the registered path names that same path:
`ownsRegistration` in `brokerServer.ts` requires
`settings.dataPath === registration.dataPath`, next to the route ID and the route credential. With
the plugin no longer writing `dataPath`:

- a vault minted by this release has no `dataPath`, so its first registration gets `401`;
- a synced vault carries the other device's `dataPath`, so it gets `401` on every device but the
  one that wrote it, which is #667 again, one layer down.

So the move to a per-device record also moves where copy detection happens. Until now it ran
twice: in the plugin, before registering, and in the broker, which refused a copy whose `data.json`
named the original's path even with the original closed. A third check, the broker's `409` for a
route already held under another data path, catches two open copies and is unrelated to `dataPath`
in the file.

What the equality check protected, read from the code on 2026-11-09: it is not an authentication
factor. The registrant must still present the route credential stored in the file it names, the
file must still pass `isPluginDataPath` (the plugin's own `data.json` under `plugins/<id>/`,
normalized) and the owner and write-access checks. Anyone who can read the route credential can
also read the `dataPath` beside it, so the equality adds no secret. It is a copy guard.

## Decision

1. **The bound location lives in a per-device record**, a JSON map from route ID to canonical
   `data.json` path under one namespaced key of `window.localStorage`. It is not a setting and does
   not go through `SettingsStore`. It is never synced and never in a vault-scoped store
   (`app.saveLocalStorage` is vault-scoped, so a copy would read an empty store). Recorded in the
   SPEC; listed here because the rest of this decision depends on it.

2. **One pure classification decides every start and every unresolved-location check.** Its inputs
   are the local entry for the route, the legacy `dataPath`, the current canonical path and whether
   the legacy value names this vault's own file in the 2.11/2.12 form. Its answer is `bind`, `same`
   or `changed`:

   - a local entry equal to the current path is `same`, whatever the legacy value holds;
   - a local entry that differs is `changed`;
   - with no local entry: no legacy value, a legacy value equal to the current path, a legacy value
     in the other path style than the current path, or a legacy value naming this vault's own file
     in the older linked-folder form (the 3.0.1 fix) is `bind`; anything else is `changed`.

   Path style is read from the text alone: a drive letter or a leading `\\` is Windows style, a
   leading `/` is POSIX style, anything else is neither. A legacy value of neither style is treated
   as the same style, so it prompts. `startDiscovery` and `isLocationUnresolved` call the same
   function, so the endpoint resolver and the start cannot disagree (the `planMigration` precedent
   of ADR-0025). `isLocationUnresolved` still fails closed when the current path cannot be read.

3. **The plugin never writes `dataPath` again** and leaves an existing value as it is. First bind,
   **This vault was moved** and **Make this copy independent** write the device record only. The
   new identity's route ID is recorded with the current path. An older build therefore still reads
   what it wrote, on the device that wrote it.

4. **A store that throws or is missing reads as empty, and its failure is logged without a path or
   a route ID.** A failed write never stops the route from registering. The bind repeats on the next
   start. A corrupt map under the key is replaced by a fresh one on the next write rather than
   making every later write fail.

5. **The broker drops `dataPath` from its ownership check.** A registration is admitted when the
   `data.json` at the registered path passes every existing file check and holds the registered
   route ID and a matching route credential. A `dataPath` in that file, of any value or absent, is
   ignored. The `409` for a route held under another data path, the per-request file checks and the
   bare `/mcp` copy conflict are unchanged.

6. **`BROKER_PROTOCOL_VERSION` goes from 3 to 4.** Any open vault can host the broker. A version 3
   host keeps the equality check and refuses this release's registrations with a bare `401`, which
   the vault can only report as "for a reason this vault cannot check". At version 4 the health
   probe reports the other host as incompatible instead, and the existing "update the plugin in
   every open vault" message applies. Outcome: the bump was adopted as the plan's recommended
   default when the broker change was implemented. It was not separately confirmed by the user.

## Alternatives considered

- **Keep the equality check and keep writing `dataPath` for the broker alone.** Rejected: it makes
  every start on every device rewrite a synced field, so devices keep overwriting each other's
  value, and a running route's next re-registration fails on whichever device lost the last sync.
  That is #667 with sync conflicts added. It also contradicts the SPEC's decision to stop writing
  the field.
- **Have the broker compare against the device record instead of `data.json`.** Rejected: the broker
  runs in whichever vault's renderer hosts it, not in the registrant's, and it reads registrants'
  state only through their `data.json` files by design (ADR-0021: no registration files, routes in
  memory only). Handing it the device record would need a second channel for something the
  registrant already checked before registering.
- **Send the device record's entry in the registration body for the broker to compare.** Rejected:
  the registrant chooses that value, so comparing it with the registered path proves nothing the
  registrant did not already decide.
- **Leave the protocol version at 3.** Considered as the fallback had the bump been declined. It
  costs nothing while every open vault runs this release, and avoids an "incompatible" notice in a
  vault that still runs an older one. It was not chosen because the
  failure it leaves is the worse one: a mixed set of open vaults where an older one hosts gives the
  new vault an unexplained `401` with no hint that updating the other vault fixes it.

## Consequences

**Positive**

- A synced vault registers its route on every device with no prompt. The one exception is a legacy
  value of the same style that differs, on a device with no record yet: it prompts once, and the
  confirmation is recorded locally only.
- A move or a copy on the same device is still caught, through the local entry for the route ID.
- One classification function serves the start and the endpoint resolver, so the copy buttons and
  the route state agree by construction.

**Negative**

- The broker no longer catches a copy on its own. A copy whose original is closed, opened on a
  device whose record was cleared or that never bound the route, registers silently, which the SPEC
  accepts as rare. Two open copies still get the broker's `409`.
- With the version bump, a machine that runs this release in one open vault and an older release in
  another shows "incompatible" in whichever does not host, until both are updated.
- **Make this copy independent** leaves the original's legacy `dataPath` beside the new route ID,
  because nothing writes the field. On another device of the same platform style the new route
  then prompts once. Clearing the field would break a downgrade on the device that wrote it, the
  reason the SPEC keeps it.
- A store that keeps failing to write turns every start into a first bind and loses copy detection
  for that vault on that device. The failure is logged on every start.

**Neutral**

- Entries for deleted vaults stay in the device record. The SPEC accepts this.
- The `.mcpb` shim reads neither `codexDiscovery` nor the device record, so its `data.json` read
  contract does not change.
- The record is shared by every vault Obsidian opens on the device, which is what lets it see a
  copy. Route IDs are random UUIDs, so two vaults never share an entry.

## References

- SPEC: `docs/specs/per-device-vault-location-667.SPEC.md`
- Plan: `docs/plans/per-device-vault-location-667.md`
- Issue: #667
- Code read on 2026-11-09: `packages/obsidian-plugin/src/features/mcp-client-config/services/brokerServer.ts`
  (`ownsRegistration`, `BROKER_PROTOCOL_VERSION`, the same-path `409`) and
  `services/discoveryBroker.ts` (`startRuntime`, `isLocationUnresolved`, `isLegacyLocation`,
  `probeBroker`)
- [ADR-0021](/docs/architecture/ADR-0021-shared-local-discovery-broker.md),
  [ADR-0025](/docs/architecture/ADR-0025-migrate-existing-tokens-to-adaptive.md) (one pure function
  for preview and effect), [ADR-0027](/docs/architecture/ADR-0027-shared-broker-for-all-clients.md)
