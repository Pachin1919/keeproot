from __future__ import annotations

import hashlib
import json
import mimetypes
import posixpath
import re
import sqlite3
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from .common import CharacterBudget, validate_office_package, xml_root, zip_entry_names
from .delimited import choose_header, indexed_rows, read_delimited_file, unique_headers
from .document_readers import read_docx, read_pdf, read_pptx

PROCESSOR_VERSION = "0.3.4"
SCHEMA = "atlas.content-inspection.v1"
OFFICE_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
MAX_PROFILE_ROWS = 10_000
MAX_PROFILE_COLUMNS = 200
SENSITIVE_HEADER_RULES = (
    (re.compile(r"(phone|mobile|tel|contact|电话|手机|联系方式)", re.IGNORECASE), "contact_number"),
    (re.compile(r"(email|mail|邮箱|邮件)", re.IGNORECASE), "email"),
    (re.compile(r"(name|姓名|联系人)", re.IGNORECASE), "person_name"),
    (re.compile(r"(身份证|证件|passport|id.number)", re.IGNORECASE), "identity_number"),
)
BOOLEAN_HEADER_HINT = re.compile(
    r"(^|[_\s])(is|has|flag|boolean|enabled|disabled)([_\s]|$)|是否|启用状态|禁用状态|开关|布尔",
    re.IGNORECASE,
)


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_text_file(file_path: Path, budget: CharacterBudget) -> dict:
    byte_limit = min(4 * 1024 * 1024, max(1024 * 1024, budget.limit * 8))
    with file_path.open("rb") as stream:
        raw = stream.read(byte_limit + 1)
    input_truncated = len(raw) > byte_limit
    raw = raw[:byte_limit]
    encoding = "utf-8"
    text = None
    for candidate in ("utf-8-sig", "utf-16", "gb18030", "cp1252"):
        try:
            text = raw.decode(candidate)
            encoding = candidate
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = raw.decode("utf-8", errors="replace")
        encoding = "utf-8-replacement"
    return {
        "kind": "text",
        "status": "partial" if input_truncated or len(text) > budget.limit else "complete",
        "encoding": encoding,
        "sample_line_count": text.count("\n") + (1 if text else 0),
        "line_count_complete": not input_truncated,
        "text": budget.take(text, budget.limit),
    }


def read_delimited(file_path: Path, budget: CharacterBudget, *, purpose: str) -> dict:
    byte_limit = 16 * 1024 * 1024
    table = read_delimited_file(
        file_path,
        max_bytes=byte_limit,
        max_rows=MAX_PROFILE_ROWS + 13 if purpose == "data" else 100_001,
    )
    input_truncated = table.truncated
    if purpose == "data":
        raw_rows = indexed_rows(
            table,
            maximum_columns=MAX_PROFILE_COLUMNS,
            maximum_cell_characters=2000,
        )
        if len(raw_rows) >= MAX_PROFILE_ROWS + 12:
            input_truncated = True
        profile = profile_rows(raw_rows, file_path.name, input_truncated)
        return {
            **profile,
            "encoding": table.encoding,
            "delimiter": table.delimiter,
            "delimiter_detection": table.delimiter_detection,
            "decode_warning": table.decode_warning,
        }
    rows = []
    row_count = 0
    maximum_columns = 0
    for row in table.rows:
        row_count += 1
        maximum_columns = max(maximum_columns, len(row))
        if len(rows) < 12:
            rows.append([budget.take(value, 200) for value in row[:40]])
        if row_count >= 100_000:
            input_truncated = True
            break
    return {
        "kind": "delimited_text",
        "status": "partial" if input_truncated or row_count > len(rows) or budget.truncated else "complete",
        "encoding": table.encoding,
        "delimiter": table.delimiter,
        "delimiter_detection": table.delimiter_detection,
        "decode_warning": table.decode_warning,
        "row_count": row_count,
        "maximum_columns": maximum_columns,
        "header": rows[0] if rows else [],
        "sample_rows": rows[1:],
    }


def shared_strings(archive: zipfile.ZipFile, names: set[str]) -> tuple[list[str], bool]:
    if "xl/sharedStrings.xml" not in names:
        return [], False
    root = xml_root(archive, "xl/sharedStrings.xml")
    result = []
    total_characters = 0
    truncated = False
    for item in root.findall(f"{{{OFFICE_MAIN}}}si"):
        value = "".join(node.text or "" for node in item.iter(f"{{{OFFICE_MAIN}}}t"))
        clipped = value[:1000]
        result.append(clipped)
        total_characters += len(clipped)
        if len(value) > len(clipped):
            truncated = True
        if len(result) >= 100_000 or total_characters >= 8 * 1024 * 1024:
            truncated = True
            break
    return result, truncated


