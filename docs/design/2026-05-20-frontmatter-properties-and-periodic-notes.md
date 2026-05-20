# 2026-05-20 — Frontmatter properties (D) + periodic notes (C) — design

Spec for two independent tool families to be shipped as two sequential PRs.
Decisions in this document were brainstormed in interview form on 2026-05-20.
No production code is written from this document directly — the implementation
plan lives in a separate file produced by `superpowers:writing-plans`.

## Goals

Add two tool families that close concrete usability gaps the current 30-tool
surface leaves open:

1. **D — atomic frontmatter properties.** First-class get/set/delete on a
   single YAML key, plus vault-wide value enumeration. Today, modifying a
   single key requires `patch_vault_file targetType:"frontmatter"` which
   replaces the entire block — clumsy and risk-prone for agents.

2. **C — daily/periodic notes helpers.** Ergonomic creation/append on
   daily, weekly, monthly, quarterly and yearly notes — the single most
   common Obsidian workflow, currently reachable only via
   `execute_template` with path-pattern knowledge.

## Out of scope

- Bulk write (`set_note_properties(path, {...})`) — deferred until soak
  signals demand. Per-call latency is sub-10 ms in-process; the multi-key
  case is uncommon enough that YAGNI applies.
- Append-to-list-idempotent (`append_to_note_property_list`) — same reason.
- Periodic note rename / delete — out of scope; daily notes are not
  special once they exist, the existing `rename_vault_file` /
  `delete_vault_file` already cover the case.
- Recent-changes feed, Canvas tools, MCP `resources` capability — these
  were the other candidates considered in the same brainstorm. Not blocked
  by this spec; can be sequenced after.

## Stack

Same as the rest of the plugin (no new runtime deps for D; C may pull
`obsidian-daily-notes-interface` if not already transitively present —
verified during implementation).

- TypeScript 5 strict, `verbatimModuleSyntax: true`
- ArkType for boundary validation
- `bun:test` (native)
- Registered via the shared `ToolRegistry` — no direct SDK calls

## Architecture

Both modules add files under
`packages/obsidian-plugin/src/features/mcp-tools/tools/`, following the
established pattern (one file per tool, schema + handler + types,
unit-tested next to the source). No new feature module under `features/`
is required.

Tool registration is wired in
`packages/obsidian-plugin/src/features/mcp-tools/index.ts` — a single
edit per PR.

```
mcp-tools/tools/
├── getNoteProperty.ts          (PR #1 / D)
├── setNoteProperty.ts          (PR #1 / D)
├── deleteNoteProperty.ts       (PR #1 / D)
├── listPropertyValues.ts       (PR #1 / D)
├── getOrCreateDailyNote.ts     (PR #2 / C)
├── appendToDailyNote.ts        (PR #2 / C)
└── getOrCreatePeriodicNote.ts  (PR #2 / C)
```

## Module D — atomic frontmatter properties

### Tool surface (4 tools, atomic)

Naming uses `note_property` (semantic, concise). Coexists with the
existing `patch_vault_file targetType:"frontmatter"` — the latter remains
the path for replacing the entire FM block; the new tools are the path
for single-key ops.

#### `get_note_property(path, key) → value | null`

- `path: string` — vault-relative
- `key: string` — top-level YAML key
- Returns the raw value preserving native type (string, number, boolean,
  list, or `null` if the key does not exist on this note).
- File not found → `errorCode: "file_not_found"`.
- Frontmatter missing on the file → returns `null` (not an error — the
  key cannot exist if there is no FM, that is the same as "key absent").
