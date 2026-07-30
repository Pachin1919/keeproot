from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Any, Iterable


QUALITY_SCHEMA = "atlas.analytics.quality.v1"
POLICY_DECISIONS = {"allow", "warn", "deny", "guarded", "tracked_direct", "pass"}
RECOVERY_OUTCOMES = {"completed", "conflict_safe_stop", "failed", "cancelled"}


def _timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _check(
    check_id: str,
    severity: str,
    issue_ids: list[str],
    description: str,
) -> dict[str, Any]:
    issue_count = len(issue_ids)
    return {
        "check_id": check_id,
        "severity": severity,
        "status": "PASS" if issue_count == 0 else severity,
        "issue_count": issue_count,
        "sample_record_ids": issue_ids[:5],
        "description": description,
    }


def evaluate_quality(
    records: Iterable[dict[str, Any]],
    facts: dict[str, Any],
) -> dict[str, Any]:
    items = list(records)
    keys = [(str(item.get("record_type")), str(item.get("record_id"))) for item in items]
    key_counts = Counter(keys)
    duplicate_ids = [f"{kind}:{record_id}" for (kind, record_id), count in key_counts.items() if count > 1]

    missing_required = [
        str(item.get("record_id") or f"row-{index}")
        for index, item in enumerate(items)
        if not item.get("record_type") or not item.get("record_id") or not item.get("recorded_at")
    ]
    invalid_timestamps = [
        str(item.get("record_id"))
        for item in items
        if item.get("recorded_at") and _timestamp(item.get("recorded_at")) is None
    ]

    run_rows = [item for item in items if item.get("record_type") == "run"]
    run_ids = {item.get("run_id") or item.get("record_id") for item in run_rows}
    run_started = {
        item.get("run_id") or item.get("record_id"): _timestamp(item.get("recorded_at"))
        for item in run_rows
    }
    missing_run_references = [
        str(item.get("record_id"))
        for item in items
        if item.get("record_type") != "run"
        and item.get("run_id")
        and item.get("run_id") not in run_ids
    ]
    event_before_run = [
        str(item.get("record_id"))
        for item in items
        if item.get("record_type") != "run"
        and item.get("run_id") in run_started
        and _timestamp(item.get("recorded_at")) is not None
        and run_started[item.get("run_id")] is not None
        and _timestamp(item.get("recorded_at")) < run_started[item.get("run_id")]
    ]

    invalid_task_bounds = []
    missing_task_project = []
    for task in facts["task_fact"]:
        task_id = str(task.get("task_id"))
        selected = task.get("selected_count")
        excluded = task.get("excluded_count")
        inputs = task.get("input_count")
        input_bytes = task.get("input_bytes")
        selected_bytes = task.get("selected_bytes")
        input_text_bytes = task.get("input_text_bytes")
        selected_text_bytes = task.get("selected_text_bytes")
        input_binary_bytes = task.get("input_binary_bytes")
        selected_binary_bytes = task.get("selected_binary_bytes")
        selected_extraction_inputs = task.get("selected_extraction_inputs")
        numeric = [
            value
            for value in (
                selected,
                excluded,
                inputs,
                input_bytes,
                selected_bytes,
                input_text_bytes,
                selected_text_bytes,
                input_binary_bytes,
                selected_binary_bytes,
                selected_extraction_inputs,
            )
            if value is not None
        ]
        if any(value < 0 for value in numeric):
            invalid_task_bounds.append(task_id)
        elif inputs is not None and selected is not None and selected > inputs:
            invalid_task_bounds.append(task_id)
        elif input_bytes is not None and selected_bytes is not None and selected_bytes > input_bytes:
            invalid_task_bounds.append(task_id)
        elif (
            input_text_bytes is not None
            and selected_text_bytes is not None
            and selected_text_bytes > input_text_bytes
        ):
            invalid_task_bounds.append(task_id)
        elif (
            input_binary_bytes is not None
            and selected_binary_bytes is not None
            and selected_binary_bytes > input_binary_bytes
        ):
            invalid_task_bounds.append(task_id)
        if not task.get("project_id"):
            missing_task_project.append(task_id)

    invalid_policy = [
        str(policy.get("decision_id"))
        for policy in facts["policy_fact"]
        if policy.get("decision") not in POLICY_DECISIONS
    ]
    missing_caller = [
        str(item.get("record_id"))
        for item in run_rows
        if not item.get("actor") or not item.get("tool")
    ]
    invalid_recovery_contract = []
    invalid_rule_evaluation_contract = []
    task_ids = {str(item.get("task_id")) for item in facts["task_fact"]}
    for item in items:
        if item.get("record_type") != "operation_event":
            continue
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
        if item.get("event_type") == "rollback_outcome_recorded":
            if (
                payload.get("operation") != "rollback"
                or payload.get("outcome") not in RECOVERY_OUTCOMES
                or not isinstance(payload.get("reason_code"), str)
                or not payload.get("reason_code")
                or not isinstance(payload.get("attempt_id"), str)
                or not payload.get("attempt_id")
                or payload.get("run_id") != item.get("run_id")
            ):
                invalid_recovery_contract.append(str(item.get("record_id")))
        elif item.get("event_type") == "task_rule_evaluated":
            task_id = payload.get("task_id")
            if (
                not isinstance(task_id, str)
                or task_id not in task_ids
                or not isinstance(payload.get("eligible_rule_ids"), list)
                or not isinstance(payload.get("applied_rule_ids"), list)
                or not isinstance(payload.get("rule_version_ids"), list)
                or _timestamp(payload.get("evaluated_at")) is None
            ):
                invalid_rule_evaluation_contract.append(str(item.get("record_id")))

    checks = [
        _check("duplicate_record_id", "FAIL", sorted(duplicate_ids), "Record IDs must be unique within each record type."),
        _check("required_fields", "FAIL", missing_required, "Every record needs type, ID, and recorded_at."),
        _check("timestamp_format", "FAIL", invalid_timestamps, "recorded_at must be a valid ISO timestamp."),
        _check("run_reference", "FAIL", missing_run_references, "Records with run_id must reference an exported run."),
        _check("event_order", "FAIL", event_before_run, "A child record cannot occur before its run starts."),
        _check("task_bounds", "FAIL", invalid_task_bounds, "Task counts and bytes must be non-negative and internally bounded."),
        _check("policy_enum", "FAIL", invalid_policy, "Policy decisions must use the exported V1 vocabulary."),
        _check("caller_metadata", "WARN", missing_caller, "Run actor and tool should be recorded."),
        _check("task_project", "WARN", missing_task_project, "Task facts should identify one Project."),
        _check(
            "recovery_outcome_contract",
            "FAIL",
            invalid_recovery_contract,
            "Explicit rollback outcomes require operation, outcome, reason_code, matching run_id, and attempt_id.",
        ),
        _check(
            "task_rule_evaluation_contract",
            "FAIL",
            invalid_rule_evaluation_contract,
            "Task rule evaluation requires an exported Task, explicit eligible/applied/version lists, and evaluated_at.",
        ),
    ]
    critical_errors = sum(check["issue_count"] for check in checks if check["severity"] == "FAIL")
    warnings = sum(check["issue_count"] for check in checks if check["severity"] == "WARN")
    return {
        "schema": QUALITY_SCHEMA,
        "status": "FAIL" if critical_errors else ("WARN" if warnings else "PASS"),
        "record_count": len(items),
        "fact_counts": facts["counts"],
        "critical_errors": critical_errors,
        "warnings": warnings,
        "checks": checks,
    }