def worksheet_cell_value(cell: ET.Element, strings: list[str], budget: CharacterBudget) -> str:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        value = "".join(node.text or "" for node in cell.iter(f"{{{OFFICE_MAIN}}}t"))
    else:
        raw = cell.findtext(f"{{{OFFICE_MAIN}}}v", default="")
        if cell_type == "s" and raw.isdigit() and int(raw) < len(strings):
            value = strings[int(raw)]
        elif cell_type == "b":
            value = "TRUE" if raw == "1" else "FALSE"
        else:
            value = raw
    return budget.take(value, 300)


def worksheet_cell_raw_value(cell: ET.Element, strings: list[str]) -> str:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        value = "".join(node.text or "" for node in cell.iter(f"{{{OFFICE_MAIN}}}t"))
    else:
        raw = cell.findtext(f"{{{OFFICE_MAIN}}}v", default="")
        if cell_type == "s" and raw.isdigit() and int(raw) < len(strings):
            value = strings[int(raw)]
        elif cell_type == "b":
            value = "TRUE" if raw == "1" else "FALSE"
        else:
            value = raw
    return value[:2000]


def column_index(cell_reference: str) -> int:
    match = re.match(r"([A-Z]+)", cell_reference.upper())
    if not match:
        return 0
    result = 0
    for character in match.group(1):
        result = result * 26 + ord(character) - ord("A") + 1
    return result - 1


def column_label(index: int) -> str:
    value = index + 1
    result = ""
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(ord("A") + remainder) + result
    return result


def worksheet_rows_with_strings(
    root: ET.Element,
    strings: list[str],
) -> tuple[list[tuple[int, dict[int, str]]], bool]:
    rows: list[tuple[int, dict[int, str]]] = []
    truncated = False
    for row in root.findall(f".//{{{OFFICE_MAIN}}}row"):
        values: dict[int, str] = {}
        for fallback_index, cell in enumerate(row.findall(f"{{{OFFICE_MAIN}}}c")):
            index = column_index(cell.attrib.get("r", "")) if cell.attrib.get("r") else fallback_index
            if index >= MAX_PROFILE_COLUMNS:
                truncated = True
                continue
            value = worksheet_cell_raw_value(cell, strings)
            if value != "":
                values[index] = value
        if values:
            rows.append((int(row.attrib.get("r", len(rows) + 1)), values))
        if len(rows) >= MAX_PROFILE_ROWS + 12:
            truncated = True
            break
    return rows, truncated


def sensitive_reason(column_name: str, values: list[object]) -> str | None:
    for pattern, reason in SENSITIVE_HEADER_RULES:
        if pattern.search(column_name):
            return reason
    strings = [str(value).strip() for value in values if value not in (None, "")][:200]
    if strings and sum(bool(re.fullmatch(r"\+?\d[\d\s-]{8,}", value)) for value in strings) / len(strings) >= 0.8:
        return "contact_or_identifier_pattern"
    if strings and sum("@" in value and "." in value for value in strings) / len(strings) >= 0.8:
        return "email_pattern"
    return None


def infer_column(series, column_name: str) -> tuple[str, dict | None]:
    import pandas as pd

    non_empty = series.dropna().astype(str).str.strip()
    non_empty = non_empty[non_empty != ""]
    if non_empty.empty:
        return "empty", None
    lowered = set(non_empty.str.lower().unique())
    if lowered.issubset({"true", "false", "yes", "no", "是", "否"}):
        return "boolean", None
    if lowered.issubset({"0", "1"}) and BOOLEAN_HEADER_HINT.search(column_name):
        return "boolean", None
    if re.search(r"(date|time|month|year|日期|时间|月份|年月)", column_name, re.IGNORECASE):
        parsed = pd.to_datetime(non_empty, errors="coerce")
        if parsed.notna().mean() >= 0.6:
            parsed_values = parsed.dropna()
            inferred_type = (
                "date"
                if not parsed_values.empty
                and parsed_values.eq(parsed_values.dt.normalize()).all()
                else "datetime"
            )
            return inferred_type, {
                "minimum": parsed.min().isoformat(),
                "maximum": parsed.max().isoformat(),
            }
    numeric = pd.to_numeric(non_empty, errors="coerce")
    if numeric.notna().mean() >= 0.9 and sensitive_reason(column_name, non_empty.tolist()) is None:
        numeric_values = numeric.dropna()
        if not numeric_values.empty and numeric_values.mod(1).abs().le(1e-12).all():
            return "integer", None
        return "number", None
    if non_empty.str.match(r"https?://", case=False).mean() >= 0.8:
        return "url", None
    return "text", None


