from __future__ import annotations

import hashlib
import json
import csv
import io
import re
from difflib import SequenceMatcher
from datetime import date
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "atlas.content-relationship.v1"
PROCESSOR_VERSION = "0.4.0"
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_RETURNED_IDS = 50
SUPPORTED_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log", ".xlsx",
}
DETAIL_LIMITS = {"input_bytes": 256 * 1024, "text_blocks": 2000, "records": 10000,
                 "columns": 50, "cell_characters": 1200, "entries": 100,
                 "entry_characters": 2000, "returned_characters": 24000}


def _bounded_entries(entries: list[dict], remaining: int = 24000) -> tuple[list[dict], bool]:
    returned = []; truncated = False
    def bound(value, budget):
        if isinstance(value, str):
            size = min(len(value), max(0, budget), DETAIL_LIMITS["entry_characters"])
            return value[:size], size, size < len(value)
        if isinstance(value, list):
            result = []; used = 0; cut = False
            for item in value:
                item, size, shortened = bound(item, budget - used); result.append(item); used += size; cut |= shortened
            return result, used, cut
        if isinstance(value, dict):
            result = {}; used = 0; cut = False
            for key, item in value.items():
                # Keys are data in CSV rows and must count toward the return budget.
                # Preserve field/header names rather than creating ambiguous clipped aliases.
                if len(str(key)) > budget - used:
                    cut = True; continue
                used += len(str(key))
                item, size, shortened = bound(item, budget - used); result[key] = item; used += size; cut |= shortened
            return result, used, cut
        return value, 0, False
    for entry in entries:
        if len(returned) >= DETAIL_LIMITS["entries"] or remaining <= 0:
            truncated = True; break
        # The complete entry's text, including all table cells, shares a 2000-character cap.
        value, size, cut = bound(entry, min(remaining, DETAIL_LIMITS["entry_characters"]))
        value["truncated"] = cut; returned.append(value); remaining -= size; truncated |= cut
    return returned, truncated or len(returned) < len(entries)


def _detail_result(kind, status, summary, entries, **extra):
    remaining = 6000; metadata_truncated = False; omitted = object()
    def metadata(value):
        nonlocal remaining, metadata_truncated
        if isinstance(value, str):
            if len(value) > remaining:
                metadata_truncated = True; return omitted
            remaining -= len(value); return value
        if isinstance(value, list): return [item for original in value if (item := metadata(original)) is not omitted]
        if isinstance(value, dict): return {key: item for key, original in value.items() if (item := metadata(original)) is not omitted}
        return value
    extra = {key: extra[key] for key in sorted(extra, key=lambda key: (key != 'time_sources', key != 'key_columns', key))}
    extra = metadata(extra)
    values, truncated = _bounded_entries(entries, DETAIL_LIMITS['returned_characters'] - 512 - (6000 - remaining))
    return {"kind": kind, "status": status, "summary": summary, "entries": values,
            "known_total_entries": len(entries), "truncated": truncated or metadata_truncated,
            "metadata_truncated": metadata_truncated,
            "limits": DETAIL_LIMITS, **extra}


def _strict_detail_text(file_path: Path) -> str:
    if file_path.stat().st_size > DETAIL_LIMITS["input_bytes"]:
        raise ValueError("Detailed comparison input exceeds 256 KiB.")
    return file_path.read_bytes().decode("utf-8", errors="strict")


def _blocks(text: str) -> list[str]:
    blocks = []; current = []
    for line in text.splitlines(keepends=True):
        current.append(line)
        if not line.strip(" \t\r\n"):
            blocks.append("".join(current)); current = []
    if current: blocks.append("".join(current))
    if len(blocks) > DETAIL_LIMITS["text_blocks"]:
        raise ValueError("Detailed text comparison exceeds 2000 blocks.")
    return blocks


def _text_details(left: str, right: str) -> dict:
    a, b = _blocks(left), _blocks(right)
    summary = {"added": 0, "removed": 0, "changed": 0, "unchanged": 0, "left_blocks": len(a), "right_blocks": len(b)}
    entries = []
    for tag, i, end_i, j, end_j in SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        count = max(end_i - i, end_j - j)
        for offset in range(count):
            before = a[i + offset] if i + offset < end_i else None
            after = b[j + offset] if j + offset < end_j else None
            kind = "unchanged" if tag == "equal" else "added" if before is None else "removed" if after is None else "changed"
            summary[kind] += 1
            entries.append({"type": kind, "left_block": i + offset + 1 if before is not None else None,
                            "right_block": j + offset + 1 if after is not None else None,
                            "before": before, "after": after})
    left_counts, right_counts = Counter(a), Counter(b)
    repeated = sorted(value for value in left_counts.keys() | right_counts.keys()
                      if left_counts[value] > 1 or right_counts[value] > 1)
    summary["repeated"] = len(repeated)
    summary["left_duplicate_occurrences"] = sum(n - 1 for n in left_counts.values() if n > 1)
    summary["right_duplicate_occurrences"] = sum(n - 1 for n in right_counts.values() if n > 1)
    duplicates = [{"type": "repeated", "before": value, "left_count": left_counts[value], "right_count": right_counts[value]} for value in repeated]
    # Differences and repeated blocks remain visible before unchanged samples.
    entries = [entry for entry in entries if entry["type"] != "unchanged"] + duplicates + [entry for entry in entries if entry["type"] == "unchanged"]
    return _detail_result("text_blocks", "available", summary, entries)


