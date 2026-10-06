# ADR-0027: Shared broker for all clients

- **Status:** Accepted and implemented
- **Date:** 2026-10-06
- **Scope:** One stable loopback endpoint per vault for every HTTP client, hosted inside Obsidian
- **Amends:** [ADR-0021](/docs/architecture/ADR-0021-shared-local-discovery-broker.md) (broker hosting, broker port, Node.js requirement, idle exit, Codex-only registration and the Codex credential swap)

## Context

Each vault server bound the first free port from `27200` through `27205`.
Opening vaults in a different order swapped their ports.
The plugin persisted the bound port as `mcpTransport.livePort`, but port selection never read it back, so a vault had no preference for the port it used before.

Only the `.mcpb` shim and the Codex broker read `livePort` at connect time.
Every other client config embedded the port: The Claude Code command and `.mcp.json` entry, the streamable HTTP and Cline entries, the `mcp-remote` config, the Windows POST-only bridge and the Claude Desktop config sync.
After a swap those configs reached another vault, which usually rejected the token with `401`, or reached no listener at all.

ADR-0021 solved this for Codex alone with a detached Node.js broker on `127.0.0.1:27206`.
That broker needed a system Node.js installation, a generated executable in a per-user application-data directory, a process outside Obsidian's lifecycle and a ten-second idle exit.
ADR-0021 rejected hosting the broker in a vault's renderer because that vault would own the routes of every other vault

## Decision

### Port layout

The shared broker always listens on `127.0.0.1:27200` (`BROKER_PORT` in `packages/obsidian-plugin/src/features/mcp-transport/constants.ts`).
The broker port is not configurable.

The dynamic vault range is `27201` through `27212`, twelve slots.
A dynamic vault tries its persisted `livePort` first when that port is inside the range, then the remaining ports in order.
This reduces drift between restarts but does not reserve a port for a vault.

A fixed port (`mcpTransport.port`) behaves as before: One port and no fallback.
The settings UI refuses a new fixed port of `27200` because it is reserved for the shared broker.
An existing fixed `27200` still loads as a direct vault port.
While that vault runs, no vault can host the broker.
That vault registers no route and shows a Notice asking the user to change its fixed port

### In-process hosting and election

The broker runs inside one vault's Obsidian renderer.
`services/brokerServer.ts` in the `mcp-client-config` feature implements the broker, and `services/discoveryBroker.ts` implements host election and the per-vault route runtime.
The detached process, `scripts/discoveryBroker.js`, its generated source asset and the `broker-v2` application-data directory are removed.
The broker and Codex no longer need a system Node.js installation.
Node.js remains a requirement only for the `.mcpb` export and the `mcp-remote` path.

On plugin load, after the vault's MCP transport has started, each vault probes `GET /_obsidian_mcp_broker/health` on port `27200`:

- **A healthy broker** answers with the name `obsidian-mcp-discovery-broker` and protocol version `3`. The vault registers with it
- **A free port** makes the vault start the broker in-process
- **`EADDRINUSE`** means another vault won the race between probe and bind. The vault probes again and registers
- **Any other listener**, such as a foreign process, a vault on an older plugin version whose vault server holds `27200`, or a vault with fixed port `27200`, leaves the vault without a broker. Direct vault ports keep working, one Notice per start names those causes and the route status keeps retrying with backoff
- **A broker with another protocol version** produces a Notice asking the user to update the plugin in every open vault

Every vault, including the host, registers its route over a loopback control connection.
The request is `POST /_obsidian_mcp_broker/register/<route-id>` with the route credential as bearer and a lease header.
Its body names the route, the canonical `data.json` path, the lease and the port of the vault's running MCP transport.
The broker holds registrations only in memory and only while the control connection is open.

The broker forwards a route to the port the vault registered on its control connection, never to `mcpTransport.livePort` in `data.json`.
Obsidian does not await `onunload`, so a save from an unloaded plugin instance can still land after the reloaded instance has published its own port, and the file can then name a released port.
A registration whose port is not an integer from `1024` through `65535`, is `27200` or is the port the broker listens on gets `401`

### Failover and unload

When a vault's control connection drops, for example because the hosting vault closed, the vault retries after a random delay of 50 to 250 ms.
Later retries use the existing exponential backoff from 1 to 30 seconds.
The first vault that binds the port hosts the broker and the others register with it.
The broker has no idle exit and lives as long as the plugin instance that hosts it.
Clients see a short outage during failover.

Obsidian does not await `onunload`.
The plugin therefore starts closing the listener synchronously, destroys every control connection and in-flight forwarded request, cancels a pending election and then awaits the remaining cleanup.
Obsidian does not await `onload` either, so a vault can unload while its transport or route is still starting.

One queue per plugin instance runs the transport start on load, transport restarts and route changes one at a time, so two of them never tear down each other's transport or route.
`onunload` closes the queue first and synchronously.
A queued operation then never runs, and one still running stops or tears down the route or transport it creates instead of keeping it.
The rest of `onload` does not run after an unload

