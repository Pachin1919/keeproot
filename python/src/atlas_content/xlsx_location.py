from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import stat
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from .common import validate_office_package, xml_root, zip_entry_names
from .inspector import OFFICE_MAIN, OFFICE_REL, PACKAGE_REL, normalize_xlsx_target, column_index

MAX_XLSX_BYTES = 64 * 1024 * 1024
MAX_SHEETS = 50
MAX_CELLS = 50
MAX_CELL_TEXT = 1_200
MAX_EXCEL_ROW = 1_048_576
MAX_EXCEL_COLUMN = 16_384
CELL_PATTERN = re.compile(r"^([A-Z]{1,3})([1-9][0-9]{0,6})$", re.IGNORECASE)


def _fingerprint(file_path: Path) -> tuple[str, os.stat_result]:
    before = file_path.lstat()
    if not stat.S_ISREG(before.st_mode) or file_path.is_symlink():
        raise ValueError("XLSX must be a regular file, not a symbolic link")
    if before.st_size > MAX_XLSX_BYTES:
        raise ValueError("XLSX exceeds the 64 MiB content-location limit")
    digest = hashlib.sha256()
    with file_path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    after = file_path.lstat()
    if (before.st_size, before.st_mtime_ns, before.st_ino, before.st_dev) != (
        after.st_size, after.st_mtime_ns, after.st_ino, after.st_dev
    ):
        raise ValueError("XLSX changed while its locations were being read")
    return digest.hexdigest(), before


def normalize_cell(value: str) -> str:
    match = CELL_PATTERN.fullmatch(value.strip())
    if not match:
        raise ValueError("Cell must be a standard A1 coordinate such as A1 or XFD1048576")
    label = match.group(1).upper()
    row = int(match.group(2))
    column = column_index(label)
    if row > MAX_EXCEL_ROW or column >= MAX_EXCEL_COLUMN:
        raise ValueError("Cell coordinate exceeds the XLSX row or column limit")
    return f"{label}{row}"


def _column_number(label: str) -> int:
    number = 0
    for character in label:
        number = number * 26 + ord(character) - ord("A") + 1
    return number


def _inside_range(cell: str, range_value: str) -> tuple[bool, bool]:
    parts = range_value.split(":", 1)
    if len(parts) == 1:
        parts.append(parts[0])
    points = []
    for item in parts:
        match = CELL_PATTERN.fullmatch(item.replace("$", ""))
        if not match:
            return False, False
        points.append((_column_number(match.group(1).upper()), int(match.group(2))))
    target = CELL_PATTERN.fullmatch(cell)
    if not target:
        return False, False
    column, row = _column_number(target.group(1)), int(target.group(2))
    left, top = points[0]
    right, bottom = points[1]
    contains = min(left, right) <= column <= max(left, right) and min(top, bottom) <= row <= max(top, bottom)
    return contains, contains and column == min(left, right) and row == min(top, bottom)


def _shared_strings(archive: zipfile.ZipFile, names: set[str]) -> list[str]:
    if "xl/sharedStrings.xml" not in names:
        return []
    root = xml_root(archive, "xl/sharedStrings.xml")
    return ["".join(node.text or "" for node in item.iter(f"{{{OFFICE_MAIN}}}t"))
            for item in root.findall(f"{{{OFFICE_MAIN}}}si")]


def _raw_cell(cell: ET.Element, strings: list[str]) -> tuple[str | None, str, str | None, bool, bool]:
    cell_type = cell.attrib.get("t")
    formula = cell.find(f"{{{OFFICE_MAIN}}}f")
    formula_text = (formula.text or "") if formula is not None else None
    formula_truncated = bool(formula_text is not None and len(formula_text) > 500)
    if formula_truncated:
        formula_text = formula_text[:500]
    value_node = cell.find(f"{{{OFFICE_MAIN}}}v")
    if cell_type == "inlineStr":
        value = "".join(node.text or "" for node in cell.iter(f"{{{OFFICE_MAIN}}}t"))
        status = "value" if value else "empty"
    elif formula is not None and value_node is None:
        return None, "formula_no_cache", formula_text, True, formula_truncated
    else:
        raw = value_node.text if value_node is not None and value_node.text is not None else ""
        if cell_type == "s":
            if not raw.isdigit() or int(raw) >= len(strings):
                return None, "unavailable", formula_text, formula is not None, formula_truncated
            value = strings[int(raw)]
        elif cell_type == "b":
            value = "TRUE" if raw == "1" else "FALSE"
        else:
            value = raw
        if cell_type == "e":
            status = "error"
        elif formula is not None:
            status = "formula_cached"
        else:
            status = "value" if value else "empty"
    return value, status, formula_text, formula is not None, formula_truncated


