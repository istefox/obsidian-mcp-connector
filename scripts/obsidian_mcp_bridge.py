#!/usr/bin/env python3
"""POST-only stdio bridge for the Obsidian MCP Connector plugin.

A drop-in replacement for mcp-remote on setups where mcp-remote hangs on
`initialize` (observed on Windows: the client times out after 60s because the
GET SSE stream mcp-remote opens never settles). This bridge talks to the
plugin's local HTTP server using POST requests only, so it never opens that
stream.

The plugin's server is stateless and answers each POST with a single JSON
response (it sends no server-initiated messages), so a plain request/response
loop is all that is needed. Standard library only, no pip install.

Usage (claude_desktop_config.json):

    {
      "mcpServers": {
        "obsidian": {
          "command": "python",
          "args": ["C:\\\\path\\\\to\\\\obsidian_mcp_bridge.py", "http://127.0.0.1:27200/mcp"],
          "env": { "OBSIDIAN_BEARER_TOKEN": "your-token-here" }
        }
      }
    }

The token can also be passed as a second argument instead of the env var, but
the env var keeps it out of the process list.
"""
import json
import os
import sys
import urllib.error
import urllib.request

PROTOCOL_VERSION_FALLBACK = "2025-06-18"


def log(msg):
    # stderr only: stdout is the JSON-RPC channel the MCP client reads.
    print(f"[obsidian-bridge] {msg}", file=sys.stderr, flush=True)


def emit_error(req_id, code, msg):
    error = {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": msg}}
    sys.stdout.write(json.dumps(error) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        log("missing server URL argument")
        sys.exit(1)
    url = sys.argv[1]
    token = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("OBSIDIAN_BEARER_TOKEN", "")
    if not token:
        log("no bearer token (pass as 2nd arg or set OBSIDIAN_BEARER_TOKEN)")
        sys.exit(1)

    negotiated_version = {"value": None}

    def post(message):
        body = json.dumps(message).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {token}",
        }
        # After initialize, the spec asks clients to echo the negotiated version.
        if negotiated_version["value"]:
            headers["MCP-Protocol-Version"] = negotiated_version["value"]
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()

    log(f"started, target={url}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            log(f"skipping non-JSON line: {line[:80]}")
            continue

        is_request = "id" in message and message["id"] is not None
        try:
            status, raw = post(message)
        except urllib.error.URLError as err:
            log(f"POST failed: {err}")
            if is_request:
                emit_error(message["id"], -32000, f"bridge POST failed: {err}")
            continue

        if not is_request:
            # Notification: the stateless server replies 202 with no body.
            continue

        if not raw:
            emit_error(message["id"], -32000, f"empty response (HTTP {status})")
            continue
        try:
            response = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            emit_error(message["id"], -32000, f"non-JSON response (HTTP {status})")
            continue

        if message.get("method") == "initialize":
            result = response.get("result") or {}
            negotiated_version["value"] = result.get("protocolVersion") or PROTOCOL_VERSION_FALLBACK
            log(f"initialized, protocol={negotiated_version['value']}")

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
