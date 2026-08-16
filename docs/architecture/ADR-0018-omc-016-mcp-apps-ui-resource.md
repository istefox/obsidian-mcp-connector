# ADR-0018: MCP Apps — a `ui://` resource surface for the two search tools

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Stefano Ferri
**Issue:** OMC-016 / #427 (Gate C of the 2.0 roadmap)

---

## Context

`search_vault_smart` and `search_vault_simple` return a JSON blob as text. In a host that
speaks the MCP Apps extension that blob can be a rendered, ranked, clickable list instead.
The spike on `spike/427-mcp-apps-ui-resource` (`678afcf`) proved the host end works: Claude
Desktop fetched a `ui://` resource from this connector and rendered it. Three facts were
measured there and are taken as given here — `capabilities.extensions` must declare
`io.modelcontextprotocol/ui` (the generic `resources` capability alone produced nothing), the
mime type must be exactly `text/html;profile=mcp-app`, and the page must complete the
`ui/initialize` → `ui/notifications/initialized` handshake or the iframe stays blank. None of
it required negotiating protocol revision `2026-07-28`.

The spike is not for merge. It predates the era split (ADR-0016) and registered its handlers
inside `createMcpService` on the old single construction path. What survives from it is shape,
not placement: the `ResourceRegistryClass`, `ToolRegistryClass.setMeta`, the
`gen-mcp-app-source.ts` generator, and the observation that `McpServer.registerResource()`
must be avoided.

This ADR moves the legacy `initialize` reply bytes for the second time in this release, on the
same justification ADR-0017 used: 2.0 is the release allowed to move them.

### What the installed `@modelcontextprotocol/server@2.0.0` actually does

Read from `node_modules`, not from memory. Re-check if the version moves.

| Fact | Where |
|---|---|
| A declared `resources` capability makes the `McpServer` constructor call `setResourceRequestHandlers()`, which registers **all three** resource handlers and then `registerCapabilities({ resources: { listChanged: … ?? true } })` | `mcp-DXXb3Vv3.mjs:1350`, `:1497` |
| `mergeCapabilities` is a shallow per-key object merge, so a sibling key declared at construction survives that rewrite | `src-CX2iR2pK.mjs:6839-6852` |
| `resources/list`, `resources/read` and `resources/templates/list` are gated on the **same single** `resources` capability — there is no per-method sub-capability | `mcp-DXXb3Vv3.mjs:999-1004` |
| `extensions` is a first-class optional field of `ServerCapabilities` on both eras (`z.record(z.string(), JSONObject)`), and the 2026 pick includes it | `src-CX2iR2pK.mjs:2559`, `:2572`, `:2849` |
| `server/discover` advertises `discoverAdvertisedCapabilities(getCapabilities())`, which is `{ ...capabilities }` — the declared set verbatim | `mcp-DXXb3Vv3.mjs:1037`, `:1291` |
| The 2026 dispatch registry admits `resources/list`, `resources/read` and `resources/templates/list` | `src-CX2iR2pK.mjs:3168-3170` |
| A 2026-era `resources/read` requires `Mcp-Name` mirroring `params.uri` | `src-CX2iR2pK.mjs:4990-4993`, `:5041-5056` |
| A result's `_meta` is `z.looseObject`, so foreign keys survive the encode seam on the modern era | `src-CX2iR2pK.mjs:2912-2927` |
| Result validation against a tool `outputSchema` is skipped entirely when no schema is declared (`if (!tool.outputSchema) return;`) | `mcp-DXXb3Vv3.mjs:1439` |

The first row answers the SPEC's open question the wrong way round and the answer is better
than the question assumed: **`resources/templates/list` is not unimplemented.** Declaring the
capability installs the SDK's own handler for it, and overriding `resources/list` and
`resources/read` afterwards (the same move `prompts/list` and `prompts/get` already make at
`mcpServer.ts:267-270`) leaves that third handler in place, answering `{ resourceTemplates:
[] }`. There is nothing to register and nothing to refuse.

The second and third rows are the OMC-023 defect shape repeating: a bare `resources: {}` would
be rewritten to `{ listChanged: true }` before anything read it, and this transport can no more
deliver `notifications/resources/list_changed` than it could deliver the prompts one. An
explicit `false` survives the `??`, and the shallow merge means an explicit `subscribe: false`
declared alongside it survives too.

### What `@modelcontextprotocol/ext-apps@1.7.5` actually provides

