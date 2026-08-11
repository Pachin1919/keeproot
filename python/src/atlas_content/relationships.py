from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "atlas.content-relationship.v1"
PROCESSOR_VERSION = "0.2.0"
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_RETURNED_IDS = 50
SUPPORTED_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log",
}


def _sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _read_text(file_path: Path) -> tuple[str, str, int]:
    size = file_path.stat().st_size
    if size > MAX_FILE_BYTES:
        raise ValueError(
            f"Content relationship input exceeds the {MAX_FILE_BYTES}-byte local limit: {file_path}"
        )
    raw = file_path.read_bytes()
    for encoding in ("utf-8-sig", "utf-16", "gb18030", "cp1252"):
        try:
            return raw.decode(encoding), encoding, size
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace"), "utf-8-replacement", size


def _normalized_lines(text: str) -> list[str]:
    return [line.strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if line.strip()]


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(candidate)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _jsonl_facts(text: str) -> dict | None:
    records: list[dict] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            return None
        if not isinstance(record, dict):
            return None
        records.append(record)
    if not records:
        return None

    message_ids: set[str] = set()
    message_hashes: dict[str, str] = {}
    duplicate_message_ids: set[str] = set()
    timestamps: list[datetime] = []
    timestamped_records = 0
    for record in records:
        message_id = record.get("message_id")
        if isinstance(message_id, str) and message_id.strip():
            normalized_id = message_id.strip()
            semantic_record = {
                "role": record.get("role"),
                "content": record.get("content"),
                "timestamp": record.get("timestamp") or record.get("created_at") or record.get("date"),
                "parent_message_id": record.get("parent_message_id"),
            }
            record_hash = hashlib.sha256(
                json.dumps(
                    semantic_record,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest()
            if normalized_id in message_hashes:
                duplicate_message_ids.add(normalized_id)
            message_ids.add(normalized_id)
            message_hashes[normalized_id] = record_hash
        timestamp = None
        for key in ("timestamp", "created_at", "date"):
            timestamp = _parse_timestamp(record.get(key))
            if timestamp:
                break
        if timestamp:
            timestamps.append(timestamp)
            timestamped_records += 1
    return {
        "record_count": len(records),
        "message_ids": message_ids,
        "message_hashes": message_hashes,
        "duplicate_message_ids": duplicate_message_ids,
        "timestamped_records": timestamped_records,
        "timestamps": sorted(timestamps),
    }


def _coverage(facts: dict | None) -> dict:
    if not facts or not facts["timestamps"]:
        return {
            "status": "unavailable",
            "reason": "no_parseable_record_timestamps",
        }
    complete = facts["timestamped_records"] == facts["record_count"]
    return {
        "status": "complete" if complete else "partial",
        "basis": "record_timestamps",
        "start": facts["timestamps"][0].isoformat(),
        "end": facts["timestamps"][-1].isoformat(),
        "record_count": facts["record_count"],
        "timestamped_records": facts["timestamped_records"],
    }


def _bounded_ids(values: set[str]) -> tuple[list[str], bool]:
    ordered = sorted(values)
    return ordered[:MAX_RETURNED_IDS], len(ordered) > MAX_RETURNED_IDS


def compare_files(
    left_input: str,
    right_input: str,
    *,
    expected_left_sha256: str,
    expected_right_sha256: str,
) -> dict:
    left_path = Path(left_input).resolve()
    right_path = Path(right_input).resolve()
    for label, file_path in (("left", left_path), ("right", right_path)):
        if not file_path.is_file() or file_path.is_symlink():
            raise ValueError(f"Content relationship {label} input must be a regular file: {file_path}")
        if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"Unsupported content relationship extension: {file_path.suffix.lower()}")

    left_hash = _sha256_file(left_path)
    right_hash = _sha256_file(right_path)
    if left_hash != expected_left_sha256 or right_hash != expected_right_sha256:
        raise ValueError("Content relationship input Hash does not match the Node baseline.")

    left_text, left_encoding, left_size = _read_text(left_path)
    right_text, right_encoding, right_size = _read_text(right_path)
    left_lines = _normalized_lines(left_text)
    right_lines = _normalized_lines(right_text)
    left_normalized = "\n".join(left_lines)
    right_normalized = "\n".join(right_lines)
    left_jsonl = _jsonl_facts(left_text) if left_path.suffix.lower() == ".jsonl" else None
    right_jsonl = _jsonl_facts(right_text) if right_path.suffix.lower() == ".jsonl" else None

    left_ids = left_jsonl["message_ids"] if left_jsonl else set()
    right_ids = right_jsonl["message_ids"] if right_jsonl else set()
    shared_ids = left_ids & right_ids
    unchanged_shared_ids = {
        message_id for message_id in shared_ids
        if left_jsonl["message_hashes"].get(message_id) == right_jsonl["message_hashes"].get(message_id)
    } if left_jsonl and right_jsonl else set()
    changed_shared_ids = shared_ids - unchanged_shared_ids
    ids_unambiguous = bool(left_jsonl and right_jsonl) and not (
        left_jsonl["duplicate_message_ids"] or right_jsonl["duplicate_message_ids"]
    )
    left_new_ids = left_ids - right_ids
    right_new_ids = right_ids - left_ids
    left_new_list, left_ids_truncated = _bounded_ids(left_new_ids)
    right_new_list, right_ids_truncated = _bounded_ids(right_new_ids)
    changed_id_list, changed_ids_truncated = _bounded_ids(changed_shared_ids)

    left_counter = Counter(left_lines)
    right_counter = Counter(right_lines)
    common_line_count = sum((left_counter & right_counter).values())
    left_line_count = len(left_lines)
    right_line_count = len(right_lines)
    left_overlap = common_line_count / left_line_count if left_line_count else 0.0
    right_overlap = common_line_count / right_line_count if right_line_count else 0.0

    if left_hash == right_hash:
        relation_type, basis = "identical", "sha256"
    elif ids_unambiguous and left_ids and right_ids and left_ids <= right_ids and not changed_shared_ids:
        relation_type, basis = "left_contained_by_right", "message_id_subset"
    elif ids_unambiguous and left_ids and right_ids and right_ids <= left_ids and not changed_shared_ids:
        relation_type, basis = "right_contained_by_left", "message_id_subset"
    elif left_ids and right_ids and shared_ids:
        relation_type = "overlap"
        basis = "message_id_intersection_with_changed_content" if changed_shared_ids else "message_id_intersection"
    elif left_normalized and left_normalized == right_normalized:
        relation_type, basis = "identical", "normalized_text"
    elif left_normalized and left_normalized in right_normalized:
        relation_type, basis = "left_contained_by_right", "normalized_text_containment"
    elif right_normalized and right_normalized in left_normalized:
        relation_type, basis = "right_contained_by_left", "normalized_text_containment"
    elif common_line_count and (left_overlap >= 0.25 or right_overlap >= 0.25):
        relation_type, basis = "overlap", "normalized_line_intersection"
    else:
        relation_type, basis = "independent", "no_material_deterministic_overlap"

    if _sha256_file(left_path) != left_hash or _sha256_file(right_path) != right_hash:
        raise ValueError("Content relationship input changed during local comparison.")

    return {
        "schema": SCHEMA,
        "processor": {
            "name": "atlas-content-relationship",
            "version": PROCESSOR_VERSION,
            "language": "python",
            "network_used": False,
            "browser_used": False,
            "external_application_used": False,
        },
        "sources": {
            "left": {
                "path": str(left_path),
                "name": left_path.name,
                "extension": left_path.suffix.lower(),
                "sha256": left_hash,
                "byte_size": left_size,
                "encoding": left_encoding,
            },
            "right": {
                "path": str(right_path),
                "name": right_path.name,
                "extension": right_path.suffix.lower(),
                "sha256": right_hash,
                "byte_size": right_size,
                "encoding": right_encoding,
            },
        },
        "relation": {
            "type": relation_type,
            "basis": basis,
            "semantic_claim": False,
        },
        "evidence": {
            "left_line_count": left_line_count,
            "right_line_count": right_line_count,
            "common_line_count": common_line_count,
            "left_overlap_ratio": round(left_overlap, 6),
            "right_overlap_ratio": round(right_overlap, 6),
            "left_message_id_count": len(left_ids),
            "right_message_id_count": len(right_ids),
            "shared_message_id_count": len(shared_ids),
            "unchanged_shared_message_id_count": len(unchanged_shared_ids),
            "changed_message_ids": changed_id_list,
            "left_new_message_ids": left_new_list,
            "right_new_message_ids": right_new_list,
            "duplicate_message_ids": {
                "left": sorted(left_jsonl["duplicate_message_ids"])[:MAX_RETURNED_IDS] if left_jsonl else [],
                "right": sorted(right_jsonl["duplicate_message_ids"])[:MAX_RETURNED_IDS] if right_jsonl else [],
            },
            "message_id_lists_truncated": (
                left_ids_truncated or right_ids_truncated or changed_ids_truncated
            ),
        },
        "coverage": {
            "left": _coverage(left_jsonl),
            "right": _coverage(right_jsonl),
        },
        "attention": {
            "model_visible_body_bytes": 0,
            "screenshots_used": 0,
            "maximum_returned_message_ids_per_side": MAX_RETURNED_IDS,
        },
        "next_action": {
            "mode": "use_local_relationship_evidence",
            "agent_role": "Interpret whether the deterministic relationship supports preserve, delta, or supersede.",
        },
    }
