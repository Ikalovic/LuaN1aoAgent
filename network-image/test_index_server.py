import json
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
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

from index_server import (
    FlowIndex,
    GatewayControl,
    body_record,
    capture_gate_command,
    configure_gateway_firewall,
    ensure_conntrack_accounting,
    file_is_nonempty,
    flow_record,
    mitm_command,
    prepare_tun_gate_ready_file,
    publish_gateway_ready,
    route_gate_command,
)


class FramedFlowReader:
    starts: list[int] = []
    delay = 0.0

    def __init__(self, source) -> None:
        self.source = source
        self.starts.append(source.tell())

    def stream(self):
        while True:
            header = self.source.readline()
            if not header:
                return
            if not header.endswith(b"\n"):
                raise sys.modules["mitmproxy.exceptions"].FlowReadException("partial header")
            try:
                length = int(header[:-1])
            except ValueError as error:
                raise sys.modules["mitmproxy.exceptions"].FlowReadException("invalid header") from error
            payload = self.source.read(length)
            if len(payload) != length:
                raise sys.modules["mitmproxy.exceptions"].FlowReadException("partial payload")
            if self.delay:
                time.sleep(self.delay)
            yield SimpleNamespace(id=payload.decode(), started_at=float(payload.decode().split("-")[-1]))


def framed_flow(flow_id: str) -> bytes:
    payload = flow_id.encode()
    return f"{len(payload)}\n".encode() + payload


def indexed_record(path: Path, flow, quota: dict | None = None) -> dict:
    return {
        "id": flow.id,
        "started_at": f"{flow.started_at:020.6f}",
        "source_file": str(path),
        "quota_pressure": bool((quota or {}).get("quota_pressure", False)),
        "evicted_exchanges": int((quota or {}).get("evicted_records", 0)),
    }