def profile_rows(
    rows: list[tuple[int, dict[int, str]]],
    sheet_name: str,
    truncated: bool,
    *,
    merged_ranges: list[str] | None = None,
    formula_count: int = 0,
) -> dict:
    try:
        import pandas as pd
    except ImportError as error:
        raise ValueError("Tabular profiling requires the managed Pandas component") from error

    header_offset, header_row_number, header = choose_header(rows)
    width = min(
        MAX_PROFILE_COLUMNS,
        max((max(row.keys(), default=-1) + 1 for _, row in rows), default=0),
    )
    if not header or width == 0:
        return {
            "kind": "tabular_profile",
            "status": "unavailable",
            "engine": "pandas+sqlite",
            "sheet": sheet_name,
            "reason": "No non-empty table rows were found.",
        }
    headers = unique_headers(header, width)
    records = []
    for _, row in rows[header_offset + 1:MAX_PROFILE_ROWS + header_offset + 1]:
        record = [row.get(index) or None for index in range(width)]
        if any(value not in (None, "") for value in record):
            records.append(record)
    frame = pd.DataFrame(records, columns=headers, dtype="object")
    columns = []
    sensitive_columns = []
    for name in headers:
        series = frame[name] if name in frame else pd.Series(dtype="object")
        inferred_type, date_range = infer_column(series, name)
        missing_mask = series.isna() | series.fillna("").astype(str).str.strip().eq("")
        missing_count = int(missing_mask.sum())
        detail = {
            "name": name,
            "inferred_type": inferred_type,
            "missing_count": missing_count,
            "missing_rate": round(missing_count / len(frame), 6) if len(frame) else None,
            "distinct_count": int(series.dropna().astype(str).nunique()),
        }
        if date_range:
            detail["date_range"] = date_range
        columns.append(detail)
        reason = sensitive_reason(name, series.tolist())
        if reason:
            sensitive_columns.append({"column": name, "reason": reason})

    duplicate_count = int(frame.duplicated(keep="first").sum()) if len(frame) else 0
    connection = sqlite3.connect(":memory:")
    try:
        frame.to_sql("profile_data", connection, index=False, if_exists="replace")
        sql_row_count = int(connection.execute("SELECT COUNT(*) FROM profile_data").fetchone()[0])
        sql_distinct_count = int(
            connection.execute("SELECT COUNT(*) FROM (SELECT DISTINCT * FROM profile_data)").fetchone()[0]
        )
    finally:
        connection.close()
    sql_duplicate_count = sql_row_count - sql_distinct_count
    cross_check = {
        "status": "pass" if sql_row_count == len(frame) and sql_duplicate_count == duplicate_count else "fail",
        "pandas_row_count": len(frame),
        "sql_row_count": sql_row_count,
        "pandas_duplicate_row_count": duplicate_count,
        "sql_duplicate_row_count": sql_duplicate_count,
    }
    merged_ranges = merged_ranges or []
    header_merged = any(
        re.search(rf"\d+", cell_range)
        and header_row_number in [int(value) for value in re.findall(r"\d+", cell_range)]
        for cell_range in merged_ranges
    )
    warnings = []
    if header_merged:
        warnings.append(
            "The selected header row intersects merged cells; column names may require Agent review before splitting or normalization."
        )
    return {
        "kind": "tabular_profile",
        "status": "partial" if truncated or len(records) >= MAX_PROFILE_ROWS else "complete",
        "engine": "pandas+sqlite",
        "sheet": sheet_name,
        "header_row": header_row_number,
        "row_count": len(frame),
        "column_count": len(headers),
        "duplicate_row_count": duplicate_count,
        "formula_count": formula_count,
        "columns": columns,
        "sensitive_columns": sensitive_columns,
        "raw_values_returned": False,
        "header_layout": "merged_or_multilevel" if header_merged else "flat_candidate",
        "quality_warnings": warnings,
        "cross_check": cross_check,
        "limits": {"maximum_rows": MAX_PROFILE_ROWS, "maximum_columns": MAX_PROFILE_COLUMNS},
    }


