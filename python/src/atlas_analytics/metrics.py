from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import Counter
from pathlib import Path
from typing import Any


METRICS_SCHEMA = "atlas.analytics.metrics.v1"
PACKAGE_ROOT = Path(__file__).resolve().parent
OUTCOMES = ("completed", "conflict_safe_stop", "failed", "cancelled")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _load_contract(name: str) -> tuple[dict[str, Any], str]:
    path = PACKAGE_ROOT / "contracts" / f"{name}.v1.json"
    body = path.read_bytes()
    return json.loads(body), _sha256(body)


def _load_sql(name: str) -> str:
    return (PACKAGE_ROOT / "sql" / f"{name}.v1.sql").read_text(encoding="utf-8")


def _json_list(value: list[str]) -> str:
    return json.dumps(sorted(set(value)), separators=(",", ":"))


def _context_metric(
    connection: sqlite3.Connection,
    task_rows: list[dict[str, Any]],
    contract: dict[str, Any],
    contract_hash: str,
) -> dict[str, Any]:
    row = connection.execute(
        _load_sql("context_selection_text_byte_rate")
    ).fetchone()
    eligible_rows = int(row["eligible_rows"])
    eligible_task_ids = (
        str(row["eligible_task_ids"]).split("|") if row["eligible_task_ids"] else []
    )
    numerator = int(row["numerator"]) if row["numerator"] is not None else None
    denominator = (
        int(row["denominator"]) if row["denominator"] is not None else None
    )
    exclusion_details = []
    for item in sorted(task_rows, key=lambda value: str(value.get("task_id"))):
        if item.get("task_id") in eligible_task_ids:
            continue
        input_text = item.get("input_text_bytes")
        selected_text = item.get("selected_text_bytes")
        input_binary = item.get("input_binary_bytes")
        if input_text is None or selected_text is None:
            reason = "missing_text_measurement"
        elif input_text == 0 and (input_binary or 0) > 0:
            reason = "pure_binary_extraction_task"
        elif (
            input_text < 0
            or selected_text < 0
            or selected_text > input_text
        ):
            reason = "invalid_text_bounds"
        else:
            reason = "no_direct_text_input"
        exclusion_details.append({"task_id": item.get("task_id"), "reason": reason})
    exclusion_counts = Counter(item["reason"] for item in exclusion_details)
    return {
        "metric_id": contract["metric_id"],
        "contract_version": contract["version"],
        "contract_hash": contract_hash,
        "availability": "available" if eligible_rows else "unavailable",
        "unit": contract["unit"],
        "numerator": numerator,
        "denominator": denominator,
        "value": (
            round(numerator / denominator, 6)
            if numerator is not None and denominator
            else None
        ),
        "eligible_rows": eligible_rows,
        "eligible_task_ids": eligible_task_ids,
        "excluded_rows": len(exclusion_details),
        "excluded_task_ids": [
            item["task_id"] for item in exclusion_details
        ],
        "exclusion_counts": {
            "pure_binary_extraction_tasks": exclusion_counts[
                "pure_binary_extraction_task"
            ],
            "missing_text_measurement": exclusion_counts[
                "missing_text_measurement"
            ],
            "invalid_text_bounds": exclusion_counts["invalid_text_bounds"],
            "no_direct_text_input": exclusion_counts["no_direct_text_input"],
        },
        "exclusion_details": exclusion_details,
        "limitations": contract["limitations"],
    }


