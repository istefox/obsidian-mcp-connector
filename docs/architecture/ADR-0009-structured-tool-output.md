# ADR-0009: Structured tool output (structuredContent dual-emit)

**Status:** Accepted  
**Date:** 2026-06-14  
**Deciders:** Stefano Ferri

---

## Context

Every successful tool result in the plugin is built by `successJson(value)` in
`packages/obsidian-plugin/src/features/mcp-tools/services/responseBuilders.ts`.
Today it returns only a `content[].text` JSON string. Structured-aware MCP
clients (Claude Desktop, Claude Code) receive no typed object; they must parse
the text blob.

The MCP spec (2025-06-18) introduced `structuredContent` on `CallToolResult` as
the mechanism to carry the object form alongside the serialized text.
`@modelcontextprotocol/sdk` 1.29.0 (already installed) includes
`structuredContent: z.record(z.string(), z.unknown()).optional()` in its ESM
`CallToolResultSchema`. No dependency bump is required.

The 48 registered tools all go through `successJson`, so a single edit there
gives every tool structured output with no per-tool changes.

### Transport forwarding: risk resolution

The SPEC identified a critical risk: whether the transport path from a handler's
returned `ToolResponse` to the wire actually forwards `structuredContent` or
strips it.

**Finding:** no transport change is required.

The transport path works as follows:

1. `mcpServer.ts` calls `server.server.setRequestHandler(CallToolRequestSchema, handler)` on the low-level `Server` instance (not the high-level `McpServer`).
2. The low-level `Server.setRequestHandler()` overrides the `tools/call` method with a wrapper (see `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js`, line ~120). That wrapper calls `safeParse(CallToolResultSchema, result)` and returns `validationResult.data`.
3. `CallToolResultSchema` in the ESM dist extends `ResultSchema` (`z.looseObject`). It explicitly declares `structuredContent: z.record(z.string(), z.unknown()).optional()` (ESM `types.js`, line 1302). Zod's loose object mode passes through unknown fields; declared fields are preserved verbatim.
4. Therefore, any `structuredContent` field present on the handler's return value survives the SDK validation pass and reaches the wire unchanged.

The local ArkType `resultSchema` exported from `toolRegistry.ts` (used only as
the TypeScript return-type constraint on `register()`) does not include
`structuredContent`. This type must be widened so handlers returning
`structuredContent` type-check cleanly; it is not a runtime concern.

### Payload duplication

Dual-emit means large payloads (search, `list_vault_files` with `limit: 1000`)
are carried twice over the wire: once as `content[].text` and once as
`structuredContent`. On structured-aware transports this roughly doubles the
token cost for those tools. The SPEC accepts this for v1 with no size cap or
per-tool exclusion.

---

## Decision

**Centralize `structuredContent` emission in `successJson`.** One edit to
`responseBuilders.ts` gives all 48 tools structured output. No per-tool opt-in
or per-tool schema in v1.

**Dual-emit.** `content[0].text` stays byte-identical to today. `structuredContent`
is added as the object form. Old clients are unaffected; new clients read the
object directly.

**Wrapping rule.** `structuredContent` is always a JSON object:
- plain object (not array, not null): passed through as-is.
- array, primitive, `null`: wrapped as `{ result: value }`.
- `undefined`: `structuredContent` omitted entirely.

**Success-only.** `errorJson` and `errorText` carry no `structuredContent`.

**No `outputSchema` in v1.** Per-tool schema declarations are deferred to v2.

**No transport change.** The SDK validation pass preserves `structuredContent`
for free (confirmed by reading `server/index.js` and `esm/types.js` in
`node_modules`).

---

## Alternatives considered

### Alternative A: Per-tool opt-in decorator

Each tool handler explicitly calls `successJsonStructured(value)` instead of
the centralized change. This would give fine-grained control and avoid the
double-emit cost on large-payload tools immediately.

**Rejected.** With 48 tools across 11+ handler files, the surface area for
missing opt-in is large and would drift over time. The SPEC's constraint that
all 48 tools gain structured output from a single edit rules this out for v1.
Size optimization is explicitly deferred.

### Alternative B: Size-threshold opt-out in `successJson`

Skip `structuredContent` when `JSON.stringify(value).length` exceeds a chosen
byte threshold (e.g. 10 KB), emitting only the text form for large payloads.

**Rejected.** The SPEC explicitly records this as out of scope: "Uniform
dual-emit. No size cap, no per-tool exclusion." Adding a threshold in v1
introduces a configuration surface, requires a documented constant, and makes
client behavior payload-size-dependent. Token cost on large results is accepted
as a documented tradeoff.

### Alternative C: Forward `structuredContent` from the transport by re-wrapping

Intercept the handler result in `mcpServer.ts` (the `CallToolRequestSchema`
handler), inspect it, and call a helper to attach `structuredContent` before
returning. This would keep `responseBuilders.ts` unchanged.

**Rejected.** Transport is policy-free after the 0.18.0 refactor (ADR-0006
durable note). Emitting `structuredContent` is the response builder's concern;
placing the logic in the transport layer reverses that separation. The
centralized `successJson` path is cleaner.

---

## Consequences

**Positive:**
- All 48 tools gain structured output from a single file edit, with zero
  per-tool changes and zero behavioral change for existing clients.
- No dependency bump, no registry change, no transport change.
- The `ToolResponse` type becomes the single source of truth for the wire shape;
  callers do not need to know about `structuredContent`.

**Negative:**
- Large-payload tools (`search_vault`, `list_vault_files` with high `limit`)
  carry the payload twice on structured-aware transports. This is accepted and
  documented; v2 may add per-tool opt-out.
- `content[].text` and `structuredContent` can differ in shape for
  array/primitive returns (text = `[...]`, structured = `{ result: [...] }`).
  Clients must be aware of this intentional divergence.

**Neutral:**
- The local ArkType `resultSchema` in `toolRegistry.ts` (line 138) must be
  widened to include `"structuredContent?": "Record<string, unknown>"` so
  handlers returning `structuredContent` pass TypeScript type-checking. This is
  a type-only change; it has no effect on runtime dispatch or validation.
- `successText`, `errorText`, and `errorJson` are unchanged. No audit of their
  call sites is needed.
- The existing 1255-test suite must pass with no edits to any existing test
  file, confirmed by the regression task.

---

## Files to create or modify

| File | Change |
|---|---|
| `packages/obsidian-plugin/src/features/mcp-tools/services/responseBuilders.ts` | Widen `ToolResponse` type; add `isPlainObject` helper; rewrite `successJson` to emit `structuredContent`. |
| `packages/obsidian-plugin/src/features/mcp-tools/services/responseBuilders.test.ts` | Add new `describe` block with red-first tests; existing tests unchanged. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/toolRegistry.ts` | Widen local `resultSchema` to include optional `structuredContent` field so TypeScript accepts the new `ToolResponse`. |
| `packages/obsidian-plugin/src/features/mcp-transport/services/mcpServer.test.ts` | Add a test asserting `structuredContent` reaches the HTTP wire response for `tools/call`. |

---

## References

- SPEC.md at repo root (structured-tool-output, 2026-06-14)
- MCP spec 2025-06-18, `CallToolResult.structuredContent`
- `@modelcontextprotocol/sdk` 1.29.0 ESM dist: `types.js` line 1302, `server/index.js` lines ~120-160
- ADR-0006: mcp-transport composition root policy