class FlowIndexTest(unittest.TestCase):
    def setUp(self) -> None:
        FramedFlowReader.starts.clear()
        FramedFlowReader.delay = 0.0
        self.reader = patch("index_server.io.FlowReader", FramedFlowReader, create=True)
        self.record = patch("index_server.flow_record", side_effect=indexed_record)
        self.reader.start()
        self.record.start()

    def tearDown(self) -> None:
        self.record.stop()
        self.reader.stop()

    def test_reads_only_bytes_after_each_committed_record(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "epoch.mitm"
            first = framed_flow("flow-1")
            second = framed_flow("flow-2")
            path.write_bytes(first + second)
            index = FlowIndex(Path(directory))

            self.assertEqual([record["id"] for record in index.records()], ["flow-2", "flow-1"])
            self.assertEqual([record["id"] for record in index.records()], ["flow-2", "flow-1"])
            with path.open("ab") as output:
                output.write(framed_flow("flow-3"))
            self.assertEqual([record["id"] for record in index.records()], ["flow-3", "flow-2", "flow-1"])

            self.assertEqual(FramedFlowReader.starts, [0, len(first + second)])

    def test_partial_tail_is_retried_from_the_last_complete_record(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "epoch.mitm"
            first = framed_flow("flow-1")
            second = framed_flow("flow-2")
            split = len(second) - 2
            path.write_bytes(first + second[:split])
            index = FlowIndex(Path(directory))

            self.assertEqual([record["id"] for record in index.records()], ["flow-1"])
            with path.open("ab") as output:
                output.write(second[split:])
            self.assertEqual([record["id"] for record in index.records()], ["flow-2", "flow-1"])

            self.assertEqual(FramedFlowReader.starts, [0, len(first)])

    def test_rotation_preserves_inode_records_and_eviction_removes_them(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "epoch.mitm"
            active.write_bytes(framed_flow("flow-1"))
            index = FlowIndex(root)
            self.assertEqual([record["id"] for record in index.records()], ["flow-1"])

            part = root / "epoch.part-000001-n000000001.mitm"
            os.replace(active, part)
            active.write_bytes(framed_flow("flow-2"))
            self.assertEqual([record["id"] for record in index.records()], ["flow-2", "flow-1"])
            self.assertEqual(FramedFlowReader.starts, [0, 0])

            part.unlink()
            (root / "epoch.mitm.quota.json").write_text(json.dumps({
                "quotaPressure": True,
                "evictedExchanges": 1,
            }), encoding="utf-8")
            records = index.records()
            self.assertEqual([record["id"] for record in records], ["flow-2"])
            self.assertTrue(records[0]["quota_pressure"])
            self.assertEqual(records[0]["evicted_exchanges"], 1)

    def test_restart_rebuilds_the_same_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "epoch.mitm").write_bytes(framed_flow("flow-1") + framed_flow("flow-2"))

            first = FlowIndex(root).records()
            second = FlowIndex(root).records()

            self.assertEqual(first, second)
            self.assertEqual(FramedFlowReader.starts, [0, 0])

    def test_concurrent_records_share_one_incremental_scan(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "epoch.mitm").write_bytes(framed_flow("flow-1") + framed_flow("flow-2"))
            index = FlowIndex(root)
            FramedFlowReader.delay = 0.01
            barrier = threading.Barrier(8)

            def read_ids() -> list[str]:
                barrier.wait()
                return [record["id"] for record in index.records()]

            with ThreadPoolExecutor(max_workers=8) as executor:
                snapshots = list(executor.map(lambda _index: read_ids(), range(8)))

            self.assertEqual(snapshots, [["flow-2", "flow-1"]] * 8)
            self.assertEqual(FramedFlowReader.starts, [0])


class RouteProxyTest(unittest.TestCase):
    def test_missing_readiness_file_is_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.ready"
            self.assertFalse(file_is_nonempty(path))
            path.write_bytes(b"")
            self.assertFalse(file_is_nonempty(path))
            path.write_bytes(b"ready\n")
            self.assertTrue(file_is_nonempty(path))

    def test_conntrack_accounting_configuration_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory) / "nf_conntrack_acct"
            status.write_text("1\n", encoding="utf-8")
            ensure_conntrack_accounting(status)
            status.write_text("0\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "disabled"):
                ensure_conntrack_accounting(status)
            status.unlink()
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                ensure_conntrack_accounting(status)

    def test_transparent_capture_accepts_authorized_self_signed_https(self) -> None:
        command = mitm_command()
        self.assertIn("ssl_insecure=true", command)
        self.assertEqual(command[command.index("--pdeathsig") + 1], "TERM")
        self.assertEqual(command[command.index("--mode") + 1], "socks5@1080")
        self.assertIn("connection_strategy=eager", command)
        self.assertFalse(any("transparent" in argument for argument in command))

    def test_gateway_marks_all_executor_protocols_and_routes_only_tcp_to_tun(self) -> None:
        commands: list[list[str]] = []

        def run(command, **_kwargs):
            commands.append(command)
            return MagicMock(returncode=0)

        with patch("index_server.subprocess.run", side_effect=run):
            configure_gateway_firewall()

        set_marks = [command for command in commands if "--set-mark" in command]
        restore_marks = [command for command in commands if "--restore-mark" in command]
        fwmark_rules = [command for command in commands if command[:3] == ["ip", "rule", "add"] and "fwmark" in command]
        later_local = next(command for command in commands if command == ["ip", "rule", "add", "priority", "200", "lookup", "local"])
        old_local = next(command for command in commands if command == ["ip", "rule", "del", "priority", "0", "lookup", "local"])
        self.assertEqual(len(set_marks), 2)
        self.assertEqual(
            {
                (
                    command[command.index("--uid-owner") + 1],
                    command[command.index("--ctstate") + 1],
                )
                for command in set_marks
            },
            {("1000", "NEW"), ("101", "NEW")},
        )
        self.assertEqual(
            {(command[command.index("--uid-owner") + 1], command[command.index("-p") + 1]) for command in restore_marks},
            {("1000", "tcp"), ("101", "tcp")},
        )
        self.assertIn(["ip", "tuntap", "add", "dev", "luanniao0", "mode", "tun", "user", "102", "group", "102"], commands)
        self.assertIn(["ip", "tuntap", "add", "dev", "luanniao1", "mode", "tun", "user", "102", "group", "102"], commands)
        self.assertIn(["ip", "route", "add", "default", "dev", "luanniao0", "table", "4242"], commands)
        self.assertIn(["ip", "route", "add", "default", "dev", "luanniao1", "table", "4243"], commands)
        self.assertEqual([int(rule[rule.index("priority") + 1]) for rule in fwmark_rules], [100, 110])
        self.assertTrue(all(commands.index(rule) < commands.index(later_local) for rule in fwmark_rules))
        self.assertLess(commands.index(later_local), commands.index(old_local))
        self.assertFalse(any("REDIRECT" in command for command in commands))
        self.assertFalse(any("nat" in command for command in commands))

    def test_tun_gates_run_unprivileged_with_separate_owners(self) -> None:
        capture = capture_gate_command()
        route = route_gate_command()

        for command in (capture, route):
            self.assertIn("--reuid=102", command)
            self.assertIn("--no-new-privs", command)
            self.assertEqual(command[command.index("--pdeathsig") + 1], "TERM")
        self.assertEqual(capture[capture.index("--mode") + 1], "capture")
        self.assertEqual(capture[capture.index("--tun") + 1], "luanniao0")
        self.assertEqual(capture[capture.index("--proxy") + 1], "127.0.0.1:1080")
        self.assertNotIn("--routes-file", capture)
        self.assertEqual(route[route.index("--mode") + 1], "route")
        self.assertEqual(route[route.index("--tun") + 1], "luanniao1")
        self.assertEqual(route[route.index("--routes-file") + 1], "/run/luanniao/routes.json")

    def test_gateway_readiness_requires_every_data_plane_component(self) -> None:
        ready = MagicMock()
        conditions = {
            "mitm_listener_ready": True,
            "ca_ready": True,
            "capture_gate_ready": True,
            "route_gate_ready": True,
        }
        for missing in conditions:
            with self.subTest(missing=missing):
                ready.reset_mock()
                incomplete = {**conditions, missing: False}
                self.assertFalse(publish_gateway_ready(ready, **incomplete))
                ready.set.assert_not_called()

        self.assertTrue(publish_gateway_ready(ready, **conditions))
        ready.set.assert_called_once_with()

    def test_tun_ready_file_is_created_by_relay_uid_without_chown_capability(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tun-gate.ready"
            with (
                patch("index_server.subprocess.run") as run,
                patch("index_server.os.chmod") as chmod,
                patch("index_server.os.chown") as chown,
            ):
                prepare_tun_gate_ready_file(path)

        run.assert_called_once_with([
            "setpriv", "--reuid=102", "--regid=102", "--clear-groups",
            "install", "-m", "0600", "/dev/null", str(path),
        ], check=True)
        self.assertEqual(chmod.call_args_list[0].args, (path.parent, 0o733))
        self.assertEqual(chmod.call_args_list[-1].args, (path.parent, 0o755))
        chown.assert_not_called()

    def test_body_api_reports_response_truncated_by_requested_byte_limit(self) -> None:
        record = {
            "request_body": b"request",
            "response_body": b"response-body",
            "request_truncated": False,
            "response_truncated": False,
        }

        response = body_record(record, "flow:test", "response", 8)
        request = body_record(record, "flow:test", "request", 8)

        self.assertEqual(response["bytes"], 8)
        self.assertTrue(response["truncated"])
        self.assertFalse(request["truncated"])

    def test_tcp_flow_record_exposes_directional_bounded_summaries(self) -> None:
        class FakeTCPFlow:
            pass

        flow = FakeTCPFlow()
        flow.id = "flow-one"
        flow.metadata = {"taskRef": "task:test", "requestObservedBytes": 9, "responseObservedBytes": 7}
        flow.timestamp_start = 10.0
        flow.timestamp_end = 11.0
        flow.error = None
        flow.server_conn = SimpleNamespace(address=("192.0.2.10", 22), timestamp_end=11.0)
        flow.client_conn = SimpleNamespace(timestamp_end=11.0)
        flow.messages = [
            SimpleNamespace(from_client=True, content=b"hello"),
            SimpleNamespace(from_client=False, content=b"world"),
            SimpleNamespace(from_client=True, content=b"!"),
        ]

        with patch("index_server.tcp.TCPFlow", FakeTCPFlow):
            record = flow_record(Path("task-test/epoch.mitm"), flow)

        self.assertEqual(record["request_body"], b"hello!")
        self.assertEqual(record["response_body"], b"world")
        self.assertEqual(record["request_observed_bytes"], 9)
        self.assertEqual(record["response_observed_bytes"], 7)
        self.assertTrue(record["request_truncated"])
        self.assertTrue(record["response_truncated"])
        self.assertEqual(record["request_message_count"], 2)
        self.assertEqual(record["response_message_count"], 1)

    def test_gateway_route_update_atomically_writes_normalized_longest_prefix_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            routes_path = root / "run" / "routes.json"
            control = GatewayControl(
                str(root / "gateway.sock"), MagicMock(), root / "epoch.json", root, routes_path
            )
            control.replace_routes([
                {
                    "routeRef": "route:test",
                    "cidr": "172.31.0.7/24",
                    "prefixLength": 24,
                    "socksHost": "192.0.2.10",
                    "socksPort": 22000,
                    "connectionRef": "connection:test",
                },
                {
                    "routeRef": "route:specific",
                    "cidr": "172.31.0.9/32",
                    "prefixLength": 32,
                    "socksHost": "192.0.2.11",
                    "socksPort": 22001,
                },
            ])

            snapshot = json.loads(routes_path.read_text(encoding="utf-8"))
            self.assertEqual([route["cidr"] for route in snapshot["routes"]], ["172.31.0.9/32", "172.31.0.0/24"])
            self.assertEqual(snapshot["routes"][1]["connectionRef"], "connection:test")
            self.assertEqual(routes_path.stat().st_mode & 0o777, 0o644)
            self.assertFalse(routes_path.with_suffix(".tmp").exists())

    def test_gateway_route_validation_keeps_previous_snapshot_on_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            routes_path = root / "routes.json"
            control = GatewayControl(
                str(root / "gateway.sock"), MagicMock(), root / "epoch.json", root, routes_path
            )
            control.replace_routes([{
                "routeRef": "route:stable", "cidr": "172.31.0.0/24", "prefixLength": 24,
                "socksHost": "192.0.2.10", "socksPort": 22000,
            }])
            previous = routes_path.read_bytes()

            invalid_routes = [
                [{"routeRef": "route:bad", "cidr": "172.31.0.0/24", "prefixLength": 25, "socksHost": "192.0.2.10", "socksPort": 22000}],
                [{"routeRef": "route:bad", "cidr": "2001:db8::/64", "prefixLength": 64, "socksHost": "192.0.2.10", "socksPort": 22000}],
                [{"routeRef": "route:bad", "cidr": "172.31.0.0/24", "prefixLength": 24, "socksHost": "192.0.2.10", "socksPort": 0}],
                [
                    {"routeRef": "route:one", "cidr": "172.31.0.0/24", "prefixLength": 24, "socksHost": "192.0.2.10", "socksPort": 22000},
                    {"routeRef": "route:two", "cidr": "172.31.0.7/24", "prefixLength": 24, "socksHost": "192.0.2.11", "socksPort": 22001},
                ],
            ]
            for routes in invalid_routes:
                with self.subTest(routes=routes), self.assertRaises((ValueError, TypeError)):
                    control.replace_routes(routes)
                self.assertEqual(routes_path.read_bytes(), previous)

    def test_gateway_epoch_end_waits_for_zero_active_work_and_returns_fsynced_ack(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epoch_state = root / "epoch.json"
            flow_file = root / "epoch.mitm"
            net_file = root / "epoch.net.jsonl"
            capture_status = root / "capture-status.json"
            conntrack_status = root / "conntrack-status.json"
            flow_file.write_bytes(b"flow-bytes")
            net_file.write_bytes(b"net-bytes")
            epoch_state.write_text(json.dumps({
                "active": True,
                "epochRef": "epoch:test",
                "flowFile": str(flow_file),
                "netFile": str(net_file),
            }))
            capture_status.write_text(json.dumps({"epochs": {"epoch:test": {
                "activeFlowCount": 1,
                "activeTcpCount": 1,
                "persistedSequence": 4,
                "error": "",
            }}}))
            conntrack_status.write_text(json.dumps({"epochs": {"epoch:test": {
                "activeNetworkCount": 1,
                "persistedSequence": 6,
                "error": "",
            }}}))
            drain_calls = 0

            def drain_connections() -> int:
                nonlocal drain_calls
                drain_calls += 1
                if drain_calls == 2:
                    capture_status.write_text(json.dumps({"epochs": {"epoch:test": {
                        "activeFlowCount": 0,
                        "activeTcpCount": 0,
                        "persistedSequence": 5,
                        "error": "",
                    }}}))
                    conntrack_status.write_text(json.dumps({"epochs": {"epoch:test": {
                        "activeNetworkCount": 0,
                        "persistedSequence": 7,
                        "error": "",
                    }}}))
                return 1 if drain_calls == 1 else 0

            control = GatewayControl(
                str(root / "gateway.sock"),
                MagicMock(),
                epoch_state,
                root,
                root / "routes.json",
                capture_status,
                conntrack_status,
                drain_connections,
                1,
            )
            with patch("index_server.time.sleep", return_value=None):
                ack = control.end_epoch({"epochRef": "epoch:test"})

            self.assertGreaterEqual(drain_calls, 4)
            self.assertEqual(ack["activeFlowCount"], 0)
            self.assertEqual(ack["activeTcpCount"], 0)
            self.assertEqual(ack["activeNetworkCount"], 0)
            self.assertEqual(ack["persistedFlowSequence"], 5)
            self.assertEqual(ack["persistedNetworkSequence"], 7)
            self.assertEqual(ack["flowBytes"], len(b"flow-bytes"))
            self.assertEqual(ack["netBytes"], len(b"net-bytes"))
            self.assertTrue(ack["flushed"])
            persisted = json.loads(epoch_state.read_text())
            self.assertFalse(persisted["active"])
            self.assertEqual(persisted["drainAck"], ack)

    def test_gateway_epoch_end_reconciles_stale_telemetry_after_kernel_drain(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epoch_state = root / "epoch.json"
            flow_file = root / "epoch.mitm"
            net_file = root / "epoch.net.jsonl"
            capture_status = root / "capture-status.json"
            conntrack_status = root / "conntrack-status.json"
            flow_file.touch()
            net_file.write_text("network\n")
            epoch_state.write_text(json.dumps({
                "active": True,
                "epochRef": "epoch:stale",
                "flowFile": str(flow_file),
                "netFile": str(net_file),
            }))
            capture_status.write_text(json.dumps({"epochs": {"epoch:stale": {
                "activeFlowCount": 0,
                "activeTcpCount": 0,
                "persistedSequence": 1,
                "error": "",
            }}}))
            conntrack_status.write_text(json.dumps({"epochs": {"epoch:stale": {
                "activeNetworkCount": 4,
                "persistedSequence": 8,
                "error": "",
            }}}))
            reconciliations = 0

            def reconcile(epoch_ref: str) -> None:
                nonlocal reconciliations
                reconciliations += 1
                self.assertEqual(epoch_ref, "epoch:stale")
                conntrack_status.write_text(json.dumps({"epochs": {"epoch:stale": {
                    "activeNetworkCount": 0,
                    "persistedSequence": 12,
                    "error": "",
                }}}))

            control = GatewayControl(
                str(root / "gateway.sock"),
                MagicMock(),
                epoch_state,
                root,
                root / "routes.json",
                capture_status,
                conntrack_status,
                lambda: 0,
                1,
                reconcile,
            )
            with patch("index_server.time.sleep", return_value=None):
                ack = control.end_epoch({"epochRef": "epoch:stale"})

            self.assertEqual(reconciliations, 1)
            self.assertEqual(ack["activeNetworkCount"], 0)
            self.assertEqual(ack["persistedNetworkSequence"], 12)
            self.assertTrue(ack["flushed"])

    def test_gateway_epoch_end_failure_keeps_epoch_active_for_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            epoch_state = root / "epoch.json"
            flow_file = root / "epoch.mitm"
            net_file = root / "epoch.net.jsonl"
            capture_status = root / "capture-status.json"
            conntrack_status = root / "conntrack-status.json"
            flow_file.touch()
            net_file.touch()
            epoch_state.write_text(json.dumps({
                "active": True,
                "epochRef": "epoch:retry",
                "flowFile": str(flow_file),
                "netFile": str(net_file),
            }))
            capture_status.write_text('{"epochs":{}}')
            conntrack_status.write_text('{"epochs":{}}')
            control = GatewayControl(
                str(root / "gateway.sock"),
                MagicMock(),
                epoch_state,
                root,
                root / "routes.json",
                capture_status,
                conntrack_status,
                lambda: 1,
                0.1,
            )

            with patch("index_server.time.monotonic", side_effect=[0.0, 1.0]):
                with self.assertRaisesRegex(RuntimeError, "drain timed out"):
                    control.end_epoch({"epochRef": "epoch:retry"})

            self.assertTrue(json.loads(epoch_state.read_text())["active"])

    def test_gateway_control_reads_fragmented_newline_delimited_request(self) -> None:
        connection = MagicMock()
        connection.recv.side_effect = [
            b'{"command":"routes.',
            b'replace","payload":{"routes":[]}}\nignored',
        ]

        request = GatewayControl._read_request(connection)

        self.assertEqual(request, {"command": "routes.replace", "payload": {"routes": []}})
        self.assertEqual(connection.recv.call_count, 2)

    def test_gateway_control_rejects_request_larger_than_one_mebibyte(self) -> None:
        connection = MagicMock()
        connection.recv.side_effect = [b"x" * (64 << 10)] * 16 + [b"x"]

        with self.assertRaisesRegex(ValueError, "exceeds 1 MiB"):
            GatewayControl._read_request(connection)

if __name__ == "__main__":
    unittest.main()