def _text_fact(value: str | None) -> dict:
    if value is None:
        return {"value": None, "value_sha256": None, "value_characters": None, "value_truncated": False}
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return {"value": value[:MAX_CELL_TEXT], "value_sha256": digest,
            "value_characters": len(value), "value_truncated": len(value) > MAX_CELL_TEXT}


def _worksheet_target(sheet: ET.Element, targets: dict[str, tuple[str, bool, bool]], names: set[str]) -> tuple[str | None, str]:
    relationship_id = sheet.attrib.get(f"{{{OFFICE_REL}}}id", "")
    target = targets.get(relationship_id)
    if not target:
        return None, "missing_worksheet_part"
    member, external, is_worksheet = target
    if not is_worksheet or external or member.startswith("../") or not member.startswith("xl/") or member not in names:
        return None, "missing_worksheet_part"
    return member, "available"


def _read_cell(cell: ET.Element | None, coordinate: str, strings: list[str], merges: list[str], merges_truncated: bool) -> dict:
    if cell is None:
        value, status, formula_text, formula_present, formula_truncated = "", "empty", None, False, False
        exists = False
    else:
        value, status, formula_text, formula_present, formula_truncated = _raw_cell(cell, strings)
        exists = True
    merge_range = None
    merge_state = "none"
    for item in merges:
        contains, anchor = _inside_range(coordinate, item)
        if contains:
            merge_range = item
            merge_state = "anchor" if anchor else "non_anchor"
            break
    if merge_state == "non_anchor":
        value, status, formula_text, formula_present, formula_truncated = None, "merged_non_anchor", None, False, False
    return {"cell": coordinate, "status": status, **_text_fact(value), "cell_exists": exists,
            "formula_present": formula_present, "formula": formula_text,
            "formula_truncated": formula_truncated,
            "merged_range": merge_range, "merge_state": "unknown" if merges_truncated and merge_state == "none" else merge_state}


def _parse_book(archive: zipfile.ZipFile):
    names = zip_entry_names(archive)
    required = {"xl/workbook.xml", "xl/_rels/workbook.xml.rels"}
    if not required.issubset(names):
        raise ValueError("XLSX package is missing workbook metadata")
    workbook = xml_root(archive, "xl/workbook.xml")
    relationships = xml_root(archive, "xl/_rels/workbook.xml.rels")
    targets: dict[str, tuple[str, bool, bool]] = {}
    for relation in relationships.findall(f"{{{PACKAGE_REL}}}Relationship"):
        relation_id = relation.attrib.get("Id")
        target_value = relation.attrib.get("Target")
        if not relation_id or not target_value:
            continue
        external = relation.attrib.get("TargetMode") == "External"
        relationship_type = relation.attrib.get("Type", "")
        if relation_id in targets:
            raise ValueError("XLSX package contains duplicate relationship identifiers")
        targets[relation_id] = (normalize_xlsx_target(target_value), external, relationship_type.endswith("/worksheet"))
    sheets = workbook.findall(f".//{{{OFFICE_MAIN}}}sheet")
    sheet_names = [item.attrib.get("name", "") for item in sheets]
    if len(sheet_names) != len(set(sheet_names)):
        raise ValueError("XLSX workbook contains ambiguous duplicate worksheet names")
    if any(not name or len(name) > 31 for name in sheet_names):
        raise ValueError("XLSX workbook contains an invalid worksheet name")
    if any(item.attrib.get("state", "visible") not in {"visible", "hidden", "veryHidden"} for item in sheets):
        raise ValueError("XLSX workbook contains an unsupported worksheet visibility state")
    return names, sheets, targets


