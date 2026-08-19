/**
 * Folder-exclusion enforcement for the semantic-search surface
 * (ADR-0020 §D15).
 *
 * Every other tool is covered by the guarded `App`, because every other
 * tool reaches vault content through it. Semantic search does not: its
 * hits come out of the embedding store, or out of Smart Connections'
 * own index, and neither passes the seam. So this surface carries its
 * own enforcement, at two points — index time, in `productionWiring`'s
 * `isExcluded`, and query time, here.
 *
 * Query time is not redundant with index time. `embeddings/` keeps
 * `filePath` and `heading` for files indexed *before* their folder was
 * excluded, Smart Connections keeps an index this plugin cannot purge at
 * all, and a rebuild takes minutes. Filtering the results is what makes
 * the exclusion take effect the moment the user clicks, rather than
 * whenever the index next settles.
 *
 * The wrap goes on the *chooser*, not on one provider instance: the
 * settings UI re-runs the chooser on a provider swap
 * (`applySettings`), and so does the auto-provider refresh. A wrapper
 * applied to `state.provider` alone would be silently discarded by the
 * next swap, and the hole would open only for users who change
 * provider — the hardest kind of gap to notice.
 */
import type {
  SearchOpts,
  SearchResult,
  SemanticSearchProvider,
} from "$/features/semantic-search";
import type { ProviderChooser } from "./providerFactory";
import type { PathPolicy } from "$/shared/pathPolicy";

/** Supplies the policy in force for the current call. */
export type PolicySource = () => PathPolicy;

/**
 * Wrap one provider so no hit under an excluded folder ever leaves it.
 *
 * The policy is read per `search()` call, never captured: the call runs
 * inside the request scope established at dispatch, which is what makes
 * phase 2's per-token policy a change of one line elsewhere and none
 * here.
 *
 * Results are dropped, never replaced by a count or a placeholder. A
 * "3 results hidden" note would confirm the folder exists and would
 * disclose roughly how much is in it, which is precisely what the
 * policy is for (ADR-0020 §D3).
 */
export function guardProviderWithPolicy(
  provider: SemanticSearchProvider,
  policy: PolicySource,
): SemanticSearchProvider {
  return {
    isReady: () => provider.isReady(),
    async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
      const results = await provider.search(query, opts);
      const inForce = policy();
      if (inForce.isEmpty) return results;
      return results.filter((r) => !inForce.isExcluded(r.filePath));
    },
  };
}

/**
 * Wrap a chooser so every provider it ever returns is guarded.
 *
 * This is the resolution point for the whole feature: `setup()` calls
 * the chooser once at load, and both `applySettings` and
 * `refreshAutoProvider` call it again later. Guarding here covers a
 * provider added next year without that provider knowing this file
 * exists.
 */
export function guardChooserWithPolicy(
  chooser: ProviderChooser,
  policy: PolicySource,
): ProviderChooser {
  return (settings) => guardProviderWithPolicy(chooser(settings), policy);
}
