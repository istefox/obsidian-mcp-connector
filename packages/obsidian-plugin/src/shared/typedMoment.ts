import { moment } from "obsidian";

/**
 * Locally-declared surface of the moment instance this plugin uses.
 *
 * Why not `ReturnType<typeof moment>`: Obsidian bundles moment and
 * re-exports it, but its `.d.ts` references the external `moment`
 * typings. Environments that resolve types with production
 * dependencies only (the community-plugin scanner does) see that
 * export as `any`, so every call through it trips the
 * `no-unsafe-*` type-aware lint rules. A minimal local interface
 * keeps all call sites typed in every environment; the runtime value
 * is still Obsidian's bundled moment.
 */
export interface MomentLike {
  isValid(): boolean;
  format(format?: string): string;
  year(year: number): MomentLike;
  quarter(): number;
  quarter(quarter: number): MomentLike;
  startOf(unit: string): MomentLike;
}

export interface MomentFactory {
  (input?: string, format?: string, strict?: boolean): MomentLike;
  invalid(): MomentLike;
}

/** Obsidian's bundled moment behind the locally-typed surface. */
export const momentFn: MomentFactory = moment as unknown as MomentFactory;
