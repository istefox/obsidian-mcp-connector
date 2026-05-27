# ADR-0002 — Daily / periodic notes tools (Module C)

- **Status**: Accepted
- **Date**: 2026-05-20
- **Shipped**: v0.6.0 (PR #159 `feat/periodic-notes` → `main`)
- **Scope**: PR #2 / `feat/periodic-notes` — 3 new MCP tools + 1 detector service

## Context

Daily notes are the **single most common Obsidian workflow**: open today's note, append a bullet, move on. Today the only path for an MCP agent to do this is `execute_template` with foreknowledge of the user's path pattern (`Daily/{{date:YYYY-MM-DD}}.md` or whatever they configured) plus a Templater template that knows how to create one. Periodic variants (weekly review, monthly retrospective) are even more friction.

Two coupled design choices:

1. **Tool surface + date semantics** — is it one generic tool (`get_or_create_periodic_note(period, date?)`) or a split where daily gets a dedicated pair? How is `date?` expressed across periods (daily, weekly, monthly, quarterly, yearly)?
2. **Plugin dependency** — the official **Daily Notes** core plugin and the community **Periodic Notes** plugin each carry the user's folder / format / template configuration. They may be **both on, one on, or both off**. Do we ignore them and impose our own defaults? Read their config but reimplement creation? Or delegate to their API?

Constraints (`CLAUDE.md`): never touch the vault filesystem directly from a handler — go through Obsidian APIs so the metadata cache stays coherent, file locks on open notes are respected, and other plugins (Templater, Dataview) can hook in. Setup contract: features must not throw on missing dependencies; return `{ success: false, error }` and let the rest of the plugin load.

## Decision

### Tool surface — 3 tools

- `get_or_create_daily_note(date?) → { path, content, created }` — `date?` is ISO `YYYY-MM-DD`, default today (server-local timezone). Daily is ~90% of the read/create workflow, so it keeps a dedicated shortcut.
- `append_to_periodic_note(period?, content, date?, underHeading?) → { path, appended }` — `period?` defaults to `"daily"`; auto-creates the note if missing; `underHeading?` reuses the existing heading-walker from `patch_vault_file`; default is end-of-file append. **Revised post-#160** (was `append_to_daily_note`): generalised to all periods so weekly/monthly/quarterly/yearly notes get a one-call append too, while the `period="daily"` default keeps the common case ergonomic.
- `get_or_create_periodic_note(period, date?) → { path, content, created }` — `period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly"`.

The minor asymmetry (two get/create tools — daily-dedicated + generic — but one generalised append) is deliberate: daily get/create is the dominant case and earns its shortcut, while a single `append_to_periodic_note` with a `daily` default covers the common append without a second tool.

### Date format — ISO 8601 strict, period-specific

| Period | Format | Example |
|---|---|---|
| daily | `YYYY-MM-DD` | `2026-05-20` |
| weekly | `YYYY-Www` (ISO week) | `2026-W21` |
| monthly | `YYYY-MM` | `2026-05` |
| quarterly | `YYYY-QN` | `2026-Q2` |
| yearly | `YYYY` | `2026` |

Validated by ArkType regex at the boundary. Default = the period instance containing **today in the plugin process timezone**. In the in-process / desktop deployment that is the user's own machine (the 99% case). For headless / multi-host setups where the MCP server runs on a different host than the Obsidian client, an explicit `date` argument is the prescribed way to avoid TZ-driven off-by-one resolution. Documented in each tool's `.describe()`.

### Plugin handling — graceful, delegate to plugin API when present

A `services/periodicNotesDetector.ts` (unit-tested independently) reads at call time:

- `app.internalPlugins.plugins["daily-notes"]` (core Daily Notes)
- `app.plugins.plugins["periodic-notes"]` (community Periodic Notes)

Behaviour matrix:

| State | Behaviour |
|---|---|
| Daily Notes ON | Folder + format + template read from its config; creation via Daily Notes' API so the user's template (incl. `{{date}}` / `{{title}}` interpolations and Templater hooks) runs. |
| Daily Notes OFF, Periodic Notes ON | Periodic Notes covers daily too — same API delegation. |
| Both OFF | Fallback: folder = vault root, format = ISO 8601 strict, template = empty file. Documented in each tool's `.describe()`. |
| Daily ON, Periodic OFF | Daily uses Daily Notes API; weekly/monthly/quarterly/yearly fall back to root + ISO + no template. |

We do **not** second-guess the plugin's API — if it returns the wrong note during a user setting race, that's its problem to fix, not ours.

## Alternatives considered

1. **One generic tool only** `get_or_create_periodic_note(period, date?)` — drop `get_or_create_daily_note` and `append_to_daily_note`. **Rejected**: daily is ~90% of the workflow (per spec); making the agent specify `period: "daily"` on every call is friction at the wrong layer. Analogue to `getActiveFile` vs `getVaultFile` — the common case earns its own shortcut. Three tools is cheaper than the cognitive tax of one over-general one.

2. **Five split tools** (one per period). **Rejected**: weekly/monthly/quarterly/yearly are low-frequency variants of the same operation; collapsing them behind a `period` discriminator keeps the surface tight. The asymmetry (daily dedicated, rest collapsed) tracks real usage frequency, not aesthetic uniformity.

3. **Relative date aliases** (`"today"`, `"yesterday"`, `"last-week"`, `"this-month"`). **Rejected**: ambiguous (timezone? "yesterday" at 00:30 local?), not validatable by a regex, leak server-clock assumptions into the agent contract. ISO 8601 strict is unambiguous, parseable by ArkType, and the model can compute it from a clock context just as easily.

4. **Roll our own folder/format/template logic** ignoring the plugins. **Rejected**: would create two sources of truth — a user with Daily Notes ON and our tool installed would get two different daily notes for the same date (Obsidian UI creates one path, MCP tool creates another). Vault metadata-cache integrity and user trust both lose.

5. **Read plugin config but reimplement creation in-house** (avoid the dependency on the plugin's API surface). **Rejected**: misses template interpolation (Daily Notes runs the configured template engine, including Templater hooks if present); reimplementing template execution would duplicate logic the plugin already owns and inevitably drift. The plugin's API is the source of truth; we call it.

6. **Add Periodic Notes plugin as a hard dependency** (require it installed). **Rejected**: violates the feature-setup contract — features must degrade gracefully; forcing a community plugin install on users who only want daily-note ergonomics is unacceptable; the fallback (ISO + root + no template) is a coherent vanilla baseline.

7. **A dedicated `patch_periodic_note`** (heading/block/frontmatter replace/prepend/append), surfaced from a prior production implementation in #160. **Rejected**: the cited workflows compose with tools that now exist on `main` — *set a monthly-note frontmatter field* (`status: reviewed`) → `get_or_create_periodic_note` then **`set_note_property`** (single-key atomic, ADR-0001 / Module D); *replace under a weekly `## Highlights`* → `patch_vault_file(targetType:"heading", operation:"replace")`; *block edits* → `patch_vault_file(targetType:"block")`. A `patch_periodic_note` would duplicate `patch_vault_file` + `set_note_property` and add only inline path-resolution. Note the timing: when this ADR was first written the only frontmatter write path was whole-block `patch_vault_file`; Module D's `set_note_property` landed in between and is what makes the compose path clean. The two-call cost (resolve path, then patch) is sub-10 ms in-process. Documented as the prescribed pattern in `get_or_create_periodic_note`'s `.describe()`.

8. **A `format: "json"` option on the periodic get** (parsed frontmatter + tags + stat in one call), also from #160. **Rejected**: `get_vault_file(path, format:"json")` already returns exactly that shape; `get_or_create_periodic_note` → `get_vault_file(format:"json")` composes it without duplicating the structured-read logic.

The underlying asymmetry #160 raises — daily had an append shortcut while the other periods and all structured writes had none — is resolved by (a) generalising append to all periods (see Decision) and (b) routing structured writes through `set_note_property` / `patch_vault_file` on the resolved path, not by adding period-specific patch/read variants.

## Consequences

**Positive**:

- Agents do "open today's daily note, append a bullet" in one tool call without knowing the user's folder layout.
- Template interpolations (incl. Templater) Just Work when the user's plugins are configured — the MCP path produces the same note the Obsidian UI would.
- Detector centralises plugin-state introspection; future periodic-aware tools (`list_periodic_notes`, `archive_old_dailies`) reuse it.
- Graceful fallback means a vanilla Obsidian install (no Daily/Periodic Notes plugins) still gets working tools, just with ISO defaults — predictable, documented.

**Negative**:

- ISO week numbers (weekly period: `YYYY-Www`) require the model to think about ISO 8601 week-of-year, which it occasionally gets wrong (off-by-one on year boundaries). Mitigation: ArkType regex rejects malformed input loudly (`errorCode: "invalid_date_for_period"`), and the model can default to "current period" by omitting `date?`.
- Daily note discovery when the user has a **custom non-ISO format** (e.g. `DD-MM-YYYY`) only works **with the plugin enabled** — the detector reads the format setting and matches. Without the plugin, only ISO is recognised; a pre-existing custom-format daily note would be invisible and the tool would create a duplicate at the ISO path. Acceptable: the precondition is documented; users with custom formats are by definition users who have the plugin.
- Test plan splits: unit tests mock the plugin API; integration tests need a real plugin installed in the test vault; manual smoke through the TEST vault covers the live path. Adds a real-plugin path to the integration matrix.
- Plugin API races (user toggles the format mid-call) are explicitly out of scope — single source of truth is the plugin, we don't add defensive logic.

**Neutral**:

- `obsidian-daily-notes-interface` may need to be added as a `dependencies` entry if not already transitively present (verified during implementation, per spec). Small, well-maintained, used by Periodic Notes itself — low supply-chain risk.
- 4 → 7 added tools after both PRs (30 + 4 + 3 = 37 total). Bumped in `CLAUDE.md` tool-count note during PR #2.
- `append_to_daily_note` with non-existent `underHeading` errors the same way `patch_vault_file` does today — consistent surface for heading-walker failures. Specifically: if the daily note had to be **auto-created in the same call** and its rendered template does not contain the requested heading, the call still returns `errorCode: "heading_not_found"` and the **auto-created file is left in place** (no rollback). The file's existence is the right end-state regardless of whether this particular append landed; the model adds the heading and retries.

## References

- Spec: `docs/design/2026-05-20-frontmatter-properties-and-periodic-notes.md` (Module C)
- ADR-0001 — Atomic frontmatter property tools (sister module, ships as PR #1 first)
- Obsidian APIs: `app.internalPlugins.plugins["daily-notes"]`, `app.plugins.plugins["periodic-notes"]`
- External dep candidate: [`obsidian-daily-notes-interface`](https://github.com/liamcain/obsidian-daily-notes-interface)
- Feature-setup contract: `.clinerules` (feature `index.ts` setup signature)
- Repo pattern: `packages/obsidian-plugin/src/features/mcp-tools/tools/getActiveFile.ts` (analogue for the daily-dedicated shortcut shape)