def inspect_xlsx_locations(file_path: str, expected_sha256: str, *, sheet_name: str | None = None,
                           cell_value: str | None = None, limit: int = 50) -> dict:
    if not isinstance(limit, int) or limit < 1 or limit > MAX_CELLS:
        raise ValueError("XLSX cell location limit must be between 1 and 50")
    selected_cell = normalize_cell(cell_value) if cell_value else None
    if selected_cell and not sheet_name:
        raise ValueError("An exact --sheet is required when locating one cell")
    if len(expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_sha256):
        raise ValueError("Expected XLSX SHA-256 is invalid")
    target_path = Path(file_path)
    before_hash, before_stat = _fingerprint(target_path)
    if before_hash != expected_sha256:
        raise ValueError("XLSX changed before cell extraction")
    try:
        with zipfile.ZipFile(target_path) as archive:
            validate_office_package(archive)
            names, sheets, targets = _parse_book(archive)
            sheet_facts = []
            matched_sheet = None
            for index, item in enumerate(sheets):
                name = item.attrib.get("name", "")
                visibility = item.attrib.get("state", "visible")
                part, status = _worksheet_target(item, targets, names)
                if sheet_name == name:
                    matched_sheet = (item, part, status)
                if index < MAX_SHEETS:
                    sheet_facts.append({"name": name, "visibility": visibility, "status": status})
            if sheet_name is None:
                result = {"schema": "atlas.xlsx-location.v1", "file_sha256": expected_sha256,
                          "mode": "workbook", "sheet_count": len(sheets), "sheets": sheet_facts,
                          "sheets_truncated": len(sheets) > MAX_SHEETS}
            else:
                if matched_sheet is None:
                    raise ValueError("Worksheet does not exist; choose an exact visible or hidden Sheet name")
                sheet_element, member, part_status = matched_sheet
                if part_status != "available" or member is None:
                    raise ValueError("Selected worksheet part is unavailable")
                root = xml_root(archive, member)
                merges = [node.attrib.get("ref", "") for node in root.findall(f".//{{{OFFICE_MAIN}}}mergeCell") if node.attrib.get("ref")][:1000]
                merges_truncated = len(root.findall(f".//{{{OFFICE_MAIN}}}mergeCell")) > len(merges)
                strings = _shared_strings(archive, names)
                rows = root.findall(f".//{{{OFFICE_MAIN}}}sheetData/{{{OFFICE_MAIN}}}row")
                cells_out = []
                cells_truncated = False
                if selected_cell:
                    cell = root.find(f".//{{{OFFICE_MAIN}}}sheetData/{{{OFFICE_MAIN}}}row/{{{OFFICE_MAIN}}}c[@r='{selected_cell}']")
                    cells_out.append(_read_cell(cell, selected_cell, strings, merges, merges_truncated))
                else:
                    for row in rows:
                        for cell in row.findall(f"{{{OFFICE_MAIN}}}c"):
                            coordinate = cell.attrib.get("r", "").upper()
                            if not coordinate:
                                continue
                            try:
                                coordinate = normalize_cell(coordinate)
                            except ValueError:
                                continue
                            item = _read_cell(cell, coordinate, strings, merges, merges_truncated)
                            if item["status"] == "empty" and not item["formula_present"] and not item["cell_exists"]:
                                continue
                            if len(cells_out) < limit:
                                cells_out.append(item)
                            else:
                                cells_truncated = True
                                break
                        if cells_truncated:
                            break
                result = {"schema": "atlas.xlsx-location.v1", "file_sha256": expected_sha256,
                          "mode": "sheet", "sheet_count": len(sheets),
                          "sheets": sheet_facts, "sheets_truncated": len(sheets) > MAX_SHEETS,
                          "sheet": {"name": sheet_element.attrib.get("name", ""),
                                    "visibility": sheet_element.attrib.get("state", "visible"),
                                    "status": "available"},
                          "cell": selected_cell, "cells": cells_out,
                          "cells_truncated": cells_truncated,
                          "merged_ranges_truncated": merges_truncated}
    except (zipfile.BadZipFile, OSError, ET.ParseError) as error:
        raise ValueError("XLSX package is damaged or cannot be read") from error
    after_hash, after_stat = _fingerprint(target_path)
    if before_hash != after_hash or (before_stat.st_size, before_stat.st_mtime_ns, before_stat.st_ino, before_stat.st_dev) != (
        after_stat.st_size, after_stat.st_mtime_ns, after_stat.st_ino, after_stat.st_dev
    ):
        raise ValueError("XLSX changed during location extraction")
    result.update({"bytes": before_stat.st_size, "file_sha256": expected_sha256})
    return result


