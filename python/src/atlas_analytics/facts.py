from __future__ import annotations

from typing import Any, Iterable


RECOVERY_OUTCOMES = {
    "completed",
    "conflict_safe_stop",
    "failed",
    "cancelled",
}


def _integer(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _payload(item: dict[str, Any]) -> dict[str, Any]:
    value = item.get("payload")
    return value if isinstance(value, dict) else {}


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({item for item in value if isinstance(item, str) and item})


def build_fact_views(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Build the five V1.2 fact views consumed by quality and metrics."""

    items = list(records)
    run_rows = {
        str(item.get("run_id") or item.get("record_id")): item
        for item in items
        if item.get("record_type") == "run"
    }
    task_fact: list[dict[str, Any]] = []
    operation_fact: list[dict[str, Any]] = []
    policy_fact: list[dict[str, Any]] = []
    recovery_fact: list[dict[str, Any]] = []
    rule_application_fact: list[dict[str, Any]] = []

    for item in items:
        if item.get("record_type") != "task_contract":
            continue
        payload = _payload(item)
        task_id = str(item.get("run_id") or item.get("record_id"))
        run = run_rows.get(task_id, {})
        task_fact.append(
            {
                "task_id": task_id,
                "contract_id": item.get("record_id"),
                "run_id": item.get("run_id"),
                "project_id": item.get("project_id"),
                "recorded_at": item.get("recorded_at"),
                "status": item.get("status"),
                "rule_version_id": item.get("rule_version_id"),
                "actor": item.get("actor") or run.get("actor"),
                "tool": item.get("tool") or run.get("tool"),
                "input_count": _integer(payload.get("input_count")),
                "selected_count": _integer(item.get("selected_count")),
                "excluded_count": _integer(item.get("excluded_count")),
                "input_bytes": _integer(item.get("input_bytes")),
                "selected_bytes": _integer(item.get("selected_bytes")),
                "input_text_bytes": _integer(item.get("input_text_bytes")),
                "selected_text_bytes": _integer(item.get("selected_text_bytes")),
                "input_binary_bytes": _integer(item.get("input_binary_bytes")),
                "selected_binary_bytes": _integer(
                    item.get("selected_binary_bytes")
                ),
                "selected_extraction_inputs": _integer(
                    item.get("selected_extraction_inputs")
                ),
            }
        )

    task_by_id = {str(item["task_id"]): item for item in task_fact}
    corrected_rules_by_task: dict[str, set[str]] = {}
    for item in items:
        if (
            item.get("record_type") != "label"
            or item.get("event_type") != "task_rule_application_review"
            or item.get("decision") != "corrected"
        ):
            continue
        task_id = str(item.get("run_id") or "")
        details = _payload(item).get("details")
        details = details if isinstance(details, dict) else {}
        rule_id = details.get("rule_id")
        if task_id and isinstance(rule_id, str) and rule_id:
            corrected_rules_by_task.setdefault(task_id, set()).add(rule_id)

    for item in items:
        record_type = item.get("record_type")
        if record_type == "operation_event":
            event_type = str(item.get("event_type") or "")
            payload = _payload(item)
            operation = {
                "event_id": item.get("record_id"),
                "run_id": item.get("run_id"),
                "recorded_at": item.get("recorded_at"),
                "event_type": event_type,
            }
            operation_fact.append(operation)
            if event_type == "rollback_outcome_recorded":
                recovery_fact.append(
                    {
                        "event_id": item.get("record_id"),
                        "run_id": item.get("run_id"),
                        "recorded_at": item.get("recorded_at"),
                        "operation": payload.get("operation"),
                        "outcome": payload.get("outcome"),
                        "reason_code": payload.get("reason_code"),
                        "attempt_id": payload.get("attempt_id"),
                    }
                )
            elif event_type == "task_rule_evaluated":
                task_id = str(payload.get("task_id") or item.get("run_id") or "")
                task = task_by_id.get(task_id, {})
                eligible = _string_list(payload.get("eligible_rule_ids"))
                applied = _string_list(payload.get("applied_rule_ids"))
                corrected_rules = corrected_rules_by_task.get(task_id, set())
                rule_application_fact.append(
                    {
                        "event_id": item.get("record_id"),
                        "task_id": task_id,
                        "recorded_at": item.get("recorded_at"),
                        "evaluated_at": payload.get("evaluated_at"),
                        "status": task.get("status"),
                        "actor": task.get("actor"),
                        "tool": task.get("tool"),
                        "eligible_rule_ids": eligible,
                        "applied_rule_ids": applied,
                        "rule_version_ids": _string_list(
                            payload.get("rule_version_ids")
                        ),
                        "corrected": bool(corrected_rules.intersection(eligible)),
                    }
                )
        elif record_type == "policy_decision":
            policy_fact.append(
                {
                    "decision_id": item.get("record_id"),
                    "run_id": item.get("run_id"),
                    "recorded_at": item.get("recorded_at"),
                    "decision": item.get("decision"),
                    "rule_version_id": item.get("rule_version_id"),
                }
            )

    facts = {
        "task_fact": task_fact,
        "operation_fact": operation_fact,
        "policy_fact": policy_fact,
        "recovery_fact": recovery_fact,
        "rule_application_fact": rule_application_fact,
    }
    return {
        **facts,
        "counts": {name: len(rows) for name, rows in facts.items()},
    }
