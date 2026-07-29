from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from . import EXPORT_SCHEMA


class ExportValidationError(ValueError):
    """Raised when an Atlas analytics export is incomplete or inconsistent."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_export(export_dir: str | Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    root = Path(export_dir).resolve()
    manifest_path = root / "manifest.json"
    records_path = root / "records.jsonl"
    if not manifest_path.is_file() or not records_path.is_file():
        raise ExportValidationError("Export requires manifest.json and records.jsonl.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("export_schema") != EXPORT_SCHEMA:
        raise ExportValidationError(
            f"Unsupported export schema: {manifest.get('export_schema')!r}"
        )

    for filename, details in manifest.get("files", {}).items():
        candidate = (root / filename).resolve()
        if candidate.parent != root or not candidate.is_file():
            raise ExportValidationError(f"Manifest file is missing or escapes the export: {filename}")
        if details.get("sha256") != _sha256(candidate):
            raise ExportValidationError(f"{filename} does not match the manifest Hash.")

    records: list[dict[str, Any]] = []
    with records_path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            if record.get("export_schema") != EXPORT_SCHEMA:
                raise ExportValidationError(
                    f"Record {line_number} has an incompatible export schema."
                )
            if not record.get("record_type") or not record.get("record_id"):
                raise ExportValidationError(
                    f"Record {line_number} is missing its type or ID."
                )
            records.append(record)

    if manifest.get("record_count") != len(records):
        raise ExportValidationError(
            "Manifest record_count does not match records.jsonl."
        )
    return manifest, records


def summarize(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    items = list(records)
    record_types = Counter(item["record_type"] for item in items)
    run_statuses = Counter(
        str(item.get("status") or "unknown")
        for item in items
        if item["record_type"] == "run"
    )
    decisions = Counter(
        str(item.get("decision") or "unknown")
        for item in items
        if item["record_type"] == "policy_decision"
    )
    task_records = [item for item in items if item["record_type"] == "task_contract"]
    return {
        "record_count": len(items),
        "record_types": dict(sorted(record_types.items())),
        "run_statuses": dict(sorted(run_statuses.items())),
        "policy_decisions": dict(sorted(decisions.items())),
        "tasks": {
            "count": len(task_records),
            "selected_files": sum(item.get("selected_count") or 0 for item in task_records),
            "excluded_files": sum(item.get("excluded_count") or 0 for item in task_records),
            "input_bytes": sum(item.get("input_bytes") or 0 for item in task_records),
            "selected_bytes": sum(item.get("selected_bytes") or 0 for item in task_records),
        },
    }