Not installed at decision time. Verified by downloading and unpacking the published tarball
(`registry.npmjs.org/@modelcontextprotocol/ext-apps/-/ext-apps-1.7.5.tgz`, 40 files,
`unpackedSize` 1,363,724) and reading its `package.json` and the `.d.ts` / `.js` files under
`dist/src/`. Every name below was read there; none is recalled.

**Exports.** `.` → `dist/src/app.js`; `./app-with-deps` → `dist/src/app-with-deps.js`;
`./react` and `./react-with-deps`; `./app-bridge` (host side); `./server` (server helpers);
`./schema.json`.

**The pieces the view needs.** `App` (class), `App.connect(transport?)` — the default
transport is `new PostMessageTransport(window.parent, window.parent)`, and `connect()` sends
`ui/initialize`, stores `hostCapabilities` / `hostInfo` / `hostContext` from the result, then
sends `ui/notifications/initialized`. `AppOptions.autoResize` defaults to `true` and installs a
`ResizeObserver` that emits `ui/notifications/size-changed`, so the SPEC's "reports its size"
step is free. `AppOptions.allowUnsafeEval` defaults to `false`, and on that path the constructor
sets `z.config({ jitless: true })` specifically so the library works under the extension's
default CSP, which has no `unsafe-eval`.

**Constants.** `RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"` (`app.d.ts:78`) confirms the
mime type. `RESOURCE_URI_META_KEY = "ui/resourceUri"` (`app.d.ts:70`) is the **legacy flat**
form of the tool pointer; `_meta.ui.resourceUri` is the modern one; the doc comment says hosts
"must support both formats", and the shipped `registerAppTool` helper fills in whichever of the
two is missing (`dist/src/server/index.js`, function `K3`). The SPEC's `_meta.ui.resourceUri`
is therefore right and incomplete.

**The data channel.** `ui/notifications/tool-result` carries `params` shaped as the entire
`CallToolResult` — `_meta`, `content`, `structuredContent`, `isError` — and the params schema is
`z.core.$loose` with a `$loose` `_meta` inside it (`app.d.ts`, `eventSchemas.toolresult`). The
extension does **not** mandate `structuredContent`; it forwards the whole result and lets the
view pick. The SPEC's choice of the result's own `_meta` stands, unamended.

**The theme hint.** `McpUiInitializeResult` carries `hostContext`, and `McpUiHostContext` has
`theme?: "light" | "dark"`, `styles.variables` (a fixed vocabulary of ~80 CSS custom properties,
`--color-background-primary` through `--shadow-lg`) and `styles.css.fonts`. `App.getHostContext()`
returns it after `connect()`, `onhostcontextchanged` updates it, and `applyDocumentTheme`,
`applyHostStyleVariables`, `applyHostFonts` and `getDocumentTheme` are exported helpers. The
SPEC's conditional — "if `ui/initialize` turns out to carry a host theme hint" — resolves to yes.

**Opening a link.** `App.openLink({ url })` sends `ui/open-link`; the spec type says the host
opens the URL "in the host's default browser" and returns `isError: true` when it refuses "e.g.
due to security policy". `McpUiHostCapabilities.openLinks` says whether the host supports it at
all. Whether a given host passes a non-`http(s)` scheme such as `obsidian://` through is host
policy and is not knowable from this package.

**What must not be used.** `./server` imports `@modelcontextprotocol/sdk/server/mcp.js` and the
package declares `peerDependencies: { "@modelcontextprotocol/sdk": "^1.29.0" }` — SDK **v1**.
This repository is on the v2 split packages (`@modelcontextprotocol/server` and `/node`, both
`2.0.0`). The server helpers are therefore off limits; only the view-side entry is used.

**Sizes.** `dist/src/app.js` is 33,323 bytes but imports `zod/v4` and four modules from SDK v1.
`dist/src/app-with-deps.js` is 337,419 bytes, has **zero** imports, and is already minified
(78,184 bytes gzipped). It contains no `</script` and no `<!--` sequence, and 1,940 backticks —
which is exactly why the generated TypeScript must use `JSON.stringify` and not a template
literal, the lesson `gen-shim-source.ts` already carries.

### The size question, computed before the decision

