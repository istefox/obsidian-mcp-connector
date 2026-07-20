/**
 * Process-wide mutex for MCP-origin vault writes.
 *
 * ## Why a single vault write mutex
 *
 * The stateless HTTP transport handles requests concurrently, so two
 * MCP clients (or one client issuing parallel tool calls) can run two
 * write handlers at the same time. Every content-writing tool used to
 * do an unserialized `vault.read` → compute → `vault.modify` cycle;
 * two concurrent cycles against the same file both read the same
 * "before", each writes back "before + my change", and the last writer
 * silently discards the other's append (lost update — the same failure
 * mode `globalSettingsMutex` exists to prevent on `data.json`, see
 * `$/shared/settingsLock.ts`).
 *
 * Two layers close the race:
 *
 *  1. `vault.process(file, fn)` — Obsidian's atomic read-modify-write —
 *     replaces the split `read`/`modify` pair inside every handler, so
 *     a single-file update can no longer interleave with ANY other
 *     writer (including the user typing in the editor or sync).
 *  2. This mutex serializes whole write *operations* against each
 *     other, covering the multi-step invariants `vault.process` cannot:
 *     exists-check → create (TOCTOU), parent-folder creation, and
 *     multi-file plans (`rename_heading` writes the source plus every
 *     backlinker as one logical operation).
 *
 * One global lock instead of per-path locks: multi-file operations
 * would need to acquire several path locks (deadlock-prone without
 * global ordering), and the server is single-user/local — writes are
 * milliseconds, so lost parallelism is unmeasurable while the
 * correctness argument stays trivial.
 *
 * ## Non-re-entrant — do NOT nest
 *
 * Same contract as `globalSettingsMutex`: calling `withVaultWriteLock`
 * from inside a section that already holds the lock deadlocks. Tool
 * handlers acquire it exactly once, at the top of their write path;
 * shared helpers below that level (`ensureParentFolderExists`,
 * `applyPatch`'s compute helpers) must never acquire it themselves.
 * `applyPatch` DOES acquire it — so the patch tools that delegate to it
 * (`patch_vault_file`, `patch_active_file`) must not.
 */
import { createMutex, type Mutex } from "$/shared/settingsLock";

const vaultWriteMutex: Mutex = createMutex();

/**
 * Run `fn` serialized against every other MCP-origin vault write.
 * Returns whatever `fn` returns; a rejection propagates but does not
 * break the queue (next waiter runs normally).
 */
export function withVaultWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  return vaultWriteMutex.run(fn);
}