Saving a fixed port or a server name restarts the vault's transport.
The vault stops its route before it releases the old port and registers again with the new port only once the new transport listens.
A reconnect after a dropped control connection registers the same port, because the route stops whenever its transport stops.
A broker this vault hosts keeps running for the other vaults meanwhile.
When the restart fails, the route stays down and the settings show the transport error, so the broker never forwards a request to a released port.
**Retry connection**, **This vault was moved** and **Make this copy independent** restart the route only while the transport runs on a port other than `27200`.
Otherwise they save the location or identity change and leave the route stopped

### Routes for every vault

Every vault has a route UUID and a route credential, minted on first start when missing.
Both live under the existing `mcpClientConfig.codexDiscovery` key, so no data migration runs and the key keeps its name.
A route's lifetime does not depend on Codex.
The route credential is only a registration secret that proves route ownership: No client sends it, and the settings do not show it.
The `enabled` and `tokenId` keys that earlier versions stored under the same key are ignored and left in place.

The broker admits a registration when the vault's `data.json` names the same route ID and the same canonical `data.json` path, and the bearer matches the stored route credential.
The registered path must have the shape of this plugin's own data file, `<vault>/<config folder>/plugins/<plugin ID>/data.json`, with the plugin ID of the hosting plugin and in canonical form.
The config folder name is not checked, because each vault can override it.
On macOS and Linux the broker also checks the file and its `plugins/<plugin ID>` folder without following links: Both must be a regular file and a folder, owned by the user running Obsidian and not writable by others or by any group other than that user's own primary group.
The broker opens `data.json` without following a final link, checks the open file and reads from it, so a path swapped after the check, for example through a linked parent folder, cannot change what it reads.
A FIFO is opened without waiting for a writer and then fails the regular-file check.
Every read of a registered `data.json` goes through these checks: Admission, each forwarded request and bare `/mcp` routing.
Windows has no comparably cheap owner check, so there the broker relies on the access rules of the user profile that holds the vault.
Copied-vault handling from ADR-0021 stays.
A different data path claiming a registered route gets `409`.
A moved vault must confirm **This vault was moved**, and a copy uses **Make this copy independent**

### Request authentication on a route

For each request on `/v1/<route-id>/mcp`, the broker reads that vault's `data.json` again with the admission checks, bounded to regular files of at most 1 MB.
A file that fails a check gets `503`.
Otherwise the broker forwards the request with its `Authorization` header unchanged, or absent, to `127.0.0.1:<registered port>/mcp`.
The vault authenticates it as on a direct port, so per-client tokens and tool profiles apply, a revoked token gets the vault's `401` and `GET` gets the vault's `405`.
The broker swaps no credential: ADR-0021's Codex credential swap is removed, and the route credential sent as a client bearer gets the vault's `401` like any unknown token

### Legacy bare `/mcp` on the broker port

Configs written while a vault served `27200` directly still call `http://127.0.0.1:27200/mcp`.
For that path the broker looks for the registered vault whose token store holds the presented bearer, comparing in constant time and reading each token store again per request, and forwards the request to the port that vault registered.
No match returns `401`, or `405` for a method other than `POST`.
A token present in more than one open vault, usually a copied vault, returns `409` with a message to use **Make this copy independent** in the copy.

Host and Origin checks, registration size, timeout and pending caps, hop-by-hop header stripping and response streaming are unchanged from ADR-0021

### Client endpoint resolver

`services/endpoint.ts` is the single place that chooses the URL a client config uses.
By default it returns `http://127.0.0.1:27200/v1/<route-id>/mcp`.
A vault with a fixed port gets `http://127.0.0.1:<fixedPort>/mcp`, because the user pinned that port to address the vault directly.

Every copy button on a token row uses the resolver: Claude Desktop with `mcp-remote`, the Claude Code `claude mcp add` command, the Claude Code `.mcp.json` entry, the Cursor, Continue and VS Code streamable HTTP entry and Cline.
The Claude Desktop config sync also uses it, writes a URL and is applied again when the fixed-port setting is saved.
While a vault location change is unresolved, the resolver returns no URL, for a fixed port too, because the saved route may still belong to the original vault.
It compares the location saved with the route against the vault's own canonical `data.json` path, so the check holds while no route runs, for a legacy fixed `27200` and after a failed start.
Copy buttons are then disabled and the sync writes nothing.
A legacy fixed `27200` registers no route and still resolves to its direct URL.
The **Server port** setting shows both the vault's own endpoint and the URL client configs use.

The `.mcpb` export is unchanged.
Its shim still reads `livePort` and connects to the vault directly

### Codex entries