`main.js` today is 2,647,137 bytes (minified prod build). `JSON.stringify` of
`app-with-deps.js` is 348,293 bytes — the escaping costs 3.2% over the raw 337,419. Projected
`main.js` is therefore ≈ 2,995,430 bytes, **+13.2%**, before the view's own markup, styles and
render code (order of 10 KB). That is the design-time figure; R-08 requires it re-measured
against a real `bun run build` and stated, and that measurement is what decides whether the
ext-apps handshake survives.

---

## Decision

**D1 — One resource registry, filled at the composition root, served through the single
construction site.** `ResourceRegistryClass` lives beside `PromptRegistryClass` in
`mcp-transport/services/`, with `list` and `read` as arrow-function properties because
`setRequestHandler` takes them by reference. `composeToolRegistry` creates it, fills it from a
static declaration, and returns it alongside the other two registries; `buildMcpServer(tokenId)`
registers `resources/list` and `resources/read` against it. Not `createMcpService`, which is
where the spike put them and which now exists on only one side of the era split. The registry
serves `ui://` entries only and never dereferences a token id.

**D2 — Both capability fields explicit, one declaration, both eras.**

```
resources: { subscribe: false, listChanged: false },
extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
```

`listChanged: false` because the `ui://` set is static and nothing would ever publish the
notification; `subscribe: false` because the transport is POST-only. Both written out rather
than left to `{}`, because the SDK rewrites a bare capability object during handler registration
and an omitted `listChanged` becomes `true` — the exact defect ADR-0017 was written to repair,
one capability over. The extension shape mirrors `McpUiClientCapabilities` (`mimeTypes?:
string[]`), which is what the package defines and what the spike measured working; the SDK types
`extensions` as an unconstrained `Record<string, JSONObject>`, so nothing type-checks it and the
shape is a project-owned copy in the same class as `isModernProtocolVersion`.

Both eras carry it, from that one site. Restricting the extension to the modern era would put
the headline feature of 2.0 behind a wire no shipping client speaks: measured traffic is
`legacy 22 · modern 2`, and both modern calls were hand-built probes.

**D3 — `resources/templates/list` is left to the SDK.** Declaring the capability installs it;
we override `list` and `read` and leave the third alone. It answers an empty template list,
which is truthful. `McpServer.registerResource()` is not used: it asserts all three methods and
registers capabilities behind our back, which would undo D2.

**D4 — Push, not pull, and the payload rides the result's own `_meta`.** One static `ui://`
page serves both tools. The tools' `tools/list` entries carry the pointer in **both** forms the
extension recognises —

```
_meta: { ui: { resourceUri: "ui://mcp-connector/search-results" },
         "ui/resourceUri": "ui://mcp-connector/search-results" }
```

— because `registerAppTool` writes both and hosts are told to read both. The result payload sits
under a project-owned key, `io.github.istefox.mcp-connector/searchResults`, in the tool result's
`_meta`. No `outputSchema` is declared on either tool and `structuredContent` is not used:
`search_vault_smart` is polymorphic (it has an `index_building` error branch) and a declared
`outputSchema` makes SDK clients reject every response lacking `structuredContent` — the failure
that broke `get_vault_file` in 0.27.2–0.27.6.

**D5 — The payload exists only on the success branch.** On any `isError` result — the
`index_building` branch included — the `_meta` key is absent, and the view renders
`content[0].text` as a message. One rule instead of a per-branch decision: the view needs a
legible non-list state anyway (zero results, provider not ready), and a tool that stamps a
results payload it does not have would be lying in a machine-readable field.

**D6 — The payload is a flat, capped row list, and the vault name travels in it.**

```
{ vaultName: string,
  totalRows: number,
  truncated: boolean,
  rows: [{ filePath, excerpt, line: number|null, score: number|null, heading: string|null }] }
```

Cap: **50 rows**, `excerpt` clipped to **400 characters**. The cap is stated here rather than
discovered later, and it matters more than it looks for `search_vault_simple`, whose native
shape is per-file with N matches each — flattening 50 files can produce thousands of rows.
`search_vault_smart`'s `SearchResult` already matches the row shape field for field; the simple
tool's rows map `filename → filePath`, `context → excerpt`, keep `line`, and omit `score` and
`heading`. The view renders one list and omits what is absent; it never branches on which tool
produced the data.

The vault name lives in the payload, not in the HTML. That is what keeps the generated page
byte-identical for every user and every vault, which is what makes the drift guard in D10 mean
anything.

