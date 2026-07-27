import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import replay_client


class FakeResponse:
    status_code = 204

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def iter_bytes(self):
        yield b"response"


class FakeClient:
    requests = []

    def __init__(self, **options):
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def stream(self, method, url, headers, content):
        self.requests.append({
            "method": method,
            "url": url,
            "headers": headers,
            "content": content,
        })
        return FakeResponse()


class ReplayClientTest(unittest.TestCase):
    def test_request_uses_ephemeral_context_and_internal_header(self) -> None:
        FakeClient.requests.clear()
        with tempfile.TemporaryDirectory() as directory:
            actual_path = Path(directory) / "context.json"

            def mapped_path(value):
                self.assertEqual(value, "/run/luanniao-replay-" + "a" * 64 + ".json")
                return actual_path

            with (
                patch("replay_client.secrets.token_hex", return_value="a" * 64),
                patch("replay_client.Path", side_effect=mapped_path),
                patch("replay_client.httpx.Client", FakeClient),
                patch("replay_client.socket.getaddrinfo", return_value=[(None, None, None, None, ("172.31.0.20", 0))]),
            ):
                result = replay_client.replay({
                    "method": "POST",
                    "url": "https://172.31.0.20/test",
                    "headers": [{"name": "X-Test", "value": ""}],
                    "body": "dGVzdA==",
                    "targetCidrs": ["172.31.0.0/24"],
                    "context": {
                        "replayOf": "task:source:flow",
                        "taskRef": "task:source",
                        "routeRef": "route:source",
                    },
                })

        self.assertEqual(result, {"status": 204})
        self.assertFalse(actual_path.exists())
        request = FakeClient.requests[-1]
        self.assertEqual(request["content"], b"test")
        self.assertIn((replay_client.CONTEXT_HEADER, "a" * 64), request["headers"])
        self.assertEqual(request["headers"][0], ("X-Test", ""))

    def test_routed_replay_rejects_a_target_outside_original_cidrs(self) -> None:
        with patch("replay_client.socket.getaddrinfo", return_value=[(None, None, None, None, ("192.0.2.10", 0))]):
            with self.assertRaisesRegex(ValueError, "outside the original route"):
                replay_client.validate_route_target("http://example.test/", ["172.31.0.0/24"])

    def test_routed_replay_rejects_mixed_inside_and_outside_addresses(self) -> None:
        addresses = [
            (None, None, None, None, ("172.31.0.20", 0)),
            (None, None, None, None, ("192.0.2.10", 0)),
        ]
        with patch("replay_client.socket.getaddrinfo", return_value=addresses):
            with self.assertRaisesRegex(ValueError, "outside the original route"):
                replay_client.validate_route_target("http://example.test/", ["172.31.0.0/24"])

    def test_reserved_context_header_cannot_be_supplied(self) -> None:
        with self.assertRaisesRegex(ValueError, "header name"):
            replay_client.validate_headers([{"name": replay_client.CONTEXT_HEADER, "value": "forged"}])


if __name__ == "__main__":
    unittest.main()
