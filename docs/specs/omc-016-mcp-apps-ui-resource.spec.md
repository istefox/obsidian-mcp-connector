# OMC-016 — MCP Apps `ui://` resource surface

**Topic slug:** omc-016-mcp-apps-ui-resource

Issue #427. Gate C of the 2.0 roadmap. Supersedes the throwaway spike on
`spike/427-mcp-apps-ui-resource` (`678afcf`), which answered the feasibility question and is not
for merge.

## Objective

Give `search_vault_smart` and `search_vault_simple` a rendered, ranked result list inside the
host conversation, in place of a wall of JSON text, without changing what any client that does
not speak the MCP Apps extension receives.

The spike already established what the host requires, measured rather than argued:

- `capabilities.extensions` must declare `io.modelcontextprotocol/ui`. Declaring the generic
  `resources` capability alone produced nothing.
- The mime type must be exactly `text/html;profile=mcp-app`.
- The page must complete the `ui/initialize` → `ui/notifications/initialized` handshake or the
  host leaves the iframe blank.
- None of this required negotiating protocol revision `2026-07-28`.

What remains is the real implementation: a resources capability that goes through the single
construction site both eras share, a handshake that is not hand-written, and a view worth looking
at.

## Scope

**In scope**

- A `resources` capability serving `ui://` application resources.
- A generated, self-contained HTML view, bundling `@modelcontextprotocol/ext-apps` for the
  handshake.
- `_meta.ui.resourceUri` on the `tools/list` entries for `search_vault_smart` and
  `search_vault_simple`, and the corresponding structured payload on those tools' results.
- Click-to-open into Obsidian.

**Out of scope**

- Vault notes as MCP resources. The resources capability exists to serve application UIs and
  nothing else. Exposing vault markdown through `resources/list` would put vault content on a
  surface that `ToolScope`, the per-token allowlist and `userDisabled` do not reach — those are
  tool-level concepts — and would need a policy model designed from scratch. That is a separate
  feature with a separate decision.
- `search_vault`. Its result shape differs most from the other two; it can adopt the same view
  later, additively, which is the point of adopting per tool.
