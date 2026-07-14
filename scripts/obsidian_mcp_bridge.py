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
import re
import sys
import urllib.error
import urllib.request
from typing import Any, Optional

PROTOCOL_VERSION_FALLBACK = "2025-06-18"

# SSE line endings per the spec: CRLF, CR, or LF. Deliberately not
# str.splitlines(), which also breaks on Unicode line/paragraph separators
# that could appear unescaped inside a JSON string value.
_SSE_LINE_SPLIT = re.compile(r"\r\n|\r|\n")


def log(msg):
    # stderr only: stdout is the JSON-RPC channel the MCP client reads.
    print(f"[obsidian-bridge] {msg}", file=sys.stderr, flush=True)


def parse_sse(body: str) -> list[dict]:
    """Parse an SSE response body into ordered JSON-RPC messages.

    Implements the subset of the SSE format this bridge needs: `data:`
    lines are buffered and, on a blank line (event dispatch) or end of
    body, joined with "\\n" and JSON-decoded as one message. `event:`,
    `id:`, `retry:` fields and `:`-comment lines are ignored — this bridge
    only forwards the JSON-RPC payload, not SSE event metadata. An event
    whose joined data does not decode as JSON is dropped, not raised, so
    one bad event does not lose the rest of an otherwise-valid body.

    Args:
        body: Decoded (str) SSE response body. Recognizes CRLF, CR, and LF
            line endings per the SSE spec.

    Returns:
        Parsed JSON-RPC message dicts, in the order their events appeared
        in the body. Non-dict JSON values (e.g. a bare number) are skipped.
    """
    messages: list[dict] = []
    data_lines: list[str] = []

    def dispatch() -> None:
        if not data_lines:
            return
        raw = "\n".join(data_lines)
        data_lines.clear()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return
        if isinstance(parsed, dict):
            messages.append(parsed)

    for line in _SSE_LINE_SPLIT.split(body):
        if line == "":
            dispatch()
        elif line.startswith(":"):
            continue  # comment line
        elif line.startswith("data:"):
            value = line[len("data:"):]
            if value.startswith(" "):
                value = value[1:]
            data_lines.append(value)
        else:
            continue  # event:, id:, retry:, or unknown field

    dispatch()  # flush a final event with no trailing blank line
    return messages


def build_error(req_id: Any, code: int, msg: str) -> dict:
    """Build a JSON-RPC 2.0 error response object.

    Args:
        req_id: The id of the request being answered.
        code: JSON-RPC error code.
        msg: Human-readable error message.

    Returns:
        A JSON-RPC error response dict.
    """
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": msg}}


def route_sse_messages(
    messages: list[dict], request_id: Any
) -> tuple[list[dict], Optional[dict]]:
    """Split parsed SSE messages into notifications and the matching response.

    Args:
        messages: Ordered messages returned by parse_sse().
        request_id: The id of the outgoing request this SSE body answers.

    Returns:
        (notifications_in_original_order, response_or_None). A message
        counts as the response only if its "id" equals request_id; every
        other message (id-less, or carrying a different id) is treated as
        a notification and kept in its original order.
    """
    notifications: list[dict] = []
    response: Optional[dict] = None
    for msg in messages:
        if response is None and "id" in msg and msg.get("id") == request_id:
            response = msg
        else:
            notifications.append(msg)
    return notifications, response


def resolve_response_messages(
    content_type: str, raw: bytes, request_id: Any, status: int
) -> list[dict]:
    """Resolve one HTTP response body into the messages to emit on stdout.

    Branches on the response Content-Type: `application/json` decodes the
    whole body as a single JSON-RPC message; `text/event-stream` parses SSE
    and returns any notifications followed by the message matching
    request_id. Malformed or empty bodies, and SSE bodies with no message
    matching request_id, all fall back to one `-32000` error message so
    every caller has a single, uniform failure shape.

    Args:
        content_type: The response's raw Content-Type header value
            (charset parameter, if any, is ignored).
        raw: The raw (undecoded) response body.
        request_id: The id of the request this response answers.
        status: HTTP status code, included in fallback error messages for
            diagnosis.

    Returns:
        Messages to write to stdout, in order. Always non-empty.
    """
    if not raw:
        return [build_error(request_id, -32000, f"empty response (HTTP {status})")]

    media_type = content_type.split(";")[0].strip().lower()

    if media_type == "text/event-stream":
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return [build_error(request_id, -32000, f"non-JSON response (HTTP {status})")]
        notifications, response = route_sse_messages(parse_sse(text), request_id)
        if response is None:
            return notifications + [
                build_error(request_id, -32000, f"non-JSON response (HTTP {status})")
            ]
        return notifications + [response]

    try:
        return [json.loads(raw.decode("utf-8"))]
    except (json.JSONDecodeError, UnicodeDecodeError):
        return [build_error(request_id, -32000, f"non-JSON response (HTTP {status})")]


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
