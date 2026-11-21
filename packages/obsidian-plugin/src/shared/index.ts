import type { App } from "obsidian";
import type { SmartConnections, Templater } from "shared";
import type McpToolsPlugin from "src/main";
import { scrubArgumentValues } from "./log/redact";
import { logger } from "./logger";

// Augment Obsidian's App type to include the (undocumented) plugin
// registry. Relocated from the retired mcp-server-install/types.ts —
// shared/index.ts is the primary consumer and is always compiled, so a
// declare-module here applies project-wide (also used by
// mcp-tools/tools/executeTemplate.ts).
declare module "obsidian" {
  interface App {
    plugins: {
      plugins: {
        ["smart-connections"]?: {
          env?: SmartConnections.SmartSearch;
        } & Plugin;
        ["templater-obsidian"]?: {
          templater?: Templater.ITemplater;
        };
      };
    };
  }
}

export interface Dependency<ID extends keyof App["plugins"]["plugins"], API> {
  id: keyof Dependencies;
  name: string;
  required: boolean;
  installed: boolean;
  url?: string;
  api?: API;
  plugin?: App["plugins"]["plugins"][ID];
}

export interface Dependencies {
  "smart-connections": Dependency<
    "smart-connections",
    SmartConnections.SmartSearch
  >;
  "templater-obsidian": Dependency<"templater-obsidian", Templater.ITemplater>;
}

// Smart Connections v3.0+ uses a Smart Environment architecture instead of window.SmartSearch
declare const window: {
  SmartSearch?: SmartConnections.SmartSearch;
} & Window;

// Minimal shape of the Smart Connections v3.0+ plugin instance that we
// rely on at runtime. Keeping it local (rather than exported) avoids
// coupling the shared package to v3 specifics; the wrapper below
// normalises v3 results back into the v2-compatible SmartSearch API.
interface SmartSourcesLookupResult {
  item: {
    path: string;
    name?: string;
    key?: string;
    breadcrumbs?: string;
    link?: string;
    size?: number;
    read: () => Promise<string>;
  };
  score: number;
}

interface SmartConnectionsV3Plugin {
  env?: {
    smart_sources?: {
      lookup: (params: {
        hypotheticals: string[];
        filter: Record<string, unknown>;
      }) => Promise<SmartSourcesLookupResult[]>;
    };
  };
}

/**
 * One look at the Smart Connections plugin as it is right now: v3+ through
 * `env.smart_sources` (wrapped back into the v2 `SmartSearch` shape), else
 * v2 through `window.SmartSearch` or a plugin `env` that exposes a callable
 * `search`. `installed` is true only when a usable API was found.
 */
