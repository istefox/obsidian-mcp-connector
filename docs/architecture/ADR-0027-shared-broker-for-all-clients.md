# ADR-0027: Shared broker for all clients

- **Status:** Accepted and implemented, amended by ADR-0028 (Codex installer, project install, entry ownership)
- **Date:** 2026-10-06
- **Scope:** One stable loopback endpoint per vault for every HTTP client, hosted inside Obsidian
- **Amends:** [ADR-0021](/docs/architecture/ADR-0021-shared-local-discovery-broker.md) (broker hosting, broker port, Node.js requirement, idle exit, Codex-only registration, the Codex credential swap, Codex entry names and the Codex config installer)

> **Amended by [ADR-0028](/docs/architecture/ADR-0028-codex-installer-and-project-scope.md).**
> Codex is no longer copy-only.
> Each token row has a **Codex** menu that copies a `config.toml` entry or a `codex mcp add` command, or installs the entry into the user's Codex config or into a project's `.codex/config.toml` after a preview and a confirmation.
> The installer keeps the plain `obsidian_<vault>` key, refuses another vault's entry by the route in its URL and migrates this vault's earlier entries, including those on `27206` and those that send the route credential.
> The passages below marked "Amended by ADR-0028" record this decision's original text

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
- **Any other listener**, such as a foreign process, a vault on an older plugin version whose vault server holds `27200`, or a vault with fixed port `27200`, leaves the vault without a broker. Direct vault ports keep working, one Notice per start names those causes and the route status shows **Unavailable** and keeps retrying with backoff
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
The vault resolves links in that path up to the `plugins` folder and keeps the plugin folder's own name, so a plugin folder linked elsewhere, as `bun run link` creates, still names the plugin ID.
The config folder name is not checked, because each vault can override it.
On macOS and Linux the broker also checks the `plugins` folder, the plugin folder and the file.
All three must be owned by the user running Obsidian and not writable by others or by any group other than that user's own primary group.
The `plugins` folder must be a real folder, not a link, so only its owner can create or replace the plugin folder in it.
The plugin folder may be a link and is checked where it leads.
The broker opens `data.json` without following a final link, checks that it is a regular file on the open file and reads from it, so a path swapped after the check, for example through a linked parent folder, cannot change what it reads.
A FIFO is opened without waiting for a writer and then fails the regular-file check.
Every use of a registered `data.json` goes through these checks: Admission, each forwarded request and bare `/mcp` routing.
Windows has no comparably cheap owner check, so there the broker relies on the access rules of the user profile that holds the vault.
Copied-vault handling from ADR-0021 stays.
A different data path claiming a registered route gets `409`.
The same data path under another lease replaces the held control, which is how a restarting vault takes its route back. Because two open vaults can share one data file, a route's control may be replaced at most three times in ten seconds, and the next replacement gets `409` like a copied vault's
A moved vault must confirm **This vault was moved**, and a copy uses **Make this copy independent**

### Refused registrations

The broker answers every refused registration with `401` and no reason, so another local process learns nothing about a vault's files.
The registering vault runs the broker's own checks on its `data.json`, through the same code, and names the one that failed: The path shape, a `plugins` folder, plugin folder or `data.json` that is not the user's or that others or a foreign group can write, a `plugins` folder or `data.json` that is a link, a file over 1 MB, an unreadable file or invalid JSON.
The message names the path and what to change, for example removing write access for others with `chmod o-w`.
When every check passes, the cause is one the vault cannot see, such as a route credential that changed meanwhile or a host running a different plugin build, and the message says so.
The broker connection in Access Control shows **Refused** with that message, and one Notice per route start repeats it.
The route keeps retrying with backoff, so fixing the file reconnects it without a reload

### Request authentication on a route

For each request on `/v1/<route-id>/mcp`, the broker runs the admission checks on that vault's `data.json` again, on the open file and bounded to regular files of at most 1 MB.
It does not read or parse the file, because the vault authenticates the bearer itself, so a file that is no longer valid JSON still forwards.
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

