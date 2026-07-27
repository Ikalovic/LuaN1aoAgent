import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

try:
    import mitmproxy
except ModuleNotFoundError:
    package = types.ModuleType("mitmproxy")
    http = types.ModuleType("mitmproxy.http")
    io = types.ModuleType("mitmproxy.io")
    tcp = types.ModuleType("mitmproxy.tcp")
    exceptions = types.ModuleType("mitmproxy.exceptions")
    http.HTTPFlow = type("HTTPFlow", (), {})
    tcp.TCPFlow = type("TCPFlow", (), {})
    exceptions.FlowReadException = type("FlowReadException", (Exception,), {})
    package.http = http
    package.io = io
    package.tcp = tcp
    sys.modules.update({
        "mitmproxy": package,
        "mitmproxy.http": http,
        "mitmproxy.io": io,
        "mitmproxy.tcp": tcp,
        "mitmproxy.exceptions": exceptions,
    })

from flow_capture import CaptureWriter


class FlowCaptureTest(unittest.TestCase):
    def test_route_attribution_reads_runtime_snapshot(self) -> None:
        writer = CaptureWriter()
        flow = SimpleNamespace(server_conn=SimpleNamespace(address=("172.31.0.9", 8080)))
        with tempfile.TemporaryDirectory() as directory:
            routes_path = Path(directory) / "routes.json"
            routes_path.write_text(json.dumps({"routes": [
                {"routeRef": "route:broad", "cidr": "172.31.0.0/24", "prefixLength": 24},
                {"routeRef": "route:specific", "cidr": "172.31.0.9/32", "prefixLength": 32},
            ]}), encoding="utf-8")
            with patch("flow_capture.ROUTES_PATH", routes_path):
                route = writer._route_for_flow(flow)

        self.assertEqual(route["routeRef"], "route:specific")

    def test_replay_context_is_consumed_before_forwarding_and_tags_the_flow(self) -> None:
        writer = CaptureWriter()
        token = "a" * 64
        headers = {"x-luanniao-replay-context": token}
        flow = SimpleNamespace(request=SimpleNamespace(headers=headers), metadata={})

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / f"context-{token}.json"
            path.write_text(json.dumps({
                "replayOf": "task:source:flow",
                "taskRef": "task:source",
                "routeRef": "route:source",
                "connectionRef": "connection:source",
                "attribution": "web-user:test",
            }))
            details = path.stat()
            with (
                patch("flow_capture.REPLAY_CONTEXT_PREFIX", str(Path(directory) / "context-")),
                patch.object(Path, "stat", return_value=SimpleNamespace(
                    st_mode=details.st_mode,
                    st_uid=1000,
                    st_size=details.st_size,
                )),
            ):
                writer._consume_replay_context(flow)

        self.assertNotIn("x-luanniao-replay-context", headers)
        self.assertEqual(flow.metadata["replayOf"], "task:source:flow")
        self.assertEqual(flow.metadata["taskRef"], "task:source")
        self.assertEqual(flow.metadata["routeRef"], "route:source")
        self.assertEqual(flow.metadata["connectionRef"], "connection:source")

    def test_invalid_replay_context_header_is_removed_without_metadata(self) -> None:
        writer = CaptureWriter()
        headers = {"x-luanniao-replay-context": "not-a-token"}
        flow = SimpleNamespace(request=SimpleNamespace(headers=headers), metadata={})

        writer._consume_replay_context(flow)

        self.assertNotIn("x-luanniao-replay-context", headers)
        self.assertEqual(flow.metadata, {})

    def test_tcp_error_persists_failed_flow(self) -> None:
        writer = CaptureWriter()
        flow = object()

        with patch.object(writer, "_write") as write:
            writer.tcp_error(flow)

        write.assert_called_once_with(flow)

    def test_tcp_capture_tracks_directional_observed_and_captured_bytes(self) -> None:
        class FakeTCPFlow:
            def copy(self):
                return copy.deepcopy(self)

        class Writer:
            written = []

            def __init__(self, output):
                self.output = output

            def add(self, flow):
                self.written.append(flow)
                self.output.write(b"flow")

        flow = FakeTCPFlow()
        flow.id = "tcp-one"
        flow.metadata = {"epochRef": "epoch:test", "flowFile": "/tmp/epoch.mitm"}
        flow.server_conn = SimpleNamespace(address=("192.0.2.10", 22))
        flow.messages = [
            SimpleNamespace(from_client=True, content=b"abcd"),
            SimpleNamespace(from_client=False, content=b"efgh"),
        ]
        capture = MagicMock()
        writer = CaptureWriter()
        writer.captures["/tmp/epoch.mitm"] = capture

        with (
            patch("flow_capture.tcp.TCPFlow", FakeTCPFlow),
            patch("flow_capture.io.FlowWriter", Writer, create=True),
            patch("flow_capture.TCP_LIMIT", 6),
        ):
            writer._write(flow)

        saved = Writer.written[-1]
        self.assertEqual(saved.metadata["requestObservedBytes"], 4)
        self.assertEqual(saved.metadata["responseObservedBytes"], 4)
        self.assertFalse(saved.metadata["requestBodyTruncated"])
        self.assertTrue(saved.metadata["responseBodyTruncated"])
        self.assertEqual(saved.messages[0].content, b"abcd")
        self.assertEqual(saved.messages[1].content, b"ef")
        capture.append.assert_called_once_with(b"flow")

    def test_capture_status_tracks_active_flow_until_persistence_completes(self) -> None:
        class FakeHTTPFlow:
            def copy(self):
                return copy.deepcopy(self)

        class Writer:
            def __init__(self, output):
                self.output = output

            def add(self, _flow):
                self.output.write(b"flow")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epoch_state = root / "epoch.json"
            status_path = root / "capture-status.json"
            flow_path = root / "epoch.mitm"
            epoch_state.write_text(json.dumps({
                "active": True,
                "epochRef": "epoch:test",
                "flowFile": str(flow_path),
            }))
            flow = FakeHTTPFlow()
            flow.id = "http-one"
            flow.metadata = {}
            flow.request = SimpleNamespace(headers={}, raw_content=b"request")
            flow.response = SimpleNamespace(raw_content=b"response")
            flow.server_conn = SimpleNamespace(address=("192.0.2.10", 80))
            capture = MagicMock()
            writer = CaptureWriter()
            writer.captures[str(flow_path)] = capture

            with (
                patch("flow_capture.EPOCH_STATE", epoch_state),
                patch("flow_capture.CAPTURE_STATUS_PATH", status_path),
                patch("flow_capture.http.HTTPFlow", FakeHTTPFlow),
                patch("flow_capture.io.FlowWriter", Writer, create=True),
            ):
                writer.request(flow)
                capture_state = json.loads(status_path.read_text())
                self.assertTrue(capture_state["ready"])
                active = capture_state["epochs"]["epoch:test"]
                self.assertEqual(active["activeFlowCount"], 1)
                self.assertEqual(active["activeTcpCount"], 0)
                self.assertEqual(active["persistedSequence"], 0)

                writer.response(flow)
                drained = json.loads(status_path.read_text())["epochs"]["epoch:test"]

            self.assertEqual(drained["activeFlowCount"], 0)
            self.assertEqual(drained["activeTcpCount"], 0)
            self.assertEqual(drained["persistedSequence"], 1)
            capture.append.assert_called_once_with(b"flow")


if __name__ == "__main__":
    unittest.main()
