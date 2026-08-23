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

Each enabled vault writes one registration file under the shared temporary broker directory.
The registration contains the route ID, the absolute `data.json` path, the selected token ID, a SHA-256 digest of the broker credential, and a lease ID.
The registration never contains the broker credential or a vault token secret.

For every authorized request, the broker reads the registration and then reads the vault's current `data.json`.
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
Its process name is the detected Node executable, and its command line points to `discoveryBroker.js` in the shared temporary broker directory.
Those two facts identify the process during an audit of programs started by the plugin.

Vault plugins probe the fixed health endpoint before spawning the broker.
If a broker answers the expected health response, the plugin reuses it.
If several vaults race to start it, the operating system allows one listener and the other plugins accept that listener after probing it.
The plugin never stops or replaces an unknown process that owns the port.

Each vault opens an authenticated control connection after writing its registration.
The broker keeps the route live while that connection remains open.
An unexpected broker disconnect makes the plugin start or reuse a broker and register again.
The plugin closes its connection and removes only its own registration during a clean unload.

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

On macOS and Linux, the plugin requests `0700` directory modes and `0600` file modes for broker state.
Windows uses filesystem ACLs instead of POSIX mode bits, so the plugin does not claim that `chmod` makes the temporary directory private there.
The broker state contains route metadata and credential hashes, not vault bearer tokens.

### Accepted local-process risk

The fixed-port health check does not authenticate the process that owns `127.0.0.1:27206`.
A local process can bind the port first, return the static `{name, version}` response, and receive later registration requests.
Those requests reveal the raw broker credential in `Authorization`, the route ID in the URL, and the lease ID in a header.
The registration file stores only the broker credential hash, but that does not protect the credential sent over loopback HTTP.

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
It backs up the file, replaces the matching MCP table and its nested transport tables, preserves per-tool approval tables, writes atomically, and verifies the installed entry.
It aborts when the file changes between the preview and the write.
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
