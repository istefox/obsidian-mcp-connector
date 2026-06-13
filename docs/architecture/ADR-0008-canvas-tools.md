# ADR-0008: Canvas Tools (v1)

- **Status**: Accepted
- **Date**: 2026-06-13
- **Target release**: 0.18.0
- **Scope**: 3 new MCP tools: `get_canvas`, `add_canvas_node`, `connect_canvas_nodes`. Tool count +3.

---

## Context

`.canvas` files are JSON documents following the open JSON Canvas spec
(`{ nodes: [], edges: [] }`). Today they are accessible only as raw text
via `get_vault_file`. No tool exposes the graph structure or allows
structured mutations (adding nodes and edges). An agent that wants to
build or inspect a canvas must parse the raw JSON itself, generate valid
ids, avoid coordinate collisions, and serialize back. That work belongs
in the server.

v1 adds the minimum useful read + write surface:

- `get_canvas`: read a canvas as a structured graph.
- `add_canvas_node`: append one `text`, `file`, or `link` node; creates
  the canvas file if it does not exist.
- `connect_canvas_nodes`: append one edge between two existing node ids.

Group nodes, node update/delete, edge delete, and a dedicated
`create_canvas` tool are deferred to v2 (the SPEC documents the exact
out-of-scope list).

Three design questions required explicit decisions before implementation:

1. **Round-trip fidelity**: how are unknown/extra fields on existing nodes
   and edges handled across a write cycle?
2. **Auto-placement**: when `x`/`y` are omitted from `add_canvas_node`,
   how is the new node positioned?
3. **Service boundary**: where does canvas parse/serialize/id logic live?

---

## Decision

### Architecture: service + three colocated tool pairs

```
packages/obsidian-plugin/src/features/mcp-tools/
  services/
    canvasDocument.ts        ← new service: parse, serialize, id-gen, placement
    canvasDocument.test.ts   ← unit tests for service in isolation
  tools/
    getCanvas.ts             ← new tool
    getCanvas.test.ts
    addCanvasNode.ts         ← new tool
    addCanvasNode.test.ts
    connectCanvasNodes.ts    ← new tool
    connectCanvasNodes.ts
```

One edit to `index.ts` (5 imports + 3 `registry.register` calls under a
new `// Canvas` comment block). One edit to `toolAnnotations.ts` (3 new
entries). No new external dependencies; the JSON Canvas spec is
implemented directly against the vault JSON.

### Decision 1 (round-trip fidelity): spread-preserve, never re-model

