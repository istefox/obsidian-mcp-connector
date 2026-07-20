import { type } from "arktype";
import { PortNumber } from "../types";

/**
 * Parse and validate the numeric value coming from the "Fixed port"
 * settings input in AccessControlSection.svelte.
 *
 * The input is `<input type="number">` with `bind:value`, so Svelte
 * coerces its runtime value to `number` when the user enters something
 * and to `null` when the field is blank. This helper treats `null` as
 * "use the automatic range" (returned as `port: undefined` on success)
 * and validates any numeric value against `PortNumber` (integer in
 * 1024–65535).
 *
 * The function is intentionally pure and synchronous so the save
 * handler can call it inside its try/catch without adding a failure
 * surface of its own — see #358 for the silent-throw regression the
 * previous string-based implementation had (calling `.trim()` on a
 * numeric binding threw a `TypeError` outside the handler's try/catch,
 * so no Notice ever surfaced and nothing was persisted).
 */
export function parsePortInput(
  input: number | null,
):
  | { readonly ok: true; readonly port: number | undefined }
  | { readonly ok: false; readonly error: string } {
  if (input === null) return { ok: true, port: undefined };
  const validated = PortNumber(input);
  if (validated instanceof type.errors) {
    return {
      ok: false,
      error: "Port must be a whole number between 1024 and 65535.",
    };
  }
  return { ok: true, port: validated };
}
