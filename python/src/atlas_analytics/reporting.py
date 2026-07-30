from __future__ import annotations

import json
from collections import Counter
from typing import Any

import pandas as pd


ANOMALY_SCHEMA = "atlas.analytics.anomaly.v1"
OUTCOMES = ("completed", "conflict_safe_stop", "failed", "cancelled")


def _metric_by_id(metrics: dict[str, Any], metric_id: str) -> dict[str, Any]:
    return next(item for item in metrics["metrics"] if item["metric_id"] == metric_id)


def _latest_recovery(frame: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        return frame
    ranked = frame.copy()
    ranked["_rank"] = ranked["outcome"].map(
        {
            "completed": 4,
            "conflict_safe_stop": 3,
            "failed": 2,
            "cancelled": 1,
        }
    ).fillna(0)
    return (
        ranked.sort_values(
            by=["attempt_id", "recorded_at", "_rank", "event_id"],
            kind="stable",
        )
        .drop_duplicates(subset=["attempt_id"], keep="last")
        .sort_values(by=["attempt_id"], kind="stable")
    )


def _latest_rule(frame: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        return frame
    return (
        frame.sort_values(
            by=["task_id", "evaluated_at", "recorded_at", "event_id"],
            kind="stable",
        )
        .drop_duplicates(subset=["task_id"], keep="last")
        .sort_values(by=["task_id"], kind="stable")
    )


def _rule_population(row: dict[str, Any]) -> tuple[str, bool]:
    if row.get("actor") == "test" or row.get("tool") == "atlas-test":
        return "test", False
    if row.get("status") in {"cancelled", "aborted"}:
        return "cancelled", False
    if row.get("status") not in {"completed", "rolled_back"}:
        return "incomplete", False
    eligible = set(row.get("eligible_rule_ids") or [])
    if not eligible:
        return "first_scenario", False
    applied = set(row.get("applied_rule_ids") or [])
    return "eligible", bool(eligible.intersection(applied))


def build_report_assets(
    facts: dict[str, Any],
    quality: dict[str, Any],
    measurement_gaps: dict[str, Any],
    metrics: dict[str, Any],
) -> dict[str, Any]:
    """Cross-check all official SQL results with Pandas and build bounded assets."""

    context = _metric_by_id(metrics, "context_selection_text_byte_rate")
    recovery = _metric_by_id(metrics, "recovery_outcome_distribution")
    rule_reuse = _metric_by_id(metrics, "rule_reuse_rate")

    task_frame = pd.DataFrame(facts.get("task_fact", []))
    if task_frame.empty:
        eligible = task_frame
        pandas_numerator = None
        pandas_denominator = None
        eligible_task_ids: list[str] = []
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
        eligible_task_ids = sorted(
            str(item) for item in eligible["task_id"].tolist()
        )
        pandas_numerator = (
            int(eligible["selected_bytes"].sum()) if len(eligible) else None
        )
        pandas_denominator = (
            int(eligible["input_bytes"].sum()) if len(eligible) else None
        )
    if (
        pandas_numerator != context["numerator"]
        or pandas_denominator != context["denominator"]
        or eligible_task_ids != context["eligible_task_ids"]
    ):
        raise ValueError("Pandas cross-check does not match the context SQL metric.")

    recovery_frame = pd.DataFrame(facts.get("recovery_fact", []))
    latest_recovery = _latest_recovery(recovery_frame)
    recovery_counts = (
        {
            outcome: int(
                (latest_recovery["outcome"] == outcome).sum()
            )
            for outcome in OUTCOMES
        }
        if not latest_recovery.empty
        else None
    )
    if recovery_counts != recovery["outcome_counts"]:
        raise ValueError("Pandas cross-check does not match the Recovery SQL metric.")
    if recovery_counts is not None:
        for outcome in OUTCOMES:
            run_ids = sorted(
                {
                    str(item)
                    for item in latest_recovery.loc[
                        latest_recovery["outcome"].eq(outcome), "run_id"
                    ].tolist()
                }
            )
            if run_ids != recovery["outcomes"][outcome]["run_ids"]:
                raise ValueError(
                    "Pandas cross-check does not match Recovery run membership."
                )

    rule_frame = pd.DataFrame(facts.get("rule_application_fact", []))
    latest_rule = _latest_rule(rule_frame)
    classified = []
    for row in latest_rule.to_dict(orient="records"):
        population, matched = _rule_population(row)
        classified.append({**row, "population": population, "matched": matched})
    pandas_denominator_ids = sorted(
        str(item["task_id"])
        for item in classified
        if item["population"] == "eligible"
    )
    pandas_numerator_ids = sorted(
        str(item["task_id"])
        for item in classified
        if item["population"] == "eligible" and item["matched"]
    )
    pandas_corrected_ids = sorted(
        str(item["task_id"]) for item in classified if item.get("corrected")
    )
    if (
        pandas_denominator_ids != rule_reuse["denominator_task_ids"]
        or pandas_numerator_ids != rule_reuse["numerator_task_ids"]
        or pandas_corrected_ids != rule_reuse["corrected_task_ids"]
    ):
        raise ValueError("Pandas cross-check does not match the Rule Reuse SQL metric.")

    anomalies: list[dict[str, Any]] = []
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
    if not latest_recovery.empty:
        for outcome, anomaly_type in (
            ("conflict_safe_stop", "rollback_conflict_safe_stop"),
            ("failed", "rollback_failed"),
        ):
            selected = latest_recovery.loc[
                latest_recovery["outcome"].eq(outcome)
            ].sort_values(by=["run_id", "attempt_id"], kind="stable")
            for _, row in selected.iterrows():
                if len(anomalies) >= 5:
                    break
                anomalies.append(
                    {
                        "schema": ANOMALY_SCHEMA,
                        "anomaly_type": anomaly_type,
                        "run_id": str(row["run_id"]),
                        "attempt_id": str(row["attempt_id"]),
                        "reason_code": str(row["reason_code"]),
                        "interpretation_limit": (
                            "A conflict-safe stop protects later work; a failed outcome needs targeted diagnosis."
                        ),
                    }
                )
    for item in classified:
        if len(anomalies) >= 5:
            break
        if item.get("corrected"):
            anomalies.append(
                {
                    "schema": ANOMALY_SCHEMA,
                    "anomaly_type": "rule_application_corrected",
                    "task_id": str(item["task_id"]),
                    "eligible_rule_ids": sorted(
                        item.get("eligible_rule_ids") or []
                    ),
                    "applied_rule_ids": sorted(
                        item.get("applied_rule_ids") or []
                    ),
                    "interpretation_limit": (
                        "A matched rule was corrected for this Task; match does not equal satisfaction."
                    ),
                }
            )
    if len(anomalies) < 5 and not eligible.empty:
        high_selection = eligible.loc[
            eligible["selection_ratio"].ge(0.9)
        ].sort_values(
            by=["selection_ratio", "input_bytes", "task_id"],
            ascending=[False, False, True],
            kind="stable",
        )
        for _, row in high_selection.head(5 - len(anomalies)).iterrows():
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

    context_value = (
        "unavailable"
        if context["value"] is None
        else f"{context['value']:.2%}"
    )
    rule_value = (
        "unavailable"
        if rule_reuse["value"] is None
        else f"{rule_reuse['value']:.2%}"
    )
    recovery_text = (
        "unavailable"
        if recovery["outcome_counts"] is None
        else ", ".join(
            f"{name}={recovery['outcome_counts'][name]}" for name in OUTCOMES
        )
    )
    availability = measurement_gaps["availability_counts"]
    analysis_context = "\n".join(
        [
            "# Atlas analytics interpretation context",
            "",
            "Use these bounded deterministic results. Do not recount the source JSONL.",
            "",
            f"- Quality status: {quality['status']}",
            f"- Context Selection: {context_value}",
            f"- Context numerator / denominator: {context['numerator']} / {context['denominator']} bytes",
            f"- Recovery Outcome: {recovery_text}",
            (
                "- Rule Reuse: "
                f"{rule_value} ({rule_reuse['numerator']} / {rule_reuse['denominator']})"
            ),
            f"- Corrected Rule Reuse Task IDs: {', '.join(rule_reuse['corrected_task_ids']) or 'none'}",
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
            "1. Which bounded anomaly points to a concrete product gap?",
            "2. What is the smallest Runtime change that addresses it?",
            "3. What evidence would distinguish improvement from a different task mix?",
            "",
            "Limits:",
            "",
            "- Selected text bytes do not prove the Agent read every byte.",
            "- Rule application does not prove user satisfaction.",
            "- Recovery and Rule Reuse coverage starts with their explicit events.",
            "- This evaluation does not contain measured model Token usage.",
            "- Small samples are descriptive evidence, not statistical proof.",
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
            "## Official metrics",
            "",
            "| Metric | Result | Membership |",
            "| --- | ---: | --- |",
            (
                "| Context Selection text-byte rate | "
                f"{context_value} | {context['numerator']} / {context['denominator']} bytes; "
                f"{len(context['eligible_task_ids'])} Tasks |"
            ),
            (
                "| Recovery Outcome distribution | "
                f"{recovery_text} | {recovery['denominator']} logical attempts |"
            ),
            (
                "| Rule Reuse rate | "
                f"{rule_value} | {rule_reuse['numerator']} / {rule_reuse['denominator']} Tasks |"
            ),
            "",
            "SQL results were cross-checked with Pandas.",
            "",
            "## Measurement limits",
            "",
            (
                f"- Available candidates: {availability['available']}; "
                f"partial: {availability['partial']}; unavailable: {availability['unavailable']}."
            ),
            f"- Bounded samples written to `anomalies.jsonl`: {len(anomalies)}.",
            "- Context bytes are not measured Token usage.",
            "- Rule match is not user satisfaction.",
            "- Historical Recovery and Rule Reuse remain partial before explicit events.",
            "",
        ]
    )
    return {
        "pandas_version": pd.__version__,
        "cross_check": {
            "status": "PASS",
            "metrics": {
                "context_selection_text_byte_rate": {
                    "numerator": pandas_numerator,
                    "denominator": pandas_denominator,
                    "eligible_task_ids": eligible_task_ids,
                },
                "recovery_outcome_distribution": {
                    "denominator": (
                        len(latest_recovery)
                        if not latest_recovery.empty
                        else None
                    ),
                    "outcome_counts": recovery_counts,
                },
                "rule_reuse_rate": {
                    "numerator_task_ids": pandas_numerator_ids,
                    "denominator_task_ids": pandas_denominator_ids,
                    "corrected_task_ids": pandas_corrected_ids,
                },
            },
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
