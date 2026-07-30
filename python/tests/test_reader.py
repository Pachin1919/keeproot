from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from atlas_analytics.evaluation import (
    build_measurement_gaps,
    write_measurement_gap_evaluation,
)
from atlas_analytics.facts import build_fact_views
from atlas_analytics.metrics import compute_metrics
from atlas_analytics.quality import evaluate_quality
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

            first = write_measurement_gap_evaluation(
                root, root / "evaluation-one", evaluation_id="EVAL-ONE"
            )
            second = write_measurement_gap_evaluation(
                root, root / "evaluation-two", evaluation_id="EVAL-TWO"
            )
            self.assertEqual(first["status"], "ready_for_interpretation")
            self.assertTrue(first["complete"])
            self.assertEqual(
                first["measurement_gaps_hash"], second["measurement_gaps_hash"]
            )
            self.assertEqual(first["quality_hash"], second["quality_hash"])
            self.assertEqual(first["metrics_hash"], second["metrics_hash"])
            self.assertEqual(first["metric_count"], 3)
            self.assertEqual(first["pandas_cross_check"]["status"], "PASS")
            empty_metrics = json.loads(
                (root / "evaluation-one" / "metrics.json").read_text(
                    encoding="utf-8"
                )
            )["metrics"]
            for metric_id in (
                "context_selection_text_byte_rate",
                "recovery_outcome_distribution",
                "rule_reuse_rate",
            ):
                metric = next(
                    item for item in empty_metrics if item["metric_id"] == metric_id
                )
                self.assertEqual(metric["availability"], "unavailable")
                self.assertIsNone(metric["denominator"])
            self.assertEqual(
                (root / "evaluation-one" / "anomalies.jsonl").read_text(
                    encoding="utf-8"
                ),
                "",
            )

            records_path.write_text(f"{body}{{}}\n", encoding="utf-8")
            with self.assertRaises(ExportValidationError):
                load_export(root)

    def test_measurement_gap_audit_distinguishes_available_partial_and_unavailable(self) -> None:
        records = [
            {
                "export_schema": "atlas.analytics.v1",
                "record_type": "task_contract",
                "record_id": "TSK-1",
                "run_id": "TSK-1",
                "recorded_at": "2026-07-29T00:00:00.000Z",
                "status": "completed",
                "selected_count": 2,
                "excluded_count": 1,
                "input_bytes": 300,
                "selected_bytes": 200,
                "input_text_bytes": 300,
                "selected_text_bytes": 200,
                "selected_extraction_inputs": 0,
                "payload": {},
            },
            {
                "export_schema": "atlas.analytics.v1",
                "record_type": "policy_decision",
                "record_id": "DEC-1",
                "run_id": "TSK-1",
                "recorded_at": "2026-07-29T00:00:01.000Z",
                "decision": "deny",
                "payload": {},
            },
            {
                "export_schema": "atlas.analytics.v1",
                "record_type": "operation_event",
                "record_id": "EVT-1",
                "run_id": "TSK-1",
                "recorded_at": "2026-07-29T00:00:02.000Z",
                "event_type": "rollback_completed",
                "payload": {},
            },
        ]

        report = build_measurement_gaps(records, source_content_hash="a" * 64)
        by_id = {item["metric_id"]: item for item in report["metrics"]}

        self.assertEqual(by_id["context_selection_text"]["availability"], "available")
        self.assertEqual(by_id["policy_stop_rate"]["availability"], "partial")
        self.assertEqual(by_id["recovery_outcome"]["availability"], "partial")
        self.assertEqual(by_id["rule_reuse_rate"]["availability"], "unavailable")
        self.assertEqual(by_id["review_burden"]["availability"], "unavailable")
        self.assertEqual(by_id["user_success"]["availability"], "unavailable")
        self.assertEqual(by_id["actual_model_tokens"]["availability"], "unavailable")
        self.assertEqual(report["availability_counts"], {
            "available": 1,
            "partial": 2,
            "unavailable": 4,
        })

    def test_fact_views_feed_a_deterministic_quality_gate(self) -> None:
        records = [
            {
                "export_schema": "atlas.analytics.v1",
                "record_type": "run",
                "record_id": "RUN-1",
                "run_id": "RUN-1",
                "recorded_at": "2026-07-29T00:00:00.000Z",
                "status": "closed",
                "actor": "agent",
                "tool": "codex",
                "payload": {},
            },
            {
                "export_schema": "atlas.analytics.v1",
                "record_type": "task_contract",
                "record_id": "TSK-1",
                "run_id": "RUN-1",
                "project_id": "PRJ-1",
                "recorded_at": "2026-07-29T00:00:01.000Z",
                "status": "completed",
                "selected_count": 1,
                "excluded_count": 1,
                "input_bytes": 100,
                "selected_bytes": 80,
                "input_text_bytes": 100,
                "selected_text_bytes": 80,
                "input_binary_bytes": 0,
                "selected_binary_bytes": 0,
                "selected_extraction_inputs": 0,
                "payload": {"input_count": 2},
            },
            {
                "export_schema": "atlas.analytics.v1",
                "record_type": "policy_decision",
                "record_id": "DEC-1",
                "run_id": "RUN-1",
                "recorded_at": "2026-07-29T00:00:02.000Z",
                "decision": "pass",
                "payload": {},
            },
            {
                "export_schema": "atlas.analytics.v1",
                "record_type": "operation_event",
                "record_id": "EVT-1",
                "run_id": "RUN-1",
                "recorded_at": "2026-07-29T00:00:03.000Z",
                "event_type": "guarded_rollback_completed",
                "payload": {},
            },
        ]

        facts = build_fact_views(records)
        quality = evaluate_quality(records, facts)
        self.assertEqual(
            facts["counts"],
            {
                "task_fact": 1,
                "operation_fact": 1,
                "policy_fact": 1,
                "recovery_fact": 0,
                "rule_application_fact": 0,
            },
        )
        self.assertEqual(quality["status"], "PASS")
        self.assertEqual(quality["critical_errors"], 0)

        duplicate = [*records, dict(records[0])]
        failed = evaluate_quality(duplicate, build_fact_views(duplicate))
        self.assertEqual(failed["status"], "FAIL")
        self.assertIn("duplicate_record_id", {item["check_id"] for item in failed["checks"]})

    def test_metric_contracts_and_sql_produce_deterministic_official_metrics(self) -> None:
        facts = {
            "task_fact": [
                {
                    "task_id": "TSK-1",
                    "run_id": "RUN-1",
                    "project_id": "PRJ-1",
                    "recorded_at": "2026-07-29T00:00:00.000Z",
                    "status": "completed",
                    "rule_version_id": None,
                    "input_count": 2,
                    "selected_count": 1,
                    "excluded_count": 1,
                    "input_bytes": 100,
                    "selected_bytes": 80,
                    "input_text_bytes": 100,
                    "selected_text_bytes": 80,
                    "input_binary_bytes": 0,
                    "selected_binary_bytes": 0,
                    "selected_extraction_inputs": 0,
                },
                {
                    "task_id": "TSK-2",
                    "run_id": "RUN-2",
                    "project_id": "PRJ-1",
                    "recorded_at": "2026-07-29T00:00:00.000Z",
                    "status": "completed",
                    "rule_version_id": None,
                    "input_count": 2,
                    "selected_count": 1,
                    "excluded_count": 1,
                    "input_bytes": 100,
                    "selected_bytes": 50,
                    "input_text_bytes": 100,
                    "selected_text_bytes": 50,
                    "input_binary_bytes": 0,
                    "selected_binary_bytes": 0,
                    "selected_extraction_inputs": 0,
                },
                {
                    "task_id": "TSK-3",
                    "run_id": "RUN-3",
                    "project_id": "PRJ-1",
                    "recorded_at": "2026-07-29T00:00:00.000Z",
                    "status": "prepared",
                    "rule_version_id": None,
                    "input_count": 0,
                    "selected_count": 0,
                    "excluded_count": 0,
                    "input_bytes": 0,
                    "selected_bytes": 0,
                    "input_text_bytes": 0,
                    "selected_text_bytes": 0,
                    "input_binary_bytes": 2400,
                    "selected_binary_bytes": 2400,
                    "selected_extraction_inputs": 1,
                },
            ],
            "recovery_fact": [
                {
                    "event_id": "EVT-R1-A",
                    "run_id": "RUN-R1",
                    "recorded_at": "2026-07-29T00:00:01.000Z",
                    "operation": "rollback",
                    "outcome": "completed",
                    "reason_code": "restored_and_verified",
                    "attempt_id": "RBK-ONE",
                },
                {
                    "event_id": "EVT-R1-B",
                    "run_id": "RUN-R1",
                    "recorded_at": "2026-07-29T00:00:02.000Z",
                    "operation": "rollback",
                    "outcome": "completed",
                    "reason_code": "restored_and_verified",
                    "attempt_id": "RBK-ONE",
                },
                {
                    "event_id": "EVT-R2",
                    "run_id": "RUN-R2",
                    "recorded_at": "2026-07-29T00:00:03.000Z",
                    "operation": "rollback",
                    "outcome": "conflict_safe_stop",
                    "reason_code": "later_file_state_conflict",
                    "attempt_id": "RBK-TWO",
                },
            ],
            "rule_application_fact": [
                {
                    "event_id": "EVT-T1",
                    "task_id": "TSK-1",
                    "recorded_at": "2026-07-29T00:00:00.000Z",
                    "evaluated_at": "2026-07-29T00:00:00.000Z",
                    "status": "completed",
                    "actor": "agent",
                    "tool": "codex",
                    "eligible_rule_ids": ["PREF-1"],
                    "applied_rule_ids": ["PREF-1"],
                    "rule_version_ids": ["RULE-1"],
                    "corrected": False,
                },
                {
                    "event_id": "EVT-T2",
                    "task_id": "TSK-2",
                    "recorded_at": "2026-07-29T00:00:00.000Z",
                    "evaluated_at": "2026-07-29T00:00:00.000Z",
                    "status": "completed",
                    "actor": "agent",
                    "tool": "codex",
                    "eligible_rule_ids": ["PREF-1"],
                    "applied_rule_ids": [],
                    "rule_version_ids": ["RULE-1"],
                    "corrected": True,
                },
                {
                    "event_id": "EVT-T3",
                    "task_id": "TSK-3",
                    "recorded_at": "2026-07-29T00:00:00.000Z",
                    "evaluated_at": "2026-07-29T00:00:00.000Z",
                    "status": "completed",
                    "actor": "agent",
                    "tool": "codex",
                    "eligible_rule_ids": [],
                    "applied_rule_ids": [],
                    "rule_version_ids": [],
                    "corrected": False,
                },
            ],
        }

        result = compute_metrics(facts, source_content_hash="b" * 64)
        self.assertEqual(len(result["metrics"]), 3)
        metric = result["metrics"][0]
        self.assertEqual(metric["metric_id"], "context_selection_text_byte_rate")
        self.assertEqual(metric["numerator"], 130)
        self.assertEqual(metric["denominator"], 200)
        self.assertEqual(metric["value"], 0.65)
        self.assertEqual(metric["eligible_rows"], 2)
        self.assertEqual(metric["eligible_task_ids"], ["TSK-1", "TSK-2"])
        self.assertEqual(metric["excluded_rows"], 1)
        self.assertEqual(metric["exclusion_counts"], {
            "pure_binary_extraction_tasks": 1,
            "missing_text_measurement": 0,
            "invalid_text_bounds": 0,
            "no_direct_text_input": 0,
        })
        self.assertRegex(metric["contract_hash"], r"^[a-f0-9]{64}$")
        recovery = result["metrics"][1]
        self.assertEqual(recovery["metric_id"], "recovery_outcome_distribution")
        self.assertEqual(recovery["denominator"], 2)
        self.assertEqual(recovery["outcome_counts"], {
            "completed": 1,
            "conflict_safe_stop": 1,
            "failed": 0,
            "cancelled": 0,
        })
        self.assertEqual(recovery["duplicate_events_deduplicated"], 1)
        rule_reuse = result["metrics"][2]
        self.assertEqual(rule_reuse["metric_id"], "rule_reuse_rate")
        self.assertEqual(rule_reuse["numerator"], 1)
        self.assertEqual(rule_reuse["denominator"], 2)
        self.assertEqual(rule_reuse["value"], 0.5)
        self.assertEqual(rule_reuse["numerator_task_ids"], ["TSK-1"])
        self.assertEqual(rule_reuse["denominator_task_ids"], ["TSK-1", "TSK-2"])
        self.assertEqual(rule_reuse["corrected_task_ids"], ["TSK-2"])
        self.assertEqual(
            rule_reuse["excluded_task_ids"]["first_scenario"],
            ["TSK-3"],
        )


if __name__ == "__main__":
    unittest.main()
