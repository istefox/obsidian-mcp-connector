# SPEC — Prompt transclusion (#347, first half)

**Status:** Implemented
**Issue:** #347
**Date:** 2026-08-03

## Problem

`promptRenderer.ts` strips frontmatter, strips argument declarations and substitutes `{{arg}}`
placeholders. A prompt cannot include another note's content, so a prompt that refers to notes costs
the model one tool call per note *after* the prompt has already been inserted — and one model
decision each to make those calls at all.

## Scope

The transclusion half of #347 only. `completion/complete` is out of scope and stays open on the
issue; the capability spike (#413) removed its gate without producing evidence for it.

## Contract

### Syntax

| Form | Behaviour |
| --- | --- |
| `![[note]]` | expand whole note |
| `![[note\|alias]]` | expand; alias is display-only and discarded |
| `![[note#Heading]]` | expand the section down to the next heading of the same or a higher level |
| `![[note#^blockid]]` | expand the block's line range, end inclusive |
| anything else | not expanded, marker appended |

Parsing follows the convention already in `mcp-tools/services/headingRename.ts`: split on the first
`#`, then on the first `|` in whichever part carries it. A plain `[[link]]` is not an embed — the
leading `!` is the only thing that distinguishes them. A wikilink never spans a line.

### Ordering

Transclusion runs **after** `renderPrompt`, i.e. after `substituteArgs`.

- `![[{{note}}]]` resolves through an argument value. This is the point: the client picks the note.
- `{{placeholder}}` inside embedded content is left literal and never substituted. An embedded note
  is data, not a template; substituting into it would let any vault note consume the prompt's
  arguments.

Embedded content passes through `stripFrontmatter` and `stripArgDeclarations` — Obsidian never
renders frontmatter in a transclusion, and embedding a shared preamble that is itself a prompt file
must not leak its `<% tp.mcpTools.prompt(…) %>` line.

Heading and block offsets come from `metadataCache` and index the **raw** file, so slicing happens
before frontmatter is stripped. Stripping first would shift every line.

### Failure is visible, never silent

Every non-expansion keeps the original token and appends
`<!-- prompt-transclusion: not expanded (<reason>) -->`. Reasons: `not found`, `not markdown (.ext)`,
`heading not found`, `block not found`, `depth limit 1`, `size budget N bytes`, `embed limit N`,
`no target`.

The token stays useful — the model can follow it with `get_vault_file` — and an HTML comment is
invisible if the text is ever rendered. A dropped embed would be a silent failure in text the model
reads as instructions.

### Limits

| Limit | Value | Rationale |
| --- | --- | --- |
| `MAX_EMBED_DEPTH` | 1 | A depth counter is strictly stronger than cycle detection: a self-embed inlines once and its copy's `![[A]]` stays literal; `A → B → A` inlines `B`'s parent once and stops. No visited set is needed. |
| `MAX_TRANSCLUSION_BYTES` | 32 KB, cumulative over inserted content, first-fit in document order | A prompt body enters the conversation unconditionally — the model never chose to read it — so it warrants a tighter budget than a tool result. Deliberately **not** `mcpTools.maxTextOutputKB`: that is documented as the `get_vault_file` ceiling, the prompts feature has no `plugin` handle (`setup(promptRegistry, app)`), and a user raising it to 10 MB for file reads must not silently uncap prompt payloads. |
| `MAX_EMBED_EXPANSIONS` | 20 per render | Bounds `cachedRead` calls per `prompts/get`. |

Over budget **skips the embed whole, never truncates**. A note cut mid-sentence is worse input than
a pointer, and a truncation would need its own marker anyway. A failed embed does not consume
budget. A body with no embeds is returned byte for byte.

`cachedRead`, matching `promptDiscovery.ts` and `prompts/index.ts`. There is no write path here, so
the stale-cache concern that justifies `vault.read` elsewhere does not apply.

## Files

- `features/prompts/services/promptTransclusion.ts` — new. `parseEmbeds` (pure) and `expandEmbeds`.
- `features/prompts/index.ts` — two lines at the `prompts/get` handler.
- `promptRenderer.ts` — **unchanged**, still pure, sync and `App`-free. Making `renderPrompt` async
  would have spent its zero-fixture test file for nothing, since the only production caller is
  already async and already holds `app`.

Nothing is imported from `features/mcp-tools` and nothing there was exported. `findHeadingSection`
in `getVaultFilePartial.ts` is private and its contract (`::` nested paths, ambiguity error strings
for an `isError` envelope) does not fit a wikilink fragment; a local ~20-line equivalent is cleaner
than exporting a function and using a third of it.

## Known divergences from Obsidian

- `![[note#A#B]]` (nested heading path) is not resolved; falls to `heading not found`.
- An embed inside a code fence **is** expanded, where Obsidian would not. A fence-aware scanner is
  disproportionate for this surface.

Both are documented in `docs/features/prompt-system.md`.

## Verification

28 new tests. Every one names the production mutation that must turn it red; all six mutations were
applied and confirmed red before the change was accepted:

| Mutation | Result |
| --- | --- |
| `index.ts` back to `renderPrompt` alone | 2 fail |
| `!` removed from the embed pattern | 12 fail |
| `stripFrontmatter` before offset slicing | 1 fail |
| budget check removed | 2 fail |
| embed-count guard removed | 1 fail |
| depth marker removed | 1 fail |

Gate: `bun run check && bun test && bun run format:check`, 1692 tests.
