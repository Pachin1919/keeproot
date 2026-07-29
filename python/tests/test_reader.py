from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from atlas_analytics.reader import ExportValidationError, load_export, summarize


class ReaderTest(unittest.TestCase):
    def test_reads_valid_export_and_rejects_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = [
                {
                    "export_schema": "atlas.analytics.v1",
                    "record_type": "run",
                    "record_id": "RUN-1",
                    "run_id": "RUN-1",
                    "recorded_at": "2026-07-29T00:00:00.000Z",
                    "status": "closed",
                    "payload": {},
                },
                {
                    "export_schema": "atlas.analytics.v1",
                    "record_type": "policy_decision",
                    "record_id": "DEC-1",
                    "run_id": "RUN-1",
                    "recorded_at": "2026-07-29T00:00:01.000Z",
                    "decision": "pass",
                    "payload": {},
                },
            ]
            body = "".join(f"{json.dumps(record)}\n" for record in records)
            records_path = root / "records.jsonl"
            records_path.write_text(body, encoding="utf-8")
            digest = hashlib.sha256(records_path.read_bytes()).hexdigest()
            (root / "manifest.json").write_text(
                json.dumps(
                    {
                        "export_schema": "atlas.analytics.v1",
                        "record_count": 2,
                        "content_hash": "0" * 64,
                        "files": {"records.jsonl": {"sha256": digest}},
                    }
                ),
                encoding="utf-8",
            )

            _, loaded = load_export(root)
            self.assertEqual(summarize(loaded)["policy_decisions"], {"pass": 1})

            records_path.write_text(f"{body}{{}}\n", encoding="utf-8")
            with self.assertRaises(ExportValidationError):
                load_export(root)


if __name__ == "__main__":
    unittest.main()