def _recovery_metric(
    connection: sqlite3.Connection,
    raw_count: int,
    contract: dict[str, Any],
    contract_hash: str,
) -> dict[str, Any]:
    rows = [
        dict(row)
        for row in connection.execute(
            _load_sql("recovery_outcome_distribution")
        ).fetchall()
    ]
    if not rows:
        return {
            "metric_id": contract["metric_id"],
            "contract_version": contract["version"],
            "contract_hash": contract_hash,
            "availability": "unavailable",
            "coverage": "explicit_events_only",
            "unit": contract["unit"],
            "denominator": None,
            "outcome_counts": None,
            "outcomes": None,
            "duplicate_events_deduplicated": None,
            "limitations": contract["limitations"],
        }
    outcomes = {}
    for outcome in OUTCOMES:
        selected = [item for item in rows if item["outcome"] == outcome]
        outcomes[outcome] = {
            "count": len(selected),
            "run_ids": sorted({str(item["run_id"]) for item in selected}),
            "attempt_ids": sorted({str(item["attempt_id"]) for item in selected}),
            "reason_codes": sorted({str(item["reason_code"]) for item in selected}),
        }
    return {
        "metric_id": contract["metric_id"],
        "contract_version": contract["version"],
        "contract_hash": contract_hash,
        "availability": "available",
        "coverage": "partial_history_explicit_events_only",
        "unit": contract["unit"],
        "denominator": len(rows),
        "outcome_counts": {
            outcome: outcomes[outcome]["count"] for outcome in OUTCOMES
        },
        "outcomes": outcomes,
        "duplicate_events_deduplicated": raw_count - len(rows),
        "limitations": contract["limitations"],
    }


def _rule_reuse_metric(
    connection: sqlite3.Connection,
    contract: dict[str, Any],
    contract_hash: str,
) -> dict[str, Any]:
    rows = [
        dict(row)
        for row in connection.execute(_load_sql("rule_reuse_rate")).fetchall()
    ]
    if not rows:
        return {
            "metric_id": contract["metric_id"],
            "contract_version": contract["version"],
            "contract_hash": contract_hash,
            "availability": "unavailable",
            "coverage": "explicit_events_only",
            "unit": contract["unit"],
            "numerator": None,
            "denominator": None,
            "value": None,
            "numerator_task_ids": [],
            "denominator_task_ids": [],
            "corrected_task_ids": [],
            "eligible_unmatched_task_ids": [],
            "excluded_task_ids": {
                "first_scenario": [],
                "cancelled": [],
                "test": [],
                "incomplete": [],
            },
            "limitations": contract["limitations"],
        }
    denominator_ids = sorted(
        str(item["task_id"]) for item in rows if item["population"] == "eligible"
    )
    numerator_ids = sorted(
        str(item["task_id"])
        for item in rows
        if item["population"] == "eligible" and item["matched"] == 1
    )
    corrected_ids = sorted(
        str(item["task_id"]) for item in rows if item["corrected"] == 1
    )
    exclusions = {
        population: sorted(
            str(item["task_id"])
            for item in rows
            if item["population"] == population
        )
        for population in ("first_scenario", "cancelled", "test", "incomplete")
    }
    denominator = len(denominator_ids)
    numerator = len(numerator_ids)
    return {
        "metric_id": contract["metric_id"],
        "contract_version": contract["version"],
        "contract_hash": contract_hash,
        "availability": "available",
        "coverage": "partial_history_explicit_events_only",
        "unit": contract["unit"],
        "numerator": numerator,
        "denominator": denominator,
        "value": round(numerator / denominator, 6) if denominator else None,
        "numerator_task_ids": numerator_ids,
        "denominator_task_ids": denominator_ids,
        "corrected_task_ids": corrected_ids,
        "eligible_unmatched_task_ids": sorted(
            set(denominator_ids) - set(numerator_ids)
        ),
        "excluded_task_ids": exclusions,
        "limitations": contract["limitations"],
    }