**Decision:** parse with `JSON.parse`; treat the document as a plain
object tree. When mutating (add node, add edge), spread the existing node
array and append the new entry. Never re-serialize by reconstructing
objects from modeled fields. Serialize back with `JSON.stringify(doc, null, 2)`
(2-space indent, matching Obsidian's on-disk format).

**Rationale:** re-modeling would silently drop any field not listed in the
v1 schema: styling, custom extensions, future spec additions. A canvas
hand-made in Obsidian must survive a tool write unchanged except for the
appended node or edge. This is the same constraint the SPEC states
explicitly ("modeled-only re-serialization is rejected").

**Consequence:** the TypeScript type for a node is an intersection of the
modeled fields and an index signature (`Record<string, unknown>`) so the
spread is typed correctly without casting. The service never touches
unknown fields; they ride through opaque.

### Decision 2 (auto-placement): right-of-extent, row-wrap at 3200 px

**Decision:** compute the bounding box of all existing nodes (max `x +
width`). Place the new node immediately to the right with a fixed gap of
32 px. When no nodes exist (empty canvas), place at `(0, 0)`. When the
accumulated row width exceeds 3200 px, start a new row below the current
tallest node (gap 32 px vertically). Vertical center-alignment to the
tallest node in the current row is not attempted (v1 simplicity). Explicit
`x`/`y` in the request bypass all placement logic.

Per-type default sizes: `text` 400×200, `file` 400×300, `link` 400×200.
These match Obsidian's default canvas node dimensions.

**Rationale for row-wrap threshold:** Obsidian renders the canvas on a
2D infinite plane; 3200 px covers ~8 default-width nodes per row before
wrapping, which keeps a growing canvas scannable without manual reflow.
The value is a named constant (`CANVAS_ROW_WRAP_WIDTH`) in the service so
it can be adjusted without hunting through logic.

**Alternative considered (grid):** place nodes in a fixed grid (n
columns, auto-row). Rejected because the column count is arbitrary and
produces awkward layouts when a canvas already has manually positioned
nodes that don't align to the grid origin.

### Decision 3 (service boundary): `canvasDocument.ts` owns all canvas logic

**Decision:** a single new service `canvasDocument.ts` exposes five pure
or near-pure functions:

- `parseCanvas(raw: string): CanvasDocument | null`: parse and validate
  top-level shape; returns `null` on malformed JSON or missing required
  fields.
- `generateNodeId(existing: string[]): string`: 16-char lowercase hex,
  retry until unique.
- `computePlacement(nodes: CanvasNode[], opts: PlacementOpts): Rect`:
  auto-placement logic.
- `buildEmptyCanvas(): CanvasDocument`: `{ nodes: [], edges: [] }`.
- `serializeCanvas(doc: CanvasDocument): string`: `JSON.stringify` with
  2-space indent.

Tool handlers do: resolve file, read, call `parseCanvas`, mutate, call
`serializeCanvas`, write. They do not contain any JSON or placement logic.
This mirrors the `patchHelpers.ts` / `headingRename.ts` pattern.

**Alternative considered (inline in handler):** put parse/placement in
each handler. Rejected: the three handlers share parse, id-gen, and
serialize; inlining triplicates it and makes the logic untestable in
isolation.

---

## Alternatives considered

### Alternative A: Operate on raw JSON string in handlers (no service)

Each handler calls `JSON.parse` / `JSON.stringify` and runs placement
inline. No new service file.

**Rejected.** Parse + id-gen + auto-placement are shared by at minimum
two of the three handlers. Inlining duplicates logic that is
independently unit-testable. The existing codebase already extracts
shared helpers into services for this reason (`patchHelpers`, `headingRename`,
`periodicNotesDetector`). Consistency and testability both point to a service.

### Alternative B: Typed canvas model with strict schema (no index signature)

Parse canvas JSON into a typed `CanvasNode` union discriminated by `type`,
dropping unknown fields at parse time. Re-serialize from the typed model.

**Rejected.** Dropping unknown fields violates round-trip fidelity. A
canvas that has been styled in Obsidian (e.g. custom `color`, or fields
from a future spec revision) would silently lose data after any write.
The SPEC explicitly rejects this approach.

### Alternative C: Add a `create_canvas` tool instead of implicit creation

Make `add_canvas_node` require the canvas to already exist, and add a
separate `create_canvas` tool.

**Rejected.** The SPEC explicitly defers `create_canvas` to v2 and
requires `add_canvas_node` to create-if-missing (consistent with
`append_to_vault_file`'s create-if-missing behaviour). A two-step
create-then-add is worse UX for an MCP client and adds a round-trip
without benefit.

---

## Consequences

### Positive

- Agents can inspect canvas graphs and extend them without raw JSON
  manipulation.
- Round-trip fidelity means tool-written canvases open in the Obsidian
  Canvas editor without data loss.
- The service is independently unit-testable; placement, id-gen, and
  parse/serialize can be exercised without a vault mock.
- Follows the existing tool/test/service pattern exactly; the codebase
  stays consistent.

### Negative

- `add_canvas_node` is non-idempotent by spec decision: calling it twice
  with the same arguments produces two nodes. Clients must track returned
  ids if they need to de-duplicate.
- Last-write-wins on concurrent edits (consistent with all other vault
  write tools, but worth documenting).
- Auto-placement is intentionally simple (right-of-extent, row-wrap). It
  may produce suboptimal layouts for canvases with many manually
  repositioned nodes; no reflow of existing nodes is done.
- `group` node type is readable (passed through in `get_canvas`) but not
  creatable. An `add_canvas_node` call with `type: "group"` is rejected
  by the ArkType schema (union excludes `"group"`), which is intentional
  but may surprise users of the raw API.

### Neutral

- `get_canvas` truncates long `text`-node content with a `textTruncated:
  true` flag. The truncation cap is a named constant; the full text is
  accessible via `get_vault_file` on the same path.
- The three tools add 3 entries to `TOOL_ANNOTATIONS` and 3
  `registry.register` calls; no structural changes to the registry or
  composition root.

---

## References

- JSON Canvas open spec: <https://jsoncanvas.org/>
- SPEC.md (this repo): `SPEC.md`, Canvas tools v1
- Existing pattern reference: `appendToVaultFile.ts`, `patchHelpers.ts`
- MCP tool annotations: `toolAnnotations.ts` (PR #276)
