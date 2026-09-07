#!/usr/bin/env bash
#
# Spec-coverage harness for the "converge the three inconsistent heading/block
# anchor matchers" chain (issue #527, OMC-041), driven by
# docs/superpowers/plans/2026-09-07-converge-the-three-inconsistent-heading.md
# and docs/architecture/ADR-0024-converge-anchor-matchers.md.
#
# Checks four independent contracts:
#
#   1. Every SPEC requirement id (R-01 .. R-14) is referenced at least once in
#      the plan file above — skipped, not failed, wherever that plan file is
#      absent (see below).
#   2. docs/architecture/ADR-0024-converge-anchor-matchers.md exists and names
#      all four convergence-point labels (Case sensitivity, Delimiter
#      translation, Ambiguity detection, Cache-first) plus the two named
#      intentionally-separate cases (headingRename, resolveLinkTarget). This
#      is R-14's check: R-14 is marked `(no-test: ...)` in the SPEC because no
#      unit test can assert an ADR's completeness, so it gets a harness line
#      here instead of being dropped.
#   3. The three retired matcher symbols (resolveHeadingPath,
#      findLeafHeadingLine, toAnchor) are gone from src/, not merely unused.
#   4. services/resolveLinkTarget.ts is untouched relative to the pre-chain
#      merge base (R-13) — it is the already-correct resolver this chain
#      deliberately does not touch.
#
# Red here means one of those four contracts regressed: a requirement id
# dropped out of the plan, the ADR lost a convergence label, a retired symbol
# crept back into src/, or resolveLinkTarget.ts was edited when R-13 says it
# must not be. An absent plan file is none of those: docs/superpowers/plans/
# is gitignored (see .gitignore), so the plan is untracked and simply not
# there in a clean clone, in CI, or in a fresh git worktree. Failing over it
# would report an environment gap as a coverage regression, so check 1 prints
# a SKIP line and counts as passed instead; checks 2, 3 and 4 still run and
# are still enforced. Same precedent as `test:conformance` (root CLAUDE.md):
# a check that depends on an artifact CI does not have is a discipline, not a
# per-PR gate.
#
# Written for bash 3.2 (the /bin/bash macOS ships): no associative arrays, no
# mapfile, no ${var^^}, no [[ -v ]], no local -n.

# `set -eu`, not `set -euo pipefail`: every pipeline below ends in a command
# (wc -l) whose own exit status is 0 regardless of the earlier stage, so
# pipefail would be inert here — add it together with the first pipeline
# whose left-hand failure must not be swallowed.
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PACKAGE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$PACKAGE_DIR/../.." && pwd)

PLAN_FILE="$REPO_ROOT/docs/superpowers/plans/2026-09-07-converge-the-three-inconsistent-heading.md"
ADR_FILE="$REPO_ROOT/docs/architecture/ADR-0024-converge-anchor-matchers.md"
SRC_DIR="$PACKAGE_DIR/src"
RESOLVE_LINK_TARGET_REL="packages/obsidian-plugin/src/features/mcp-tools/services/resolveLinkTarget.ts"
MERGE_BASE="30fc4615b040daa27145fec2f5962e029ad4582a"

FAIL=0
PLAN_CHECKED=0

# --- 1. every R-01 .. R-14 appears in the plan -----------------------------

if [ ! -f "$PLAN_FILE" ]; then
  echo "SKIP: spec-coverage check 1 (R-01..R-14 referenced in the plan) — no plan file at $PLAN_FILE"
  echo "SKIP: docs/superpowers/plans/ is gitignored, so 2026-09-07-converge-the-three-inconsistent-heading.md is untracked and absent from a clean clone, from CI and from a fresh git worktree; this check only runs from the orchestrator's local checkout, and its absence is not a coverage regression."
  echo "SKIP: checks 2, 3 and 4 below run and are enforced regardless."
else
  PLAN_CHECKED=1
  i=1
  while [ "$i" -le 14 ]; do
    id=$(printf 'R-%02d' "$i")
    if ! grep -q -- "$id" "$PLAN_FILE"; then
      echo "spec-coverage: $id not found in $PLAN_FILE" >&2
      FAIL=1
    fi
    i=$((i + 1))
  done
fi

# --- 2. ADR-0024 exists and names all required labels ----------------------

if [ ! -f "$ADR_FILE" ]; then
  echo "spec-coverage: ADR file not found: $ADR_FILE" >&2
  FAIL=1
else
  for label in "Case sensitivity" "Delimiter translation" "Ambiguity detection" "Cache-first" "headingRename" "resolveLinkTarget"; do
    if ! grep -qF -- "$label" "$ADR_FILE"; then
      echo "spec-coverage: ADR-0024 is missing required label: $label" >&2
      FAIL=1
    fi
  done
fi

# --- 3. retired matcher symbols are gone from src/, not merely unused ------

RETIRED_COUNT=$(grep -rE "resolveHeadingPath|findLeafHeadingLine|toAnchor" "$SRC_DIR" 2>/dev/null | wc -l | tr -d ' ')
if [ "$RETIRED_COUNT" != "0" ]; then
  echo "spec-coverage: found $RETIRED_COUNT reference(s) to a retired symbol (resolveHeadingPath, findLeafHeadingLine, toAnchor) still under $SRC_DIR" >&2
  FAIL=1
fi

# --- 4. resolveLinkTarget.ts untouched relative to the merge base (R-13) ---

if ! git -C "$REPO_ROOT" cat-file -e "$MERGE_BASE" 2>/dev/null; then
  echo "spec-coverage: merge base $MERGE_BASE is not reachable from this checkout; cannot check R-13" >&2
  FAIL=1
else
  DIFF_OUTPUT=$(git -C "$REPO_ROOT" diff --stat "$MERGE_BASE" -- "$RESOLVE_LINK_TARGET_REL")
  if [ -n "$DIFF_OUTPUT" ]; then
    echo "spec-coverage: $RESOLVE_LINK_TARGET_REL differs from merge base $MERGE_BASE — R-13 requires it untouched:" >&2
    echo "$DIFF_OUTPUT" >&2
    FAIL=1
  fi
fi

# --- verdict -----------------------------------------------------------

if [ "$FAIL" -ne 0 ]; then
  echo "spec-coverage: FAIL (see reasons above)" >&2
  exit 1
fi

if [ "$PLAN_CHECKED" -eq 0 ]; then
  echo "spec-coverage: PASS — check 1 skipped (plan file absent), ADR-0024 complete, retired symbols gone, resolveLinkTarget.ts untouched"
else
  echo "spec-coverage: PASS — R-01..R-14 covered, ADR-0024 complete, retired symbols gone, resolveLinkTarget.ts untouched"
fi
