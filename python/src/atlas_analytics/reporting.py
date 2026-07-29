from __future__ import annotations

import json
from typing import Any

import pandas as pd


ANOMALY_SCHEMA = "atlas.analytics.anomaly.v1"


def _metric_by_id(metrics: dict[str, Any], metric_id: str) -> dict[str, Any]:
    return next(item for item in metrics["metrics"] if item["metric_id"] == metric_id)


def build_report_assets(
    facts: dict[str, Any],
    quality: dict[str, Any],
    measurement_gaps: dict[str, Any],
    metrics: dict[str, Any],
) -> dict[str, Any]:
    """Cross-check SQL results with Pandas and build bounded reader assets."""

    task_frame = pd.DataFrame(facts.get("task_fact", []))
    if task_frame.empty:
        eligible = task_frame
        pandas_numerator = 0
        pandas_denominator = 0
    else:
        input_bytes = pd.to_numeric(task_frame["input_text_bytes"], errors="coerce")
        selected_bytes = pd.to_numeric(
            task_frame["selected_text_bytes"], errors="coerce"
        )
        mask = (
            input_bytes.notna()
            & input_bytes.gt(0)
            & selected_bytes.notna()
            & selected_bytes.ge(0)
            & selected_bytes.le(input_bytes)
        )
        eligible = task_frame.loc[mask].copy()
        eligible["input_bytes"] = input_bytes.loc[mask].astype("int64")
        eligible["selected_bytes"] = selected_bytes.loc[mask].astype("int64")
        eligible["selection_ratio"] = (
            eligible["selected_bytes"] / eligible["input_bytes"]
        )
        pandas_numerator = int(eligible["selected_bytes"].sum())
        pandas_denominator = int(eligible["input_bytes"].sum())

    official = _metric_by_id(metrics, "context_selection_text_byte_rate")
    if (
        pandas_numerator != official["numerator"]
        or pandas_denominator != official["denominator"]
        or len(eligible) != official["eligible_rows"]
    ):
        raise ValueError("Pandas cross-check does not match the official SQL metric.")

    anomalies = []
    if not task_frame.empty:
        binary_frame = task_frame.copy()
        binary_frame["input_binary_bytes"] = pd.to_numeric(
            binary_frame["input_binary_bytes"], errors="coerce"
        ).fillna(0)
        binary_frame["selected_binary_bytes"] = pd.to_numeric(
            binary_frame["selected_binary_bytes"], errors="coerce"
        ).fillna(0)
        binary_frame["selected_extraction_inputs"] = pd.to_numeric(
            binary_frame["selected_extraction_inputs"], errors="coerce"
        ).fillna(0)
        binary_frame["input_text_bytes"] = pd.to_numeric(
            binary_frame["input_text_bytes"], errors="coerce"
        ).fillna(0)
        binary_only = binary_frame.loc[
            binary_frame["input_text_bytes"].eq(0)
            & binary_frame["input_binary_bytes"].gt(0)
        ].sort_values(
            by=["input_binary_bytes", "task_id"],
            ascending=[False, True],
            kind="stable",
        )
        for _, row in binary_only.head(5).iterrows():
            anomalies.append(
                {
                    "schema": ANOMALY_SCHEMA,
                    "anomaly_type": "binary_extraction_only_context",
                    "task_id": str(row["task_id"]),
                    "project_id": row.get("project_id"),
                    "input_binary_bytes": int(row["input_binary_bytes"]),
                    "selected_binary_bytes": int(row["selected_binary_bytes"]),
                    "selected_extraction_inputs": int(
                        row["selected_extraction_inputs"]
                    ),
                    "interpretation_limit": (
                        "This Task is excluded from the text metric; extracted text usage is not measured."
                    ),
                }
            )
    if not eligible.empty:
        high_selection = eligible.loc[eligible["selection_ratio"].ge(0.9)].sort_values(
            by=["selection_ratio", "input_bytes", "task_id"],
            ascending=[False, False, True],
            kind="stable",
        )
        for _, row in high_selection.head(max(0, 5 - len(anomalies))).iterrows():
            anomalies.append(
                {
                    "schema": ANOMALY_SCHEMA,
                    "anomaly_type": "high_context_selection_ratio",
                    "task_id": str(row["task_id"]),
                    "project_id": row.get("project_id"),
                    "input_text_bytes": int(row["input_bytes"]),
                    "selected_text_bytes": int(row["selected_bytes"]),
                    "selection_ratio": round(float(row["selection_ratio"]), 6),
                    "interpretation_limit": (
                        "This identifies weak byte reduction, not a failed task or measured Token waste."
                    ),
                }
            )

    value_text = "unavailable" if official["value"] is None else f"{official['value']:.2%}"
    availability = measurement_gaps["availability_counts"]
    analysis_context = "\n".join(
        [
            "# Atlas analytics interpretation context",
            "",
            "Use the files named below as deterministic facts. Do not recount the source JSONL.",
            "",
            f"- Quality status: {quality['status']}",
            f"- Official metric: context_selection_text_byte_rate = {value_text}",
            f"- Numerator / denominator: {official['numerator']} / {official['denominator']} bytes",
            f"- Eligible tasks: {official['eligible_rows']}",
            (
                "- Pure-binary tasks excluded: "
                f"{official['exclusion_counts']['pure_binary_extraction_tasks']}"
            ),
            f"- Bounded anomaly samples: {len(anomalies)}",
            (
                "- Measurement availability: "
                f"{availability['available']} available, "
                f"{availability['partial']} partial, "
                f"{availability['unavailable']} unavailable"
            ),
            "",
            "Questions for the Agent:",
            "",
            "1. Which bounded anomaly samples suggest a concrete Atlas product gap?",
            "2. What is the smallest Runtime change that could reduce that gap?",
            "3. What evidence would distinguish improvement from a different task mix?",
            "",
            "Limits:",
            "",
            "- Selected text bytes do not prove the Agent read every byte.",
            "- Binary inputs that require local extraction are excluded.",
            "- This evaluation does not contain measured model Token usage.",
            "- Six or fewer eligible tasks are descriptive evidence, not statistical proof.",
            "",
        ]
    )
    report = "\n".join(
        [
            "# Atlas Analytics Evaluation",
            "",
            f"Data quality: **{quality['status']}** "
            f"({quality['critical_errors']} critical errors, {quality['warnings']} warnings).",
            "",
            "## Official metric",
            "",
            "| Metric | Numerator | Denominator | Value | Eligible rows |",
            "| --- | ---: | ---: | ---: | ---: |",
            (
                "| Context selection text-byte rate | "
                f"{official['numerator']} | {official['denominator']} | "
                f"{value_text} | {official['eligible_rows']} |"
            ),
            "",
            (
                "The SQL result was cross-checked with Pandas. "
                "This is directly readable selected-text share, not Token usage; binary inputs are excluded."
            ),
            "",
            "## Measurement limits",
            "",
            (
                f"- Available candidates: {availability['available']}; "
                f"partial: {availability['partial']}; unavailable: {availability['unavailable']}."
            ),
            f"- High-selection samples written to `anomalies.jsonl`: {len(anomalies)}.",
            "- Interpret the samples with `analysis_context.md`; do not treat them as failures by default.",
            "",
        ]
    )
    return {
        "pandas_version": pd.__version__,
        "cross_check": {
            "status": "PASS",
            "numerator": pandas_numerator,
            "denominator": pandas_denominator,
            "eligible_rows": len(eligible),
        },
        "anomalies": anomalies,
        "analysis_context": analysis_context,
        "report": report,
    }


def anomalies_jsonl(anomalies: list[dict[str, Any]]) -> str:
    return "".join(
        f"{json.dumps(item, ensure_ascii=False, sort_keys=True)}\n"
        for item in anomalies
    )