While the broker cannot reach the vault, the resolver returns the vault's direct URL on the transport port its route registered, `http://127.0.0.1:<port>/mcp`.
That holds after a refused registration (**Refused**), while no compatible broker can run on `27200` (**Unavailable**) and while another vault holds the route (**Needs attention**), because the route URL then fails or reaches another vault until the user acts.
A route that is connecting, connected or retrying after a dropped control connection keeps the broker URL, because a failover between hosting vaults ends on its own.
Access Control resolves the URL again whenever the route status changes and explains that its copy buttons give a direct URL meanwhile, which breaks when the vault's port changes.
The Claude Desktop config sync writes that direct URL too when it runs meanwhile.
It runs only on an explicit action that expects a working entry, such as turning it on or replacing its token's secret, and skipping would keep a replaced secret.
It does not rewrite the entry when the route connects again.

Every copy button on a token row uses the resolver: Claude Desktop with `mcp-remote`, the Claude Code `claude mcp add` command, the Claude Code `.mcp.json` entry, the Cursor, Continue and VS Code streamable HTTP entry and Cline.
*Amended by ADR-0028:* The Codex menu on each row uses it too, for its copy actions and its installs.
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
*Amended by ADR-0028:* **Codex** is a menu with four actions: Copy the snippet, copy the `codex mcp add` command, install into the user's Codex config and install into the project.
The entry is named with the same per-vault key as every other client config, such as `obsidian_my_vault`, with no route ID in it. A snippet copied from another row therefore names this vault's one entry.
The route ID only appears in the URL.
ADR-0021's `obsidian_<vault>_<route-uuid>` names and the saved entry name are dropped.
The key no longer has to tell vaults apart, because the URL already names the route.
Renaming a vault changes the key of new snippets only. Once the location change is confirmed as a move, the route ID stays, so a pasted entry keeps its key and URL.
Equally named vaults share a key, as they already do for every other client, see the accepted risks.
Codex config is copy-only: The plugin never reads, locates or writes the Codex config.
The opt-in Claude Desktop config sync stays the only client config the plugin writes.
The earlier one-time installer and its backup, atomic write and `27206` detection are removed, so replacing an old entry is a manual paste.
*Amended by ADR-0028:* The installer is restored for the user and the project config, and runs only after a preview and a confirmation. The opt-in Claude Desktop sync stays the only client config the plugin writes without a confirmation per write.

The Codex checkbox, its token selector and **Reset Codex connection** are removed.
Entries installed through the old checkbox carry the route credential and get `401` until they are copied again from a token row.
*Amended by ADR-0028:* An install from the Codex menu also repairs them, replacing the credential with the row token.
**Make this copy independent** always gives the vault a new route, so clients that should use the copy need fresh configs from its token rows.
Codex configuration no longer requires Node.js

## Consequences

Every HTTP client config survives vault port changes, open-order swaps and restarts, because its URL names a route instead of a port.
Per-client tokens and tool profiles apply through the broker exactly as on a direct port, so the broker adds no authority of its own.
Codex keeps its stable entry without a second process, a system Node.js installation or files outside the vault.
*Amended by ADR-0028:* A confirmed Codex install writes `config.toml`, its backup and a short-lived lock file outside the vault.
Replacing a token's secret breaks a Codex entry for that token, as for any client with a pasted token.

The broker lives and dies with Obsidian.
It disappears when the last vault closes, and nothing remains in application data.
A vault that hosts the broker carries the routes of every open vault, and closing it causes a short outage until another vault takes over.

Port `27200` changes meaning.
Configs from before this change that pointed at a vault on `27200` keep working only through bare `/mcp` token routing.
Codex entries on `27206` stop working until they are replaced by hand.
*Amended by ADR-0028:* An install from the Codex menu replaces or migrates them.
A dynamic vault port can still change when its last port is taken.
Resolver URLs do not depend on it, and the `.mcpb` shim reads it at connect time.
Direct configs copied earlier that name `27201` through `27205` still address a vault port and break when it changes, until they are copied again.

A route ID is as sensitive as a token.
The broker admits the first valid registration for a route ID, so a process that knows the ID and registers first can make the vault's own registration fail.
That conflict surfaces like a copied vault's: The registration gets `409` and the broker connection in Access Control shows **Needs attention**.
On macOS and Linux the path and ownership checks keep another user's process from claiming a route with a file it controls.
They do not stop a process of the same user, which can already read the vault's `data.json` and its tokens.
Group write access is accepted only when the group is the user's own primary group, the per-user group a `002` umask relies on, so Obsidian's default file modes on Ubuntu and similar systems still register.
A vault whose `data.json`, plugin folder or `plugins` folder is writable by any other group, or by others, cannot register a route and gets the broker's `401` until that write access is removed.
Access Control names the cause, and its copy buttons give the vault's direct URL meanwhile.
Such access added after registration makes its route answer `503`.
Its direct port keeps working

