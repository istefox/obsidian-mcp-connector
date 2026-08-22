/**
 * Resolves and carries the folder-exclusion policy for one request
 * (ADR-0020 §D7, §D11).
 *
 * Two jobs that belong together:
 *
 * 1. **Resolution.** Read `mcpTools.excludedFolders` and compile it,
 *    with a fail-closed posture that inverts this project's usual
 *    fail-open default (ADR-0014 §1) for reasons §D7 spells out.
 * 2. **Request scope.** Carry the resolved policy across `await`s via
 *    `AsyncLocalStorage`, so the guarded `App` — built once at
 *    composition and closing over nothing — can read the policy in force
 *    for the call it is currently serving.
 *
 * `AsyncLocalStorage` was verified against Obsidian's renderer on
 * 2026-08-19 before this was written: `node:async_hooks` resolves, and a
 * store survives both a `setTimeout` and a promise continuation.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DENY_ALL_POLICY,
  compilePolicy,
  type PathPolicy,
} from "$/shared/pathPolicy";
import { SettingsStore } from "$/shared/settingsStore";
import { logger } from "$/shared/logger";
import type { PluginDataLike } from "$/shared/types";

/** The settings slice and key this provider reads. */
const SLICE = "mcpTools";
const FIELD = "excludedFolders";

/**
 * Resolves the vault-wide policy and scopes it to a request.
 *
 * One instance per plugin load. It is deliberately NOT a module-level
 * mutable "current policy": phase 2 makes the policy per token, and a
 * module global would have two tokens interleaving at an `await` read
 * each other's policy — a bug invisible today and shipped exactly when
 * per-token support lands.
 */
export class PathPolicyProvider {
  private readonly storage = new AsyncLocalStorage<PathPolicy>();
  private readonly store: SettingsStore;

  /**
   * Starts at deny-all, not at "nothing excluded". Before the first
   * successful read there is no basis for believing any folder is safe
   * to serve, and the two failure directions are not symmetric: denying
   * wrongly looks like an empty vault and heals on the next read, while
   * serving wrongly discloses the file and cannot be undone.
   */
  private vaultWidePolicy: PathPolicy = DENY_ALL_POLICY;

  /**
   * True between a failed read and the next successful one. Exists only
   * so the error is logged once per transition rather than on every tool
   * call, which would bury it.
   */
  private failing = false;

  constructor(plugin: PluginDataLike, store?: SettingsStore) {
    this.store = store ?? new SettingsStore(plugin);
  }

  /**
   * Re-read the settings and return the policy now in force.
   *
   * On failure the previous policy is retained, which is what gives
   * §D7's escape hatch its effect without a special case: a vault whose
   * first successful read found no excluded folders keeps that empty
   * policy through any later read failure, so a user who never touched
   * the feature is never locked out by one.
   *
   * Never throws. A caller on the request path must not have to decide
   * what a thrown settings read means.
   */
  async refresh(): Promise<PathPolicy> {
    try {
      const slice = (await this.store.readSlice(SLICE)) as
        | Record<string, unknown>
        | undefined;
      this.vaultWidePolicy = compilePolicy(slice?.[FIELD]);
      if (this.failing) {
        this.failing = false;
        logger.warn(
          "Folder-exclusion policy: settings readable again, policy refreshed.",
        );
      }
    } catch (err) {
      if (!this.failing) {
        this.failing = true;
        logger.error(
          "Folder-exclusion policy: could not read settings; retaining the last known policy. " +
            "If no successful read has happened this session, every vault path is refused.",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
    return this.vaultWidePolicy;
  }

  /** The vault-wide policy from the last successful read. */
  get vaultWide(): PathPolicy {
    return this.vaultWidePolicy;
  }

  /** True while settings reads are failing. Diagnostic only. */
  get isDegraded(): boolean {
    return this.failing;
  }

  /**
   * Run `fn` with `policy` in force for everything it awaits.
   *
   * Entered once per request, at the two dispatch points. Nested calls
   * are legal and the innermost wins, which is what makes it safe for a
   * tool to invoke another tool's handler.
   */
  runWith<T>(policy: PathPolicy, fn: () => T): T {
    return this.storage.run(policy, fn);
  }

  /**
   * The policy in force right now.
   *
   * Inside `runWith`, that request's policy. Outside it — the settings
   * UI, a background task, a unit test — the vault-wide policy, never
   * "no policy". Phase 2 keeps this rule: an absent request scope means
   * the vault-wide list still applies, because that list is the user's
   * statement about the vault rather than about any one client.
   */
  current(): PathPolicy {
    return this.storage.getStore() ?? this.vaultWidePolicy;
  }
}

/**
 * One provider per plugin instance, created on first use.
 *
 * A `WeakMap` rather than a field on `McpToolsPlugin`: `shared/` must not
 * import the plugin class (the barrel already pulls in `src/main`, which
 * is why `settingsStore` takes a structural `PluginDataLike` instead).
 * Keying by the plugin object gives every composition root the same
 * provider without any of them having to thread it through a signature,
 * and a test's throwaway plugin gets its own.
 */
const providers = new WeakMap<object, PathPolicyProvider>();

export function pathPolicyFor(plugin: PluginDataLike): PathPolicyProvider {
  let provider = providers.get(plugin);
  if (!provider) {
    provider = new PathPolicyProvider(plugin);
    providers.set(plugin, provider);
  }
  return provider;
}
