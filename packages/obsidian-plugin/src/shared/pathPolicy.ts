/**
 * Vault-relative folder matching for the exclusion policy (ADR-0020).
 *
 * Deliberately dependency-free: no `obsidian` import, no logger, nothing
 * from `$/shared/index` (which pulls in `src/main`). That keeps this
 * module trivially testable and safe to import from the enforcement
 * seam, which runs on every tool call.
 *
 * Two layers, and the split is load-bearing for performance:
 * `normalizeFolderEntry` / `normalizeFolderList` canonicalise at the
 * boundary, once; `isUnderFolder` assumes both sides are already
 * canonical and does no work beyond the comparison, because it runs
 * inside loops over every file in the vault.
 */

/**
 * Upper bound on how many folders a policy may hold. The matcher is
 * O(paths x folders) on every enumerating tool, so an accidental paste
 * of a huge list must degrade to a bounded one rather than hang the
 * vault. Clamped, not rejected — the same stance as
 * `normalizeMaxTextOutputKB`.
 */
export const MAX_POLICY_FOLDERS = 256;

/**
 * Canonicalise a vault path for comparison.
 *
 * Unicode normalisation is the part that is easy to miss. macOS stores
 * filenames decomposed, so a `TFile.path` can arrive as NFD while a
 * folder the user typed into the settings field arrives as NFC. Without
 * folding both to one form, `Café/note.md` and a `Café` entry that look
 * identical on screen compare unequal, and the folder is silently not
 * hidden.
 */
function toNfc(value: string): string {
  return value.normalize("NFC");
}

/**
 * Canonicalise one raw exclusion entry, or reject it.
 *
 * `undefined` means the entry is unusable and the caller drops it. It is
 * never "match nothing": an entry that silently matches nothing is
 * indistinguishable, in the settings UI, from one that works — which is
 * false security. Dropping makes the entry visibly disappear so the user
 * can see something was wrong and fix it (ADR-0020 §D6).
 *
 * Accepts `unknown` on purpose. One caller is a typed settings input,
 * the other reads `data.json`, which can hold anything after a hand edit
 * or a downgrade round trip.
 */
export function normalizeFolderEntry(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;

  const folded = toNfc(raw)
    .trim()
    // Obsidian vault paths always use forward slashes, even on Windows.
    // A user pasting `Journal\Therapy` must not get an entry that
    // silently matches nothing. A literal backslash in a filename is
    // legal but vanishingly rare, and over-matching is the safe error
    // here.
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (folded === "") return undefined;

  // Traversal segments are dropped, never resolved. A vault path is
  // vault-relative and never contains them, so such an entry is a typo
  // or an attempt to name something outside the vault. Resolving it
  // would produce a rule matching nothing, which is exactly the silent
  // false security this function refuses to produce.
  if (folded.split("/").some((seg) => seg === "." || seg === "..")) {
    return undefined;
  }

  return folded;
}

/**
 * Canonicalise a whole list. Returns `[]` when nothing usable survives;
 * callers that distinguish "configured but empty" from "never
 * configured" map that to `undefined` themselves.
 *
 * Nested entries are kept, never pruned. Dropping `a/b` because `a`
 * already covers it is a matching no-op but a data-loss action: the user
 * who later removes `a` would silently lose protection on `a/b`.
 */
export function normalizeFolderList(
  raw: unknown,
  max: number = MAX_POLICY_FOLDERS,
): string[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const folder = normalizeFolderEntry(entry);
    if (folder === undefined || seen.has(folder)) continue;
    seen.add(folder);
    out.push(folder);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Is `path` inside `folder`, or the folder itself?
 *
 * Both arguments must already be canonical — this does no trimming, no
 * slash stripping and no Unicode folding, because it runs once per
 * folder per file. Callers normalise at the boundary; `PathPolicy` does
 * it for you.
 *
 * Case-sensitive by decision (ADR-0020 §D13): matching case-insensitively
 * would over-hide and make "hide `Journal` but not `journal`"
 * inexpressible on a case-sensitive vault. The failure this accepts — a
 * hand-typed `journal` protecting nothing on macOS — is caught by the
 * settings UI's stale-entry marker, which is part of the design and not
 * polish.
 */
export function isUnderFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder + "/");
}

/** A compiled, ready-to-query exclusion policy. */
export interface PathPolicy {
  /** Canonical folders, in the user's order. Possibly empty. */
  readonly folders: readonly string[];
  /** True when the policy excludes nothing at all. */
  readonly isEmpty: boolean;
  /** True when `path` is inside any excluded folder. */
  isExcluded(path: string): boolean;
}

/** A policy that excludes nothing. */
export const EMPTY_POLICY: PathPolicy = Object.freeze({
  folders: Object.freeze([]) as readonly string[],
  isEmpty: true,
  isExcluded: () => false,
});

/**
 * Compile raw settings data into a policy. Total: any shape of input
 * yields a usable policy, never a throw, because the input can be
 * whatever `data.json` happens to hold.
 */
export function compilePolicy(raw: unknown): PathPolicy {
  const folders = normalizeFolderList(raw);
  if (folders.length === 0) return EMPTY_POLICY;

  const frozen = Object.freeze(folders.slice()) as readonly string[];
  return Object.freeze({
    folders: frozen,
    isEmpty: false,
    isExcluded(path: string): boolean {
      if (typeof path !== "string" || path === "") return false;
      // Normalise the path once, then loop the folders — not the other
      // way round. This runs per file in vault-wide enumerations.
      const candidate = toNfc(path);
      for (const folder of frozen) {
        if (isUnderFolder(candidate, folder)) return true;
      }
      return false;
    },
  });
}
