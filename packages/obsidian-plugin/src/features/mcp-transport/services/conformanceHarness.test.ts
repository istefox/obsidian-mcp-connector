import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const PACKAGE_ROOT = join(import.meta.dir, "../../../..");
const CONFORMANCE_DIR = join(PACKAGE_ROOT, "scripts/conformance");

/**
 * Manual recursive walk rather than `readdirSync(dir, { recursive: true })`:
 * the installed @types/node (16.x, pinned by package.json) has no overload
 * for that option, so using it would fail `tsc --noEmit` even though Bun's
 * runtime supports it.
 */
function collectBasenames(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      names.push(...collectBasenames(join(dir, entry.name)));
    } else {
      names.push(entry.name);
    }
  }
  return names;
}

function readPackageJson(): { scripts?: Record<string, string> } {
  return JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
}

/**
 * The harness, its runner and its baseline live under scripts/conformance/,
 * not under src/ and not in a machine-local scratch directory. Both halves
 * matter for different reasons:
 *
 * - Present under scripts/: the community-plugin review scanner lints
 *   src/** only and forbids eslint-disable on obsidianmd/* rules there
 *   (CLAUDE.md, ADR-0013). A refactor that moved harness.ts under src/ to
 *   shorten an import would sail through the rest of this suite and still
 *   break plugin review.
 * - Runnable from the repo: package.json's test:conformance script is what
 *   turns "the file is checked in" into "CI can actually invoke it".
 *
 * expected-failures.yml is checked separately below because its content,
 * not just its location, carries intent (it is maintained by hand and
 * never regenerated from a failing run).
 */
describe("conformance harness lives in the repo, not a scratch directory (R-15)", () => {
  test("harness.ts, run.sh and expected-failures.yml exist under scripts/conformance/", () => {
    expect(existsSync(join(CONFORMANCE_DIR, "harness.ts"))).toBe(true);
    expect(existsSync(join(CONFORMANCE_DIR, "run.sh"))).toBe(true);
    expect(existsSync(join(CONFORMANCE_DIR, "expected-failures.yml"))).toBe(
      true,
    );
  });

  test("none of the three conformance filenames exist anywhere under src/", () => {
    const basenames = collectBasenames(join(PACKAGE_ROOT, "src"));
    expect(basenames).not.toContain("harness.ts");
    expect(basenames).not.toContain("run.sh");
    expect(basenames).not.toContain("expected-failures.yml");
  });

  test("package.json's test:conformance script runs scripts/conformance/run.sh", () => {
    const pkg = readPackageJson();
    expect(pkg.scripts?.["test:conformance"]).toBe(
      "bash scripts/conformance/run.sh",
    );
  });

  test("package.json's test:mcpb script (the #412 regression guard) is untouched", () => {
    const pkg = readPackageJson();
    expect(pkg.scripts?.["test:mcpb"]).toBe("bun scripts/mcpb-smoke.ts");
  });

  test("expected-failures.yml parses to exactly four hand-maintained server-stateless: entries", () => {
    const text = readFileSync(
      join(CONFORMANCE_DIR, "expected-failures.yml"),
      "utf8",
    );
    const parsed = Bun.YAML.parse(text) as Record<string, unknown>;
    const entries = Object.values(parsed).flatMap((value) =>
      Array.isArray(value) ? value : [],
    );

    // Four, not the nine the plan budgeted (measurement came in lower, see
    // ADR-0016 §8-9). The count matters precisely because this file is
    // edited by hand and never regenerated from a failing run: a silent
    // regeneration would show up here as a count that moved without a
    // reason. A check that starts passing is supposed to lose its entry,
    // so if this count legitimately changes, update the number below along
    // with the removal rather than treating this assertion as a reason not
    // to remove one.
    expect(entries).toHaveLength(4);

    for (const entry of entries) {
      expect(typeof entry).toBe("string");
      expect(entry as string).toMatch(/^server-stateless:.+/);
    }
  });
});