export function detectSmartConnections(
  plugin: McpToolsPlugin,
): Dependencies["smart-connections"] {
  const smartConnectionsPlugin = plugin.app.plugins.plugins[
    "smart-connections"
  ] as SmartConnectionsV3Plugin | undefined;

  // Check for Smart Connections v3.0+ (uses smart environment)
  const smartSources = smartConnectionsPlugin?.env?.smart_sources;
  if (smartSources) {
    // Create a compatibility wrapper that matches the old SmartSearch interface
    const api: SmartConnections.SmartSearch = {
      search: async (search_text: string, filter?: Record<string, string>) => {
        try {
          // Use the new v3.0 lookup API
          const results = await smartSources.lookup({
            hypotheticals: [search_text],
            filter: {
              limit: filter?.limit,
              key_starts_with_any: filter?.key_starts_with_any,
              exclude_key_starts_with_any: filter?.exclude_key_starts_with_any,
              exclude_key: filter?.exclude_key,
              exclude_keys: filter?.exclude_keys,
              exclude_key_starts_with: filter?.exclude_key_starts_with,
              exclude_key_includes: filter?.exclude_key_includes,
              key_ends_with: filter?.key_ends_with,
              key_starts_with: filter?.key_starts_with,
              key_includes: filter?.key_includes,
            },
          });

          // Transform results to match expected format
          return results.map((result) => ({
            item: {
              path: result.item.path,
              name:
                result.item.name ||
                result.item.key?.split("/").pop() ||
                result.item.key ||
                result.item.path,
              breadcrumbs: result.item.breadcrumbs || result.item.path,
              read: () => result.item.read(),
              key: result.item.key ?? result.item.path,
              file_path: result.item.path,
              link: result.item.link ?? "",
              size: result.item.size ?? 0,
            },
            score: result.score,
          })) as unknown as Awaited<
            ReturnType<SmartConnections.SmartSearch["search"]>
          >;
        } catch (error) {
          // The error text can quote the user's query or filter: scrub
          // both out before the line reaches the log (ADR-0029 D4).
          const args = { search_text, filter };
          logger.error("Smart Connections search failed", {
            error:
              error instanceof Error
                ? {
                    name: error.name,
                    message: scrubArgumentValues(error.message, args),
                    stack: scrubArgumentValues(error.stack ?? "", args),
                  }
                : scrubArgumentValues(String(error), args),
          });
          return [];
        }
      },
    };

    return {
      id: "smart-connections",
      name: "Smart Connections",
      required: false,
      installed: true,
      api,
      plugin:
        smartConnectionsPlugin as App["plugins"]["plugins"]["smart-connections"],
    };
  }

  // Try window.SmartSearch first (works on some platforms for v2.x).
  // `window` is absent outside a renderer (unit tests of the poll).
  let legacyApi =
    typeof window === "undefined" ? undefined : window.SmartSearch;

  // Fallback to plugin system (fixes Linux/cross-platform detection issues).
  // SC v4 removed window.SmartSearch; plugin.env exists but has no search().
  // Guard: only accept env if it exposes a callable search() — otherwise keep
  // legacyApi null so polling continues until the v3 path becomes ready.
  if (!legacyApi && smartConnectionsPlugin?.env) {
    const candidate =
      smartConnectionsPlugin.env as unknown as SmartConnections.SmartSearch;
    if (typeof candidate.search === "function") {
      legacyApi = candidate;
      window.SmartSearch = legacyApi;
    }
  }

  return {
    id: "smart-connections",
    name: "Smart Connections",
    required: false,
    installed: !!legacyApi,
    api: legacyApi,
    plugin:
      smartConnectionsPlugin as App["plugins"]["plugins"]["smart-connections"],
  };
}

export type SmartSearchPollOptions = {
  /**
   * Called on the first tick and whenever `installed` or the callability
   * of `api.search` changes (#676: an API that turns callable while
   * `installed` stays the same must still be reported).
   */
  onNext: (dep: Dependencies["smart-connections"]) => void;
  /** Called once: a usable API was found, the horizon passed, or a tick threw. */
  onComplete: () => void;
  /** Called before `onComplete` when a tick throws. */
  onError?: (error: unknown) => void;
  /** Tick period in ms. Default 200. */
  intervalMs?: number;
  /** Give-up horizon in ms. Default 5000. */
  timeoutMs?: number;
};

function hasCallableSearch(
  api: SmartConnections.SmartSearch | undefined,
): boolean {
  return typeof api?.search === "function";
}

/**
 * Poll for the Smart Connections search API while Obsidian is still
 * loading plugins. Ticks every `intervalMs` up to `timeoutMs`, reports a
 * detection result whenever `installed` or the callability of
 * `api.search` changes (so the first tick always reports, and so does the
 * tick that finds a usable API), and stops right after the first result
 * whose `api.search` is callable. Returns a cancel function for
 * `onunload`: cancelling does not call `onComplete`.
 *
 * The poll is only the fast path for a normal startup. A Smart
 * Connections that exposes its API after the horizon is bound by
 * `startSmartSearchBinding`'s `refresh`, which `search_vault_smart` runs
 * on every call (#676).
 *
 * Plain timers on purpose. This was the one rxjs site in the plugin and
 * carried the whole library (~330 KB unminified) into the bundle.
 */
