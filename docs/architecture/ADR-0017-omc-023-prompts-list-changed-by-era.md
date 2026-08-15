# ADR-0017: The `prompts.listChanged` capability, split by protocol era

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Stefano Ferri
**Issue:** OMC-023 (Gate B of the 2.0 roadmap)

---

## Context

The server advertises a prompts capability it does not honour, on both protocol eras.

`mcpServer.ts:188` declares `prompts: {}`. `McpServer`'s constructor calls
`setPromptRequestHandlers()` for any declared prompts capability, and that path registers
`prompts: { listChanged: … ?? true }`
(`node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs:1550`). The declared set is
upgraded before anything reads it, so both the legacy `initialize` reply and the 2026
`server/discover` result report `prompts: { listChanged: true }`. Nothing in this codebase has
ever sent `notifications/prompts/list_changed`. The tools equivalent is sent — from
`activateTool.ts:127` on the legacy era, and through `notify.toolsChanged()` on the modern one
since OMC-007 — but there is no prompts twin.

Found during OMC-008 and deliberately not fixed there: declaring `listChanged: false` moves the
legacy `initialize` bytes, which that work's Invariant 1 forbids. It has waited for a release
allowed to move them. This is that release.

### The prompt set is genuinely dynamic

This is the fact that decides the ADR, and it was checked rather than assumed. Prompts are
markdown files under `Prompts/`. `features/prompts/services/vaultWatcher.ts` already watches
`create`, `delete`, `rename` and `modify`, filtered to `Prompts/*.md` non-recursively, and
`features/prompts/index.ts` memoizes discovery behind an `epoch` counter the watcher
invalidates. The set therefore changes while the server runs, and the exact point where a
notification would be published already exists.

So `listChanged: true` is not a false claim about the domain. It is a true claim that was never
wired.

### What the installed SDK actually provides

Verified by reading `@modelcontextprotocol/server@2.0.0`, not from the guide:

- `mcp-DXXb3Vv3.mjs:1550` — `listChanged: this.server.getCapabilities().prompts?.listChanged ?? true`.
  An explicit `false` survives (`false ?? true` is `false`), so retracting is a literal, not a
  fight with the SDK.
- `mcp-DXXb3Vv3.mjs:164` — `if (requested.promptsListChanged === true && allow(capabilities?.prompts?.listChanged)) honored.promptsListChanged = true`.
  Subscription-filter negotiation gates delivery on the same capability bit, so on the modern
  era declaring `true` is what makes the notification deliverable at all.
- `createMcpHandler-CLhGwQTn.d.mts:3759` — `promptsChanged(): void`, the exact twin of
  `toolsChanged()` that OMC-007 wired at `mcpServer.ts:137`.

### The legacy era cannot deliver this notification

The transport is stateless and POST-only; `GET /mcp` returns 405 on purpose, so no
server-initiated stream exists. Notifications ride the caller's own POST response with that
call's `relatedRequestId`, and in the tools case the notification **is caused by** the request it
rides. A vault file event has no request in flight to attach to.

Delivering it anyway would mean queueing the notification and attaching it to some later,
unrelated POST response. No such mechanism exists here — `flushPendingCalls`
(`toolLoadingManager.ts:183`) is a persistence flush for adaptive tool loading, not a
notification queue — and on the modern era that shape is exactly what the conformance check
`sep-2575-http-server-no-independent-requests-on-stream` forbids. This is a constraint of the
architecture, not a question of effort.

## Decision

**Split the capability by era. The modern era declares `listChanged: true` and honours it; the
legacy era declares `listChanged: false`.**

`buildMcpServer(tokenId)` is the single construction site for both eras (ADR-0016), so the
prompts capability becomes a parameter of that site rather than the literal at `mcpServer.ts:188`.

On the modern era, the prompts feature gains an `onPromptsChanged` callback fired from the point
where the watcher invalidates `epoch`, published with one line mirroring `mcpServer.ts:137`:

```ts
onPromptsChanged: () => modernHandler.notify.promptsChanged(),
```

**The notification is emitted only when the discovered list actually differs from the cached
one.** The watcher fires on `modify` as well, and correctly so — the list embeds argument
declarations and the frontmatter description, both derived from the file body (`vaultWatcher.ts`
lines 31-33). But it fires on *every* save, including saves that touch neither. Emitting per
watcher tick would send a notification for every keystroke-debounced write inside a prompt. The
epoch cache is already the comparison point; the cost is one extra discovery per event, paid
against a real vault event rather than per request.

The resulting legacy `initialize` reply is pinned by a test, so whoever reads OMC-008's
Invariant 1 next sees what superseded it rather than re-deriving why the bytes moved.

## Alternatives considered

### A. Retract on both eras — `prompts: { listChanged: false }` everywhere

One literal plus a test, and honest: the server would stop claiming anything it does not do.
Rejected because it gives up something true. The prompt set really does change at runtime, the
modern era really can deliver the notification, and the delivery path was already built by
OMC-007 — so retracting there would discard working infrastructure to avoid writing three lines.
It stays the correct fallback if the modern-era work is ever judged not worth its cost; nothing
in this decision makes A harder later.

### B. Honour on both eras

Rejected on architecture, not on effort. See "The legacy era cannot deliver this notification"
above: there is no server-initiated stream, and no request in flight to carry a vault event.
Inventing a deferred-notification queue to attach unrelated notifications to arbitrary later
responses would add a mechanism this transport has deliberately never had, and would mirror the
exact shape the modern era's conformance suite forbids.

### C. Leave it as it is

Rejected. It is the status quo the issue exists to end: two eras both advertising a capability
neither honours. A client that trusts the bit and waits for a notification waits forever, and
nothing in the wire tells it so.

## Consequences

**Positive.** After 2.0 the server carries no unhonoured capability claim on either era. On the
modern era a client that subscribes with `promptsListChanged: true` is actually told when the
user adds, removes or renames a prompt, instead of discovering it on the next poll. The
notification path is the one OMC-007 already proved end to end, so this adds a caller, not a
mechanism.

**Negative.** The legacy `initialize` reply changes, which is why this could not ship in a minor.
Any client that read `prompts.listChanged` from the handshake and branched on it sees `false`
where it previously saw `true` — a correction, since the notification never came, but a wire
change nonetheless. The prompts capability stops being a shared literal and becomes era-aware
state threaded through `buildMcpServer`, which is one more parameter at the construction site
ADR-0016 keeps deliberately single.

**Neutral.** Conformance does not move. `sep-2575-server-declares-prompts-in-discover` already
passes, and `sep-2575-server-sends-prompts-list-changed-on-subscription` stays a baselined
WARNING: it drives a `test_trigger_prompt_change` fixture tool this project refuses to ship
(ADR-0016, Alternative F), so nothing mutates the prompt list inside the check's window no
matter how good the delivery path is. The baseline entry's reason text needs no edit; its
parenthetical "and nothing here mutates prompts either (OMC-023)" becomes stale on the modern
era and should be corrected when this ships.

## References

- ADR-0016 — two protocol eras on one endpoint; Invariant 1 (legacy bytes) and §8 (the
  `legacy: 'reject'` trigger, Alternative F on fixture tools)
- ADR-0015 — the `tools/list` stability invariant, the same class of reasoning for tools
- OMC-007 (#419, PR #442) — `notify.toolsChanged()` fan-out onto open listen streams, the
  mechanism this decision reuses
- `TODO.md` → `## Roadmap — 2.0`, Gate B
- Spec: https://modelcontextprotocol.io/specification/2026-07-28
