"""Standalone unittest suite for obsidian_mcp_bridge.py.

Run: `python3 -m unittest discover -s scripts -p "test_*.py" -v` from the
repo root. Deliberately NOT part of `.claude/test-cmd` (which stays
`bun test`) — stdlib unittest only, no pytest, per SPEC.md for issue #355.
"""
import io
import json
import threading
import time
import unittest
import urllib.error
from unittest import mock

import obsidian_mcp_bridge as bridge


class _FakeResponse:
    """Fake `urllib.request.urlopen` context-manager result, no real socket."""

    def __init__(self, status: int, headers: dict, body: bytes):
        self.status = status
        self.headers = headers
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class ParseSseTests(unittest.TestCase):
    def test_response_only_body(self):
        payload = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
        body = "data: " + json.dumps(payload) + "\n\n"
        self.assertEqual(bridge.parse_sse(body), [payload])

    def test_notification_then_response_one_body(self):
        notification = {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}
        response = {"jsonrpc": "2.0", "id": 1, "result": {}}
        body = (
            "data: " + json.dumps(notification) + "\n\n"
            "data: " + json.dumps(response) + "\n\n"
        )
        self.assertEqual(bridge.parse_sse(body), [notification, response])

    def test_multiline_data(self):
        body = 'data: {"jsonrpc":"2.0","id":1,\ndata: "result":{}}\n\n'
        self.assertEqual(
            bridge.parse_sse(body), [{"jsonrpc": "2.0", "id": 1, "result": {}}]
        )

    def test_crlf_line_endings(self):
        payload = {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
        body = "data: " + json.dumps(payload) + "\r\n\r\n"
        self.assertEqual(bridge.parse_sse(body), [payload])

    def test_comment_and_event_field_ignored(self):
        payload = {"jsonrpc": "2.0", "id": 1, "result": {}}
        body = (
            ": this is a comment\n"
            "event: message\n"
            "data: " + json.dumps(payload) + "\n"
            "\n"
        )
        self.assertEqual(bridge.parse_sse(body), [payload])

    def test_malformed_body_returns_empty_list(self):
        body = "data: not-json-at-all\n\n"
        self.assertEqual(bridge.parse_sse(body), [])

    def test_no_trailing_blank_line_still_flushes(self):
        payload = {"jsonrpc": "2.0", "id": 1, "result": {}}
        body = "data: " + json.dumps(payload)
        self.assertEqual(bridge.parse_sse(body), [payload])


class RouteSseMessagesTests(unittest.TestCase):
    def test_notification_plus_response_matched_by_id(self):
        notification = {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}
        response = {"jsonrpc": "2.0", "id": 7, "result": {}}
        notifications, matched = bridge.route_sse_messages([notification, response], 7)
        self.assertEqual(notifications, [notification])
        self.assertEqual(matched, response)

    def test_order_preserved_when_notification_comes_first(self):
        notification_a = {"jsonrpc": "2.0", "method": "a"}
        notification_b = {"jsonrpc": "2.0", "method": "b"}
        response = {"jsonrpc": "2.0", "id": 7, "result": {}}
        notifications, matched = bridge.route_sse_messages(
            [notification_a, notification_b, response], 7
        )
        self.assertEqual(notifications, [notification_a, notification_b])
        self.assertEqual(matched, response)

    def test_response_only_body(self):
        response = {"jsonrpc": "2.0", "id": 3, "result": {}}
        notifications, matched = bridge.route_sse_messages([response], 3)
        self.assertEqual(notifications, [])
        self.assertEqual(matched, response)

    def test_no_matching_response(self):
        notification = {"jsonrpc": "2.0", "method": "a"}
        notifications, matched = bridge.route_sse_messages([notification], 7)
        self.assertIsNone(matched)
        self.assertEqual(notifications, [notification])

        notifications, matched = bridge.route_sse_messages([], 7)
        self.assertIsNone(matched)
        self.assertEqual(notifications, [])

    def test_different_id_is_not_the_response(self):
        other = {"jsonrpc": "2.0", "id": 99, "result": {}}
        notifications, matched = bridge.route_sse_messages([other], 7)
        self.assertIsNone(matched)
        self.assertEqual(notifications, [other])


class BuildErrorTests(unittest.TestCase):
    def test_shape(self):
        self.assertEqual(
            bridge.build_error(5, -32000, "boom"),
            {"jsonrpc": "2.0", "id": 5, "error": {"code": -32000, "message": "boom"}},
        )


class ResolveResponseMessagesTests(unittest.TestCase):
    def test_application_json_well_formed(self):
        payload = {"jsonrpc": "2.0", "id": 1, "result": {}}
        raw = json.dumps(payload).encode()
        self.assertEqual(
            bridge.resolve_response_messages("application/json", raw, 1, 200),
            [payload],
        )

    def test_application_json_with_charset(self):
        payload = {"jsonrpc": "2.0", "id": 1, "result": {}}
        raw = json.dumps(payload).encode()
        self.assertEqual(
            bridge.resolve_response_messages(
                "application/json; charset=utf-8", raw, 1, 200
            ),
            [payload],
        )

    def test_event_stream_response_only(self):
        payload = {"jsonrpc": "2.0", "id": 1, "result": {}}
        body = "data: " + json.dumps(payload) + "\n\n"
        self.assertEqual(
            bridge.resolve_response_messages(
                "text/event-stream", body.encode(), 1, 200
            ),
            [payload],
        )

    def test_event_stream_notification_then_response(self):
        notification = {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}
        response = {"jsonrpc": "2.0", "id": 1, "result": {}}
        body = (
            "data: " + json.dumps(notification) + "\n\n"
            "data: " + json.dumps(response) + "\n\n"
        )
        self.assertEqual(
            bridge.resolve_response_messages(
                "text/event-stream", body.encode(), 1, 200
            ),
            [notification, response],
        )

    def test_event_stream_malformed_no_data_json(self):
        body = "data: not-json-at-all\n\n"
        self.assertEqual(
            bridge.resolve_response_messages(
                "text/event-stream", body.encode(), 1, 200
            ),
            [bridge.build_error(1, -32000, "non-JSON response (HTTP 200)")],
        )

    def test_event_stream_no_message_matches_request_id(self):
        notification = {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}
        body = "data: " + json.dumps(notification) + "\n\n"
        self.assertEqual(
            bridge.resolve_response_messages(
                "text/event-stream", body.encode(), 1, 200
            ),
            [notification, bridge.build_error(1, -32000, "non-JSON response (HTTP 200)")],
        )

    def test_malformed_application_json_body(self):
        self.assertEqual(
            bridge.resolve_response_messages(
                "application/json", b"not json", 1, 200
            ),
            [bridge.build_error(1, -32000, "non-JSON response (HTTP 200)")],
        )

    def test_empty_body(self):
        self.assertEqual(
            bridge.resolve_response_messages("application/json", b"", 1, 202),
            [bridge.build_error(1, -32000, "empty response (HTTP 202)")],
        )


class ConcurrencyTests(unittest.TestCase):
    def _run_main(self, fake_urlopen, lines):
        stdin = io.StringIO("\n".join(lines) + "\n")
        out = io.StringIO()
        with mock.patch(
            "obsidian_mcp_bridge.urllib.request.urlopen", fake_urlopen
        ), mock.patch("sys.stdout", out):
            start = time.monotonic()
            bridge.main(argv=["bridge.py", "http://fake.local/mcp", "tok"], stdin=stdin)
            elapsed = time.monotonic() - start
        return out.getvalue(), elapsed

    def test_two_slow_requests_run_in_parallel(self):
        # Concurrency proof without wall-clock bounds: each tool call blocks
        # until BOTH calls are in flight. A serial bridge would never reach
        # in_flight == 2, so the bounded wait fails the first call instead of
        # deadlocking, and both_in_flight stays unset.
        both_in_flight = threading.Event()
        counter_lock = threading.Lock()
        in_flight = 0

        def fake_urlopen(req, timeout=None):
            nonlocal in_flight
            payload = json.loads(req.data.decode("utf-8"))
            req_id = payload.get("id")
            if req_id in (1, 2):
                with counter_lock:
                    in_flight += 1
                    if in_flight == 2:
                        both_in_flight.set()
                if not both_in_flight.wait(timeout=5.0):
                    raise urllib.error.URLError("request never became concurrent")
            body = json.dumps({"jsonrpc": "2.0", "id": req_id, "result": {}}).encode()
            return _FakeResponse(200, {"Content-Type": "application/json"}, body)

        lines = [
            json.dumps({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {}}),
        ]
        out, _ = self._run_main(fake_urlopen, lines)
        self.assertTrue(both_in_flight.is_set())
        received = [json.loads(line) for line in out.strip().splitlines()]
        self.assertEqual(len(received), 3)
        self.assertEqual({msg["id"] for msg in received}, {0, 1, 2})

    def test_slow_failure_does_not_affect_fast_concurrent_request(self):
        def fake_urlopen(req, timeout=None):
            payload = json.loads(req.data.decode("utf-8"))
            req_id = payload.get("id")
            if req_id == 1:
                raise urllib.error.URLError("boom")
            body = json.dumps({"jsonrpc": "2.0", "id": req_id, "result": {}}).encode()
            return _FakeResponse(200, {"Content-Type": "application/json"}, body)

        lines = [
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {}}),
        ]
        out, _ = self._run_main(fake_urlopen, lines)
        messages = {msg["id"]: msg for msg in (json.loads(l) for l in out.strip().splitlines())}
        self.assertIn("bridge POST failed", messages[1]["error"]["message"])
        self.assertEqual(messages[2].get("result"), {})

    def test_sse_notification_then_response_two_stdout_lines(self):
        def fake_urlopen(req, timeout=None):
            notification = {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}
            response = {"jsonrpc": "2.0", "id": 5, "result": {}}
            body = (
                "data: " + json.dumps(notification) + "\n\n"
                "data: " + json.dumps(response) + "\n\n"
            ).encode()
            return _FakeResponse(200, {"Content-Type": "text/event-stream"}, body)

        lines = [
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {"name": "activate_tools"},
                }
            ),
        ]
        out, _ = self._run_main(fake_urlopen, lines)
        received = [json.loads(line) for line in out.strip().splitlines()]
        self.assertEqual(len(received), 2)
        self.assertNotIn("id", received[0])
        self.assertEqual(received[1].get("id"), 5)

    def test_negotiated_protocol_version_header_on_concurrent_requests(self):
        # Pins the "single write before any worker thread" claim from
        # ADR-0012: after initialize negotiates a version, every follow-up
        # request thread must send it in the MCP-Protocol-Version header.
        seen_headers = {}
        headers_lock = threading.Lock()

        def fake_urlopen(req, timeout=None):
            payload = json.loads(req.data.decode("utf-8"))
            req_id = payload.get("id")
            with headers_lock:
                seen_headers[req_id] = req.get_header("Mcp-protocol-version")
            if payload.get("method") == "initialize":
                result = {"protocolVersion": "2099-01-01"}
            else:
                result = {}
            body = json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}).encode()
            return _FakeResponse(200, {"Content-Type": "application/json"}, body)

        lines = [
            json.dumps({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {}}),
        ]
        self._run_main(fake_urlopen, lines)
        self.assertIsNone(seen_headers[0])
        self.assertEqual(seen_headers[1], "2099-01-01")
        self.assertEqual(seen_headers[2], "2099-01-01")

    def test_stdin_eof_with_no_pending_work_returns_promptly(self):
        def fake_urlopen(req, timeout=None):
            payload = json.loads(req.data.decode("utf-8"))
            body = json.dumps(
                {"jsonrpc": "2.0", "id": payload.get("id"), "result": {}}
            ).encode()
            return _FakeResponse(200, {"Content-Type": "application/json"}, body)

        lines = [
            json.dumps({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}),
        ]
        _, elapsed = self._run_main(fake_urlopen, lines)
        self.assertLess(elapsed, 1.0)


if __name__ == "__main__":
    unittest.main()
