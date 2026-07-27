import json
import tempfile
import unittest
from pathlib import Path

from segmented_capture import SegmentedCapture, capture_base_path, capture_quota_state


def count_fixed_records(path: Path) -> int:
    return len(path.read_bytes()) // 4 if path.exists() else 0


class SegmentedCaptureTest(unittest.TestCase):
    def test_rotates_atomically_and_evicts_exact_record_counts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "epoch.mitm"
            capture = SegmentedCapture(
                base, ".mitm", segment_bytes=5, max_files=2,
                count_records=count_fixed_records, evicted_field="evictedExchanges",
            )

            capture.append(b"aaaa")
            capture.append(b"bbbb")
            capture.append(b"cccc")

            self.assertEqual(base.read_bytes(), b"cccc")
            parts = sorted(base.parent.glob("epoch.part-*.mitm"))
            self.assertEqual([path.read_bytes() for path in parts], [b"bbbb"])
            self.assertEqual(capture_base_path(parts[0], ".mitm"), base)
            quota = capture_quota_state(parts[0], ".mitm", "evictedExchanges")
            self.assertEqual(quota, {"quota_pressure": True, "evicted_records": 1})
            manifest = json.loads(Path(f"{base}.quota.json").read_text())
            self.assertEqual(manifest["quotaBytes"], 10)
            self.assertEqual(manifest["evictedExchanges"], 1)

    def test_recovers_an_interrupted_eviction_without_double_counting(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "epoch.net.jsonl"
            tombstone = base.with_name(".epoch.part-000007-n000000003.net.jsonl.evicted")
            tombstone.write_bytes(b"stale bytes")

            first = SegmentedCapture(base, ".net.jsonl", 32, 2, lambda _path: 0)
            second = SegmentedCapture(base, ".net.jsonl", 32, 2, lambda _path: 0)

            self.assertFalse(tombstone.exists())
            self.assertEqual(first.state()["evictedRecords"], 3)
            self.assertEqual(second.state()["evictedRecords"], 3)
            self.assertEqual(second.next_sequence, 8)


if __name__ == "__main__":
    unittest.main()
