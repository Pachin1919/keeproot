from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any


METRICS_SCHEMA = "atlas.analytics.metrics.v1"
PACKAGE_ROOT = Path(__file__).resolve().parent


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _load_contract() -> tuple[dict[str, Any], str]:
    path = PACKAGE_ROOT / "contracts" / "context_selection_text_byte_rate.v1.json"
    body = path.read_bytes()
    return json.loads(body), _sha256(body)


def _load_sql() -> str:
    return (
        PACKAGE_ROOT / "sql" / "context_selection_text_byte_rate.v1.sql"
    ).read_text(
        encoding="utf-8"
    )


def compute_metrics(
    facts: dict[str, Any],
    *,
    source_content_hash: str,
) -> dict[str, Any]:
    """Compute official metrics through versioned SQL and one explicit contract."""

    contract, contract_hash = _load_contract()
    task_rows = facts.get("task_fact", [])
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    try:
        connection.execute(
            """
            CREATE TABLE task_fact (
              task_id TEXT PRIMARY KEY,
              run_id TEXT,
              project_id TEXT,
              recorded_at TEXT,
              status TEXT,
              rule_version_id TEXT,
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
        with connection:
            connection.executemany(
                """
                INSERT INTO task_fact VALUES (
                  :task_id, :run_id, :project_id, :recorded_at, :status,
                  :rule_version_id, :input_count, :selected_count, :excluded_count,
                  :input_bytes, :selected_bytes, :input_text_bytes,
                  :selected_text_bytes, :input_binary_bytes,
                  :selected_binary_bytes, :selected_extraction_inputs
                )
                """,
                task_rows,
            )
        row = connection.execute(_load_sql()).fetchone()
    finally:
        connection.close()

    numerator = int(row["numerator"])
    denominator = int(row["denominator"])
    eligible_rows = int(row["eligible_rows"])
    pure_binary_rows = sum(
        1
        for item in task_rows
        if (item.get("input_text_bytes") or 0) == 0
        and (item.get("input_binary_bytes") or 0) > 0
    )
    missing_text_measurement_rows = sum(
        1
        for item in task_rows
        if item.get("input_text_bytes") is None
        or item.get("selected_text_bytes") is None
    )
    invalid_text_bounds_rows = sum(
        1
        for item in task_rows
        if item.get("input_text_bytes") is not None
        and item.get("selected_text_bytes") is not None
        and (
            item["input_text_bytes"] < 0
            or item["selected_text_bytes"] < 0
            or item["selected_text_bytes"] > item["input_text_bytes"]
        )
    )
    metric = {
        "metric_id": contract["metric_id"],
        "contract_version": contract["version"],
        "contract_hash": contract_hash,
        "unit": contract["unit"],
        "numerator": numerator,
        "denominator": denominator,
        "value": round(numerator / denominator, 6) if denominator else None,
        "eligible_rows": eligible_rows,
        "excluded_rows": len(task_rows) - eligible_rows,
        "exclusion_counts": {
            "pure_binary_extraction_tasks": pure_binary_rows,
            "missing_text_measurement": missing_text_measurement_rows,
            "invalid_text_bounds": invalid_text_bounds_rows,
        },
        "limitations": contract["limitations"],
    }
    return {
        "schema": METRICS_SCHEMA,
        "source_content_hash": source_content_hash,
        "contract_set_hash": _sha256(
            f"{contract['metric_id']}:{contract_hash}".encode("utf-8")
        ),
        "metrics": [metric],
    }
