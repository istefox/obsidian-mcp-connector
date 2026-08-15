import { TFile, type App } from "obsidian";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { PromptFrontmatterSchema } from "shared";
import { logger } from "$/shared/logger";
import type {
  PromptListEntry,
  PromptRegistry,
} from "$/features/mcp-transport/services/promptRegistry";
import { discoverPrompts } from "./services/promptDiscovery";
import { renderPrompt } from "./services/promptRenderer";
import { expandEmbeds } from "./services/promptTransclusion";
import { createVaultWatcher, type VaultWatcher } from "./services/vaultWatcher";

export type PromptsFeatureState = {
  watcher: VaultWatcher;
  /**
   * Cancel a pending list-changed comparison. Called from teardown so a save
   * landing during unload cannot fire into a handler that is going away.
   */
  stopNotifier: () => void;
};

/**
 * How long the vault must stay quiet before the prompt list is re-scanned to
 * decide whether anything actually changed.
 *
 * The watcher fires on `modify` as well as create/delete/rename, so every
 * save inside a prompt reaches this path — Obsidian writes while the user is
 * still typing. Without this window the connector would re-scan the vault,
 * and potentially notify, several times per sentence.
 */
const NOTIFY_DEBOUNCE_MS = 500;

/**
 * A stable, order-independent form of the prompt list, for deciding whether
 * anything a client can observe has changed.
 *
 * `discoverPrompts` returns entries in vault iteration order and never sorts,
 * so comparing raw arrays would report a change when two prompts merely swap
 * places. Sorting by name first means only real content differences —
 * a prompt appearing, disappearing, or its description or argument
 * declarations changing — produce a notification.
 */
function canonical(list: PromptListEntry[]): string {
  return JSON.stringify([...list].sort((a, b) => a.name.localeCompare(b.name)));
}

export type PromptsSetupOptions = {
  /**
   * Publish `notifications/prompts/list_changed` (ADR-0017). Optional: the
   * legacy era has no way to deliver one, and the unit tests that only
   * exercise discovery and rendering pass nothing.
   */
  notifyPromptsChanged?: () => void;
  /**
   * Override {@link NOTIFY_DEBOUNCE_MS}. Same escape hatch as the semantic
   * indexer's `debounceMs` (`semantic-search/services/indexer.ts`): tests
   * need the comparison to run promptly, and half a second per assertion
   * across a suite is real time spent waiting for a timer.
   */
  debounceMs?: number;
};

export async function setup(
  promptRegistry: PromptRegistry,
  app: App,
  options: PromptsSetupOptions = {},
): Promise<
  | { success: true; state: PromptsFeatureState }
  | { success: false; error: string }
> {
  const { notifyPromptsChanged, debounceMs = NOTIFY_DEBOUNCE_MS } = options;
  try {
    // Memoized discovery: prompts/list used to re-scan every markdown
    // file and cachedRead each candidate on every call. The watcher
    // below invalidates on create/delete/rename/modify under Prompts/.
    // The epoch guard prevents caching a scan that raced an
    // invalidation (event fired while discoverPrompts was running).
    let epoch = 0;
    let cached: { epoch: number; list: PromptListEntry[] } | null = null;
    promptRegistry.setLister(async () => {
      if (cached && cached.epoch === epoch) return cached.list;
      const startEpoch = epoch;
      const list = await discoverPrompts(app);
      if (epoch === startEpoch) cached = { epoch: startEpoch, list };
      return list;
    });

    promptRegistry.setHandler("*", async (name, args) => {
      const path = `Prompts/${name}.md`;
      const abstractFile = app.vault.getAbstractFileByPath(path);
      if (abstractFile === null) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Prompt not found: ${name}`,
        );
      }
      if (!(abstractFile instanceof TFile)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Prompt not found: ${name}`,
        );
      }
      const file = abstractFile;

      const cache = app.metadataCache.getFileCache(file);
      const fm: Record<string, unknown> | undefined = cache?.frontmatter;
      const rawTags = fm?.tags;
      const tagsArray = Array.isArray(rawTags)
        ? rawTags
        : typeof rawTags === "string"
          ? [rawTags]
          : null;

      if (!tagsArray) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Prompt not found: ${name}`,
        );
      }

      try {
        PromptFrontmatterSchema.assert({ ...fm, tags: tagsArray });
      } catch {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Prompt not found: ${name}`,
        );
      }

      const content = await app.vault.cachedRead(file);
      // Transclusion runs after renderPrompt, so `![[{{note}}]]` resolves
      // through an argument value rather than being expanded before the
      // placeholder is known.
      const rendered = renderPrompt(content, args);
      const text = await expandEmbeds(app, file.path, rendered);

      return {
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    });

    // Baseline for the comparison below. Taken once at setup so the first
    // watcher event is judged against the vault as it was at load, not
    // against nothing — otherwise the first save of the session always
    // looks like a change.
    let lastNotified = canonical(await discoverPrompts(app));

    let timer: ReturnType<typeof setTimeout> | null = null;
    const stopNotifier = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const watcher = createVaultWatcher(app, () => {
      // Invalidate the memoized prompt list. This half must stay sync and
      // cheap: it runs on every save inside a prompt.
      epoch += 1;
      cached = null;

      // The other half, and the reason it is deferred rather than done
      // here: deciding whether to notify means re-scanning the vault, which
      // is exactly the cost the memo above exists to avoid paying per event.
      // On the legacy era there is nothing to schedule at all.
      if (!notifyPromptsChanged) return;
      stopNotifier();
      timer = setTimeout(() => {
        timer = null;
        void (async () => {
          try {
            const next = canonical(await discoverPrompts(app));
            // A save that touched neither the description nor the argument
            // declarations changes no byte a client can see, so it is not a
            // list change and must not be announced as one.
            if (next === lastNotified) return;
            lastNotified = next;
            notifyPromptsChanged();
          } catch (error) {
            // A failed re-scan means the next event re-runs the comparison
            // against the same baseline. Losing a notification is a stale
            // list until the client re-lists; throwing out of a timer is an
            // unhandled rejection.
            logger.warn("prompts: list-changed comparison failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
      }, debounceMs);
    });

    return { success: true, state: { watcher, stopNotifier } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function teardown(state: PromptsFeatureState): void {
  state.watcher.stop();
  // Stopping the watcher stops new events, but one comparison may already be
  // scheduled from a save moments ago. Cancel it: its callback publishes onto
  // a handler this teardown is about to close.
  state.stopNotifier();
}
