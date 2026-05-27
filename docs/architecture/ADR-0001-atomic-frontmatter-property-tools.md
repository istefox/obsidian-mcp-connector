# ADR-0001 — Atomic frontmatter property tools (Module D)

- **Status**: Accepted
- **Date**: 2026-05-20
- **Shipped**: v0.6.0 (PR #159 `feat/note-properties` → `main`)
- **Scope**: PR #1 / `feat/note-properties` — 4 new MCP tools

## Context

The current 30-tool surface lets agents read frontmatter (`get_vault_file_partial mode:"frontmatter"`, `get_active_file`) but the only write path is `patch_vault_file targetType:"frontmatter"`, which **replaces the entire YAML block**. For an agent that wants to set a single key (`priority: 5`, `status: done`, append one tag) this is clumsy and risk-prone: it has to read the whole block, mutate one field client-side, and re-emit — losing any concurrent edits the user made in between.

Three sub-decisions are needed for a clean tool family:

1. **Tool surface shape** — one op-discriminated tool, or N atomic tools?
2. **Value schema** — how to express the YAML scalar/list type space at the MCP boundary, given that older MCP clients serialise booleans as strings?
3. **Enumeration return shape** — how `list_property_values` reports a potentially-large, mixed-type distribution.

Constraint from `CLAUDE.md`: tools are registered via `ToolRegistry`, schemas are ArkType, every untrusted boundary is validated; vault writes go through `app.fileManager.processFrontMatter` (atomic, metadata-cache-safe). Pattern in the rest of the repo: **atomic, action-named tools** — `rename_heading`, `list_tags`, `delete_active_file`, `append_to_vault_file`, not generic ops with a discriminator.

## Decision

Ship **4 atomic tools** under the `note_property` namespace, each doing exactly one thing:

- `get_note_property(path, key) → value | null`
- `set_note_property(path, key, value)` — value type: ArkType union `string | number | boolean | string[] | number[]`. Dates as ISO 8601 strings (Obsidian YAML has no native date type).
- `delete_note_property(path, key)` — idempotent (absent key → no-op success).
- `list_property_values(key, folder?, limit?=500)` — returns a wrapper object:

```
{
  values: Array<{ value: <native type>, count: number }>,
  truncated: boolean,
  totalDistinct: number,
}
```

`set_note_property` with `value: null` is documented to redirect internally to `delete_note_property` (zero-friction for agents that compute "clear this field" intent). YAML-illegal key characters are pre-validated → `errorCode: "invalid_key"`. All writes go through `processFrontMatter`. `list_property_values` iterates `app.metadataCache` in-memory — no file I/O — and preserves native types in `value` (a numeric `priority: 5` returns `5`, not `"5"`).

## Alternatives considered

1. **Single discriminator tool** `note_property(op: "get"|"set"|"delete"|"list", ...)`. **Rejected**: violates the repo pattern (`ToolRegistry` is per-tool, not per-discriminated-union); forces the model to think about the op enum on every call; clobbers ArkType's per-tool `.describe()` schema docs (each op has a different argument shape, so the description becomes a wall of conditionals). The 30→34 tool count is well within client-rendering bounds.

2. **Two bulk-oriented tools** `get_note_properties(path) → {...}` + `set_note_properties(path, patch: {...})`. **Rejected**: bulk write was explicitly deferred (YAGNI per spec: per-call latency is sub-10 ms in-process, the multi-key case is uncommon); the bulk-read shape already exists via `get_vault_file_partial mode:"frontmatter"`; bulk write hides the per-key delete semantic that agents need (sentinel value vs missing key is a confusing contract).

3. **JSON-string + type wrapper** `set_note_property(path, key, jsonValue: string, valueType: "string"|"number"|...)`. **Rejected**: pushes type discipline onto the agent at the wrong layer; ArkType union already expresses the space natively; the boolean-as-string MCP gotcha is solved centrally in `ToolRegistry` (`CLAUDE.md` Gotcha — boolean coercion), so the union resolves correctly.

4. **Single-string value with server-side type inference** (`set_note_property(path, key, value: string)` and the server parses `"5"` → 5, `"true"` → boolean). **Rejected**: ambiguous (is `"5"` the string `"5"` or the number `5`?); the user's existing YAML may rely on the distinction; type inference is a footgun that surfaces as silent data corruption.

5. **`Record<value, count>` return for `list_property_values`** (the `list_tags` shape). **Rejected**: JSON object keys are strings, which coerces native types away — a vault with `priority: 5` and `priority: "5"` would collapse to one entry. The array-of-objects wrapper preserves the distinction. Precedent: `getRecentFiles` already uses a wrapper return — this is the established pattern for "list with metadata about the list".

## Consequences

**Positive**:

- Agents can mutate a single FM key in one call without read-modify-write race risk; the atomic `processFrontMatter` path is the canonical Obsidian-API write.
- Native-type preservation in `list_property_values` keeps the schema honest for sloppy real-world vaults (mixed `string` / `number` for the same key).
- Per-tool ArkType schemas keep the model-facing docs precise; `.describe()` on each field is unambiguous.
- `list_property_values` uses `metadataCache` only → O(notes) memory scan, no file I/O, scales to 10k+ note vaults.

**Negative**:

- Tool count grows 30 → 34 (`CLAUDE.md` count note bumps in PR #1). Within comfortable bounds for Claude Desktop / Cursor / Cline tool-list rendering but non-zero.
- The union value type is intentionally **not** mixed-type lists — a frontmatter list with both numbers and strings cannot round-trip through `set_note_property`. Spec accepts the trade-off; the bulk-replace `patch_vault_file` path remains available for those edge cases.
- `value: null` → delete redirect is documented behaviour but depends on MCP clients passing `null` consistently (not coerced to missing arg). Flagged as an "open item" in the spec; pinned by unit test at implementation time.
- `limit=500` default on `list_property_values` is a heuristic; vaults with >500 distinct values for a single key will see `truncated: true` and need to pass a higher limit. Acceptable — the wrapper tells them so explicitly.

**Neutral**:

- Coexists with `patch_vault_file targetType:"frontmatter"`: the latter remains the path for replacing the whole block, the new tools are the path for single-key ops. Two paths, two purposes; the `.describe()` docs make the choice clear.
- Naming `note_property` (not `frontmatter_property`, not `yaml_property`) is semantic: agents reason about "the note's properties" the same way Obsidian's UI labels them.

## References

- Spec: `docs/design/2026-05-20-frontmatter-properties-and-periodic-notes.md` (Module D)
- Repo pattern: `packages/obsidian-plugin/src/features/mcp-tools/tools/renameHeading.ts`, `listTags.ts`, `getRecentFiles.ts`
- `ToolRegistry`: `packages/obsidian-plugin/src/features/mcp-tools/` — boolean string-coercion centralised
- `CLAUDE.md` — Tool registration pattern; Gotchas (boolean serialisation)
- Obsidian API: `app.fileManager.processFrontMatter(file, cb)`, `app.metadataCache`
- ADR-0002 — Periodic notes (sister module, ships as PR #2 after this lands)
