# ADR-0021: Shared local discovery broker

- **Status:** Accepted and implemented
- **Date:** 2026-08-22
- **Scope:** Dynamic Streamable HTTP discovery for Codex without one process per client session

## Context

The vault MCP server chooses a port from `27200` through `27205` and can bind a different port after a restart.
Vault token secrets can also change without restarting the HTTP server.

Codex reads a Streamable HTTP URL and its static authorization headers from `config.toml`.
Pointing Codex at the vault directly therefore makes either the port or the token stale.
A STDIO shim can read both values dynamically, but Codex starts that shim for each MCP client session.
Several tasks then produce several helper processes for the same vault.

## Decision

One user-level Node.js broker listens on `127.0.0.1:27206`.
Every enabled vault receives a stable UUID route and a stable broker credential.
The Codex entry points to `/v1/<route-id>/mcp` and sends that credential in `Authorization`.

Each enabled vault sends a bounded registration body over its authenticated control connection
The registration contains the route ID, the absolute `data.json` path, the selected token ID, a SHA-256 digest of the broker credential, and a lease ID
The broker verifies ownership against the selected vault's saved discovery settings before admitting the route
It stores the registration only in memory and rejects a duplicate route before modifying its existing owner
No registration files are required, so clearing temporary files does not invalidate active routes

For every authorized request, the broker uses its live in-memory registration and reads the vault's current `data.json`
It resolves `mcpTransport.livePort` and the token record with the selected stable token ID.
The broker replaces the incoming authorization header with the current vault token before forwarding the request to `127.0.0.1:<livePort>/mcp`.

### Process ownership and lifecycle

The plugin starts the broker as a detached process because Codex needs one stable endpoint shared by every task and every open vault.
Running the broker inside one vault's Obsidian renderer would make that vault the owner of routes for all other vaults.
Letting Codex launch a STDIO bridge would return to one process per client session.

This broker is the first current component that the plugin starts outside Obsidian's process lifecycle.
Closing Obsidian or the final vault does not terminate the process directly.
The operating system closes each vault's control connection when its renderer exits or crashes, and the broker removes that route.
The broker exits after ten seconds without an active control connection.
Its process name is the detected Node executable, and its command line points to `discoveryBroker.js` in a persistent per-user application-data directory
Those two facts identify the process during an audit of programs started by the plugin.

Vault plugins probe the fixed health endpoint before spawning the broker.
If a broker answers the expected health response, the plugin reuses it.
If several vaults race to start it, the operating system allows one listener and the other plugins accept that listener after probing it.
The plugin never stops or replaces an unknown process that owns the port.

Each vault submits its registration when opening the control connection
The broker keeps the route live while that connection remains open
An unexpected broker disconnect makes the plugin start or reuse a broker and resubmit the complete registration
Initial connection failures also retry, while duplicate identities stop with an actionable conflict status
The plugin closes its connection during a clean unload, removing only its own route and upstream connections
Closing a downstream client connection releases its upstream transport without synthesizing an MCP cancellation notification or replaying requests

### Storage, upgrades and copied vaults

