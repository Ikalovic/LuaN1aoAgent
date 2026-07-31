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
    def test_request_uses_out_of_band_context_without_internal_header(self) -> None:
        FakeClient.requests.clear()
        with tempfile.TemporaryDirectory() as directory:
            actual_path = Path(directory) / "context.json"
            with (
                patch.object(replay_client, "CONTEXT_PATH", actual_path),
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
        self.assertEqual(request["headers"][0], ("X-Test", ""))
        self.assertFalse(any(name.lower() == "x-luanniao-replay-context" for name, _ in request["headers"]))

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

    def test_old_context_header_is_not_control_metadata(self) -> None:
        self.assertEqual(
            replay_client.validate_headers([{"name": "X-Luanniao-Replay-Context", "value": "application-value"}]),
            [("X-Luanniao-Replay-Context", "application-value")],
        )


if __name__ == "__main__":
    unittest.main()
