#!/usr/bin/env bash
#
# Spec-coverage harness for the "return the obsidian:// URI of a note" chain
# (issue #533), driven by
# docs/superpowers/plans/2026-09-13-issue-533-return-the-obsidian-uri-of-a.md
# and docs/architecture/ADR-0026-obsidian-uri-on-note-tools.md.
#
# Checks five independent contracts:
#
#   1. Every SPEC requirement id (R-01 .. R-11) is referenced at least once in
#      the plan file above — skipped, not failed, wherever that plan file is
#      absent (see below).
#   2. docs/architecture/ADR-0026-obsidian-uri-on-note-tools.md exists and
#      names the labels a reader needs to trust the decision actually holds:
#      the `%23` heading-in-file-value encoding, the `heading_not_found`
#      error code, `encodeURIComponent`, and the three prior ADRs this one
#      builds on or deliberately diverges from (ADR-0018, ADR-0020,
#      ADR-0023, ADR-0024) plus the two shared internals it names as
#      off-limits (readVaultFileAsJson, SearchResult).
#   3. README mentions `obsidian://open` and `heading_not_found`, so a reader
#      of the shipped docs — not just the ADR — can find both.
#   4. The five out-of-scope files (R-09) are byte-identical to the
#      pre-chain baseline commit.
#   5. index.test.ts still asserts the registry-wide "no outputSchema"
#      guard — this chain adds fields to existing tools' results, and must
#      never be the chain that quietly declares one.
#
# Red here means one of those five contracts regressed. An absent plan file
# is not a regression: docs/superpowers/plans/ is gitignored, so the plan is
# untracked and simply not there in a clean clone, in CI, or in a fresh git
# worktree. Failing over it would report an environment gap as a coverage
# regression, so check 1 prints a SKIP line and counts as passed instead;
# checks 2-5 still run and are still enforced. Same precedent as
# `test:conformance` (root CLAUDE.md) and spec-coverage-converge-anchors.sh.
#
# Written for bash 3.2 (the /bin/bash macOS ships): no associative arrays, no
# mapfile, no ${var^^}, no [[ -v ]], no local -n.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PACKAGE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$PACKAGE_DIR/../.." && pwd)

PLAN_FILE="$REPO_ROOT/docs/superpowers/plans/2026-09-13-issue-533-return-the-obsidian-uri-of-a.md"
ADR_FILE="$REPO_ROOT/docs/architecture/ADR-0026-obsidian-uri-on-note-tools.md"
README_FILE="$REPO_ROOT/README.md"
INDEX_TEST_FILE="$PACKAGE_DIR/src/features/mcp-tools/index.test.ts"
BASELINE_SHA="66e4050849dff689b2b59561facfb85687090763"

OUT_OF_SCOPE_FILES="
packages/obsidian-plugin/src/features/mcp-tools/tools/getOrCreatePeriodicNote.ts
packages/obsidian-plugin/src/features/mcp-tools/tools/getVaultFiles.ts
packages/obsidian-plugin/src/features/mcp-tools/tools/getVaultFilePartial.ts
packages/obsidian-plugin/src/features/mcp-apps/services/searchResultsPayload.ts
packages/obsidian-plugin/src/features/mcp-apps/assets/searchResultsAppSource.ts
"

FAIL=0
PLAN_CHECKED=0

# --- 1. every R-01 .. R-11 appears in the plan ------------------------------

if [ ! -f "$PLAN_FILE" ]; then
  echo "SKIP: spec-coverage check 1 (R-01..R-11 referenced in the plan) — no plan file at $PLAN_FILE"
  echo "SKIP: docs/superpowers/plans/ is gitignored, so 2026-09-13-issue-533-return-the-obsidian-uri-of-a.md is untracked and absent from a clean clone, from CI and from a fresh git worktree; this check only runs from the orchestrator's local checkout, and its absence is not a coverage regression."
  echo "SKIP: checks 2-5 below run and are enforced regardless."
else
  PLAN_CHECKED=1
  i=1
  while [ "$i" -le 11 ]; do
    id=$(printf 'R-%02d' "$i")
    if ! grep -q -- "$id" "$PLAN_FILE"; then
      echo "spec-coverage: $id not found in $PLAN_FILE" >&2
      FAIL=1
    fi
    i=$((i + 1))
  done
fi

# --- 2. ADR-0026 exists and names all required labels -----------------------

if [ ! -f "$ADR_FILE" ]; then
  echo "spec-coverage: ADR file not found: $ADR_FILE" >&2
  FAIL=1
else
  for label in "%23" "heading_not_found" "encodeURIComponent" "readVaultFileAsJson" "SearchResult" "ADR-0018" "ADR-0020" "ADR-0023" "ADR-0024"; do
    if ! grep -qF -- "$label" "$ADR_FILE"; then
      echo "spec-coverage: ADR-0026 is missing required label: $label" >&2
      FAIL=1
    fi
  done
fi

# --- 3. README mentions the URI scheme and the error code -------------------

if [ ! -f "$README_FILE" ]; then
  echo "spec-coverage: README not found: $README_FILE" >&2
  FAIL=1
else
  for label in "obsidian://open" "heading_not_found"; do
    if ! grep -qF -- "$label" "$README_FILE"; then
      echo "spec-coverage: README.md is missing required mention: $label" >&2
      FAIL=1
    fi
  done
fi

# --- 4. out-of-scope files byte-identical to baseline (R-09) -----------------

if ! git -C "$REPO_ROOT" cat-file -e "$BASELINE_SHA" 2>/dev/null; then
  echo "spec-coverage: baseline $BASELINE_SHA is not reachable from this checkout; cannot check R-09" >&2
  FAIL=1
else
  for rel in $OUT_OF_SCOPE_FILES; do
    DIFF_OUTPUT=$(git -C "$REPO_ROOT" diff --stat "$BASELINE_SHA" -- "$rel")
    if [ -n "$DIFF_OUTPUT" ]; then
      echo "spec-coverage: $rel differs from baseline $BASELINE_SHA — R-09 requires it untouched:" >&2
      echo "$DIFF_OUTPUT" >&2
      FAIL=1
    fi
  done
fi

# --- 5. registry-wide "no outputSchema" guard is still asserted -------------

if [ ! -f "$INDEX_TEST_FILE" ]; then
  echo "spec-coverage: index.test.ts not found: $INDEX_TEST_FILE" >&2
  FAIL=1
else
  if ! grep -qF -- "no registered tool declares an MCP outputSchema" "$INDEX_TEST_FILE"; then
    echo "spec-coverage: index.test.ts no longer asserts the registry-wide outputSchema guard" >&2
    FAIL=1
  fi
fi

# --- verdict -----------------------------------------------------------

if [ "$FAIL" -ne 0 ]; then
  echo "spec-coverage: FAIL (see reasons above)" >&2
  exit 1
fi

if [ "$PLAN_CHECKED" -eq 0 ]; then
  echo "spec-coverage: PASS — check 1 skipped (plan file absent), ADR-0026 complete, README mentions present, out-of-scope files untouched, outputSchema guard present"
else
  echo "spec-coverage: PASS — R-01..R-11 covered, ADR-0026 complete, README mentions present, out-of-scope files untouched, outputSchema guard present"
fi