def inspect_xlsx_row(file_path: str, expected_sha256: str, *, sheet_name: str,
                     row_number: int | None = None, key_column: str | None = None,
                     key_value: str | None = None, max_columns: int = 50) -> dict:
    """Return one bounded row snapshot, locating keyed rows by their current position."""
    if not sheet_name or len(sheet_name) > 31:
        raise ValueError("An exact worksheet name is required")
    if (row_number is None) == (key_column is None or key_value is None):
        raise ValueError("Provide either an Excel row number or a key column and value")
    if row_number is not None and (not isinstance(row_number, int) or row_number < 1 or row_number > MAX_EXCEL_ROW):
        raise ValueError("Excel row is outside supported bounds")
    if key_column is not None:
        key_column = re.sub(r"[0-9]+$", "", key_column.strip().upper())
        if not re.fullmatch(r"[A-Z]{1,3}", key_column) or _column_number(key_column) > MAX_EXCEL_COLUMN:
            raise ValueError("Key column must be a valid Excel column")
        if not isinstance(key_value, str) or not key_value.strip() or len(key_value) > MAX_CELL_TEXT:
            raise ValueError("Key value is required and must be bounded")
    if not isinstance(max_columns, int) or max_columns < 1 or max_columns > 50:
        raise ValueError("Row candidate supports at most 50 columns")
    if len(expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_sha256):
        raise ValueError("Expected XLSX SHA-256 is invalid")
    target_path = Path(file_path)
    before_hash, before_stat = _fingerprint(target_path)
    if before_hash != expected_sha256:
        raise ValueError("XLSX changed before row extraction")
    try:
        with zipfile.ZipFile(target_path) as archive:
            validate_office_package(archive)
            names, sheets, targets = _parse_book(archive)
            selected = next((item for item in sheets if item.attrib.get("name") == sheet_name), None)
            if selected is None:
                raise ValueError("Worksheet does not exist")
            part, status = _worksheet_target(selected, targets, names)
            if status != "available" or not part:
                raise ValueError("Selected worksheet part is unavailable")
            root = xml_root(archive, part)
            strings = _shared_strings(archive, names)
            rows = root.findall(f".//{{{OFFICE_MAIN}}}sheetData/{{{OFFICE_MAIN}}}row")
            matches = []
            for item in rows:
                actual_row = int(item.attrib.get("r", "0"))
                if row_number is not None:
                    if actual_row == row_number:
                        matches.append(item)
                        break
                else:
                    for cell in item.findall(f"{{{OFFICE_MAIN}}}c"):
                        coordinate = cell.attrib.get("r", "")
                        try:
                            normalized = normalize_cell(coordinate)
                        except ValueError:
                            continue
                        match = CELL_PATTERN.fullmatch(normalized)
                        if match and match.group(1).upper() == key_column and _raw_cell(cell, strings)[0] == key_value:
                            matches.append(item)
                            break
                    if len(matches) > 1:
                        break
            if not matches:
                raise ValueError("XLSX row identity was not found")
            if len(matches) != 1:
                raise ValueError("XLSX row key is not unique")
            selected_row = matches[0]
            actual_row = int(selected_row.attrib.get("r", "0"))
            cells = []
            row_hash_parts = []
            for cell in selected_row.findall(f"{{{OFFICE_MAIN}}}c"):
                coordinate = normalize_cell(cell.attrib.get("r", ""))
                parsed = CELL_PATTERN.fullmatch(coordinate)
                if not parsed or int(parsed.group(2)) != actual_row:
                    continue
                value, cell_status, formula, formula_present, formula_truncated = _raw_cell(cell, strings)
                fact = {"cell": coordinate, "column": parsed.group(1).upper(), "status": cell_status,
                        **_text_fact(value), "formula_present": formula_present,
                        "formula": formula, "formula_truncated": formula_truncated}
                row_hash_parts.append({"column": fact["column"], "status": fact["status"],
                                       "value_sha256": fact["value_sha256"], "formula_present": fact["formula_present"],
                                       "formula_sha256": hashlib.sha256((fact["formula"] or "").encode("utf-8")).hexdigest()})
                if len(cells) < max_columns:
                    cells.append(fact)
                else:
                    raise ValueError("XLSX row exceeds the bounded column count")
            if not cells:
                raise ValueError("XLSX row has no readable cells")
            row_sha = hashlib.sha256(json.dumps(row_hash_parts, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    except (zipfile.BadZipFile, OSError, ET.ParseError) as error:
        raise ValueError("XLSX package is damaged or cannot be read") from error
    after_hash, after_stat = _fingerprint(target_path)
    if before_hash != after_hash or (before_stat.st_size, before_stat.st_mtime_ns, before_stat.st_ino, before_stat.st_dev) != (
        after_stat.st_size, after_stat.st_mtime_ns, after_stat.st_ino, after_stat.st_dev
    ):
        raise ValueError("XLSX changed during row extraction")
    return {"schema": "atlas.xlsx-row.v1", "file_sha256": before_hash, "sheet": sheet_name,
            "row": actual_row, "row_sha256": row_sha, "key": {"column": key_column, "value": key_value} if key_column else None,
            "cells": cells, "status": "available"}
