"""Standalone unittest suite for obsidian_mcp_bridge.py.

Run: `python3 -m unittest discover -s scripts -p "test_*.py" -v` from the
repo root. Deliberately NOT part of `.claude/test-cmd` (which stays
`bun test`) — stdlib unittest only, no pytest, per SPEC.md for issue #355.
"""
import json
import unittest

import obsidian_mcp_bridge as bridge


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


if __name__ == "__main__":
    unittest.main()