def _table(text: str, delimiter: str) -> tuple[list[str], list[dict]]:
    reader = csv.reader(io.StringIO(text.removeprefix('\ufeff'), newline=""), delimiter=delimiter, strict=True)
    header = next(reader, None)
    if not header or len(header) > DETAIL_LIMITS["columns"] or any(not h.strip() or len(h) > DETAIL_LIMITS["cell_characters"] for h in header) or len(set(header)) != len(header):
        raise ValueError("Detailed CSV/TSV comparison requires unique bounded non-empty headers.")
    rows = []
    for row in reader:
        if len(rows) >= DETAIL_LIMITS["records"]:
            raise ValueError("Detailed table comparison exceeds 10000 records.")
        if len(row) != len(header) or any(len(value) > DETAIL_LIMITS["cell_characters"] for value in row):
            raise ValueError("Detailed table record does not match its header or cell limit.")
        rows.append(dict(zip(header, row)))
    return header, rows


def _event_dates(rows: list[dict], column: str | None) -> dict:
    if not column: return {"status": "not_requested", "column": None}
    dates = []; invalid = 0; missing = 0
    for row in rows:
        value = row[column]
        if not value: missing += 1; continue
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value): raise ValueError()
            dates.append(date.fromisoformat(value).isoformat())
        except ValueError: invalid += 1
    return {"status": "complete" if len(dates) == len(rows) else "partial" if dates else "unavailable",
            "column": column, "record_count": len(rows), "valid_count": len(dates), "missing_count": missing,
            "invalid_count": invalid, "start": min(dates) if dates else None, "end": max(dates) if dates else None,
            "basis": "explicit_ISO_date_column"}


def _table_details(left: str, right: str, left_ext: str, right_ext: str,
                   key_column: str | None, period_column: str | None, event_date_column: str | None) -> dict:
    ah, a = _table(left, "\t" if left_ext == ".tsv" else ",")
    bh, b = _table(right, "\t" if right_ext == ".tsv" else ",")
    return _compare_table_rows(ah, a, bh, b, key_column, period_column, event_date_column)


def _compare_table_rows(ah, a, bh, b, key_column, period_column, event_date_column):
    if set(ah) != set(bh): raise ValueError("Detailed table column sets do not match.")
    for column in (key_column, period_column, event_date_column):
        if column and column not in ah: raise ValueError("A requested comparison column does not match an exact header.")
    columns = sorted(ah)
    times = {"event_dates": {"left": _event_dates(a, event_date_column), "right": _event_dates(b, event_date_column)},
             "business_period": {"column": period_column, "basis": "literal_column_values" if period_column else "not_requested",
                                 "left_distinct_count": len({row[period_column] for row in a}) if period_column else None,
                                 "right_distinct_count": len({row[period_column] for row in b}) if period_column else None,
                                 "left_values": sorted({row[period_column] for row in a})[:50] if period_column else [],
                                 "right_values": sorted({row[period_column] for row in b})[:50] if period_column else [],
                                 "samples_truncated": bool(period_column and (len({row[period_column] for row in a}) > 50 or len({row[period_column] for row in b}) > 50))}}
    summary = {"left_records": len(a), "right_records": len(b), "added": None, "removed": None, "changed": None, "unchanged": None}
    if not key_column:
        return _detail_result("table_rows", "uncertain", summary, [], reasons=["explicit_key_column_required"],
                              key_columns=[], columns=columns, time_sources=times)
    key_columns = [key_column] + ([period_column] if period_column and period_column != key_column else [])
    problems = []; indices = []
    for side, rows in (("left", a), ("right", b)):
        keys = [tuple(row[column] for column in key_columns) for row in rows]; counts = Counter(keys)
        empty = sum(1 for values in keys if any(not value.strip() for value in values))
        duplicates = {values: count for values, count in counts.items() if count > 1}
        summary[f"{side}_empty_key_records"] = empty
        summary[f"{side}_duplicate_keys"] = len(duplicates)
        summary[f"{side}_duplicate_key_records"] = sum(duplicates.values())
        for number, values in enumerate(keys, 1):
            if any(not value.strip() for value in values): problems.append({"type": "empty_key", "side": side, "record_number": number, "key": list(values)})
        for values, count in sorted(duplicates.items()): problems.append({"type": "duplicate_key", "side": side, "key": list(values), "count": count})
        indices.append(dict(zip(keys, rows)))
    if problems:
        return _detail_result("table_rows", "uncertain", summary, problems, reasons=["empty_or_duplicate_composite_key"],
                              key_columns=key_columns, columns=columns, time_sources=times)
    left_rows, right_rows = indices; entries = []
    for name in ("added", "removed", "changed", "unchanged"): summary[name] = 0
    for values in sorted(left_rows.keys() | right_rows.keys()):
        before = left_rows.get(values); after = right_rows.get(values)
        kind = "added" if before is None else "removed" if after is None else "unchanged" if before == after else "changed"
        summary[kind] += 1
        entries.append({"type": kind, "key": list(values), "before": {col: before[col] for col in columns} if before else None,
                        "after": {col: after[col] for col in columns} if after else None})
    entries = [entry for entry in entries if entry["type"] != "unchanged"] + [entry for entry in entries if entry["type"] == "unchanged"]
    return _detail_result("table_rows", "available", summary, entries, key_columns=key_columns, columns=columns, time_sources=times)


