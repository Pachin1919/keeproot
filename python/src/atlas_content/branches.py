from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .relationships import MAX_FILE_BYTES

SCHEMA = "atlas.chat-branch-set.v1"
PROCESSOR_VERSION = "0.1.0"


def _sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _semantic_hash(record: dict) -> str:
    value = {
        "role": record.get("role"),
        "content": record.get("content"),
        "timestamp": record.get("timestamp") or record.get("created_at") or record.get("date"),
        "parent_message_id": record.get("parent_message_id"),
    }
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _read_jsonl(file_path: Path, expected_hash: str) -> list[dict]:
    if not file_path.is_file() or file_path.is_symlink():
        raise ValueError(f"Chat branch input must be a regular JSONL file: {file_path}")
    if file_path.suffix.lower() != ".jsonl":
        raise ValueError(f"Chat branch input must use .jsonl: {file_path}")
    if file_path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"Chat branch input exceeds {MAX_FILE_BYTES} bytes: {file_path}")
    if _sha256_file(file_path) != expected_hash:
        raise ValueError("Chat branch input Hash does not match the Node baseline.")
    records: list[dict] = []
    seen: set[str] = set()
    with file_path.open("r", encoding="utf-8-sig") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid JSONL at {file_path}:{line_number}") from error
            if not isinstance(record, dict):
                raise ValueError(f"Chat branch record must be an object at {file_path}:{line_number}")
            message_id = record.get("message_id")
            if not isinstance(message_id, str) or not message_id.strip():
                raise ValueError(f"Chat branch record lacks message_id at {file_path}:{line_number}")
            if message_id in seen:
                raise ValueError(f"Duplicate message_id in chat branch: {message_id}")
            seen.add(message_id)
            records.append(record)
    if not records:
        raise ValueError(f"Chat branch input contains no records: {file_path}")
    return records


def analyze_branches(request_file: str, output_dir: str) -> dict:
    request_path = Path(request_file).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    sources = request.get("sources")
    if not isinstance(sources, list) or not 2 <= len(sources) <= 12:
        raise ValueError("Chat branch analysis requires 2 to 12 sources.")
    destination = Path(output_dir).resolve()
    destination.mkdir(parents=True, exist_ok=False)

    loaded: list[dict] = []
    for source in sources:
        file_path = Path(source["path"]).resolve()
        expected_hash = source["sha256"]
        records = _read_jsonl(file_path, expected_hash)
        loaded.append({
            "source_id": source["source_id"],
            "path": file_path,
            "sha256": expected_hash,
            "records": records,
            "fingerprints": [
                (record["message_id"], _semantic_hash(record)) for record in records
            ],
        })

    positions = [0] * len(loaded)
    segment_counter = 0
    segments: list[dict] = []
    source_chains: list[list[str]] = [[] for _ in loaded]

    def emit_group(indices: list[int], parent_segment_id: str | None) -> None:
        nonlocal segment_counter
        if not indices:
            return
        common = 0
        while all(positions[index] + common < len(loaded[index]["records"]) for index in indices):
            fingerprints = {
                loaded[index]["fingerprints"][positions[index] + common] for index in indices
            }
            if len(fingerprints) != 1:
                break
            common += 1
        current_parent = parent_segment_id
        if common:
            segment_counter += 1
            segment_id = f"segment-{segment_counter:03d}"
            exemplar = loaded[indices[0]]["records"][positions[indices[0]]:positions[indices[0]] + common]
            segment_path = destination / f"{segment_id}.jsonl"
            segment_path.write_text(
                "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in exemplar),
                encoding="utf-8",
            )
            segment_hash = _sha256_file(segment_path)
            segments.append({
                "segment_id": segment_id,
                "parent_segment_id": parent_segment_id,
                "source_ids": [loaded[index]["source_id"] for index in indices],
                "record_count": common,
                "first_message_id": exemplar[0]["message_id"],
                "last_message_id": exemplar[-1]["message_id"],
                "path": str(segment_path),
                "sha256": segment_hash,
                "byte_size": segment_path.stat().st_size,
            })
            for index in indices:
                positions[index] += common
                source_chains[index].append(segment_id)
            current_parent = segment_id

        groups: dict[tuple[str, str], list[int]] = {}
        for index in indices:
            if positions[index] >= len(loaded[index]["records"]):
                continue
            fingerprint = loaded[index]["fingerprints"][positions[index]]
            groups.setdefault(fingerprint, []).append(index)
        for group in groups.values():
            emit_group(group, current_parent)

    emit_group(list(range(len(loaded))), None)
    input_record_count = sum(len(source["records"]) for source in loaded)
    material_record_count = sum(segment["record_count"] for segment in segments)
    source_results = []
    for index, source in enumerate(loaded):
        source_results.append({
            "source_id": source["source_id"],
            "path": str(source["path"]),
            "sha256": source["sha256"],
            "record_count": len(source["records"]),
            "conversation_ids": sorted({
                str(record.get("conversation_id")) for record in source["records"]
                if record.get("conversation_id")
            }),
            "segment_chain": source_chains[index],
        })
    return {
        "schema": SCHEMA,
        "processor": {
            "name": "atlas-chat-branch-set",
            "version": PROCESSOR_VERSION,
            "language": "python",
            "network_used": False,
            "browser_used": False,
            "external_application_used": False,
        },
        "relation": {
            "type": "branched_conversation" if segments and segments[0]["source_ids"] == [
                source["source_id"] for source in loaded
            ] else "independent_set",
            "semantic_claim": False,
        },
        "sources": source_results,
        "segments": segments,
        "evidence": {
            "source_count": len(loaded),
            "input_record_count": input_record_count,
            "deduplicated_record_count": material_record_count,
            "duplicate_records_avoided": input_record_count - material_record_count,
            "main_source_id": max(source_results, key=lambda item: item["record_count"])["source_id"],
        },
        "attention": {
            "model_visible_body_bytes": 0,
            "screenshots_used": 0,
            "reading_plan": "Read each segment once; use each source segment_chain to reconstruct its branch.",
        },
    }