export function loadSmartSearchAPI(
  plugin: McpToolsPlugin,
  options: SmartSearchPollOptions,
): () => void {
  const intervalMs = options.intervalMs ?? 200;
  const timeoutMs = options.timeoutMs ?? 5000;
  // Never a dep's own key on the first tick, so the first tick reports.
  let lastKey: string | undefined;
  let done = false;

  const stop = () => {
    done = true;
    window.clearInterval(ticker);
    window.clearTimeout(horizon);
  };
  const finish = () => {
    if (done) return;
    stop();
    options.onComplete();
  };

  const ticker = window.setInterval(() => {
    if (done) return;
    let dep: Dependencies["smart-connections"];
    try {
      dep = detectSmartConnections(plugin);
    } catch (error) {
      options.onError?.(error);
      finish();
      return;
    }
    // Not the `api` identity: the v3 branch builds a new wrapper on every
    // detection, so identity would report on every tick.
    const callable = hasCallableSearch(dep.api);
    const key = `${dep.installed}|${callable}`;
    if (key !== lastKey) {
      lastKey = key;
      options.onNext(dep);
    }
    if (callable) finish();
  }, intervalMs);
  const horizon = window.setTimeout(finish, timeoutMs);

  return () => {
    if (!done) stop();
  };
}

export type SmartSearchBindingOptions = Omit<
  SmartSearchPollOptions,
  "onNext"
> & {
  /**
   * The one bind path: assigns the API and re-runs whatever depends on it.
   * Called by the startup poll and by `refresh`.
   */
  bind: (dep: Dependencies["smart-connections"]) => void;
};

export type SmartSearchBinding = {
  /**
   * When `plugin.smartSearch` has no callable `search`, look at Smart
   * Connections once more and, if a usable API is there now, hand it to
   * `bind`. Returns whether `plugin.smartSearch.search` is callable
   * afterwards. A no-op returning false once cancelled.
   */
  refresh: () => boolean;
  /** Stops the startup poll and turns `refresh` into a no-op. */
  cancel: () => void;
};

/**
 * Binds the Smart Connections search API onto `plugin.smartSearch`: the
 * startup poll (`loadSmartSearchAPI`) for the common case, plus an
 * on-demand `refresh` for a Smart Connections that exposes its API only
 * after the poll's horizon, which on a large vault can be a minute or
 * more (#676). Both go through the same `bind`, so a late binding re-runs
 * the `auto` chooser exactly like an early one (#430).
 *
 * `refresh` is called at the time the binding matters, on a
 * `search_vault_smart` call, rather than from a timer that keeps running
 * for the whole session: no reader of `plugin.smartSearch` sits outside
 * that call path, and a vault without Smart Connections pays nothing.
 */
export function startSmartSearchBinding(
  plugin: McpToolsPlugin,
  options: SmartSearchBindingOptions,
): SmartSearchBinding {
  const { bind: bindApi, ...pollOptions } = options;
  let cancelled = false;
  // Whether `bind` has been handed a callable API. Not the same as
  // `plugin.smartSearch.search` being callable now: a v2
  // `window.SmartSearch` can be bound while it has no `search` and gain
  // one later IN PLACE, which makes the bound field callable without
  // `bind` (and the `auto` chooser it re-runs) ever having seen it.
  let boundCallable = false;
  const bind = (dep: Dependencies["smart-connections"]) => {
    boundCallable = hasCallableSearch(dep.api);
    bindApi(dep);
  };
  const cancelPoll = loadSmartSearchAPI(plugin, {
    ...pollOptions,
    onNext: bind,
  });
  return {
    refresh: () => {
      if (cancelled) return false;
      if (boundCallable && hasCallableSearch(plugin.smartSearch)) return true;
      const dep = detectSmartConnections(plugin);
      if (!hasCallableSearch(dep.api)) return false;
      bind(dep);
      return hasCallableSearch(plugin.smartSearch);
    },
    cancel: () => {
      cancelled = true;
      cancelPoll();
    },
  };
}

export * from "./logger";
