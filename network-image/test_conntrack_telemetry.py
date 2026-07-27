import json
import tempfile
import unittest
from pathlib import Path

from conntrack_telemetry import AGENT_INTENT_MARK, ConntrackEpochTracker, parse_conntrack_line, stream_conntrack_epochs


class ConntrackTelemetryTest(unittest.TestCase):
    def test_keeps_only_marked_executor_intent_for_tcp_udp_and_icmp(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "epoch.json"
            output = root / "epoch.net.jsonl"
            routes = root / "routes.json"
            state.write_text(json.dumps({"active": True, "epochRef": "epoch:1", "netFile": str(output)}))
            routes.write_text(json.dumps({"routes": [{
                "routeRef": "route:test", "connectionRef": "connection:test",
                "cidr": "172.31.0.0/24", "prefixLength": 24,
            }]}))
            mark = f"mark={AGENT_INTENT_MARK:#x}"
            events = [
                f"[10.0] [NEW] ipv4 2 tcp 6 30 SYN_SENT src=10.0.0.2 dst=172.31.0.20 sport=50000 dport=80 {mark}\n",
                "[10.1] [NEW] ipv4 2 tcp 6 30 SYN_SENT src=10.0.0.2 dst=172.31.0.20 sport=50001 dport=80\n",
                "[10.2] [NEW] ipv4 2 tcp 6 30 SYN_SENT src=127.0.0.1 dst=10.0.0.3 sport=8080 dport=41000 mark=0\n",
                f"[10.3] [NEW] ipv4 2 udp 17 30 src=10.0.0.2 dst=8.8.8.8 sport=50002 dport=53 {mark}\n",
                f"[10.4] [NEW] ipv4 2 icmp 1 30 src=10.0.0.2 dst=172.31.0.21 type=8 code=0 id=3 {mark}\n",
            ]

            stream_conntrack_epochs(
                events,
                {"run_ref": "run:test", "task_ref": "task:test"},
                routes,
                state,
                AGENT_INTENT_MARK,
            )

            records = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual([record["protocol"] for record in records], ["tcp", "udp", "icmp"])
            self.assertTrue(all(record["origin"] == "executor" for record in records))
            self.assertEqual(records[0]["destination"], {"host": "172.31.0.20", "port": 80})
            self.assertEqual(records[0]["route_ref"], "route:test")
            self.assertNotIn("route_ref", records[1])
            self.assertNotIn("route_ref", records[2])

    def test_normalizes_and_attributes_routed_tcp(self) -> None:
        starts = {}
        metadata = {"run_ref": "run:test", "task_ref": "task:test", "epoch_ref": "epoch:test"}
        routes = [{
            "routeRef": "route:test", "connectionRef": "connection:test",
            "cidr": "172.31.0.0/24", "prefixLength": 24,
        }]
        line = (
            "[1784779441.722724] [NEW] ipv4 2 tcp 6 120 SYN_SENT "
            "src=192.168.207.4 dst=172.31.0.20 sport=37760 dport=80 packets=2 bytes=120 "
            "[UNREPLIED] src=127.0.0.1 dst=192.168.207.4 sport=8080 dport=37760 packets=0 bytes=0"
        )

        record = parse_conntrack_line(line, metadata, routes, starts)

        self.assertEqual(record["kind"], "network_connection")
        self.assertEqual(record["destination"], {"host": "172.31.0.20", "port": 80})
        self.assertEqual(record["bytes_original"], 120)
        self.assertTrue(record["network_ref"].startswith("net:"))
        self.assertEqual(record["route_ref"], "route:test")
        self.assertEqual(record["connection_ref"], "connection:test")
        self.assertNotIn("session_ref", record)
        self.assertEqual(record["task_ref"], "task:test")

    def test_preserves_connection_start_until_destroy(self) -> None:
        starts = {}
        metadata = {"run_ref": "run:test", "task_ref": "task:test", "epoch_ref": "epoch:test"}
        opened = parse_conntrack_line(
            "[10.0] [NEW] ipv4 2 udp 17 30 src=10.0.0.2 dst=8.8.8.8 sport=50000 dport=53",
            metadata, [], starts,
        )
        closed = parse_conntrack_line(
            "[12.0] [DESTROY] ipv4 2 udp 17 30 src=10.0.0.2 dst=8.8.8.8 sport=50000 dport=53 packets=1 bytes=32",
            metadata, [], starts,
        )

        self.assertEqual(closed["connection_ref"], opened["connection_ref"])
        self.assertEqual(closed["started_at"], opened["started_at"])
        self.assertEqual(closed["ended_at"], "1970-01-01T00:00:12Z")

    def test_icmp_identity_includes_type_code_and_identifier(self) -> None:
        starts = {}
        metadata = {"run_ref": "run:test", "task_ref": "task:test", "epoch_ref": "epoch:test"}
        first = parse_conntrack_line(
            "[10.0] [NEW] ipv4 2 icmp 1 30 src=10.0.0.2 dst=192.0.2.10 type=8 code=0 id=3",
            metadata, [], starts,
        )
        second = parse_conntrack_line(
            "[10.0] [NEW] ipv4 2 icmp 1 30 src=10.0.0.2 dst=192.0.2.10 type=8 code=0 id=4",
            metadata, [], starts,
        )
        closed = parse_conntrack_line(
            "[12.0] [DESTROY] ipv4 2 icmp 1 30 src=10.0.0.2 dst=192.0.2.10 type=8 code=0 id=3 packets=1 bytes=84",
            metadata, [], starts,
        )

        self.assertNotEqual(first["network_ref"], second["network_ref"])
        self.assertEqual(first["network_ref"], closed["network_ref"])
        self.assertEqual(first["icmp"], {"type": 8, "code": 0, "id": 3})

    def test_connection_keeps_the_epoch_that_observed_its_start(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "epoch.json"
            first = root / "epoch-1.net.jsonl"
            second = root / "epoch-2.net.jsonl"

            def events():
                state.write_text(json.dumps({"active": True, "epochRef": "epoch:1", "netFile": str(first)}))
                yield "[10.0] [NEW] ipv4 2 tcp 6 30 SYN_SENT src=10.0.0.2 dst=192.0.2.10 sport=50000 dport=80\n"
                state.write_text(json.dumps({"active": True, "epochRef": "epoch:2", "netFile": str(second)}))
                yield "[12.0] [DESTROY] ipv4 2 tcp 6 30 src=10.0.0.2 dst=192.0.2.10 sport=50000 dport=80 packets=1 bytes=32\n"

            stream_conntrack_epochs(
                events(),
                {"run_ref": "run:test", "task_ref": "task:test"},
                root / "routes.json",
                state,
            )

            records = [json.loads(line) for line in first.read_text().splitlines()]
            self.assertEqual([record["event"] for record in records], ["new", "destroy"])
            self.assertEqual({record["epoch_ref"] for record in records}, {"epoch:1"})
            self.assertFalse(second.exists())

    def test_connection_keeps_route_attribution_after_route_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "epoch.json"
            output = root / "epoch.net.jsonl"
            routes = root / "routes.json"
            state.write_text(json.dumps({"active": True, "epochRef": "epoch:1", "netFile": str(output)}))

            def events():
                routes.write_text(json.dumps({"routes": [{
                    "routeRef": "route:test", "connectionRef": "connection:test",
                    "cidr": "172.31.0.0/24", "prefixLength": 24,
                }]}))
                yield "[10.0] [NEW] ipv4 2 tcp 6 30 SYN_SENT src=10.0.0.2 dst=172.31.0.20 sport=50000 dport=80\n"
                routes.write_text('{"routes":[]}')
                yield "[12.0] [DESTROY] ipv4 2 tcp 6 30 src=10.0.0.2 dst=172.31.0.20 sport=50000 dport=80 packets=1 bytes=32\n"

            stream_conntrack_epochs(
                events(),
                {"run_ref": "run:test", "task_ref": "task:test"},
                routes,
                state,
            )

            records = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual({record["network_ref"] for record in records}, {records[0]["network_ref"]})
            self.assertEqual({record["route_ref"] for record in records}, {"route:test"})
            self.assertEqual({record["connection_ref"] for record in records}, {"connection:test"})

    def test_epoch_status_reaches_zero_only_after_destroy_is_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "epoch.json"
            output = root / "epoch.net.jsonl"
            status = root / "conntrack-status.json"
            state.write_text(json.dumps({
                "active": True,
                "epochRef": "epoch:status",
                "netFile": str(output),
            }))
            events = [
                "[10.0] [NEW] ipv4 2 tcp 6 30 SYN_SENT src=10.0.0.2 dst=192.0.2.10 sport=50000 dport=80\n",
                "[12.0] [DESTROY] ipv4 2 tcp 6 30 src=10.0.0.2 dst=192.0.2.10 sport=50000 dport=80 packets=1 bytes=32\n",
            ]

            stream_conntrack_epochs(
                events,
                {"run_ref": "run:test", "task_ref": "task:test"},
                root / "routes.json",
                state,
                status_path=status,
            )

            epoch_status = json.loads(status.read_text())["epochs"]["epoch:status"]
            self.assertEqual(epoch_status["activeNetworkCount"], 0)
            self.assertEqual(epoch_status["persistedSequence"], 2)
            self.assertEqual(epoch_status["error"], "")

    def test_runtime_drain_closes_stale_owners_and_rejects_queued_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "epoch.json"
            output = root / "epoch.net.jsonl"
            status = root / "conntrack-status.json"
            state.write_text(json.dumps({
                "active": True,
                "epochRef": "epoch:drain",
                "netFile": str(output),
            }))
            tracker = ConntrackEpochTracker(status)

            def events():
                yield "[10.0] [NEW] ipv4 2 udp 17 30 src=10.0.0.2 dst=8.8.8.8 sport=50000 dport=53\n"
                tracker.close_epoch("epoch:drain")
                yield "[10.1] [UPDATE] ipv4 2 udp 17 30 src=10.0.0.2 dst=8.8.8.8 sport=50000 dport=53\n"

            stream_conntrack_epochs(
                events(),
                {"run_ref": "run:test", "task_ref": "task:test"},
                root / "routes.json",
                state,
                status_path=status,
                tracker=tracker,
            )

            records = [json.loads(line) for line in output.read_text().splitlines()]
            self.assertEqual([record["event"] for record in records], ["new", "destroy"])
            self.assertEqual(records[-1]["state"], "closed")
            self.assertIn("runtime_drained", records[-1]["flags"])
            epoch_status = json.loads(status.read_text())["epochs"]["epoch:drain"]
            self.assertEqual(epoch_status["activeNetworkCount"], 0)
            self.assertEqual(epoch_status["persistedSequence"], 2)
            self.assertEqual(tracker.starts, {})


if __name__ == "__main__":
    unittest.main()