Codex is a client like any other.
Each token row has **Codex**, which copies a `config.toml` entry with the client endpoint URL, normally `http://127.0.0.1:27200/v1/<route-id>/mcp`, and that row's vault token.
The entry is named with the same per-vault key as every other client config, such as `obsidian_my_vault`, with no route ID in it. A snippet copied from another row therefore names this vault's one entry.
The route ID only appears in the URL.
ADR-0021's `obsidian_<vault>_<route-uuid>` names and the saved entry name are dropped. Equally named vaults share a key, as they already do for every other client, and renaming a vault renames its entry.
Codex config is copy-only: The plugin never reads, locates or writes the Codex config.
The opt-in Claude Desktop config sync stays the only client config the plugin writes.
The earlier one-time installer and its backup, atomic write and `27206` detection are removed, so replacing an old entry is a manual paste.

The Codex checkbox, its token selector and **Reset Codex connection** are removed.
Entries installed through the old checkbox carry the route credential and get `401` until they are copied again from a token row.
**Make this copy independent** always gives the vault a new route, so clients that should use the copy need fresh configs from its token rows.
Codex configuration no longer requires Node.js

## Consequences

Every HTTP client config survives vault port changes, open-order swaps and restarts, because its URL names a route instead of a port.
Per-client tokens and tool profiles apply through the broker exactly as on a direct port, so the broker adds no authority of its own.
Codex keeps its stable entry without a second process, a system Node.js installation or files outside the vault.
Replacing a token's secret breaks a Codex entry for that token, as for any client with a pasted token.

The broker lives and dies with Obsidian.
It disappears when the last vault closes, and nothing remains in application data.
A vault that hosts the broker carries the routes of every open vault, and closing it causes a short outage until another vault takes over.

Port `27200` changes meaning.
Configs from before this change that pointed at a vault on `27200` keep working only through bare `/mcp` token routing.
Codex entries on `27206` stop working until they are replaced by hand.
A dynamic vault port can still change when its last port is taken.
Resolver URLs do not depend on it, and the `.mcpb` shim reads it at connect time.
Direct configs copied earlier that name `27201` through `27205` still address a vault port and break when it changes, until they are copied again.

A route ID is as sensitive as a token.
The broker admits the first valid registration for a route ID, so a process that knows the ID and registers first can make the vault's own registration fail.
That conflict surfaces like a copied vault's: The registration gets `409` and the broker connection in Access Control shows **Needs attention**.
On macOS and Linux the path and ownership checks keep another user's process from claiming a route with a file it controls.
They do not stop a process of the same user, which can already read the vault's `data.json` and its tokens.
Group write access is accepted only when the group is the user's own primary group, the per-user group a `002` umask relies on, so Obsidian's default file modes on Ubuntu and similar systems still register.
A vault whose `data.json` or plugin folder is writable by any other group, or by others, cannot register a route and gets the broker's `401` until that write access is removed.
Such access added after registration makes its route answer `503`.
Its direct port keeps working

## Accepted risks

- **Failover outage:** After the hosting vault closes, broker requests fail until another vault binds the port and the open vaults register again
- **Port-owner trust on `27200`:** A process that binds `127.0.0.1:27200` first receives the bearer tokens clients send, including vault tokens on routes, and registrations reveal route credentials. This is the same trust model as squatting a direct vault port today. The single fixed port is easier to target than a vault in a port range. The plugin reports the foreign listener in a Notice but cannot stop clients from sending credentials to it. ADR-0021's reasoning against a registration-only challenge still applies
- **Breaking move for Codex:** Entries on `127.0.0.1:27206`, and entries that send the route credential, fail until a snippet from **Codex** on a token row replaces them. The plugin does not detect or rewrite such entries, because it never touches `config.toml`
- **Legacy direct configs on `27200`:** They keep working only through bare `/mcp` token routing, and fail while a foreign process or an older plugin version holds `27200`
- **Route registration by a same-user process:** A process running as the same user that knows a route ID can register first with a `data.json` it controls and then receive the bearer tokens clients send on that route. Such a process can already read every vault's `data.json`, tokens included, so registration adds no access it lacks. The vault's own registration then fails with `409` and shows **Needs attention** instead of silently losing its route. A full registry of trusted vault paths was not adopted
- **Windows ownership:** The broker checks only the path shape on Windows and relies on the user profile's access rules to keep other users from writing a vault's `data.json`

## Alternatives considered

- **Keep the detached Node.js process and extend it to every client.** It keeps the system Node.js requirement, the generated executable in application data and a process outside Obsidian's lifecycle for every user instead of only Codex users
- **Reserve a port per vault.** A persisted per-vault port still collides when vaults are copied or opened on another machine, needs an allocation scheme across vaults that cannot see each other and still breaks direct configs when the reservation fails. Preferring `livePort` keeps the benefit without the contract
- **Keep the broker Codex-only.** It leaves every other HTTP client exposed to open-order port swaps, which was the defect that prompted this change