**D7 — The view bundles `@modelcontextprotocol/ext-apps` via the `./app-with-deps` entry,
subject to the measured figure.** Hand-rolled copies of somebody else's protocol are this
repository's known failure mode. `app-with-deps.js` is chosen over `.` because it is
self-contained: no `zod/v4`, no SDK v1 resolution, nothing to keep in sync with a dependency
graph this project deliberately moved off. The pre-measured cost is +13.2% on `main.js`; the
decision is conditional on the real build agreeing, and the fallback with its trigger is
recorded in Alternative G.

**D8 — Theme: host context first, media query as fallback.** After `connect()`, read
`getHostContext()`; apply `styles.variables` through `applyHostStyleVariables` and `theme`
through `applyDocumentTheme`, and re-apply both from `onhostcontextchanged`. Every colour in
the page is a CSS custom property whose default comes from a `prefers-color-scheme` block, so a
host that sends no context still gets a page that matches the surrounding conversation. The
spike's fixed light palette is not carried forward.

**D9 — Click-out goes through `app.openLink`, and degrades visibly.** A sandboxed iframe cannot
navigate the top window, so a bare anchor is not a design. The row click calls
`app.openLink({ url: "obsidian://open?vault=…&file=…" })` with both components
`encodeURIComponent`-escaped. If `hostCapabilities.openLinks` is absent, or the call resolves
with `isError`, the row shows the vault-relative path in a selectable element instead of failing
silently. The line number is displayed and is never claimed as a jump target: `obsidian://open`
has no documented line parameter. Registering this plugin's own URI handler would give real
navigation and is out of scope — it adds a URI surface the community-plugin scanner sees.
Depending on the Advanced URI plugin is refused outright: a runtime dependency on another
author's plugin, and two click behaviours to explain.

**D10 — The asset is generated by a pure function that the generator and the drift test both
call.** `assets/mcp-apps/searchResults.html` (hand-written shell: markup, styles, render code)
plus the installed `app-with-deps.js` go through `buildSearchResultsHtml(shell, bundle)` in
`scripts/`, and the generator writes the result into a `…Source.ts` under `src/`, Prettier-
formatted before writing, exactly as `connectorShimSource.ts` is. The colocated test calls the
same pure function on the same two inputs and compares against the generated constant, so both
failure modes are loud: editing the shell without regenerating, and bumping ext-apps without
regenerating. The function asserts the bundle contains no `</script` sequence before splicing —
true of 1.7.5, not guaranteed of 1.7.6.

The generated source lands under `src/features/mcp-apps/assets/`, with the feature that owns the
content, not under `mcp-transport/assets/` as the SPEC wrote. That follows the
`mcp-client-config/assets/connectorShimSource.ts` precedent and the SPEC's own architecture
sentence — the transport owns an empty registry, the feature owns what fills it. The assembly
helper stays in `scripts/`, because non-plugin code belongs outside `src/`.

---

## Alternatives considered

### A. Register the resources through `McpServer.registerResource()`

The high-level helper. Rejected: it calls `setResourceRequestHandlers()` (asserting all three
methods at once) and `registerCapabilities({ resources: { listChanged: … ?? true } })` behind our
back, and then `sendResourceListChanged()` on a transport that cannot deliver it. It would
overwrite D2's explicit `listChanged: false` with the SDK's default and reintroduce OMC-023's
defect on a new capability. Verified at `mcp-DXXb3Vv3.mjs:1592-1620`, not inferred.

### B. Register on the pre-era-split path, as the spike did

`createMcpService` still exists and the handlers would compile there. Rejected: after ADR-0016
that function is not the construction site — `buildMcpServer(tokenId)` is, and the modern branch
reaches it through the SDK's `McpServerFactory`. Handlers wired outside it would exist on the
legacy leg only, silently, and the whole point of the single construction site is that per-token
surfaces and capability declarations cannot drift between eras. The spike answered a feasibility
question on an architecture that no longer exists.

### C. Declare the extension on the modern era only

Symmetrical with ADR-0017, which split `prompts.listChanged` by era, and it would leave the
legacy `initialize` bytes untouched. Rejected on measurement: the legacy/modern split is
`22 / 2`, and both modern requests were hand-built probes from a test session. The feature would
ship unreachable. ADR-0017's split was forced by a capability the legacy era physically cannot
honour; nothing here is era-specific — a `ui://` resource is fetched by an ordinary
`resources/read` that both eras serve.

### D. Carry the payload in `structuredContent` instead of the result's `_meta`

