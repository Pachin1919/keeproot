from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .facts import build_fact_views
from .metrics import compute_metrics
from .quality import evaluate_quality
from .reader import load_export
from .reporting import anomalies_jsonl, build_report_assets


MEASUREMENT_GAPS_SCHEMA = "atlas.measurement-gaps.v1"
EVALUATION_SCHEMA = "atlas.analytics.evaluation.v1"
EVALUATOR_VERSION = "1.2.0"


def _metric(
    metric_id: str,
    availability: str,
    evidence_records: int,
    available_fields: list[str],
    missing_fields: list[str],
    reason: str,
) -> dict[str, Any]:
    return {
        "metric_id": metric_id,
        "availability": availability,
        "evidence_records": evidence_records,
        "available_fields": available_fields,
        "missing_fields": missing_fields,
        "reason": reason,
    }


def build_measurement_gaps(
    records: Iterable[dict[str, Any]],
    *,
    source_content_hash: str,
) -> dict[str, Any]:
    """Describe which candidate product metrics the current export can support."""

    items = list(records)
    record_counts = Counter(str(item.get("record_type") or "missing") for item in items)
    tasks = [item for item in items if item.get("record_type") == "task_contract"]
    policies = [item for item in items if item.get("record_type") == "policy_decision"]
    operations = [item for item in items if item.get("record_type") == "operation_event"]
    preference_rules = [
        item for item in items if item.get("record_type") == "preference_rule"
    ]

    context_fields = [
        "selected_count",
        "excluded_count",
        "input_text_bytes",
        "selected_text_bytes",
        "selected_extraction_inputs",
    ]
    context_evidence = [
        item for item in tasks if all(item.get(field) is not None for field in context_fields)
    ]
    context_availability = "available" if context_evidence else "unavailable"

    recovery_events = [
        item
        for item in operations
        if "rollback" in str(item.get("event_type") or "").lower()
        or "recovery" in str(item.get("event_type") or "").lower()
    ]
    explicit_recovery = [
        item
        for item in operations
        if item.get("event_type") == "rollback_outcome_recorded"
    ]
    explicit_rule_evaluations = [
        item
        for item in operations
        if item.get("event_type") == "task_rule_evaluated"
    ]

    metrics = [
        _metric(
            "context_selection_text",
            context_availability,
            len(context_evidence),
            context_fields if context_evidence else [],
            [] if context_evidence else context_fields,
            (
                "Task records separate directly readable text from binary extraction inputs."
                if context_evidence
                else "No Task record contains the five required text-context fields."
            ),
        ),
        _metric(
            "policy_stop_rate",
            "partial",
            len(policies),
            ["decision"],
            ["policy_outcome_class"],
            "Policy results exist, but safety stops are not separated from ordinary denials.",
        ),
        _metric(
            "recovery_outcome",
            "available" if explicit_recovery else ("partial" if recovery_events else "unavailable"),
            len(explicit_recovery or recovery_events),
            (
                ["operation", "outcome", "reason_code", "run_id", "attempt_id"]
                if explicit_recovery
                else (["event_type"] if recovery_events else [])
            ),
            [] if explicit_recovery else [
                "operation",
                "outcome",
                "reason_code",
                "attempt_id",
            ],
            (
                "Explicit rollback outcomes are available from the event enablement point."
                if explicit_recovery
                else (
                    "Legacy recovery events exist, but their outcomes cannot be normalized safely."
                    if recovery_events
                    else "No explicit rollback outcome event is available."
                )
            ),
        ),
        _metric(
            "rule_reuse_rate",
            (
                "available"
                if explicit_rule_evaluations
                else ("partial" if preference_rules else "unavailable")
            ),
            len(explicit_rule_evaluations or preference_rules),
            (
                [
                    "task_id",
                    "eligible_rule_ids",
                    "applied_rule_ids",
                    "rule_version_ids",
                    "evaluated_at",
                ]
                if explicit_rule_evaluations
                else (
                    ["preference_rule", "rule_version_id"]
                    if preference_rules
                    else []
                )
            ),
            [] if explicit_rule_evaluations else [
                "eligible_rule_ids",
                "applied_rule_ids",
                "evaluated_at",
            ],
            (
                "Explicit Task rule eligibility and application facts are available from the event enablement point."
                if explicit_rule_evaluations
                else (
                    "Rule records exist, but historical Task eligibility and application cannot be inferred."
                    if preference_rules
                    else "No explicit Task rule evaluation event is available."
                )
            ),
        ),
        _metric(
            "review_burden",
            "unavailable",
            0,
            [],
            ["review_requested"],
            "The Runtime does not record a normalized review request event.",
        ),
        _metric(
            "user_success",
            "unavailable",
            0,
            [],
            ["user_result_label"],
            "The Runtime does not record a user result label for completed tasks.",
        ),
        _metric(
            "actual_model_tokens",
            "unavailable",
            0,
            [],
            ["host_measured_input_tokens", "host_measured_output_tokens"],
            "The Agent host does not provide measured token usage in the current export.",
        ),
    ]
    availability_counts = Counter(item["availability"] for item in metrics)

    return {
        "schema": MEASUREMENT_GAPS_SCHEMA,
        "source": {
            "content_hash": source_content_hash,
            "record_count": len(items),
            "record_types": dict(sorted(record_counts.items())),
        },
        "availability_counts": {
            state: availability_counts.get(state, 0)
            for state in ("available", "partial", "unavailable")
        },
        "metrics": metrics,
    }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_measurement_gap_evaluation(
    export_dir: str | Path,
    output_dir: str | Path,
    *,
    evaluation_id: str,
) -> dict[str, Any]:
    """Publish the current V1.2 facts, quality, and measurement-gap slice."""

    manifest, records = load_export(export_dir)
    target = Path(output_dir).resolve()
    target.mkdir(parents=True, exist_ok=False)

    report = build_measurement_gaps(
        records,
        source_content_hash=manifest["content_hash"],
    )
    gaps_path = target / "measurement-gaps.json"
    gaps_path.write_text(
        f"{json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    gaps_hash = _sha256(gaps_path)
    facts = build_fact_views(records)
    quality = evaluate_quality(records, facts)
    quality_path = target / "quality.json"
    quality_path.write_text(
        f"{json.dumps(quality, ensure_ascii=False, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    quality_hash = _sha256(quality_path)
    files = {
        "measurement-gaps.json": {
            "sha256": gaps_hash,
            "bytes": gaps_path.stat().st_size,
        },
        "quality.json": {
            "sha256": quality_hash,
            "bytes": quality_path.stat().st_size,
        },
    }
    metrics_hash = None
    metric_count = 0
    if quality["status"] == "FAIL":
        evaluation_status = "quality_failed"
        evaluation_complete = False
        pandas_version = None
        cross_check = None
        next_required = ["fix_quality_errors"]
    else:
        metrics = compute_metrics(
            facts,
            source_content_hash=manifest["content_hash"],
        )
        metrics_path = target / "metrics.json"
        metrics_path.write_text(
            f"{json.dumps(metrics, ensure_ascii=False, indent=2, sort_keys=True)}\n",
            encoding="utf-8",
        )
        metrics_hash = _sha256(metrics_path)
        metric_count = len(metrics["metrics"])
        files["metrics.json"] = {
            "sha256": metrics_hash,
            "bytes": metrics_path.stat().st_size,
        }
        assets = build_report_assets(facts, quality, report, metrics)
        asset_bodies = {
            "anomalies.jsonl": anomalies_jsonl(assets["anomalies"]),
            "analysis_context.md": assets["analysis_context"],
            "report.md": assets["report"],
        }
        for filename, body in asset_bodies.items():
            asset_path = target / filename
            asset_path.write_text(body, encoding="utf-8")
            files[filename] = {
                "sha256": _sha256(asset_path),
                "bytes": asset_path.stat().st_size,
            }
        evaluation_status = "ready_for_interpretation"
        evaluation_complete = True
        pandas_version = assets["pandas_version"]
        cross_check = assets["cross_check"]
        next_required = []
    evaluation_manifest = {
        "evaluation_schema": EVALUATION_SCHEMA,
        "evaluation_id": evaluation_id,
        "evaluator_version": EVALUATOR_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": evaluation_status,
        "complete": evaluation_complete,
        "pandas_version": pandas_version,
        "pandas_cross_check": cross_check,
        "source_export": {
            "export_schema": manifest["export_schema"],
            "ledger_schema": manifest.get("ledger_schema"),
            "content_hash": manifest["content_hash"],
            "record_count": manifest["record_count"],
        },
        "files": files,
        "measurement_gaps_hash": gaps_hash,
        "quality_hash": quality_hash,
        "metrics_hash": metrics_hash,
        "next_required": next_required,
    }
    manifest_path = target / "manifest.json"
    manifest_path.write_text(
        f"{json.dumps(evaluation_manifest, ensure_ascii=False, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    return {
        "evaluation_id": evaluation_id,
        "status": evaluation_status,
        "complete": evaluation_complete,
        "measurement_gaps_hash": gaps_hash,
        "quality_hash": quality_hash,
        "metrics_hash": metrics_hash,
        "metric_count": metric_count,
        "pandas_version": pandas_version,
        "pandas_cross_check": cross_check,
        "quality_status": quality["status"],
        "fact_counts": facts["counts"],
        "availability_counts": report["availability_counts"],
    }
