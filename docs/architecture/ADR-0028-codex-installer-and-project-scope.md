# ADR-0028: Codex installer, project scope and entry ownership on the shared broker

- **Status:** Accepted and implemented
- **Date:** 2026-10-07
- **Scope:** How the plugin produces and writes Codex configuration for a token row: the copy actions, the user-level and project-level installs, entry names and ownership, the migration of older entries, the Codex home on each platform and the tool-profile offer
- **Amends:** [ADR-0027](/docs/architecture/ADR-0027-shared-broker-for-all-clients.md) (Codex entries: copy-only, the installer removal and the two Codex accepted risks) and [ADR-0021](/docs/architecture/ADR-0021-shared-local-discovery-broker.md) (its Codex installer, restored here with new naming and ownership rules)

## Context

ADR-0021 gave Codex a broker credential, `obsidian_<vault>_<route-uuid>` entry names and a one-time installer for the user's `config.toml`.
That installer previewed its action, backed up the file, held a cooperative lock, wrote atomically, read the result back and refused layouts it could not edit safely.

ADR-0027 moved the broker into Obsidian on `127.0.0.1:27200` and made every client send its own vault token.
It named Codex entries `obsidian_<vault>` like every other client and made Codex copy-only: The plugin stopped reading, locating or writing `config.toml`.
Commit `4a40dc6` deleted the installer and its tests.

Copy-only lost three things the installer gave Codex users.
A confirmed in-place replacement kept the user's per-tool approvals.
A second vault's entry under the same name was refused instead of overwritten.
Entries written by 2.11 and 2.12 were migrated.
ADR-0027 records the second loss as an accepted risk: Two equally named vaults pasted into one `config.toml` give Codex a duplicate table, and Codex rejects the whole file.

Claude Code meanwhile gained a per-vault project path, stored at `mcpClientConfig.claudeCodeProjectPath` (commit `ccf3113`), and a token-free `.mcp.json` entry.
Codex has a project layer too: It reads `.codex/config.toml` from the folders between its working directory and the project root, and only for projects the user has marked trusted.

New tokens get the `adaptive` profile (ADR-0023 D11).
Codex does not refetch `tools/list` after `notifications/tools/list_changed`, so a tool that `activate_tool` promotes during a Codex session stays invisible to that session until Codex reconnects.

Facts this decision rests on, checked on 2026-10-07:

- **Codex home.** `find_codex_home` in `codex-rs/utils/home-dir/src/lib.rs` (openai/codex `main`): A non-empty `CODEX_HOME` must exist and be a folder, and is canonicalized, or Codex fails. Without it the home is `<home_dir>/.codex`, which need not exist
- **`codex mcp add`.** `codex-rs/cli/src/mcp_cmd.rs` (commit `4994306`, 2026-09-29): `codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`, with `--bearer-token-env-var <ENV_VAR>` for a streamable HTTP server. There is no header flag and no scope flag
- **Codex documentation.** Native Windows Codex and the Codex app use `%USERPROFILE%\.codex`. The Codex CLI inside WSL uses the Linux home and shares the Windows one only when WSL sets `CODEX_HOME=/mnt/c/Users/<user>/.codex`. Project config loads only for trusted projects, and MCP servers may be scoped to a project
- **WSL networking.** In WSL's default NAT mode a Linux program reaches a Windows server through the host IP, not `127.0.0.1`. Mirrored mode, on Windows 11 22H2 and later, lets it use `127.0.0.1`
- **Node.** `os.homedir()` reads `USERPROFILE` on Windows and `HOME` on POSIX

## Decision

### D1: Explicit installs into the user and the project Codex config

Each token row has a **Codex** menu with four actions: Copy the `config.toml` snippet, copy the `codex mcp add` command, install into the user's Codex config and install into the project.
All four use the URL from `resolveClientEndpoint` (ADR-0027) and are disabled while it returns none, like every other copy button.

An install always runs as preview, then confirmation in a modal, then install.
`installCodexConfig` requires the revision the preview returned, so no code path writes without a preview.
Nothing installs on its own: Not at startup, reconnect, port change, token change or route change.
A replaced or revoked token, or a new route, leaves installed entries as they are until the user installs again.

This amends ADR-0027's "Codex config is copy-only".
The opt-in Claude Desktop config sync stays the only client config the plugin writes without a confirmation per write.

### D2: The row token, never the route credential