def compute_metrics(
    facts: dict[str, Any],
    *,
    source_content_hash: str,
) -> dict[str, Any]:
    """Compute the three official V1.2 metrics through versioned SQL."""

    contract_names = [
        "context_selection_text_byte_rate",
        "recovery_outcome_distribution",
        "rule_reuse_rate",
    ]
    loaded = {name: _load_contract(name) for name in contract_names}
    task_rows = facts.get("task_fact", [])
    recovery_rows = facts.get("recovery_fact", [])
    rule_rows = facts.get("rule_application_fact", [])
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    try:
        connection.execute(
            """
            CREATE TABLE task_fact (
              task_id TEXT PRIMARY KEY,
              contract_id TEXT,
              run_id TEXT,
              project_id TEXT,
              recorded_at TEXT,
              status TEXT,
              rule_version_id TEXT,
              actor TEXT,
              tool TEXT,
              input_count INTEGER,
              selected_count INTEGER,
              excluded_count INTEGER,
              input_bytes INTEGER,
              selected_bytes INTEGER,
              input_text_bytes INTEGER,
              selected_text_bytes INTEGER,
              input_binary_bytes INTEGER,
              selected_binary_bytes INTEGER,
              selected_extraction_inputs INTEGER
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE recovery_fact (
              event_id TEXT PRIMARY KEY,
              run_id TEXT,
              recorded_at TEXT,
              operation TEXT,
              outcome TEXT,
              reason_code TEXT,
              attempt_id TEXT
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE rule_application_fact (
              event_id TEXT PRIMARY KEY,
              task_id TEXT,
              recorded_at TEXT,
              evaluated_at TEXT,
              status TEXT,
              actor TEXT,
              tool TEXT,
              eligible_rule_ids TEXT,
              applied_rule_ids TEXT,
              rule_version_ids TEXT,
              corrected INTEGER,
              eligible_count INTEGER,
              applied_eligible_count INTEGER
            )
            """
        )
        with connection:
            if task_rows:
                connection.executemany(
                    """
                    INSERT INTO task_fact VALUES (
                      :task_id, :contract_id, :run_id, :project_id, :recorded_at,
                      :status, :rule_version_id, :actor, :tool, :input_count,
                      :selected_count, :excluded_count, :input_bytes,
                      :selected_bytes, :input_text_bytes, :selected_text_bytes,
                      :input_binary_bytes, :selected_binary_bytes,
                      :selected_extraction_inputs
                    )
                    """,
                    [
                        {
                            "contract_id": item.get("contract_id"),
                            "actor": item.get("actor"),
                            "tool": item.get("tool"),
                            **item,
                        }
                        for item in task_rows
                    ],
                )
            if recovery_rows:
                connection.executemany(
                    """
                    INSERT INTO recovery_fact VALUES (
                      :event_id, :run_id, :recorded_at, :operation, :outcome,
                      :reason_code, :attempt_id
                    )
                    """,
                    recovery_rows,
                )
            if rule_rows:
                normalized_rule_rows = []
                for item in rule_rows:
                    eligible = set(item.get("eligible_rule_ids") or [])
                    applied = set(item.get("applied_rule_ids") or [])
                    normalized_rule_rows.append(
                        {
                            **item,
                            "eligible_rule_ids": _json_list(list(eligible)),
                            "applied_rule_ids": _json_list(list(applied)),
                            "rule_version_ids": _json_list(
                                item.get("rule_version_ids") or []
                            ),
                            "corrected": 1 if item.get("corrected") else 0,
                            "eligible_count": len(eligible),
                            "applied_eligible_count": len(eligible.intersection(applied)),
                        }
                    )
                connection.executemany(
                    """
                    INSERT INTO rule_application_fact VALUES (
                      :event_id, :task_id, :recorded_at, :evaluated_at, :status,
                      :actor, :tool, :eligible_rule_ids, :applied_rule_ids,
                      :rule_version_ids, :corrected, :eligible_count,
                      :applied_eligible_count
                    )
                    """,
                    normalized_rule_rows,
                )
        context_contract, context_hash = loaded[
            "context_selection_text_byte_rate"
        ]
        recovery_contract, recovery_hash = loaded[
            "recovery_outcome_distribution"
        ]
        rule_contract, rule_hash = loaded["rule_reuse_rate"]
        metrics = [
            _context_metric(
                connection, task_rows, context_contract, context_hash
            ),
            _recovery_metric(
                connection, len(recovery_rows), recovery_contract, recovery_hash
            ),
            _rule_reuse_metric(connection, rule_contract, rule_hash),
        ]
    finally:
        connection.close()

    return {
        "schema": METRICS_SCHEMA,
        "source_content_hash": source_content_hash,
        "contract_set_hash": _sha256(
            "\n".join(
                f"{name}:{loaded[name][1]}" for name in contract_names
            ).encode("utf-8")
        ),
        "metrics": metrics,
    }