- Frontmatter malformed (YAML invalid in Obsidian's parser) → error
  identical in shape to `get_vault_file_partial mode:"frontmatter"`.

#### `set_note_property(path, key, value)`

- `value: string | number | boolean | string[] | number[]` — ArkType union.
  Date values are passed as ISO 8601 strings (Obsidian YAML does not type
  them natively).
- File missing FM block → block is auto-initialised at the file head, like
  `patch_vault_file` already does for missing headings.
- `value === null` → semantically equivalent to `delete_note_property`
  (documented in `.describe()`, redirects internally — zero-friction for
  agents that compute a "clear this field" intent).
- YAML-illegal key characters (`:`, `\n`, leading `#`, etc) → pre-validated,
  `errorCode: "invalid_key"`.
- Atomic on disk via `app.fileManager.processFrontMatter(file, cb)`.

#### `delete_note_property(path, key)`

- Idempotent: key absent → no-op success.
- File missing → error (`file_not_found`).
- Same `processFrontMatter` atomic path.

#### `list_property_values(key, folder?, limit?=500) → wrapper`

```
{
  values: Array<{ value: <native type>, count: number }>,
  truncated: boolean,
  totalDistinct: number,
}
```

- Iterates `app.metadataCache` in-memory (no file I/O).
- `folder?` filters results to files whose path starts with that prefix
  (slash-normalised, same convention as `list_vault_files`).
- `limit` defaults to 500 distinct values. If the underlying set is
  larger, results are truncated to the top-`limit` by count, descending;
  `truncated: true` and `totalDistinct` lets the agent decide whether
  to refine.
- Preserves native types in `value` so number/string distinction is not
  lost (a frontmatter `priority: 5` returns `value: 5` not `"5"`).

### Edge cases (D)

| Case | Behaviour |
|---|---|
| File path traverses out of vault | Rejected by Obsidian's `vault.getAbstractFileByPath` (returns null) → `file_not_found`. |
| Key is empty string | `invalid_key`. |
| Set on note containing only `---\n---\n` (empty FM block) | `processFrontMatter` re-emits the block with the new key — supported. |
| Concurrent edit by user while set runs | `processFrontMatter` re-reads-then-writes inside a single atomic operation per Obsidian; no extra serialisation needed at the tool level. |
| `list_property_values` with `key="tags"` (special-cased by Obsidian) | Returns the union of frontmatter `tags`/`tag` arrays; inline `#tags` are out of scope here (use `list_tags`). |

## Module C — daily / periodic notes

### Tool surface (3 tools)

#### `get_or_create_daily_note(date?) → { path, content, created }`

- `date?: string` — ISO `YYYY-MM-DD`. Default: today in the **plugin
  process timezone**, which in the in-process / desktop deployment is
  the user's own machine TZ (the 99% case). In a headless or
  multi-host setup where the MCP server runs on a different host than
  the Obsidian client, an explicit `date: YYYY-MM-DD` should be passed
  to avoid TZ-driven off-by-one errors. Documented verbatim in
  `.describe()`.
- Returns the existing note if present, otherwise creates it and returns
  the new file. `created: boolean` reflects which path was taken.

#### `append_to_daily_note(content, date?, underHeading?) → { path, appended }`

- `content: string` — markdown to append.
- `date?` as above.
- `underHeading?: string` — if provided, appends inside that heading's
  section (reuses the existing `patchActiveFile` heading walker). Default:
  end-of-file append (like `append_to_vault_file`).
- If the daily note does not exist, it is auto-created first (same path as
  `get_or_create_daily_note`).
- **`underHeading` resolution on an auto-created daily**: if the freshly
  created file (empty or rendered from template) does not contain the
  requested heading, the tool returns `errorCode: "heading_not_found"`.
  The auto-created file is **left in place** (no rollback) — its
  existence is the right end state regardless of whether this single
  append landed. The model can then add the heading (`patch_vault_file`
  or a subsequent `append_to_daily_note` without `underHeading`) and
  retry. Strict-by-default, no silent end-of-file fallback (consistent
  with `patch_vault_file targetType:"heading"`).

#### `get_or_create_periodic_note(period, date?) → { path, content, created }`

- `period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly"`.
- `date?` is ISO 8601 strict, period-specific:
  - daily → `YYYY-MM-DD`
  - weekly → `YYYY-Www` (ISO week)
  - monthly → `YYYY-MM`
  - quarterly → `YYYY-QN`
  - yearly → `YYYY`
- Default: the period instance containing today.

### Plugin handling — graceful

A small detector reads at call time:

- `app.internalPlugins.plugins["daily-notes"]` — built-in Daily Notes
- `app.plugins.plugins["periodic-notes"]` — community Periodic Notes

| Plugin state | Behaviour |
|---|---|
| Daily Notes ON | Folder, date format, template all read from its config. Creation via `createDailyNote(date)` so template + interpolations (`{{date}}`, `{{title}}`, etc) are applied. |
| Daily Notes OFF, Periodic Notes ON | Periodic Notes covers daily too — same path via its API. |
| Both OFF | Fallback defaults: folder = vault root, format = ISO 8601 strict, template = none (empty file). Documented in `.describe()`. |
| Daily ON, Periodic OFF | `period: "weekly"|"monthly"|...` falls back to fallback defaults (root, ISO format, no template). Daily continues to use the Daily Notes plugin. |

The detector is exported as `services/periodicNotesDetector.ts` and
unit-tested independently.

### Edge cases (C)

| Case | Behaviour |
|---|---|
| `date` malformed for the chosen period (e.g. `2026-W99`) | Pre-validated by ArkType regex; `errorCode: "invalid_date_for_period"`. |
| Daily note exists with custom non-ISO format the plugin generates | Detector reads the plugin's format setting and matches. Without the plugin, only ISO is recognised. |
| Plugin returns the wrong note (race during user setting change) | Out of scope — single source of truth is the plugin's API; we don't second-guess. |
| `append_to_daily_note` with `underHeading` that doesn't exist (existing daily) | Error from the heading walker (same as `patch_vault_file` today). |
| `append_to_daily_note` with `underHeading` that doesn't exist (auto-created daily, this call) | `errorCode: "heading_not_found"`; auto-created file is **not** rolled back. Model adds heading + retries. |
| User disables the Daily Notes plugin **after** notes have been created with its custom format | Subsequent calls without the plugin fall back to ISO format → may create a second note that day with the ISO path while the custom-format note is orphaned. Documented; not auto-recovered. Recommend re-enabling the plugin to keep continuity. |
| Template that calls Templater | Daily Notes API uses the configured template engine; if Templater is configured + enabled, it runs. If template references undefined variables, the plugin handles it. Out of our hands. |

## Tool count after both PRs

30 (current) + 4 (D) + 3 (C) = **37 tools**. Within comfortable bounds for
Claude Desktop / Cursor / Cline tool-list rendering. CLAUDE.md tool count
note bumped in PR #2's CLAUDE.md update.

## Test plan (strict)

Per tool, baseline:

- Unit happy path (1+ test).
- Edge cases enumerated in this spec — at least 2 per tool, more where the
  table above lists multiple.
- Integration test against a tmpdir vault with FM fixtures (per the
  existing test-setup pattern; see `test-setup.ts`).
- Manual smoke through Claude Desktop on the vault TEST.

In addition:

- **Soak proattivo**: pre-release BRAT branch posted to folotp +
  marcoaperez before merge, with a structured ask (chain-discriminator
  per `Soak preflight` in CLAUDE.md, plus the per-tool happy + edge
  list). Wait 1–2 days for feedback before merge.
- **CI green** including the `build-smoke` job that the PR #150 cycle
  added.

## Shipping plan

**PR #1 — D (`feat/note-properties`)**

- 4 new tool files + tests
- 1 edit to `mcp-tools/index.ts` (registration)
- CLAUDE.md tool count update (30 → 34)
- CHANGELOG `[Unreleased]` entry under `### Added`
- Soak proattivo, merge after.

**PR #2 — C (`feat/periodic-notes`)**

- 3 new tool files + tests
- 1 new service (`periodicNotesDetector.ts`) + tests
- 1 edit to `mcp-tools/index.ts`
- CLAUDE.md tool count update (34 → 37)
- CHANGELOG `[Unreleased]` entry under `### Added`
- Starts after PR #1 soak closes (assimilates any feedback pattern).

Both target `main` directly via PR (per `main-strict` ruleset). No
intermediate release branch — release cut is a separate, later step that
will bundle the new code with any other accumulated changes.

## Success criteria

- All 7 tools registered, schema-valid, callable from at least one MCP
  client (manual smoke).
- Per-tool tests pass under `bun test` in each package.
- `bun run check` green across the workspace.
- Soak round closes with zero unresolved blockers from folotp +
  marcoaperez.
- CHANGELOG and CLAUDE.md are in sync with the new tool count and the
  new entries.

## Open items (resolve during implementation, do not re-design)

1. `set_note_property` with `value: null` redirect to delete — confirmed
   in this spec; double-check no MCP client serialises `null` differently
   from "missing arg". Same scrutiny for boolean values vs the
   ToolRegistry boolean-string coercion (CLAUDE.md gotcha #1) — when the
   schema is a union with `string` as first alternative, an incoming
   `"true"` should still be coerced to boolean if the agent's intent was
   boolean, but ArkType union resolution may match string first; verify
   and pin behaviour with a unit test.
2. YAML-illegal key char list — finalise the regex in the implementation
   based on the exact behaviour of `processFrontMatter`.
3. Whether `obsidian-daily-notes-interface` is already transitively
   present in `bun.lock`; if not, add as a `dependencies` entry (small,
   well-maintained, used by Periodic Notes itself).