def _jsonl_details(left_facts: dict | None, right_facts: dict | None) -> dict:
    if not left_facts or not right_facts:
        return _detail_result("message_facts", "unsupported", {}, [], reasons=["JSONL_message_facts_unavailable"])
    a, b = left_facts["message_ids"], right_facts["message_ids"]
    changed = {key for key in a & b if left_facts["message_hashes"][key] != right_facts["message_hashes"][key]}
    uncertain = bool(left_facts['duplicate_message_ids'] or right_facts['duplicate_message_ids'])
    entries = [{"type": "added", "message_id": key} for key in sorted(b - a)]
    entries += [{"type": "removed", "message_id": key} for key in sorted(a - b)]
    entries += [{"type": "uncertain_shared_id" if uncertain else "changed", "message_id": key} for key in sorted(a & b if uncertain else changed)]
    entries += [{"type": "duplicate_id", "side": side, "message_id": key} for side, facts in (("left", left_facts), ("right", right_facts)) for key in sorted(facts["duplicate_message_ids"])]
    return _detail_result("message_facts", "uncertain" if uncertain else "available",
                          {"added": len(b - a), "removed": len(a - b), "changed": None if uncertain else len(changed),
                           "unchanged": None if uncertain else len(a & b) - len(changed)}, entries,
                          reasons=['duplicate_message_IDs_prevent_reliable_content_matching'] if uncertain else [],
                          time_sources={"event_dates": {"left": _coverage(left_facts), "right": _coverage(right_facts)},
                                        "business_period": {"basis": "not_inferred"}})


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
    details: bool = False,
    key_column: str | None = None,
    period_column: str | None = None,
    event_date_column: str | None = None,
    left_sheet: str | None = None,
    right_sheet: str | None = None,
) -> dict:
    left_path = Path(left_input).resolve()
    right_path = Path(right_input).resolve()
    for label, file_path in (("left", left_path), ("right", right_path)):
        if not file_path.is_file() or file_path.is_symlink():
            raise ValueError(f"Content relationship {label} input must be a regular file: {file_path}")
        if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"Unsupported content relationship extension: {file_path.suffix.lower()}")
        if details and file_path.stat().st_size > (MAX_FILE_BYTES if file_path.suffix.lower() == '.xlsx' else DETAIL_LIMITS['input_bytes']):
            raise ValueError('XLSX comparison input exceeds 16 MiB.' if file_path.suffix.lower() == '.xlsx' else 'Detailed comparison input exceeds 256 KiB.')

    left_hash = _sha256_file(left_path)
    right_hash = _sha256_file(right_path)
    if left_hash != expected_left_sha256 or right_hash != expected_right_sha256:
        raise ValueError("Content relationship input Hash does not match the Node baseline.")

    xlsx = left_path.suffix.lower() == '.xlsx' or right_path.suffix.lower() == '.xlsx'
    if xlsx and not (details and left_path.suffix.lower() == right_path.suffix.lower() == '.xlsx' and left_sheet and right_sheet):
        raise ValueError('XLSX comparison requires --details and both exact selected sheets, with two XLSX inputs.')
    if (left_sheet or right_sheet) and not xlsx:
        raise ValueError('Selected sheets apply only to XLSX comparison.')
    if xlsx:
        left_text = right_text = ''; left_encoding = right_encoding = 'office_xml_raw_cells'
        left_size, right_size = left_path.stat().st_size, right_path.stat().st_size
    else:
        left_text, left_encoding, left_size = _read_text(left_path)
        right_text, right_encoding, right_size = _read_text(right_path)
    left_lines = _normalized_lines(left_text)
    right_lines = _normalized_lines(right_text)
    left_normalized = "\n".join(left_lines)
    right_normalized = "\n".join(right_lines)
    left_jsonl = _jsonl_facts(left_text) if left_path.suffix.lower() == ".jsonl" else None
    right_jsonl = _jsonl_facts(right_text) if right_path.suffix.lower() == ".jsonl" else None
    options = [key_column, period_column, event_date_column]
    if any(options) and not details:
        raise ValueError("Key, period and event-date columns require --details.")
    if any(options) and not xlsx and not (left_path.suffix.lower() in ('.csv', '.tsv') and right_path.suffix.lower() in ('.csv', '.tsv')):
        raise ValueError("Explicit key and time columns apply only to CSV/TSV inputs.")
    if any(column and (not isinstance(column, str) or len(column) > 1200) for column in options):
        raise ValueError("Comparison columns must be exact bounded headers.")
    detailed = None
    if details:
        le, rext = left_path.suffix.lower(), right_path.suffix.lower()
        if xlsx:
            from .xlsx_comparison import read_selected_table
            ah, a, am, ab = read_selected_table(left_path, left_sheet)
            bh, b, bm, bb = read_selected_table(right_path, right_sheet)
            detailed = _compare_table_rows(ah, a, bh, b, key_column, period_column, event_date_column)
            detailed['selected_sheets'] = {'left': am, 'right': bm}
            detailed['blank_physical_rows'] = {'left': ab, 'right': bb, 'policy': 'exclude_entirely_empty_physical_rows_only'}
            detailed['limits'] = {**DETAIL_LIMITS, 'input_bytes': MAX_FILE_BYTES}
        elif le in ('.md', '.txt') and rext in ('.md', '.txt'):
            detailed = _text_details(_strict_detail_text(left_path), _strict_detail_text(right_path))
        elif le in ('.csv', '.tsv') and rext in ('.csv', '.tsv'):
            detailed = _table_details(_strict_detail_text(left_path), _strict_detail_text(right_path), le, rext,
                                      key_column, period_column, event_date_column)
        elif le == '.jsonl' and rext == '.jsonl':
            detailed = _jsonl_details(left_jsonl, right_jsonl)
        else:
            detailed = _detail_result('unsupported', 'unsupported', {}, [], reasons=['Detailed_compare_supports_MD_TXT_CSV_TSV_JSONL_pairs_only'])
        detailed.setdefault('time_sources', {'event_dates': {'basis': 'not_available'}, 'business_period': {'basis': 'not_inferred'}})
        detailed['time_sources']['file_modified'] = {'basis': 'filesystem_mtime',
            'left': datetime.fromtimestamp(left_path.stat().st_mtime, timezone.utc).isoformat(),
            'right': datetime.fromtimestamp(right_path.stat().st_mtime, timezone.utc).isoformat()}
        detailed['byte_equal'] = left_hash == right_hash

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
    elif xlsx:
        relation_type, basis = 'unknown', 'selected_sheet_keyed_row_facts'
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
        **({"details": detailed} if details else {}),
        "identity": {"same_content": left_hash == right_hash, "same_path": left_path == right_path,
                     "merge_performed": False, "note": "Equal Hash proves content equality, not shared Resource identity."},
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
                "modified_at": datetime.fromtimestamp(left_path.stat().st_mtime, timezone.utc).isoformat(),
            },
            "right": {
                "path": str(right_path),
                "name": right_path.name,
                "extension": right_path.suffix.lower(),
                "sha256": right_hash,
                "byte_size": right_size,
                "encoding": right_encoding,
                "modified_at": datetime.fromtimestamp(right_path.stat().st_mtime, timezone.utc).isoformat(),
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
            "model_visible_body_bytes": len(json.dumps(detailed['entries'], ensure_ascii=False).encode('utf-8')) if details else 0,
            "details_requested": details,
            "screenshots_used": 0,
            "maximum_returned_message_ids_per_side": MAX_RETURNED_IDS,
        },
        "next_action": {
            "mode": "use_local_relationship_evidence",
            "agent_role": "Interpret whether the deterministic relationship supports preserve, delta, or supersede.",
        },
    }