A vault whose plugin folder is a link saved its route with a path through the link's target before linked plugin folders were supported.
That route never registered, and the vault now reports a changed location once, which **This vault was moved** resolves

## Accepted risks

- **Failover outage:** After the hosting vault closes, broker requests fail until another vault binds the port and the open vaults register again
- **Port-owner trust on `27200`:** A process that binds `127.0.0.1:27200` first receives the bearer tokens clients send, including vault tokens on routes, and registrations reveal route credentials. This is the same trust model as squatting a direct vault port today. The single fixed port is easier to target than a vault in a port range. The plugin reports the foreign listener in a Notice but cannot stop clients from sending credentials to it. ADR-0021's reasoning against a registration-only challenge still applies
- **Breaking move for Codex:** Entries on `127.0.0.1:27206`, and entries that send the route credential, fail until a snippet from **Codex** on a token row replaces them. The plugin does not detect or rewrite such entries, because it never touches `config.toml`. *Amended by ADR-0028:* A confirmed install from the Codex menu migrates them; until then they fail as described
- **Legacy direct configs on `27200`:** They keep working only through bare `/mcp` token routing, and fail while a foreign process or an older plugin version holds `27200`
- **Route registration by a same-user process:** A process running as the same user that knows a route ID can register first with a `data.json` it controls and then receive the bearer tokens clients send on that route. Such a process can already read every vault's `data.json`, tokens included, so registration adds no access it lacks. The vault's own registration then fails with `409` and shows **Needs attention** instead of silently losing its route. A full registry of trusted vault paths was not adopted
- **Equally named vaults in Codex:** Two vaults with the same name produce the same `obsidian_<vault>` key. Pasting both gives `config.toml` a duplicate table, and Codex rejects the whole file. ADR-0021's installer refused such conflicts, but the plugin no longer writes `config.toml`. Renaming one entry's key fixes it, because Codex connects by URL and the key is only a label. Keeping the route UUID in the key was rejected so that Codex is named like every other client. *Amended by ADR-0028:* The installer refuses another vault's entry under the same key again. A pasted snippet or a `codex mcp add` entry stays unprotected
- **Windows ownership:** The broker checks only the path shape on Windows and relies on the user profile's access rules to keep other users from writing a vault's `data.json`
- **Linked plugin folder:** On macOS and Linux the broker follows a link at the plugin folder, as `bun run link` creates, and checks its target with the same owner rule. Only the owner of the `plugins` folder can place that link, `data.json` is still opened without following a link and checked on the open file, and a registration still needs the route credential stored in that file, so the link gives no other user a file the broker trusts
- **Direct URL while the broker cannot reach a vault:** A config copied or synced after a refused registration, while the broker is unavailable or during a route conflict names the vault's current port and breaks when that port changes. The plugin does not rewrite it when the route connects again. Access Control asks to copy such configs again once the broker connection shows **Connected**

## Alternatives considered

- **Keep the detached Node.js process and extend it to every client.** It keeps the system Node.js requirement, the generated executable in application data and a process outside Obsidian's lifecycle for every user instead of only Codex users
- **Reserve a port per vault.** A persisted per-vault port still collides when vaults are copied or opened on another machine, needs an allocation scheme across vaults that cannot see each other and still breaks direct configs when the reservation fails. Preferring `livePort` keeps the benefit without the contract
- **Keep the broker Codex-only.** It leaves every other HTTP client exposed to open-order port swaps, which was the defect that prompted this change
- **Cache the parsed `data.json` by file metadata.** On Windows, back-to-back rewrites of the same size often keep the exact same timestamps, so a changed file could look unchanged unless a time window and a clock check guard the cache. That bought about 0.2 ms per request. A route request needs nothing from the file's contents, so the broker checks the open file without reading it, which saves the read and the parse with no cached state to go stale
