# ADR-0020: Shared local discovery broker

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

Vault plugins probe the fixed health endpoint before spawning the broker.
If a healthy broker already owns the port, the plugin reuses it.
If several vaults race to start it, the operating system allows one listener and the other plugins accept that listener after probing it.
The plugin never stops or replaces an unknown process that owns the port.

Each vault opens an authenticated control connection after writing its registration.
The broker keeps the route live while that connection remains open.
The operating system closes the connection if the vault renderer exits or crashes, so the broker can remove the route without a timer.
An unexpected broker disconnect makes the plugin restart the broker and register again.
The plugin closes its connection and removes only its own registration during a clean unload.
The broker exits after no control connection remains for 30 seconds.

Codex configuration is separate from runtime discovery.
The settings UI always offers a copyable TOML snippet.
It also offers an explicit one-time installer.
The installer locates the user config from `CODEX_HOME` or the documented default directory, previews the path and action, and waits for confirmation.
It backs up the file, replaces the matching MCP table and its nested transport tables, preserves per-tool approval tables, writes atomically, and verifies the installed entry.
It aborts when the file changes between the preview and the write.
It refuses ambiguous entries, multiline TOML strings, and unknown config locations.
No startup, reconnect, port change, or token change edits `config.toml`.

## Consequences

Codex starts no per-task bridge process for this connection.
All enabled vaults share one broker process while keeping distinct routes and credentials.
A vault port change or selected token regeneration takes effect on the next request.
Switching the selected token keeps the stable route and broker credential, so the Codex entry stays valid.
Revoking the selected token disables its route instead of choosing another token.

The fixed broker port is part of the local integration contract.
Discovery fails when an unrelated process owns that port.
Node.js is a runtime dependency for discovery.
Bun remains a development dependency only.

The broker credential is stored as plain text in `config.toml` because Codex sends a static HTTP authorization header.
It grants access only through the matching localhost route while its vault control connection is open.
The vault token is not copied into the registration or Codex configuration.
