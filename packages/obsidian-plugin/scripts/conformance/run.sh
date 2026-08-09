#!/usr/bin/env bash
#
# Run the MCP conformance suite's `server-stateless` scenario against a
# headless instance of this plugin's MCP server.
#
# The suite is built from source at a pinned ref: the published CLI
# (0.1.16) has none of the 2026-07-28 scenarios. The ref is pinned rather
# than tracking main because the suite is pre-release — an upstream
# scenario change must not turn this job red for reasons unrelated to any
# commit here. .github/workflows/conformance.yml sets the same ref
# explicitly; the two move together.
#
# Failures are judged against expected-failures.yml, not against zero.
# That file carries WHY each red check is red; it is edited by hand and
# never regenerated from a failing run.
#
# Written for bash 3.2 (the /bin/bash macOS ships): no associative
# arrays, no mapfile, no ${var^^}, no [[ -v ]], no local -n.
#
# Environment:
#   MCP_CONFORMANCE_DIR    use this checkout instead of cloning; must
#                          already be built (dist/index.js present)
#   MCP_CONFORMANCE_REF    override the pinned ref
#   MCP_CONFORMANCE_CACHE  where clones live (default: $TMPDIR)
#   CONFORMANCE_PROXY_PORT port the harness's proxy binds (default 27300)

# `set -eu`, not `set -euo pipefail`: this script contains no pipeline, so
# pipefail would be inert. Add it together with the first pipeline whose
# left-hand failure must not be swallowed, rather than as a header habit.
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PACKAGE_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)

CONFORMANCE_REPO="https://github.com/modelcontextprotocol/conformance.git"
# modelcontextprotocol/conformance @ 0.2.0-alpha.10.
CONFORMANCE_REF="${MCP_CONFORMANCE_REF:-81eb1c3edaed87d7fd585d7b80186da7a2960660}"

SCENARIO="server-stateless"
BASELINE="$SCRIPT_DIR/expected-failures.yml"
PROXY_PORT="${CONFORMANCE_PROXY_PORT:-27300}"
PROXY_URL="http://127.0.0.1:$PROXY_PORT/mcp"
READY_TIMEOUT_S=90

for tool in bun node git curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "conformance: $tool is required but not on PATH" >&2
    exit 1
  fi
done

# --- resolve the suite -----------------------------------------------------

if [ -n "${MCP_CONFORMANCE_DIR:-}" ]; then
  CONFORMANCE_DIR="$MCP_CONFORMANCE_DIR"
  if [ ! -f "$CONFORMANCE_DIR/dist/index.js" ]; then
    echo "conformance: MCP_CONFORMANCE_DIR=$CONFORMANCE_DIR has no dist/index.js." >&2
    echo "conformance: build it there first (npm ci && npm run build)." >&2
    exit 1
  fi
  echo "conformance: using $CONFORMANCE_DIR"
else
  CACHE_ROOT="${MCP_CONFORMANCE_CACHE:-${TMPDIR:-/tmp}}/mcp-conformance"
  CONFORMANCE_DIR="$CACHE_ROOT/$CONFORMANCE_REF"

  if [ -d "$CONFORMANCE_DIR" ] && [ ! -d "$CONFORMANCE_DIR/.git" ]; then
    echo "conformance: $CONFORMANCE_DIR exists but is not a git checkout." >&2
    echo "conformance: remove it, or point MCP_CONFORMANCE_DIR elsewhere." >&2
    exit 1
  fi

  if [ ! -d "$CONFORMANCE_DIR/.git" ]; then
    echo "conformance: fetching $CONFORMANCE_REF into $CONFORMANCE_DIR"
    mkdir -p "$CONFORMANCE_DIR"
    git -C "$CONFORMANCE_DIR" init -q
    git -C "$CONFORMANCE_DIR" remote add origin "$CONFORMANCE_REPO"
    # Fetching one commit by sha keeps the pin exact and the download small.
    git -C "$CONFORMANCE_DIR" fetch -q --depth 1 origin "$CONFORMANCE_REF"
    git -C "$CONFORMANCE_DIR" checkout -q FETCH_HEAD
  fi

  if [ ! -f "$CONFORMANCE_DIR/dist/index.js" ]; then
    echo "conformance: building the suite (npm ci)"
    # `prepare` builds on install; `npm run build` after it is idempotent
    # and covers an install that skipped lifecycle scripts.
    (cd "$CONFORMANCE_DIR" && npm ci && npm run build)
  fi
fi

# --- boot the harness ------------------------------------------------------

cd "$PACKAGE_DIR"
bun scripts/conformance/harness.ts &
HARNESS_PID=$!

# Ask first, then insist. A harness that outlives this script holds the
# port and the next run fails to bind, so the exit path may not be
# best-effort.
cleanup() {
  kill "$HARNESS_PID" 2>/dev/null || true
  WAITED=0
  while [ "$WAITED" -lt 10 ] && kill -0 "$HARNESS_PID" 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
  done
  kill -9 "$HARNESS_PID" 2>/dev/null || true
}
trap cleanup EXIT

READY=""
ELAPSED=0
while [ "$ELAPSED" -lt "$READY_TIMEOUT_S" ]; do
  if ! kill -0 "$HARNESS_PID" 2>/dev/null; then
    echo "conformance: the harness exited before it started listening" >&2
    exit 1
  fi
  # Any HTTP answer means the proxy is up, and the proxy binds after the
  # plugin's own server does, so one probe covers both. curl without -f
  # succeeds on a 405, which is what GET /mcp returns by design.
  if curl -s -o /dev/null --max-time 2 "$PROXY_URL"; then
    READY="yes"
    break
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ -z "$READY" ]; then
  echo "conformance: $PROXY_URL did not answer within ${READY_TIMEOUT_S}s" >&2
  exit 1
fi

# --- run -------------------------------------------------------------------

set +e
node "$CONFORMANCE_DIR/dist/index.js" server \
  --url "$PROXY_URL" \
  --scenario "$SCENARIO" \
  --expected-failures "$BASELINE"
STATUS=$?
set -e

exit "$STATUS"
