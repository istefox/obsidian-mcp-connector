import { TFile, type Vault } from "obsidian";

/**
 * Outcome of resolving a vault-relative path. A failure carries only a
 * `reason` discriminator — never a response envelope — so each caller keeps
 * ownership of its own error wire shape (plain text vs JSON `errorCode`).
 */
export type ResolveTFileResult =
  | { ok: true; file: TFile }
  | { ok: false; reason: "not_found" | "not_a_file" };

/**
 * Resolve a vault-relative path to an existing TFile.
 *
 * Centralizes the `getAbstractFileByPath` → exists → `instanceof TFile` guard
 * that was copy-pasted across ~19 tool handlers. Returns a discriminated reason
 * instead of a formatted error so the call site can emit its existing message
 * unchanged — the resolution logic is shared, the wire format is not.
 */
export function resolveTFile(vault: Vault, path: string): ResolveTFileResult {
  const abstract = vault.getAbstractFileByPath(path);
  if (!abstract) return { ok: false, reason: "not_found" };
  if (!(abstract instanceof TFile)) return { ok: false, reason: "not_a_file" };
  return { ok: true, file: abstract };
}