This is what most MCP Apps examples do, and `ui/notifications/tool-result` forwards
`structuredContent` as readily as `_meta`. Verified as legal: the SDK skips result validation
entirely when no `outputSchema` is declared (`mcp-DXXb3Vv3.mjs:1439`), so `structuredContent`
without a schema is not rejected server-side. Rejected anyway. `structuredContent` is a
first-class, client-visible field: emitting it invites a client to expect the pair, and the
`outputSchema`/`structuredContent` coupling is precisely the trap that broke `get_vault_file`
across five releases. `_meta` is free-form, invisible to every client that does not read the key,
and symmetric with how the tool advertises its UI on the `tools/list` entry. Kept as the
contingency: if a host turns out to strip `_meta` when forwarding a result, this is where the
payload moves, and the move is one function.

### E. A per-call `ui://` URI with the data baked into the page

Removes the data channel question entirely. Rejected: it requires the server to hold a payload
between the `tools/call` and the `resources/read`. This transport is stateless and POST-only by
design — `initialize` state is not available to a later request, let alone a tool result — and
growing per-call state to serve a renderer would be the single largest architectural concession
in the release, made for a view.

### F. A view that fetches its own data through the host

`App.callServerTool` and `App.readServerResource` exist and would work. Rejected: it makes the
view's requests indistinguishable from the agent's at the transport, so per-token counters,
adaptive promotion and the era counters all start counting a renderer as a client. It also buys
interactive refinement — re-query, paginate, filter — that this release does not need. The view
is a renderer.

### G. A hand-written `postMessage` handshake instead of `@modelcontextprotocol/ext-apps`

Roughly 2–3 KB against 348 KB, a >99% saving on the single largest line item. Rejected as the
default: `isModernProtocolVersion` and `SUPPORTED_PROTOCOL_VERSIONS` are both documented in
CLAUDE.md as project-owned copies of somebody else's rules that go stale silently, and this
would be a third and much larger one — a full request/response protocol with a version
negotiation, a capability exchange, and a resize channel. It is retained as the **fallback with
a stated trigger**: if the measured `main.js` delta exceeds **+20%**, the handshake is
hand-written and the measurement is the recorded reason (R-08). The design-time projection is
+13.2%, so the expected outcome is that the trigger does not fire.

### H. Bundle the `.` entry (33 KB) and resolve `zod` and SDK v1 externally

Nine times smaller before bundling. Rejected: `app.js` imports `zod/v4` and four modules from
`@modelcontextprotocol/sdk` **v1**, which this project does not depend on — it is present only
transitively. Taking that entry means adding SDK v1 as a declared dependency of a repository
that runs on the v2 split packages, and the two would then need to be kept in step forever. After
bundling zod and the v1 `Protocol` class the result would not be dramatically smaller than the
337 KB upstream already produced, so the saving is mostly imaginary while the coupling is real.

### I. Ship the HTML as a separate plugin asset file instead of baking it into `main.js`

Obsidian would load an extra file from the plugin directory and `main.js` would not grow at all.
Rejected: the release workflow uploads `main.js`, `manifest.json` and the `.mcpb`, and the
community-plugin release convention is that trio. Adding a fourth artifact means changing the
release workflow, the `.mcpb` packer and the reproducible-build verification Obsidian runs on
the release, all to avoid a 13% growth on a bundle that already carries Transformers.js and
onnxruntime-web. It also introduces a runtime file read that can fail, on a path that currently
cannot.

### J. Expose vault notes through `resources/*` as well

The obvious adjacent feature once a resources capability exists. Rejected, and the reason is
access control rather than effort: `ToolScope`, the per-token allowlist and `userDisabled` are
all tool-level concepts and none of them reaches `resources/read`. Listing vault markdown there
would put vault content on a surface where a token's policy does not apply. That needs a policy
model designed from scratch and is a separate decision. The registry serves `ui://` and nothing
else, and R-14 makes that testable rather than merely intended.

### K. A plugin-owned URI handler, or the Advanced URI plugin, for real line navigation

Both would make the displayed line number a jump target. The own-handler route adds a new URI
surface for the community-plugin scanner to review in the same release that already adds a
resources capability and a 348 KB asset; the Advanced URI route makes a shipped feature depend
on another author's plugin being installed, and produces two different click behaviours to
document. Rejected for this release; the line stays informational and the SPEC says so plainly.

### L. `resources: {}` or `resources: { listChanged: true }`