The executable lives under `obsidian-mcp-connector/broker-v2` in `%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on macOS, or `$XDG_DATA_HOME` (default `~/.local/share`) on Linux
This directory contains generated executable code, not route registrations or credentials
The plugin recreates the executable when starting a broker if its directory is missing

Control protocol version 2 retains the existing `/v1/<route-id>/mcp` client URLs
An older broker on the shared port is reported as incompatible, never killed or replaced
Update the plugin in the open vaults and close their old connections so the old broker can exit before retrying
Client configuration is unchanged unless the user explicitly resets identity or installs a replacement entry

Discovery settings in the vault remain the durable owner of the route and broker credential
The first upgraded start records the canonical settings-file location and retains the legacy client-entry name
Legacy settings contain no prior location, so a copy made before that first binding cannot be distinguished from its original when opened alone
Later location changes require an explicit choice between keeping identity for a move and resetting identity for a copy
Resetting identity rotates the route, broker credential and client-entry name, requiring updated client configuration
New entry names use the full route UUID rather than a lossy vault-name conversion
No reset edits another vault or an external client configuration automatically

Copying `.obsidian` also copies the vault's MCP token secrets
A separate confirmed action rotates those secrets in one settings write while retaining token IDs, labels and tool policies
This does not rotate credentials in the original vault, update exported clients, or cancel already-submitted operations
The broker reads the new selected secret on its next request

### Supported systems and Node.js

Discovery supports the plugin's desktop targets: Windows, macOS, and Linux.
The plugin manifest excludes mobile installations because the feature uses Node.js filesystem, networking, and child-process APIs.

The broker requires a system Node.js installation that Obsidian can execute.
The plugin checks `node` on the inherited `PATH` and the existing platform-specific install locations used by `nodeDetect.ts`.
If Node.js is unavailable, enabling discovery fails with an actionable error and the feature remains disabled.
The rest of the plugin continues to run.
Bun remains a development dependency only.

The plugin does not use Obsidian's Electron executable as a Node.js fallback.
Electron can disable `ELECTRON_RUN_AS_NODE`, and the packaged Obsidian runtime does not provide a supported contract for launching this script.
The `.mcpb` shim is not an equivalent fallback because Claude Desktop supplies the Node.js runtime that launches it.

On macOS and Linux, the plugin requests `0700` directory modes and `0600` file modes for the broker executable
Windows uses filesystem ACLs instead of POSIX mode bits, so the plugin does not claim that `chmod` establishes privacy there

### Accepted local-process risk

The fixed-port health check does not authenticate the process that owns `127.0.0.1:27206`.
A local process can bind the port first, return the static `{name, version}` response, and receive later registration requests.
Those requests reveal the raw broker credential in `Authorization`, the route ID in the URL, and the lease ID in a header.
Keeping registration metadata in memory does not protect the credential sent over loopback HTTP

This is an accepted instance of the existing local port-owner trust model.
Existing direct HTTP client configurations and the `.mcpb` shim also send bearer credentials to a loopback listener without authenticating the process that owns the port.
The fixed broker port is easier to target than the default vault port range.
Its credential has narrower authority than a vault bearer because it works only for one broker route while that vault's control connection is active.

A per-launch secret is not adopted as a complete mitigation.
It could authenticate the plugin's registration request only if the process that owns the port could not read the secret.
A process running as the same operating-system user can read the broker files and Codex configuration under the same local trust assumptions.
More importantly, Codex would still send its configured bearer credential to whichever process owns port `27206`.
A registration challenge therefore would not authenticate the broker to Codex.
Mutually authenticated local IPC would require a different transport and credential-distribution design.

### Codex configuration

Codex configuration is separate from runtime discovery.
The settings UI always offers a copyable TOML snippet.
It also offers an explicit one-time installer.
The installer locates the user config from `CODEX_HOME` or the documented default directory, previews the path and action, and waits for confirmation.
It backs up the file, replaces the matching MCP table and its nested transport tables, preserves per-tool approval tables, writes atomically, and reads back the expected bytes
It rejects unrecognized table headers, inline server tables and additional root-entry settings instead of discarding them
It checks for changes after preview and again after backup, but its cooperative lock cannot make external editors participate or provide filesystem compare-and-swap
Rollback never overwrites a concurrently replaced file
It recovers lock files older than 30 seconds and waits for a fresh lock.
It permits multiline strings outside the entry it owns and refuses a multiline string inside the entry it would replace.
It also refuses ambiguous entries and unknown config locations.
No startup, reconnect, port change, or token change edits `config.toml`.

## Consequences

Codex starts no per-task bridge process for this connection.
All enabled vaults share one broker process while keeping distinct routes and credentials.
A vault port change or selected token regeneration takes effect on the next request.
Switching the selected token keeps the stable route and broker credential, so the Codex entry stays valid.
Revoking the selected token disables its route instead of choosing another token.

The fixed broker port and the detached Node.js process are part of the local integration contract.
Discovery fails when an unrelated process owns that port without returning the expected health response.
The broker may remain visible for up to ten seconds after the final vault disconnects.

The broker credential is stored as plain text in `config.toml` because Codex sends a static HTTP authorization header.
It grants access only through the matching localhost route while its vault control connection is open.
The vault token is not copied into the registration or Codex configuration.
