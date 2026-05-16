# Security Policy

## Reporting a Vulnerability

If you discover a security issue in MCP Connector (`istefox/obsidian-mcp-connector`), please report it privately via [GitHub Security Advisories](https://github.com/istefox/obsidian-mcp-connector/security/advisories/new).

**Please do not report security vulnerabilities through public GitHub issues.** Use the private GHSA form so the report is visible only to maintainers until a fix is released.

When reporting, please include:

- Description of the issue and the threat model it violates
- Steps to reproduce (commit SHA, plugin version, Obsidian version, OS)
- Potential impact (data loss, privilege escalation, network exposure, etc.)
- Any suggested fixes or mitigations

You should receive an acknowledgement within 48 hours. If for some reason you do not, please open a public issue **without sensitive details** asking me to check the GHSA queue.

## Disclosure Policy

When a security report is received:

1. Confirm the vulnerability and scope its impact across supported versions.
2. Audit related code paths for similar issues.
3. Prepare fixes for all supported releases (see [Supported Versions](#supported-versions)).
4. Coordinate disclosure timing with the reporter; default to 90 days from report to public disclosure, shorter for actively exploited issues.
5. Release patched versions, publish a GHSA advisory, and credit the reporter (unless they request anonymity).

## Threat Model

MCP Connector exposes an MCP server that gives an external AI client (Claude Desktop, Claude Code, Cursor, Cline, Continue, etc.) read/write access to an Obsidian vault, plus the ability to execute Obsidian commands. The threat model is structured around three boundaries:

1. **Transport** — who can reach the MCP server.
2. **Authorization** — what an authenticated client can do, especially on irreversible side effects.
3. **Content** — what the MCP server reads from the vault and forwards to the model.

### Transport (0.4.x)

The 0.4.x line runs the MCP server **in-process inside the Obsidian plugin**. Implementation lives in `packages/obsidian-plugin/src/features/mcp-transport/`.

- **Loopback bind only.** The HTTP listener binds `127.0.0.1` on a port from a fixed allow-list (`27200`–`27205`); never `0.0.0.0`. The plugin will refuse to start on any other interface. See `port.ts`.
- **Bearer token authentication.** A 256-bit token is generated at first plugin load and persisted in the vault's `data.json` at `mcpTransport.bearerToken`. Comparison uses `crypto.timingSafeEqual` over UTF-8 bytes to prevent timing oracles. The token is rotatable from Settings → MCP Connector → Access Control. See `token.ts`.
- **Origin validation (anti-DNS-rebinding).** Every request is checked against a loopback regex on the `Origin` header **before** authentication. Per MCP spec 2025-06-18 / RFC 6454, this prevents a rogue webpage in the user's browser from issuing forged requests to the local server. See `origin.ts` + `middleware.ts`.
- **Method + path allow-list.** Only `POST` and `GET` on `/mcp` and `/mcp/*` are routed; everything else returns 404 before reaching the MCP handler. See `middleware.ts`.
- **Stateless transport.** Each request constructs a fresh `StreamableHTTPServerTransport` + server pair. No session cookies, no persistent client state on the server. The `ToolRegistry` stays a singleton so per-request cost is on the order of milliseconds.

**Transport is not encrypted.** This is intentional: the listener is loopback-only, so no on-the-wire attacker can observe the traffic. Adding TLS to a `127.0.0.1` listener would require the plugin to manage a self-signed cert — strictly worse UX for no incremental security against the relevant threat models. If your threat model includes a malicious local process running on the same machine and reading raw kernel sockets, MCP transport security is not the right layer to address that.

### Authorization (`execute_obsidian_command`)

Most tools are vault file/search operations whose authorization is the Bearer token + the user's expectation that the AI client they connected has full vault access. The exception is `execute_obsidian_command`, which can run **any** registered Obsidian command (core or plugin), including potentially destructive ones (delete file, close vault, run external scripts via plugins, etc.).

This tool is gated by the `command-permissions` feature with a layered policy:

- **Disabled by default.** The master toggle (Settings → MCP Connector → Command execution) ships off; an MCP call to `execute_obsidian_command` returns `deny` until explicitly enabled.
- **Per-command allowlist.** Even with the master toggle on, only commands explicitly added to `commandPermissions.allowedCommands` proceed without a modal. Anything else triggers a confirmation modal in the Obsidian UI.
- **Modal confirmation (slow path).** First invocation of an unknown command opens a modal with three options: *Allow once* (this call only), *Allow always* (persist to allowlist), *Deny*. The handler awaits the click for up to 30 seconds before defaulting to deny.
- **Destructive-verb heuristic.** Commands whose ID or display name matches a destructive verb regex (`delete`, `remove`, `purge`, `drop`, `truncate`, `clear`, etc.) are flagged in the modal with a red tint, and the *Allow always* button is disabled — the user can still grant per-call permission but cannot persist it. Curated quick-add presets (Editing, Navigation, Search) exclude every word the regex catches.
- **Audit log.** Every call (allow or deny, modal or fast-path) is recorded in `commandPermissions.recentInvocations` (FIFO 50 entries) with timestamp + command id + decision + reason. Exportable to CSV from the settings UI.
- **Rate limit.** 100 calls per 60-second tumbling window hard limit (server-side, drops requests above), plus a configurable soft warning threshold (default 30/min) that surfaces a warning banner in the modal.

Full design rationale, threat model, and option matrix in [`docs/design/issue-29-command-execution.md`](docs/design/issue-29-command-execution.md). Touch `permissionCheck.ts` only after reading that document — there are four load-bearing invariants documented in `CLAUDE.md` § Gotchas that must be preserved.

### Out of scope

The following are **explicitly not** addressed by this plugin's security model. Users with these threat models need to layer mitigations elsewhere:

- **Content-side filtering or redaction of vault data passed to the model.** When the AI client requests a note via `get_vault_file` or a search via `search_vault_smart`, the plugin returns vault content as-is. The plugin does not scan for PII, secrets, credentials, or other sensitive content before returning it. If your vault contains content you would not paste into the model's chat window, do not connect it to an MCP client without your own filtering layer in front.
- **Indirect prompt injection in note bodies.** A malicious note (e.g., one synced from an untrusted external source) could contain text designed to manipulate the model into issuing unintended tool calls. The plugin does not detect or strip such content. The mitigations against this are structural — the explicit consent gate on `execute_obsidian_command`, the absence of filesystem escape (all tool paths are vault-relative), and `fetch` being user-driven (the model has to be asked to fetch a URL; the plugin does not auto-fetch).
- **`fetch` egress.** The `fetch` tool issues outbound HTTP to arbitrary URLs supplied by the AI client. This is intentional (it's the documented purpose of the tool) but it is the **only** non-loopback network egress in the plugin. Users who want to constrain model-driven egress should disable `fetch` at the MCP client layer or run behind a network policy that limits outbound HTTP from the Obsidian process.
- **Compromised AI client.** A malicious or compromised MCP client connecting with a valid Bearer token has the same authority as the user. The Bearer token is the trust boundary; rotate it (Settings → Access Control → Regenerate) if you suspect compromise.
- **Compromised Obsidian.** A malicious plugin running in the same Obsidian process can read this plugin's `data.json` (and therefore the Bearer token) directly. Only install Obsidian plugins from sources you trust.

## Legacy 0.3.x Considerations

The 0.3.x line (`main` branch) ships a different architecture: a standalone Go MCP server binary launched by Claude Desktop over stdio, communicating with Obsidian via the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin over HTTPS with a self-signed certificate.

For 0.3.x users, the binary distribution is secured by:

- **SLSA Level 3 build provenance.** Binaries are built by `release.yml` on GitHub Actions with `actions/attest-build-provenance@v4`. The release page footer links to the attestation.
- **Verification.** Users can verify a downloaded binary's provenance with:
  ```bash
  gh attestation verify --owner istefox <binary-path>
  ```
  This confirms the binary was built from the exact commit and workflow recorded in the attestation, not tampered with after release.

The 0.4.x release pipeline (per `release.yml` split, PR #62) only emits attestations for tags whose name starts with `0.3.` — the 0.4.x line ships plugin-only assets (`main.js`, `manifest.json`, `obsidian-plugin-X.zip`) and does not currently produce SLSA attestation. Verification for 0.4.x relies on the BRAT plugin or community store identifying the release by its tag commit SHA, plus the install path being the user's own vault directory.

## Supported Versions

| Version | Status | Security policy |
|---|---|---|
| **0.4.x** | **Current — full support** | Critical and high vulnerabilities patched; plugin-only release line. Latest: `0.4.7` (2026-05-16). |
| **0.3.x** | Legacy — critical fixes only | Binary release line for users on the standalone-server architecture. Patched only for actively exploited or data-loss-class issues. Latest: `0.3.12` (2026-04-28). |
| 0.2.x and earlier | End of life | No support. Users should migrate to `0.4.0` (or `0.3.12` if the binary architecture is required). |

## Security Update Policy

Time-to-patch targets, measured from confirmed report:

- **Critical** (active exploitation, data loss, or remote authentication bypass): patch within 7 days, advisory published within 14.
- **High** (privilege escalation within the documented threat model, authentication bypass requiring local access, persistent unauthorized state changes): patch within 30 days.
- **Moderate / Low**: addressed in the next regular release.

Patches for the 0.4.x line ship as new tags on the `feat/http-embedded` → `main` track. Patches for the 0.3.x line ship from the `main` branch as 0.3.x tags.

## Best Practices for Users

1. **Pin and update.** Use BRAT or the community store. Update promptly after security advisories; the latest tag is recorded in the GitHub Releases page metadata.
2. **Bearer token hygiene.** Treat the Bearer token (Settings → Access Control) as a secret. Rotate after sharing the device, after suspected compromise, or routinely (annually). The *Auto-write Claude Desktop config* option is OFF by default — if you turn it on, the token rotation will rewrite `claude_desktop_config.json` automatically with a `.backup` sibling file.
3. **Command execution gate.** Leave the master toggle off unless you actively want the MCP client to run Obsidian commands. When you enable it, prefer the curated Editing / Navigation presets over wildcard allowlist additions; review the audit log periodically.
4. **0.3.x users — verify binaries.** Run `gh attestation verify --owner istefox <binary>` before placing a downloaded binary at the install location. Do not skip this step on a fresh install.
5. **Vault content review.** Before connecting an MCP client, glance at vault folders containing secrets (`.env` files, credentials notes, exported tokens) and consider whether the AI client's authority should extend to those folders. The plugin has no per-folder ACL — the trust boundary is per-vault.
6. **Monitor logs.** Open the developer console (Cmd+Opt+I on macOS / Ctrl+Shift+I on Windows/Linux) periodically to scan for `[mcp-transport]` or `[command-permissions]` log lines that indicate unexpected activity.

## Security Acknowledgments

The following individuals and organizations have contributed to the security posture of this project through responsible disclosure or substantive review:

- @folotp — extensive soak testing across the 0.4.0 beta cycle (rounds 1, 2, 3) surfacing multiple silent-data-corruption regressions in `patch_*_file` and `execute_template`. Reports landed as fixes in 0.3.8, 0.3.12, 0.4.0-beta.2, and 0.4.0-beta.3.
- Original authorization design for `execute_obsidian_command` (issue #29 / threat model) — carried forward from the 0.3.x codebase unchanged (MIT-licensed).

## License

This security policy is licensed under the [MIT License](LICENSE), same as the rest of the project.