`{}` is what the spike shipped and is the smaller diff. Rejected: the SDK rewrites it to
`{ listChanged: true }` at handler-registration time, which is an unhonoured claim on a
POST-only transport — the same defect OMC-023 existed to repair, recreated on a new capability
in the very release that repaired it. `listChanged: true` honoured is not available either: the
`ui://` set is static and compiled in, so nothing could ever fire the notification.

---

## Consequences

### Positive

- The two most-used search tools render as a ranked, clickable list in any host that speaks the
  extension, and return byte-identical text to every host that does not. R-06 makes that an
  assertion rather than an intention.
- The capability declaration, the handler registration and the per-token surface all stay at
  `buildMcpServer`, so the two eras cannot disagree about what this server offers. Adding a
  third era later inherits the resources capability for free.
- The handshake, the resize protocol, the theme vocabulary and the link-out channel are all
  upstream code. When the extension revises, the change is a version bump and a regeneration,
  not a re-reading of a spec.
- `resources/templates/list` is answered rather than refused, at zero cost, because the SDK's
  own handler stays installed.
- The payload shape is one flat row list for both tools, so a third tool (`search_vault`, out of
  scope here) adopts the same view by projecting into it — no view branching, no second page.

### Negative

- `main.js` grows by roughly 13%, for every user, including those on clients that will never
  render the page. This is the single largest cost of the decision and it is paid unconditionally.
- The legacy `initialize` reply bytes move again. `eraRouter.test.ts`'s full-body pin and
  `modernEra.test.ts`'s `server/discover` capability assertion both fail until updated, by
  design — those two assertions are the record of what 2.0 permitted.
- A new generated-source drift trap joins the existing one. Editing the HTML shell, or bumping
  `@modelcontextprotocol/ext-apps`, without re-running the generator ships the old page. The
  drift test is the only thing standing between that and a silent regression.
- `ext-apps` declares a peer dependency on SDK **v1**. Even used only through the pre-built
  view entry, that is a second MCP SDK lineage in the dependency graph, and a future version
  could start requiring it at the entry we do use.
- Whether Claude Desktop passes an `obsidian://` URL through `ui/open-link` is unknown and
  unknowable from the package. If it refuses, R-11's click behaviour degrades to a displayed
  path and the feature is meaningfully less useful — which is exactly why R-18 blocks the cut.
- The view is HTML and JavaScript outside both `tsc --noEmit` and `svelte-check`. Nothing in the
  gate type-checks it; only a human in front of a real vault sees whether it renders.

### Neutral

- `resources/list` ignores its pagination cursor and returns the whole set. With one entry that
  is correct behaviour and not a shortcut.
- Declaring `resources` moves the server into the region the conformance baseline's two
  list-changed-on-subscription entries live in. The result may move in either direction; the
  baseline is maintained by hand and never regenerated from a failing run.
- A token whose profile excludes a search tool never sees its `tools/list` entry and therefore
  never sees the pointer. The `ui://` resources themselves are global, and the registry never
  dereferences a token id — the same split ADR-0014 already established for tools.
- `tools/list` is served fresh on every request, so no distributed `.mcpb` bundle and no
  configured client needs re-exporting to pick the pointer up.
- The spike's diagnostic `logger.warn` calls on `resources/list` and `resources/read` are not
  carried forward. They answered a one-time question about whether the host ever asks.

---

## References

- SPEC: `SPEC.md` (repo root) — OMC-016, R-01 … R-18.
- Plan: `docs/superpowers/plans/2026-08-15-omc-016-mcp-apps-ui-resource.md`.
- ADR-0016 — two protocol eras on one endpoint; `buildMcpServer` as the single construction site.
- ADR-0017 — `prompts.listChanged` split by era; the precedent for moving the legacy reply in 2.0.
- ADR-0014 — per-token tool surfaces; why the registry never dereferences a token id.
- ADR-0015 — the `tools/list` stability invariant.
- Spike: `spike/427-mcp-apps-ui-resource` at `678afcf` (not for merge).
- `@modelcontextprotocol/server@2.0.0`, `dist/mcp-DXXb3Vv3.mjs` and `dist/src-CX2iR2pK.mjs`.
- `@modelcontextprotocol/ext-apps@1.7.5`, published tarball: `dist/src/app.d.ts`,
  `dist/src/spec.types.d.ts`, `dist/src/styles.d.ts`, `dist/src/server/index.js`.
