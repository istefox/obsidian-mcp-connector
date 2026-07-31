/**
 * In-memory, per-token record of `activate_tool`'s default
 * (`persist: false`) promotions.
 *
 * The 0.28.2 implementation cleared the shared registry's adaptive flag,
 * which is global — one client's exploratory activation widened every
 * other client's surface. Keeping the promotion here instead preserves
 * the documented meaning of `persist` ("available until the plugin
 * reloads") per token, and `resolveToolScope` unions it into the
 * token's stored `promoted` list.
 *
 * Entries for revoked tokens are unreachable — ids are never reused —
 * and die with the process.
 */

const EMPTY: ReadonlySet<string> = new Set<string>();

export class SessionPromotions {
  private readonly byToken = new Map<string, Set<string>>();

  /** Promote `names` for `tokenId` for the lifetime of this process. */
  promote(tokenId: string, ...names: string[]): void {
    let promoted = this.byToken.get(tokenId);
    if (!promoted) {
      promoted = new Set<string>();
      this.byToken.set(tokenId, promoted);
    }
    for (const name of names) promoted.add(name);
  }

  /** The names promoted in-session for `tokenId`; empty when there are none. */
  get(tokenId: string): ReadonlySet<string> {
    return this.byToken.get(tokenId) ?? EMPTY;
  }
}