Each entry carries the vault token of the row it is made from.
A user-level install writes it in `http_headers` unless the per-session option to keep the token out of `config.toml` is on.
With that option, and always in a project, the entry reads `bearer_token_env_var = "OBSIDIAN_MCP_TOKEN"`.

The route credential stays a registration secret.
The installer receives the route ID through `savedRouteId`, never the credential, so no output of the plugin can contain it.
The broker forwards the bearer unchanged (ADR-0027), and the vault authenticates it and applies that token's profile and revocation.

### D3: Plain names, ownership decided by the route in the URL

The entry key is `vaultServerId(vault name)`, the same key as every other client config.
Before it replaces an existing `[mcp_servers.<key>]`, the installer decides from the entry's `url` whose entry it is:

- **`/v1/<route-id>/mcp` on `127.0.0.1` or `localhost`, any port.** This vault's when the route ID is this vault's saved route, another vault's otherwise. Another vault's entry is refused, and the message names the file, the key and that the entry belongs to another vault
- **`/mcp` on a loopback port.** This vault's when it equals the URL being installed, or when its static bearer equals the row token. Otherwise it is refused as an entry the installer cannot attribute
- **Any other URL, or none, such as a stdio entry or a remote server.** Refused as unattributable

The check reads the path, not the port.
The old broker port `27206` now lies in the dynamic vault range `27201` through `27212` (ADR-0027), so a URL on `27206` can address a vault directly.

### D4: Migration of earlier entries

An entry under a key other than the plain key is an earlier entry of this vault in two cases, where `<route-hex>` is the route ID without hyphens:

- **By key.** Its key ends in `_<route-hex>`, which covers `obsidian_<route-hex>` (ADR-0021's UUID-only name) and the 2.11 name. Its URL and port do not matter
- **By URL.** Its URL is `/v1/<route-id>/mcp` on `127.0.0.1` or `localhost` with this vault's route, on the same port as the URL being installed, which is itself a loopback `/mcp` or `/v1/<route-id>/mcp` URL

Unlike D3, this rule reads the port.
A key the user chose is the user's, so a route URL under it on another port, such as the old broker port `27206`, is not claimed: That entry is neither migrated nor touched, does not count toward the refusal below, and is left for the user to remove or edit.

The installer renames that entry's table headers to the plain key, as ADR-0021's migration did, then replaces its transport keys as a replace does.
`url` becomes the client endpoint, the route credential or old token becomes the row token or the environment variable, and `enabled` and `required` take the snippet's values.
Policy keys and the `tools` and `oauth` sub-tables stay.
`startup_timeout_sec` counts as a policy key: An existing value stays, and an entry without one gets 30 seconds.

More than one entry of this vault in one file, such as a migrated entry next to a plain one, is refused with both keys named, as ADR-0021's installer did.
The preview names the old key and the old URL.
A rename changes the server name inside Codex's tool names, so references to it elsewhere need a manual update.

### D5: Locating the Codex home, on Windows and in WSL

The plugin mirrors `find_codex_home`:

- **`CODEX_HOME` non-empty in Obsidian's environment.** Used when it is absolute and names an existing folder, resolved through links as Codex canonicalizes it. A relative, missing or non-folder value is not located, because Codex would refuse it too, and the menu points to the copy actions
- **Otherwise `os.homedir()` followed by `.codex`.** A missing folder is created with mode `0700` on a confirmed install only, and the preview says so. An empty home directory is not located

Windows follows the same rule, which gives `%USERPROFILE%\.codex`, the documented home of native Windows Codex and the Codex app.

The plugin never probes WSL.
A Codex CLI in WSL reads its Linux home, unless WSL sets `CODEX_HOME=/mnt/c/Users/<user>/.codex` as Codex documents, in which case it reads the file this installer writes.
Either way it reaches `127.0.0.1:27200` on Windows only with mirrored networking.
Otherwise the copy actions, run inside WSL, are the supported path.

The preview shows the target path and whether it came from `CODEX_HOME` or the default.
That is how a user sees that an Obsidian started from the Dock on macOS does not inherit a `CODEX_HOME` exported in a shell profile.

### D6: Project installs

The project install writes `<project path>/.codex/config.toml`.
The project path is the shared per-vault setting at `mcpClientConfig.claudeCodeProjectPath`, validated by `parseClaudeCodeProjectPath`: Absolute, with no quote, line break or PowerShell wildcard.
It must also name an existing folder, or the project action is disabled with the reason.

`.codex` must be a real folder or absent.
A link is refused, because a cloned repository could otherwise point the write at a file outside the project, while the preview still shows the project path.
This check runs before the lock file is created, so no lock or backup lands through a link.
A missing `.codex` is created on a confirmed install.

A project entry always uses `bearer_token_env_var`.
The installer enforces this itself, not only the settings UI, because the file may be committed.
Replacing a project entry that held a literal token removes that token.

The Notice after a project install always says that Codex loads the file only for a trusted project.
The plugin does not read Codex's trust settings, which would couple it to Codex's private config layout.
Ownership, migration and the write guarantees of D9 apply as for the user config.

### D7: The `codex mcp add` command

The command is `codex mcp add '<key>' --url '<client endpoint>' --bearer-token-env-var OBSIDIAN_MCP_TOKEN`.
Single quotes keep both arguments literal in POSIX shells and in PowerShell.
The generator refuses a key outside `[A-Za-z0-9_-]` or starting with `-`, and a URL that contains a quote, a typographic single quote, whitespace or a control character.

The command never contains a token, because the Codex CLI has no flag for a static header.
It writes the user config of the Codex home the shell sees, and it sets no `startup_timeout_sec`, so that entry keeps Codex's default.

### D8: The profile offer

When the row's token has the `adaptive` profile, the install preview offers to switch it to `all`, unticked by default.
The switch is written through `updateTokenPolicy` only when the user ticks it and confirms, and only after the install succeeds or finds the entry unchanged.
Declining, cancelling or a failed install leave the profile as it was.

A `core` token gets no offer, because its owner chose that narrower surface.
The allowlist ceiling (ADR-0014) is not touched.

### D9: The restored write guarantees

Both targets use the installer that existed before commit `4a40dc6`:

- **Preview.** It reads the file and returns a SHA-256 revision of its bytes, or of its absence, and writes nothing
- **Lock.** A cooperative lock file next to the config, `config.toml.obsidian-mcp.lock`, is taken before the revision is checked again. A lock older than 30 seconds is recovered, a fresh one is waited for up to 5 seconds
- **Backup.** An existing file is copied to `config.toml.backup-<time>-<id>` with mode `0600`, and the file is read again afterwards to catch a change during the backup
- **Atomic write.** The new content goes to a temporary file that is renamed over the config, keeping the existing file's mode, or `0600` for a new file
- **Verification.** The file is read back. A mismatch after the rename can only be another writer's edit, so it is reported with the backup path and never rolled back
- **Refusals.** A link, a file that is not regular, inline, dotted and array entries, unrecognized keys or nested tables in the owned entry, a multiline string inside it, an unterminated string or array and an unrecognized table header are refused, as in ADR-0021's installer
- **Encoding.** CRLF line endings and a byte order mark are preserved

## Alternatives considered

- **Keep Codex copy-only, as ADR-0027 decided.** It drops a shipped feature the SPEC asks to keep, and leaves the duplicate-table risk of equally named vaults with the user
- **Install into the user config only.** Project scoping, which Claude Code has, would stay a manual paste
- **Reinstate the broker's credential swap, so entries carry the route credential.** It limits Codex to one owner token and one profile, and puts a second credential in every entry
- **Keep the route UUID in the entry key, as ADR-0021 did.** The key would differ from every other client's and change whenever a copied vault gets a new route
- **Plain names without an ownership check.** A second, equally named vault would overwrite the first vault's entry
- **Replace any same-named entry once the user confirms the preview.** The preview shows a path and an action, and a user cannot be expected to recognize a route UUID inside a URL. The installer can
- **A separate project path for Codex.** It duplicates the validation of the Claude Code field and lets the two drift
- **Let the user choose a literal token for a project file.** The file may be committed
- **Probe WSL distributions for a Linux Codex home, such as `\\wsl.localhost\<distro>\home\<user>\.codex`.** Finding the distribution and the user needs `wsl.exe`, so the plugin would run a process, and it would write across the WSL file share. The entry would still fail in WSL's default NAT mode, where Linux cannot reach `127.0.0.1` on Windows. Codex's own `CODEX_HOME` sharing serves users who want one config
- **A setting that overrides the Codex home.** The SPEC does not ask for one, and the copy actions cover an unusual home
- **Offer `core` instead of `all`.** Core leaves every tool outside the core set reachable only through activation, which a Codex session sees only after it reconnects, the same failure the offer exists to avoid
- **Detect Codex from the client identity and serve it a non-adaptive catalog.** It changes the MCP server and needs client identity facts that are not verified
- **Write a new installer.** The 2.11 and 2.12 installer and its tests already cover CRLF, a byte order mark, multiline strings, array literals, stale locks and concurrent editors, each found in earlier review. Porting them keeps that coverage

## Consequences

### Positive

- Codex has every capability Claude Code has in the plugin: Per-token authentication, profiles and revocation, the stable broker URL, per-project scoping and a token-free option. It also keeps the installer
- Entries from 2.11 and 2.12, and those ADR-0027 broke on `27206` or with the route credential, are repaired by one confirmed install that keeps the user's approvals and tool settings, as long as they are under the plain key or a key ending in `_<route-hex>`
- Equally named vaults no longer produce an invalid `config.toml` through the installer

### Negative

- The plugin again writes files outside the vault: `config.toml`, its backups and a short-lived lock file, in the Codex home or in a project's `.codex` folder
- Backups accumulate and are never cleaned up. In a project they are untracked files that `git add -A` would commit
- A project file names this vault's route ID in its URL. ADR-0027 treats a route ID as sensitive as a token, which matters on shared Windows machines, where the broker has no owner check. A committed file also names a route that exists only on this machine, so a collaborator with an equally named vault gets the ownership refusal
- A pasted snippet or a `codex mcp add` entry is still unprotected against equally named vaults
- Every entry in the environment variable form reads `OBSIDIAN_MCP_TOKEN`. Two vaults in one Codex with that form share one variable, so only one of them authenticates
- A direct `/mcp` entry is attributed only by an equal URL or by a static bearer equal to the row token (D3). An entry in the environment variable form has no static bearer, and every project entry is in that form. So an entry written while the broker was refused, or on a fixed port, and later on a port that has since changed, is refused as unattributable, although it may well be this vault's. Remedy: remove the entry, or rename its key, then install again. The installer does not guess from the port, because ports in the dynamic range `27201` through `27212` are shared between vaults and a port match would not prove ownership
- A migration renames the server, which changes Codex's tool names for it
- An entry the user renamed that still points at `27206` is neither migrated nor touched, and keeps failing until the user removes or edits it

### Neutral

- The broker contract, its security model and the route credential's role are unchanged
- The legacy `enabled`, `tokenId` and `serverId` keys stay on disk and are not read
- Revoking or replacing a token, or **Make this copy independent**, leaves installed entries failing with the vault's `401` or on the old route until the next install, as for any pasted config

### Accepted risks

- **Route ID in a project file.** Accepted, because a project file holds no token and the risk needs another local Windows account that registers the route first. SECURITY.md says so next to its advice to keep configs with route IDs private
- **Same-user races.** A process running as the same user can swap `.codex` or `config.toml` between the link check and the write. Such a process can already edit those files directly
- **Cooperative lock.** External editors and Codex itself do not take the lock. The revision check and the verification detect their writes but cannot prevent them

## References

- SPEC "Codex integration with parity to Claude Code on the shared broker", approved 2026-10-06, requirements R-01 to R-14. It is not tracked in the repository
- [ADR-0021](/docs/architecture/ADR-0021-shared-local-discovery-broker.md), [ADR-0027](/docs/architecture/ADR-0027-shared-broker-for-all-clients.md), [ADR-0023](/docs/architecture/ADR-0023-token-usage-optimization.md) D11, [ADR-0014](/docs/architecture/ADR-0014-per-client-tool-profiles.md), [ADR-0025](/docs/architecture/ADR-0025-migrate-existing-tokens-to-adaptive.md)
- Commits `4a40dc6` (installer removal, the source of the port), `ccf3113` (project path), `05fcf08` (endpoint kinds and refused routes)
- openai/codex: `codex-rs/utils/home-dir/src/lib.rs` on `main`, `codex-rs/cli/src/mcp_cmd.rs` at `4994306`
- Codex documentation: [Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced), [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Windows app](https://learn.chatgpt.com/docs/windows/windows-app.md)
- [Accessing network applications with WSL](https://learn.microsoft.com/en-us/windows/wsl/networking)
- [Node.js `os.homedir()`](https://nodejs.org/api/os.html#oshomedir)
