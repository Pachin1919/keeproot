from __future__ import annotations

from typing import Any, Iterable


def _integer(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _recovery_outcome(event_type: str) -> str:
    lowered = event_type.lower()
    if "conflict" in lowered or "stopped" in lowered:
        return "conflict_stop"
    if "failed" in lowered or "error" in lowered:
        return "failure"
    if lowered.endswith("rollback_completed") or lowered.endswith("recovery_completed"):
        return "success"
    if "started" in lowered or "requested" in lowered:
        return "started"
    return "unclassified"


def build_fact_views(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Build only the four V1.2 fact views currently consumed by quality checks."""

    items = list(records)
    task_fact = []
    operation_fact = []
    policy_fact = []
    recovery_fact = []

    for item in items:
        record_type = item.get("record_type")
        if record_type == "task_contract":
            payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
            task_fact.append(
                {
                    "task_id": item.get("record_id"),
                    "run_id": item.get("run_id"),
                    "project_id": item.get("project_id"),
                    "recorded_at": item.get("recorded_at"),
                    "status": item.get("status"),
                    "rule_version_id": item.get("rule_version_id"),
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
        elif record_type == "operation_event":
            event_type = str(item.get("event_type") or "")
            operation = {
                "event_id": item.get("record_id"),
                "run_id": item.get("run_id"),
                "recorded_at": item.get("recorded_at"),
                "event_type": event_type,
            }
            operation_fact.append(operation)
            if "rollback" in event_type.lower() or "recovery" in event_type.lower():
                recovery_fact.append(
                    {
                        **operation,
                        "outcome": _recovery_outcome(event_type),
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
    }
    return {
        **facts,
        "counts": {name: len(rows) for name, rows in facts.items()},
    }