- A user-facing kill switch for MCP Apps. Not in this release.
- MCP Tasks (`io.modelcontextprotocol/tasks`, OMC-010 / #416). Still parked, still no client.

## Stack

- TypeScript, Bun workspace monorepo, existing plugin build.
- `@modelcontextprotocol/server` and `@modelcontextprotocol/node`, both pinned at `2.0.0`, unchanged.
- New: `@modelcontextprotocol/ext-apps` (`1.7.5` on npm at time of writing, not currently
  installed), used in the view.
- Generated asset pipeline modelled on `scripts/gen-shim-source.ts` →
  `assets/connectorShimSource.ts`.

## Architecture

### Resource registry

A `ResourceRegistry` shaped like the existing `PromptRegistry`: the transport owns an empty
instance, the feature that owns the content fills it at setup time, and `composeToolRegistry`
wires it. `list` and `read` are handed to `setRequestHandler` by reference, so they are
arrow-function properties rather than methods.

The registry serves `ui://` entries only. It is populated at setup, from a static declaration —
there is no discovery, no vault read, and no per-request work.

### Registration site

Handler registration and capability declaration both go through `buildMcpServer(tokenId)`, the
single construction site for both protocol eras (CLAUDE.md, ADR-0016). The legacy branch calls it
directly; the modern branch reaches it through the SDK's `McpServerFactory`. The spike registered
its handlers on the pre-era-split path and must not be copied as-is.

The declared capabilities gain:

- `resources: { subscribe: false, listChanged: false }` — declared explicitly, both fields, on
  both eras. The `ui://` set is static, so `listChanged: true` would be a claim nothing honours,
  which is the exact defect OMC-023 existed to repair. `subscribe: false` because the transport is
  POST-only and cannot push outside a request. Explicit rather than `{}` because the SDK has been
  observed rewriting a bare capability object during handler registration.
- `extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } }`.

Both eras carry the same declaration. Restricting the extension to the modern era would leave the
headline feature of 2.0 unreachable by every client that exists: measured traffic is
`legacy 22 · modern 2`, and both modern calls were hand-built probes.

This moves the legacy `initialize` reply bytes, which OMC-008's Invariant 1 forbade. 2.0 is the
release allowed to move them, and ADR-0017 has already moved them once for the same reason.

### Data flow — push, not pull

The view is a renderer, not a client. One static `ui://` page per tool; the tool's own result
carries the structured results; the host hands them to the view.

Rejected: a view that calls back through the host to fetch its own data (it makes the view's
requests indistinguishable from the agent's at the transport, and buys refinement this release
does not need), and a per-call `ui://` URI with data baked in (it requires the server to hold a
payload between the `tools/call` and the `resources/read` — state between requests, which this
transport does not have and is not going to grow).

### Data channel

The structured payload rides in the **tool result's own `_meta`**, under the extension's key.
No `outputSchema` is declared, and `structuredContent` is not used.

This is not a preference dressed up as a rule. `search_vault_smart` is polymorphic — it has an
`index_building` error branch — and a declared `outputSchema` makes SDK clients reject every
response that lacks `structuredContent`. That is precisely what broke `get_vault_file` in
0.27.2–0.27.6. `_meta` is free-form, ignored by every client that does not read it, and symmetric
with how the tool already advertises its UI on the `tools/list` entry.

If the MCP Apps extension mandates a different channel, the extension wins; that is verified
against the installed `1.7.5`, not assumed.

### The view

A single generated HTML file, self-contained: every style inline, no external stylesheet, font or
script, because the host renders it in a sandboxed iframe with a deny-by-default CSP.

`@modelcontextprotocol/ext-apps` provides the handshake rather than hand-written `postMessage`.
Hand-rolled copies of somebody else's protocol are this repository's known failure mode —
`isModernProtocolVersion` and `SUPPORTED_PROTOCOL_VERSIONS` are both documented as project-owned
copies that go stale silently.

**Condition on that choice.** The generated HTML is baked into a `src/**` source file and
therefore into `main.js`, for every user, including those on clients that never render it. The
architect measures the real bundled delta before fixing this, and states the figure. If it is
disproportionate, that measurement is what justifies falling back to a hand-written handshake —
a guess is not.

### Asset pipeline

`assets/<name>.html` → `scripts/gen-mcp-app-source.ts` → `src/features/mcp-transport/assets/<name>Source.ts`,
generated and Prettier-formatted before writing, exactly as `connectorShimSource.ts` is.

The known trap applies here too: editing the HTML without re-running the generator silently ships
the old page. A test must make that loud, in the shape of the `test:mcpb` shim-identity check.

### Theme

Two palettes as CSS custom properties, switched on `prefers-color-scheme`, which a sandboxed
iframe does inherit. If `ui/initialize` turns out to carry a host theme hint, that is preferred
and the media query stays as the fallback — verified against `1.7.5`, not assumed.

The spike's fixed light palette is not carried forward. Obsidian users skew dark, and a white
card in a dark conversation is the first thing anyone notices.

## Data model

The payload placed in the tool result's `_meta`, per result row:

| Field | Type | Notes |
| --- | --- | --- |
| `filePath` | string | Vault-relative path, as the tools already return it. |
| `excerpt` | string | Surrounding context for the hit. |
| `line` | number \| null | 0-indexed. `null` is normal — Smart Connections cannot resolve one. |
| `score` | number \| null | Present for `search_vault_smart`, absent for `search_vault_simple`. |
| `heading` | string \| null | Where the provider supplies one. |

The two tools produce different subsets of this shape. The view renders one list and omits what is
absent; it does not branch on which tool produced the data.

## API surface

| Method | Behaviour |
| --- | --- |
| `resources/list` | Returns the `ui://` entries with their mime type. The extension permits omitting UI-only resources, but a capability that lists nothing is indistinguishable from a broken one, so they are listed. |
| `resources/read` | Returns the generated HTML at `text/html;profile=mcp-app`. An unknown URI is an error, not an empty result. |
| `resources/templates/list` | Not implemented. The SDK asserts the resources capability per method, so registering `list` and `read` alone must be confirmed legal on both eras. |
| `tools/list` | Entries for the two search tools carry `_meta.ui.resourceUri`. |
| `tools/call` | Results for those two tools carry the structured payload in `_meta`. `content` is unchanged. |

The high-level `McpServer.registerResource()` helper is avoided: it asserts all three resource
methods at once and registers capabilities behind our back.

## UI flow

1. The agent calls `search_vault_smart` or `search_vault_simple`.
2. The host reads `_meta.ui.resourceUri` from the tool's `tools/list` entry, fetches that `ui://`
   URI over `resources/read`, and renders it in a sandboxed iframe.
3. The page completes `ui/initialize` → `ui/notifications/initialized`, then reports its size so
   the host gives it a real height rather than a collapsed one.
4. The host hands the result payload to the view; the view renders a ranked list — file path,
   excerpt, score where present, line number where resolved.
5. Clicking a row opens the note in Obsidian via `obsidian://open?vault=…&file=…`. The vault name
   comes from `app.vault.getName()`, already used by `setup.ts`.

**The line number is informational, not navigational, and the SPEC says so plainly.**
`obsidian://open` has no documented parameter for jumping to a line. Registering the plugin's own
URI handler would give real navigation and was rejected for this release — it adds a new URI
surface the community-plugin scanner will see. Depending on the Advanced URI community plugin was
rejected outright: a runtime dependency on another author's plugin, and two click behaviours to
explain.

## Edge cases

- **`line: null`.** Normal under Smart Connections, which hardcodes it. The row renders without a
  line number; nothing degrades.
- **`search_vault_smart` returning `index_building`.** The error branch carries no results. The
  tool must not stamp a results payload it does not have; either the error is rendered legibly by
  the view or the `_meta` is omitted on that branch. Decide once, and test it.
- **Zero results.** The view renders an explicit empty state, not a blank card.
- **Large result sets.** The payload is capped, and the cap is stated rather than discovered. A
  `_meta` payload is served on every matching call.
- **A client that ignores the extension.** Its `content` array is byte-identical to today's. This
  is the constraint the whole design serves and it is asserted, not assumed.
- **Per-token surfaces.** A token whose profile excludes a search tool never sees its `tools/list`
  entry, so it never sees the pointer. The `ui://` resources themselves are global; the registry
  never dereferences a token id.
- **Distributed `.mcpb` bundles and configured clients.** `tools/list` is served fresh on every
  request, so nothing needs re-exporting. Confirm rather than assume.
- **Unknown `ui://` URI on `resources/read`.** A protocol error naming the URI.
- **Community-plugin review.** The generated source lands under `src/**`, which the scanner lints,
  and `eslint-disable` on `obsidianmd/*` rules is forbidden. The generated file must pass clean.
- **Conformance.** Declaring `resources` moves the server into the area the baseline's two
  list-changed-on-subscription entries live in. The result may change in either direction; the
  baseline is maintained by hand and never regenerated from a failing run.

## Success criteria

- [ ] R-01 — `buildMcpServer(tokenId)` declares `resources: { subscribe: false, listChanged: false }`
      and `extensions: { "io.modelcontextprotocol/ui": … }`, and both eras serve the same
      declaration from that one site.
- [ ] R-02 — `resources/list` returns the `ui://` entries with mime type exactly
      `text/html;profile=mcp-app`.
- [ ] R-03 — `resources/read` on a declared `ui://` URI returns the generated HTML at that same
      mime type; an unknown URI returns a protocol error naming it.
- [ ] R-04 — The `tools/list` entries for `search_vault_smart` and `search_vault_simple` carry
      `_meta.ui.resourceUri`, and no other tool does.
- [ ] R-05 — Results from those two tools carry the structured payload in the result's `_meta`.
      No `outputSchema` is declared on either tool and `structuredContent` is not used.
- [ ] R-06 — The `content` array those two tools return is byte-identical to the pre-change
      output for the same input. A test asserts this, and it fails if the text is touched.
- [ ] R-07 — The view completes the `ui/initialize` → `ui/notifications/initialized` handshake
      using `@modelcontextprotocol/ext-apps`, not hand-written `postMessage`.
- [ ] R-08 — The bundled size the view adds to `main.js` is measured and stated as a figure. If
      the choice in R-07 is reversed, that measurement is the stated reason.
- [ ] R-09 — The view renders a ranked list showing file path, excerpt, score where present and
      line number where resolved, and renders correctly when `score` or `line` is absent.
- [ ] R-10 — The view renders an explicit empty state for zero results, and handles
      `search_vault_smart`'s `index_building` branch without rendering a broken list.
- [ ] R-11 — Clicking a row opens the note in Obsidian via `obsidian://open` with the vault name
      from `app.vault.getName()`. The line number is displayed but not claimed as a jump target.
- [ ] R-12 — The view supplies light and dark palettes switched on `prefers-color-scheme`, and
      prefers a host theme hint if `ui/initialize` provides one.
- [ ] R-13 — The HTML asset is generated by a script into `src/**` and a test fails if the
      generated file and its source diverge, in the shape of the `test:mcpb` shim-identity check.
- [ ] R-14 — The resources capability serves `ui://` entries only. No vault content is reachable
      through `resources/*`.
- [ ] R-15 — The full gate passes: `bun run check`, `bun test`, `bun run format:check`,
      `bun run check:svelte`, `bun run test:mcpb`.
- [ ] R-16 — `bun run test:conformance` is run by hand and its result recorded. Any movement
      against the four-entry baseline is investigated, and the baseline is edited by hand or not
      at all — never regenerated from a failing run.
- [ ] R-17 — The generated asset and all new code under `src/**` pass community-plugin review
      constraints with no `eslint-disable` on any `obsidianmd/*` rule.
- [ ] R-18 — A human observes the ranked list render in Claude Desktop against a live vault, and
      observes a click open the correct note. This blocks the 2.0 cut, on the same standard as A2
      and B3 — the feature is not done until someone has seen it work.