def normalize_xlsx_target(target: str) -> str:
    clean = target.replace("\\", "/").lstrip("/")
    if clean.startswith("xl/"):
        return posixpath.normpath(clean)
    return posixpath.normpath(posixpath.join("xl", clean))


def read_xlsx(
    file_path: Path,
    budget: CharacterBudget,
    *,
    purpose: str,
    selected_sheet: str | None,
) -> dict:
    with zipfile.ZipFile(file_path) as archive:
        validate_office_package(archive)
        names = zip_entry_names(archive)
        required = {"xl/workbook.xml", "xl/_rels/workbook.xml.rels"}
        if not required.issubset(names):
            raise ValueError("XLSX package is missing workbook metadata")
        workbook = xml_root(archive, "xl/workbook.xml")
        relationships = xml_root(archive, "xl/_rels/workbook.xml.rels")
        targets = {
            relation.attrib["Id"]: normalize_xlsx_target(relation.attrib["Target"])
            for relation in relationships.findall(f"{{{PACKAGE_REL}}}Relationship")
            if relation.attrib.get("Id") and relation.attrib.get("Target")
        }
        strings, strings_truncated = shared_strings(archive, names)
        sheets = []
        all_sheets = workbook.findall(f".//{{{OFFICE_MAIN}}}sheet")
        available_names = [sheet.attrib.get("name", "") for sheet in all_sheets]
        hidden_sheet_count = sum(
            sheet.attrib.get("state", "visible") != "visible" for sheet in all_sheets
        )
        if selected_sheet and selected_sheet not in available_names:
            raise ValueError(
                f"Worksheet does not exist: {selected_sheet}; available sheets: {available_names}"
            )
        if purpose == "data":
            if not selected_sheet:
                raise ValueError(
                    "XLSX data profiling requires --sheet with one exact worksheet name; "
                    f"available sheets: {available_names}"
                )
        for sheet in all_sheets[:50]:
            sheet_name = sheet.attrib.get("name", "")
            if selected_sheet and sheet_name != selected_sheet:
                continue
            relationship_id = sheet.attrib.get(f"{{{OFFICE_REL}}}id")
            member = targets.get(relationship_id, "")
            if member not in names:
                sheets.append({
                    "name": budget.take(sheet_name, 200),
                    "status": "missing_worksheet_part",
                    "used_range": None,
                    "header_rows": [],
                    "merged_ranges": [],
                })
                continue
            root = xml_root(archive, member)
            rows, rows_truncated = worksheet_rows_with_strings(root, strings)
            formula_count = len(root.findall(f".//{{{OFFICE_MAIN}}}f"))
            merged = [
                item.attrib.get("ref", "")
                for item in root.findall(f".//{{{OFFICE_MAIN}}}mergeCell")
                if item.attrib.get("ref")
            ][:100]
            if purpose == "data":
                if sheet_name == selected_sheet:
                    return profile_rows(
                        rows,
                        sheet_name,
                        rows_truncated or strings_truncated,
                        merged_ranges=merged,
                        formula_count=formula_count,
                    )
                continue
            dimension = root.find(f"{{{OFFICE_MAIN}}}dimension")
            _, header_row_number, header = choose_header(rows)
            header_rows = []
            if header and selected_sheet:
                header_rows.append({
                    "row": header_row_number,
                    "cells": [
                        {
                            "cell": f"{column_label(index)}{header_row_number}",
                            "value": budget.take(value, 300),
                        }
                        for index, value in sorted(header.items())
                    ],
                })
            sensitive_headers = [
                {"column": value, "reason": reason}
                for value in header.values()
                if (reason := sensitive_reason(value, []))
            ]
            if selected_sheet:
                sheets.append({
                    "name": budget.take(sheet_name, 200),
                    "status": "read",
                    "visibility": sheet.attrib.get("state", "visible"),
                    "used_range": dimension.attrib.get("ref") if dimension is not None else None,
                    "header_rows": header_rows,
                    "merged_range_count": len(merged),
                    "merged_ranges": merged[:8],
                    "merged_ranges_truncated": len(merged) > 8,
                    "formula_count": formula_count,
                    "sensitive_header_candidates": sensitive_headers,
                })
            else:
                sheets.append({
                    "name": budget.take(sheet_name, 200),
                    "status": "read",
                    "visibility": sheet.attrib.get("state", "visible"),
                    "used_range": dimension.attrib.get("ref") if dimension is not None else None,
                    "header_row": header_row_number or None,
                    "headers": [budget.take(value, 120) for value in header.values()],
                    "merged_range_count": len(merged),
                    "formula_count": formula_count,
                    "sensitive_header_candidates": sensitive_headers,
                })
        return {
            "kind": "xlsx",
            "status": "partial"
            if len(all_sheets) > len(sheets) or budget.truncated or strings_truncated
            else "complete",
            "sheet_count": len(all_sheets),
            "hidden_sheet_count": hidden_sheet_count,
            "mode": "sheet_detail" if selected_sheet else "workbook_overview",
            "selected_sheet": selected_sheet,
            "sheets": sheets,
        }


def next_action(extension: str, purpose: str, extraction: dict) -> dict:
    if purpose == "visual":
        return {
            "mode": "bounded_visual_preview",
            "reason": "The requested judgment depends on layout or appearance after local structure/text extraction.",
            "visual_budget": {
                "maximum_images": 4,
                "maximum_resolution": "640x360",
                "selection": "representative_pages_or_slides",
            },
        }
    if extension == ".pdf" and extraction.get("image_only_pages"):
        return {
            "mode": "use_local_extraction_with_gaps",
            "reason": "Use the local PDF text layer. Image-only page numbers are reported separately; request a user export or bounded OCR/preview only if those pages are necessary.",
            "unreadable_page_count": len(extraction["image_only_pages"]),
        }
    if extraction["status"] in {"complete", "partial"}:
        if purpose == "data":
            return {
                "mode": "use_local_data_profile",
                "reason": "Use the deterministic Pandas/SQL profile for facts; ask the Agent only to interpret business meaning.",
            }
        return {
            "mode": "use_local_extraction",
            "reason": "The local result is sufficient for structure or content reasoning; do not open a browser or desktop application.",
        }
    return {
        "mode": "specialized_local_parser_required",
        "reason": f"No built-in local parser is available for {extension or 'this file type'}; add or invoke a local parser before using screenshots.",
    }


def inspect_file(
    file_value: str,
    *,
    purpose: str,
    max_characters: int,
    expected_sha256: str,
    sheet: str | None = None,
) -> dict:
    file_path = Path(file_value)
    if not file_path.exists() or not file_path.is_file():
        raise ValueError(f"Input must be one existing regular file: {file_path}")
    budget = CharacterBudget(max_characters)
    source_hash = sha256_file(file_path)
    if source_hash != expected_sha256:
        raise ValueError("Input Hash changed before local extraction")
    extension = file_path.suffix.lower()

    if extension in {".csv", ".tsv"}:
        extraction = read_delimited(file_path, budget, purpose=purpose)
    elif extension == ".xlsx":
        extraction = read_xlsx(
            file_path,
            budget,
            purpose=purpose,
            selected_sheet=sheet,
        )
    elif extension == ".pptx":
        extraction = read_pptx(file_path, budget)
    elif extension == ".docx":
        extraction = read_docx(file_path, budget)
    elif extension == ".pdf":
        extraction = read_pdf(file_path, budget)
    elif extension in {
        ".txt", ".md", ".markdown", ".json", ".jsonl", ".xml",
        ".yaml", ".yml", ".html", ".htm", ".css", ".js", ".ts",
        ".jsx", ".tsx", ".py", ".sql",
    }:
        extraction = read_text_file(file_path, budget)
    else:
        if purpose == "data":
            raise ValueError("Data profiling currently supports CSV, TSV, and one exact XLSX sheet")
        extraction = {
            "kind": extension.lstrip(".") or "unknown",
            "status": "unsupported",
        }

    stat = file_path.stat()
    return {
        "schema": SCHEMA,
        "source": {
            "path": str(file_path.resolve()),
            "name": file_path.name,
            "extension": extension,
            "media_type": mimetypes.guess_type(file_path.name)[0],
            "bytes": stat.st_size,
            "sha256": source_hash,
            "modified_ns": stat.st_mtime_ns,
        },
        "purpose": purpose,
        "selection": {"sheet": sheet},
        "processor": {
            "name": "atlas-local-content",
            "version": PROCESSOR_VERSION,
            "language": "python",
            "local": True,
            "network_used": False,
            "browser_used": False,
            "external_application_used": False,
        },
        "extraction": extraction,
        "attention": {
            "maximum_characters": max_characters,
            "characters_returned": budget.used,
            "truncated": budget.truncated or extraction["status"] == "partial",
            "screenshots_used": 0,
        },
        "next_action": next_action(extension, purpose, extraction),
    }
