from __future__ import annotations

import hashlib
import json
import math
import re
import zipfile
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import date
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape as xml_escape

import pandas as pd

from .common import validate_office_package, xml_root, zip_entry_names
from .delimited import choose_header, indexed_rows, read_delimited_file, unique_headers
from .inspector import (
    OFFICE_MAIN, OFFICE_REL, PACKAGE_REL, infer_column,
    normalize_xlsx_target, shared_strings,
)

PROCESSOR_VERSION = "1.2.0"
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_ROWS = 200_000
MAX_COLUMNS = 200


def _sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _source(file_value: str, expected_sha256: str) -> Path:
    source = Path(file_value).resolve()
    if not source.exists() or not source.is_file():
        raise ValueError("Data Work needs one existing local CSV or XLSX file")
    if source.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("This file is larger than Atlas Data Work can process locally")
    if _sha256(source) != expected_sha256:
        raise ValueError("Source changed before Atlas could read it")
    if source.suffix.lower() not in {".csv", ".xlsx"}:
        raise ValueError("Data Work currently supports CSV and XLSX files")
    return source


def _csv_rows(source: Path) -> tuple[list[str], list[list[str | None]], dict[str, Any]]:
    table = read_delimited_file(source, max_rows=MAX_ROWS + 2)
    rows = table.rows
    if not rows:
        return [], [], {
            "encoding": table.encoding,
            "delimiter": table.delimiter,
            "delimiter_detection": table.delimiter_detection,
            "decode_warning": table.decode_warning,
        }
    if table.truncated or len(rows) - 1 > MAX_ROWS:
        raise ValueError(f"This file has more than the {MAX_ROWS:,} row local Data Work limit")
    indexed = indexed_rows(table, maximum_columns=MAX_COLUMNS)
    header_offset, header_row, header = choose_header(indexed)
    width = min(
        MAX_COLUMNS,
        max((max(values.keys(), default=-1) + 1 for _, values in indexed), default=0),
    )
    headers = unique_headers(header, width)
    records = []
    for _, row in indexed[header_offset + 1:]:
        values = [row.get(index) for index in range(width)]
        if any(value not in (None, "") for value in values):
            records.append(values)
    return headers, records, {
        "encoding": table.encoding,
        "delimiter": table.delimiter,
        "delimiter_detection": table.delimiter_detection,
        "decode_warning": table.decode_warning,
        "header_row": header_row,
    }


def _xlsx_sheet_rows(source: Path, selected_sheet: str) -> tuple[list[str], list[list[str | None]], dict[str, Any]]:
    with zipfile.ZipFile(source) as archive:
        validate_office_package(archive)
        names = zip_entry_names(archive)
        workbook = xml_root(archive, "xl/workbook.xml")
        relationships = xml_root(archive, "xl/_rels/workbook.xml.rels")
        targets = {relation.attrib["Id"]: normalize_xlsx_target(relation.attrib["Target"])
                   for relation in relationships.findall(f"{{{PACKAGE_REL}}}Relationship")
                   if relation.attrib.get("Id") and relation.attrib.get("Target")}
        all_sheets = workbook.findall(f".//{{{OFFICE_MAIN}}}sheet")
        names_by_sheet = [sheet.attrib.get("name", "") for sheet in all_sheets]
        if selected_sheet not in names_by_sheet:
            raise ValueError("Choose one of the workbook sheets shown by Atlas")
        sheet = next(item for item in all_sheets if item.attrib.get("name") == selected_sheet)
        member = targets.get(sheet.attrib.get(f"{{{OFFICE_REL}}}id"), "")
        if member not in names:
            raise ValueError("The selected worksheet cannot be read")
        # The existing inspector intentionally bounds its profile reader. Data Work must
        # process the complete selected sheet, so parse the same safe XML package here.
        strings, _ = shared_strings(archive, names)
        root = xml_root(archive, member)
        raw_rows = _full_worksheet_rows(root, strings)
        if len(raw_rows) > MAX_ROWS + 12:
            raise ValueError(f"This sheet has more than the {MAX_ROWS:,} row local Data Work limit")
        header_offset, header_row, header = choose_header(raw_rows)
        width = min(MAX_COLUMNS, max((max(values.keys(), default=-1) + 1 for _, values in raw_rows), default=0))
        headers = unique_headers(header, width)
        records = []
        for _, row in raw_rows[header_offset + 1:]:
            values = [row.get(index) for index in range(width)]
            if any(value not in (None, "") for value in values):
                records.append(values)
        return headers, records, {"sheet": selected_sheet, "header_row": header_row, "available_sheets": names_by_sheet}


def _column_index(reference: str) -> int:
    match = re.match(r"([A-Z]+)", reference.upper())
    if not match:
        return 0
    value = 0
    for character in match.group(1):
        value = value * 26 + ord(character) - ord("A") + 1
    return value - 1


def _cell_value(cell: ET.Element, strings: list[str]) -> str | None:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{{{OFFICE_MAIN}}}t"))
    raw = cell.findtext(f"{{{OFFICE_MAIN}}}v", default="")
    if cell_type == "s" and raw.isdigit() and int(raw) < len(strings):
        return strings[int(raw)]
    if cell_type == "b":
        return "TRUE" if raw == "1" else "FALSE"
    return raw or None


def _full_worksheet_rows(root: ET.Element, strings: list[str]) -> list[tuple[int, dict[int, str]]]:
    rows = []
    for fallback, row in enumerate(root.findall(f".//{{{OFFICE_MAIN}}}row"), 1):
        values = {}
        for index, cell in enumerate(row.findall(f"{{{OFFICE_MAIN}}}c")):
            column = _column_index(cell.attrib.get("r", "")) if cell.attrib.get("r") else index
            if column < MAX_COLUMNS:
                value = _cell_value(cell, strings)
                if value not in (None, ""):
                    values[column] = value
        if values:
            rows.append((int(row.attrib.get("r", fallback)), values))
        if len(rows) > MAX_ROWS + 12:
            break
    return rows


def _sheets(source: Path) -> list[dict[str, Any]]:
    with zipfile.ZipFile(source) as archive:
        validate_office_package(archive)
        names = zip_entry_names(archive)
        workbook = xml_root(archive, "xl/workbook.xml")
        relationships = xml_root(archive, "xl/_rels/workbook.xml.rels")
        targets = {relation.attrib["Id"]: normalize_xlsx_target(relation.attrib["Target"])
                   for relation in relationships.findall(f"{{{PACKAGE_REL}}}Relationship")
                   if relation.attrib.get("Id") and relation.attrib.get("Target")}
        result = []
        for sheet in workbook.findall(f".//{{{OFFICE_MAIN}}}sheet"):
            name = sheet.attrib.get("name", "")
            member = targets.get(sheet.attrib.get(f"{{{OFFICE_REL}}}id"), "")
            count = None
            if member in names:
                root = xml_root(archive, member)
                count = len(root.findall(f".//{{{OFFICE_MAIN}}}row"))
            result.append({"name": name, "rows": max(0, count - 1) if count is not None else None,
                           "visibility": sheet.attrib.get("state", "visible")})
        return result


def _load(source: Path, sheet: str | None) -> tuple[pd.DataFrame, dict[str, Any]]:
    if source.suffix.lower() == ".csv":
        headers, records, detail = _csv_rows(source)
    else:
        if not sheet:
            raise ValueError("Choose a sheet before opening table data")
        headers, records, detail = _xlsx_sheet_rows(source, sheet)
    if not headers:
        raise ValueError("Atlas could not find a usable header row")
    return pd.DataFrame(records, columns=headers, dtype="object"), detail


def _types(frame: pd.DataFrame) -> dict[str, str]:
    return {str(name): infer_column(frame[name], str(name))[0] for name in frame.columns}


def _profile(frame: pd.DataFrame) -> dict[str, Any]:
    columns = []
    for name in frame.columns:
        inferred, date_range = infer_column(frame[name], str(name))
        missing = int(frame[name].map(_empty).sum())
        item: dict[str, Any] = {
            "name": str(name),
            "inferred_type": inferred,
            "missing_count": missing,
            "missing_rate": round(missing / len(frame), 6) if len(frame) else None,
            "distinct_count": int(frame[name].dropna().astype(str).nunique()),
        }
        if date_range:
            item["date_range"] = date_range
        columns.append(item)
    return {
        "rows": len(frame),
        "columns": len(frame.columns),
        "fields": columns,
        "null_cells": sum(item["missing_count"] for item in columns),
        "duplicate_rows": int(frame.fillna("").astype(str).duplicated().sum()) if len(frame) else 0,
        "sample": {
            "columns": [str(name) for name in frame.columns],
            "rows": _sample(frame, 0, 5),
        },
    }


def _empty(value: object) -> bool:
    return value is None or (isinstance(value, float) and math.isnan(value)) or str(value).strip() == ""


def _apply(frame: pd.DataFrame, operations: dict[str, Any]) -> pd.DataFrame:
    result = frame.copy()
    selected = [name for name in (operations.get("columns") or list(result.columns)) if name in result.columns]
    if not selected:
        raise ValueError("Keep at least one column")
    search = str(operations.get("search") or "").strip().lower()
    if search:
        mask = result[selected].fillna("").astype(str).apply(lambda row: row.str.lower().str.contains(search, regex=False).any(), axis=1)
        result = result[mask]
    for item in operations.get("filters", []):
        column, operator = item.get("column"), item.get("operator")
        if column not in result.columns:
            raise ValueError("One filter column is no longer available")
        value = item.get("value", "")
        series = result[column]
        if operator == "is_empty": mask = series.map(_empty)
        elif operator == "not_empty": mask = ~series.map(_empty)
        elif operator in {"=", "!=", ">", ">=", "<", "<="}:
            numbers = pd.to_numeric(series, errors="coerce")
            try: target = float(value)
            except (TypeError, ValueError): raise ValueError("Enter a number for this filter")
            mask = {"=": numbers.eq(target), "!=": numbers.ne(target), ">": numbers.gt(target), ">=": numbers.ge(target), "<": numbers.lt(target), "<=": numbers.le(target)}[operator]
        else:
            text, target = series.fillna("").astype(str), str(value)
            mask = {"equals": text.eq(target), "not_equals": text.ne(target), "contains": text.str.contains(target, case=False, regex=False), "not_contains": ~text.str.contains(target, case=False, regex=False)}.get(operator)
            if mask is None: raise ValueError("This filter is not supported")
        result = result[mask]
    if operations.get("remove_empty_rows"):
        result = result[~result.apply(lambda row: all(_empty(value) for value in row), axis=1)]
    if operations.get("remove_duplicates"):
        result = result.drop_duplicates()
    sort = operations.get("sort") or {}
    if sort.get("column") in result.columns:
        column = sort["column"]
        numeric = pd.to_numeric(result[column], errors="coerce")
        result = result.assign(__atlas_sort=numeric if numeric.notna().any() else result[column].fillna("").astype(str)).sort_values("__atlas_sort", ascending=sort.get("direction") != "desc", kind="stable").drop(columns="__atlas_sort")
    return result.loc[:, selected]


def _sample(frame: pd.DataFrame, page: int, page_size: int) -> list[list[Any]]:
    start = max(0, page) * max(1, min(page_size, 100))
    values = frame.iloc[start:start + max(1, min(page_size, 100))].values.tolist()
    return [[None if pd.isna(value) else str(value) for value in row] for row in values]


def _cast(frame: pd.DataFrame, column: str, target: str) -> tuple[pd.DataFrame, int]:
    if column not in frame.columns:
        raise ValueError(f"Cast field is unavailable: {column}")
    result = frame.copy()
    original = result[column]
    non_empty = ~original.map(_empty)
    if target == "number":
        converted = pd.to_numeric(original, errors="coerce")
    elif target == "date":
        parsed = pd.to_datetime(original, errors="coerce")
        converted = parsed.map(lambda value: value.isoformat() if pd.notna(value) else None)
    elif target == "text":
        converted = original.map(lambda value: None if _empty(value) else str(value))
    elif target == "boolean":
        truth = {"true": True, "1": True, "yes": True, "false": False, "0": False, "no": False}
        converted = original.map(lambda value: None if _empty(value) else truth.get(str(value).strip().lower()))
    else:
        raise ValueError(f"Unsupported cast target: {target}")
    failures = int((non_empty & pd.isna(converted)).sum())
    result[column] = converted
    return result, failures


def _group_aggregate(frame: pd.DataFrame, step: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, Any]]:
    dimension = step.get("dimension")
    measure = step.get("measure")
    if not isinstance(dimension, str) or not dimension or not isinstance(measure, str) or not measure:
        raise ValueError("Group aggregate needs one dimension and one measure")
    if dimension == measure or dimension not in frame.columns or measure not in frame.columns:
        raise ValueError("Group aggregate must use two available, distinct fields")
    if step.get("formula") != "sum":
        raise ValueError("Group aggregate currently supports only sum")
    if step.get("null_policy") != "exclude":
        raise ValueError("Group aggregate requires the explicit exclude null policy")
    unit = step.get("unit")
    if not isinstance(unit, str) or not unit.strip() or len(unit.strip()) > 40:
        raise ValueError("Group aggregate unit must contain 1 to 40 characters")

    totals: dict[str, dict[str, Any]] = {}
    excluded = 0
    input_rows = len(frame)
    for dimension_value, measure_value in frame[[dimension, measure]].itertuples(index=False, name=None):
        if pd.isna(measure_value) or (isinstance(measure_value, str) and not measure_value.strip()):
            excluded += 1
            continue
        try:
            number = Decimal(str(measure_value).strip())
        except (InvalidOperation, ValueError):
            raise ValueError(f"Group aggregate measure contains a non-numeric value: {measure_value}") from None
        if not number.is_finite():
            raise ValueError("Group aggregate measure values must be finite numbers")
        key = "" if pd.isna(dimension_value) else str(dimension_value)
        group = totals.setdefault(key, {"value": key, "decimal_sum": Decimal(0), "rows": 0})
        group["decimal_sum"] += number
        group["rows"] += 1
        if len(totals) > 500:
            raise ValueError("Group aggregate exceeds the 500 group output limit")

    groups = []
    output_rows = []
    grand_total = Decimal(0)
    for group in totals.values():
        try:
            value = float(group["decimal_sum"])
        except (OverflowError, ValueError):
            raise ValueError("Group aggregate sum is outside the supported numeric range") from None
        if not math.isfinite(value):
            raise ValueError("Group aggregate sum is outside the supported numeric range")
        groups.append({"value": group["value"], "sum": value, "rows": group["rows"]})
        output_rows.append({dimension: group["value"], measure: value})
        grand_total += group["decimal_sum"]
    try:
        total_value = float(grand_total)
    except (OverflowError, ValueError):
        raise ValueError("Group aggregate total is outside the supported numeric range") from None
    if not math.isfinite(total_value):
        raise ValueError("Group aggregate total is outside the supported numeric range")
    return pd.DataFrame(output_rows, columns=[dimension, measure]), {
        "dimension": dimension,
        "measure": measure,
        "formula": "sum",
        "unit": unit.strip(),
        "null_policy": "exclude",
        "input_rows": input_rows,
        "included_rows": input_rows - excluded,
        "excluded_rows": excluded,
        "grand_total": total_value,
        "groups": groups,
    }


def _pivot_aggregate(frame: pd.DataFrame, step: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, Any]]:
    row_field = step.get("row_dimension")
    column_field = step.get("column_dimension")
    measure = step.get("measure")
    fields = (row_field, column_field, measure)
    if any(not isinstance(item, str) or not item for item in fields) or len(set(fields)) != 3:
        raise ValueError("Pivot aggregate needs three distinct fields")
    if any(item not in frame.columns for item in fields):
        raise ValueError("Pivot aggregate fields must be available")
    if step.get("formula") != "sum" or step.get("null_policy") != "exclude":
        raise ValueError("Pivot aggregate supports sum with the explicit exclude null policy")
    unit = step.get("unit")
    if not isinstance(unit, str) or not unit.strip() or len(unit.strip()) > 40:
        raise ValueError("Pivot aggregate unit must contain 1 to 40 characters")

    row_order: list[str] = []
    column_order: list[str] = []
    sums: dict[tuple[str, str], Decimal] = {}
    row_counts: dict[str, int] = {}
    included = excluded = 0
    for row_value, column_value, measure_value in frame[list(fields)].itertuples(index=False, name=None):
        row_key = "" if pd.isna(row_value) else str(row_value)
        column_key = "" if pd.isna(column_value) else str(column_value)
        if row_key not in row_order:
            row_order.append(row_key)
        if column_key not in column_order:
            column_order.append(column_key)
        if pd.isna(measure_value) or (isinstance(measure_value, str) and not measure_value.strip()):
            excluded += 1
            continue
        try:
            number = Decimal(str(measure_value).strip())
        except (InvalidOperation, ValueError):
            raise ValueError(f"Pivot aggregate measure contains a non-numeric value: {measure_value}") from None
        if not number.is_finite():
            raise ValueError("Pivot aggregate measure values must be finite numbers")
        sums[(row_key, column_key)] = sums.get((row_key, column_key), Decimal(0)) + number
        row_counts[row_key] = row_counts.get(row_key, 0) + 1
        included += 1
    if len(row_order) > 40 or len(column_order) > 12:
        raise ValueError("Pivot aggregate exceeds the 40 row category by 12 column category limit")

    def as_number(value: Decimal) -> float:
        try:
            result = float(value)
        except (OverflowError, ValueError):
            raise ValueError("Pivot aggregate result is outside the supported numeric range") from None
        if not math.isfinite(result):
            raise ValueError("Pivot aggregate result is outside the supported numeric range")
        return result

    matrix_rows = []
    row_totals = []
    column_sums = {key: Decimal(0) for key in column_order}
    grand_total = Decimal(0)
    for row_key in row_order:
        values = [sums.get((row_key, column_key), Decimal(0)) for column_key in column_order]
        total = sum(values, Decimal(0))
        for key, value in zip(column_order, values):
            column_sums[key] += value
        grand_total += total
        matrix_rows.append({"row": row_key, "values": [as_number(value) for value in values], "total": as_number(total)})
        row_totals.append({"value": row_key, "sum": as_number(total), "rows": row_counts.get(row_key, 0)})
    try:
        total_numeric = as_number(grand_total)
        shares = [(Decimal(item["sum"]) / grand_total * Decimal(100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if grand_total else None for item in row_totals]
    except (InvalidOperation, ZeroDivisionError):
        raise ValueError("Pivot aggregate percentages are outside the supported range") from None
    ranked = sorted((Decimal(item["sum"]) for item in row_totals), reverse=True)
    dense_rank: dict[Decimal, int] = {}
    for amount in ranked:
        dense_rank.setdefault(amount, len(dense_rank) + 1)
    for index, item in enumerate(row_totals):
        item["share_percent"] = float(shares[index]) if shares[index] is not None else None
        item["rank"] = dense_rank[Decimal(item["sum"])]
        matrix_rows[index]["share_percent"] = item["share_percent"]
        matrix_rows[index]["rank"] = item["rank"]
    column_totals = [{"value": key, "sum": as_number(column_sums[key])} for key in column_order]
    total_label = "__TOTAL__"
    while total_label in row_order:
        total_label = f"_{total_label}"
    matrix_rows.append({"row": total_label, "values": [as_number(column_sums[key]) for key in column_order], "total": total_numeric, "share_percent": 100.0 if grand_total else None, "rank": None})

    # Prefixes keep generated headings distinct from source categories and metadata labels.
    row_heading = f"row:{row_field}"
    value_headings = [f"column:{index + 1}:{key}" for index, key in enumerate(column_order)]
    total_heading = f"total:{measure}"
    share_heading = "share_percent"
    rank_heading = "dense_rank"
    output_rows = []
    for item in matrix_rows:
        output_rows.append({row_heading: item["row"], **dict(zip(value_headings, item["values"])), total_heading: item["total"], share_heading: item.get("share_percent"), rank_heading: item.get("rank")})
    output_columns = [row_heading, *value_headings, total_heading, share_heading, rank_heading]
    return pd.DataFrame(output_rows, columns=output_columns), {
        "row_dimension": row_field, "column_dimension": column_field, "measure": measure,
        "formula": "sum", "unit": unit.strip(), "null_policy": "exclude",
        "input_rows": len(frame), "included_rows": included, "excluded_rows": excluded,
        "grand_total": total_numeric, "row_total_label": total_label,
        "row_order": row_order, "column_order": column_order,
        "column_totals": column_totals, "row_totals": row_totals,
        "matrix": matrix_rows, "output_columns": output_columns,
    }


def _month_number(value: str) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}", value):
        raise ValueError("Trend months must use YYYY-MM")
    year, month = map(int, value.split("-"))
    if month < 1 or month > 12:
        raise ValueError("Trend month is outside the calendar")
    return year * 12 + month - 1


def _month_text(number: int) -> str:
    return f"{number // 12:04d}-{number % 12 + 1:02d}"


def _trend_aggregate(frame: pd.DataFrame, step: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, Any]]:
    date_field, measure = step.get("date_field"), step.get("measure")
    if not isinstance(date_field, str) or not date_field or not isinstance(measure, str) or not measure or date_field == measure:
        raise ValueError("Trend needs distinct date and measure fields")
    if date_field not in frame.columns or measure not in frame.columns:
        raise ValueError("Trend fields must be available")
    if step.get("formula") != "sum" or step.get("null_policy") != "exclude":
        raise ValueError("Trend supports sum with the explicit exclude null policy")
    unit = step.get("unit")
    if not isinstance(unit, str) or not unit.strip() or len(unit.strip()) > 40:
        raise ValueError("Trend unit must contain 1 to 40 characters")
    start = _month_number(step.get("start_month"))
    current_start = _month_number(step.get("current_start_month"))
    end = _month_number(step.get("end_month"))
    previous_length = current_start - start
    current_length = end - current_start + 1
    if previous_length < 1 or previous_length > 12 or current_length < 1 or current_length > 12 or previous_length != current_length or previous_length + current_length > 24:
        raise ValueError("Trend requires adjacent equal periods of 1 to 12 months each")

    monthly = {number: Decimal(0) for number in range(start, end + 1)}
    included = empty = out_of_range = 0
    for date_value, measure_value in frame[[date_field, measure]].itertuples(index=False, name=None):
        text = str(date_value) if not pd.isna(date_value) else ""
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            raise ValueError("Trend dates must use exact YYYY-MM-DD date-only values")
        try:
            parsed_date = date.fromisoformat(text)
        except ValueError:
            raise ValueError("Trend contains an invalid calendar date") from None
        month = parsed_date.year * 12 + parsed_date.month - 1
        if measure_value is not None and not pd.isna(measure_value) and not (isinstance(measure_value, str) and not measure_value.strip()):
            try:
                number = Decimal(str(measure_value).strip())
            except (InvalidOperation, ValueError):
                raise ValueError(f"Trend measure contains a non-numeric value: {measure_value}") from None
            if not number.is_finite():
                raise ValueError("Trend measure values must be finite numbers")
        else:
            number = None
        if month < start or month > end:
            out_of_range += 1
            continue
        if number is None:
            empty += 1
            continue
        monthly[month] += number
        included += 1

    def numeric(value: Decimal) -> float:
        try:
            result = float(value)
        except (OverflowError, ValueError):
            raise ValueError("Trend total is outside the supported numeric range") from None
        if not math.isfinite(result):
            raise ValueError("Trend total is outside the supported numeric range")
        return result

    previous_total = sum((monthly[number] for number in range(start, current_start)), Decimal(0))
    current_total = sum((monthly[number] for number in range(current_start, end + 1)), Decimal(0))
    delta = current_total - previous_total
    growth = (delta / previous_total * Decimal(100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) if previous_total else None
    month_numbers = list(range(start, end + 1))
    monthly_totals = [{"month": _month_text(number), "sum": numeric(monthly[number])} for number in month_numbers]
    result = pd.DataFrame([{"month": item["month"], f"sum:{measure}": item["sum"]} for item in monthly_totals], columns=["month", f"sum:{measure}"])
    return result, {
        "date_field": date_field, "measure": measure, "formula": "sum", "unit": unit.strip(), "null_policy": "exclude",
        "start_month": _month_text(start), "current_start_month": _month_text(current_start), "end_month": _month_text(end),
        "previous_period": {"start_month": _month_text(start), "end_month": _month_text(current_start - 1), "total": numeric(previous_total)},
        "current_period": {"start_month": _month_text(current_start), "end_month": _month_text(end), "total": numeric(current_total)},
        "delta": numeric(delta), "growth_percent": float(growth) if growth is not None else None,
        "included_rows": included, "excluded_empty_rows": empty, "out_of_range_rows": out_of_range,
        "monthly_totals": monthly_totals,
    }


def _multi_work(request: dict[str, Any], action: str, output_path: str | None) -> dict[str, Any]:
    sources = request.get("sources") or []
    if not sources:
        raise ValueError("Multi-source Work needs at least one Source")
    frames: dict[str, pd.DataFrame] = {}
    source_results = []
    for item in sources:
        source = _source(item.get("path", ""), item.get("sha256", ""))
        frame, detail = _load(source, item.get("sheet"))
        frames[item["source_key"]] = frame
        source_results.append({"source_key": item["source_key"], "sha256": item["sha256"], "rows": len(frame), "columns": len(frame.columns), "detail": detail})

    mapping = request.get("mapping") or []
    for source_key, frame in list(frames.items()):
        renames = {item["column"]: item["canonical"] for item in mapping if item.get("source_key") == source_key and item.get("column") in frame.columns}
        if len(set(renames.values())) != len(renames.values()):
            raise ValueError(f"Field alignment creates duplicate result fields for {source_key}")
        frames[source_key] = frame.rename(columns=renames)

    recipe = request.get("recipe") or {}
    steps = recipe.get("steps") or []
    source_column = next((item for item in steps if item.get("operation") == "source-column"), None)
    if source_column:
        column = source_column.get("column") or "__source"
        if any(column in frame.columns for frame in frames.values()):
            raise ValueError("The Source column must use a new field name")
        for item in sources:
            frames[item["source_key"]][column] = item.get("name") or item["source_key"]

    combine = recipe.get("combine") or {"operation": "concatenate"}
    if combine.get("operation") == "concatenate":
        result = pd.concat([frames[item["source_key"]] for item in sources], ignore_index=True, sort=False)
    elif combine.get("operation") == "join":
        if len(sources) != 2:
            raise ValueError("The first join version requires exactly two Sources")
        left, right = sources
        how = combine.get("how", "inner")
        if how not in {"inner", "left"}:
            raise ValueError("Join type must be inner or left")
        left_key, right_key = combine.get("left_key"), combine.get("right_key")
        if left_key not in frames[left["source_key"]].columns or right_key not in frames[right["source_key"]].columns:
            raise ValueError("Choose available join keys")
        result = frames[left["source_key"]].merge(frames[right["source_key"]], left_on=left_key, right_on=right_key, how=how, suffixes=("", "_right"))
    else:
        raise ValueError("Recipe combine must be concatenate or join")

    conversion_failures: dict[str, int] = {}
    aggregation = None
    pivot_aggregation = None
    trend_aggregation = None
    for step in steps:
        operation = step.get("operation")
        if operation in {"source-column", "validate"}:
            continue
        if operation == "rename":
            old, new = step.get("from"), step.get("to")
            if old not in result.columns or not new:
                raise ValueError("Rename needs an available field and one result name")
            if new != old and new in result.columns:
                raise ValueError("Rename must use a new result field")
            result = result.rename(columns={old: new})
        elif operation == "cast":
            result, failures = _cast(result, step.get("column", ""), step.get("type", ""))
            conversion_failures[step["column"]] = failures
        elif operation == "select":
            columns = step.get("columns") or []
            if not columns or any(column not in result.columns for column in columns):
                raise ValueError("Select contains an unavailable field")
            result = result.loc[:, columns]
        elif operation == "filter":
            result = _apply(result, {"columns": list(result.columns), "filters": [step]})
        elif operation == "fill-null":
            column = step.get("column")
            if column not in result.columns:
                raise ValueError("Fill-null field is unavailable")
            result[column] = result[column].map(lambda value: step.get("value") if _empty(value) else value)
        elif operation == "deduplicate":
            columns = step.get("columns") or []
            if not columns or any(column not in result.columns for column in columns):
                raise ValueError("Deduplicate needs available fields")
            result = result.drop_duplicates(subset=columns)
        elif operation == "group-aggregate":
            if action == "details":
                measure = step.get("measure")
                if measure not in result.columns:
                    raise ValueError("Group aggregate measure is unavailable for details")
                result = result[result[measure].map(lambda value: not (pd.isna(value) or isinstance(value, str) and not value.strip()))]
                break
            if aggregation is not None or pivot_aggregation is not None or trend_aggregation is not None:
                raise ValueError("Recipe supports one aggregate operation")
            result, aggregation = _group_aggregate(result, step)
        elif operation == "pivot-aggregate":
            if action == "details":
                break
            if aggregation is not None or pivot_aggregation is not None or trend_aggregation is not None:
                raise ValueError("Recipe supports one aggregate operation")
            result, pivot_aggregation = _pivot_aggregate(result, step)
        elif operation == "trend-aggregate":
            if action == "details":
                break
            if aggregation is not None or pivot_aggregation is not None or trend_aggregation is not None:
                raise ValueError("Recipe supports one aggregate operation")
            result, trend_aggregation = _trend_aggregate(result, step)
        elif operation == "sort":
            column = step.get("column")
            if column not in result.columns:
                raise ValueError("Sort field is unavailable")
            result = result.sort_values(column, ascending=step.get("direction") != "desc", kind="stable")
        else:
            raise ValueError(f"Unsupported Recipe operation: {operation}")

    for item in sources:
        if _sha256(Path(item["path"]).resolve()) != item["sha256"]:
            raise ValueError(f"Source changed while Atlas was executing this Recipe: {item.get('name') or item['source_key']}")
    null_cells = int(result.isna().sum().sum())
    duplicate_rows = int(result.fillna("").astype(str).duplicated().sum()) if len(result) else 0
    validation = {"input_rows": sum(item["rows"] for item in source_results), "output_rows": len(result), "null_cells": null_cells, "duplicate_rows": duplicate_rows, "conversion_failures": conversion_failures}
    page_size = max(1, min(int(request.get("detail_limit", request.get("page_size", 50))), 100))
    detail_offset = max(0, int(request.get("detail_offset", 0))) if action == "details" else 0
    response = {
        "processor": {"version": PROCESSOR_VERSION},
        "source": {"sha256": sources[0]["sha256"]},
        "sources": source_results,
        "recipe": recipe,
        "columns": [str(name) for name in result.columns],
        "rows": _sample(result, 0, page_size) if action != "details" else [[None if pd.isna(value) else str(value) for value in row] for row in result.iloc[detail_offset:detail_offset + page_size].values.tolist()],
        "preview": {"sampled": True, "rows_shown": min(page_size, len(result)), "total_rows": len(result)},
        "result_summary": {"rows": len(result), "columns": len(result.columns)},
        "validation": validation,
    }
    if action == "details":
        next_offset = detail_offset + len(response["rows"])
        response["details"] = {
            "offset": detail_offset, "limit": page_size, "total": len(result),
            "next_offset": next_offset if next_offset < len(result) else None,
            "complete": next_offset >= len(result),
        }
    if aggregation is not None:
        response["aggregation"] = aggregation
    if pivot_aggregation is not None:
        response["pivot_aggregation"] = pivot_aggregation
    if trend_aggregation is not None:
        response["trend_aggregation"] = trend_aggregation
    if action == "export":
        if not output_path:
            raise ValueError("Atlas needs a local staging file for this result")
        output = Path(output_path).resolve(); output.parent.mkdir(parents=True, exist_ok=True)
        if output.suffix.lower() == ".xlsx":
            _write_xlsx(result, output, "Result")
        elif output.suffix.lower() == ".csv":
            result.to_csv(output, index=False, encoding="utf-8-sig")
        else:
            raise ValueError("Work results can be staged only as CSV or XLSX")
        response["staged"] = {"path": str(output), "sha256": _sha256(output), "bytes": output.stat().st_size}
    return response


def _xlsx_column(index: int) -> str:
    value, result = index + 1, ""
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _write_xlsx(frame: pd.DataFrame, output: Path, sheet: str) -> None:
    rows = [list(frame.columns)] + frame.where(pd.notna(frame), "").values.tolist()
    xml_rows = []
    for row_number, row in enumerate(rows, 1):
        cells = "".join(f'<c r="{_xlsx_column(index)}{row_number}" t="inlineStr"><is><t>{xml_escape(str(value))}</t></is></c>' for index, value in enumerate(row))
        xml_rows.append(f'<row r="{row_number}">{cells}</row>')
    worksheet = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="{OFFICE_MAIN}"><sheetData>{"".join(xml_rows)}</sheetData></worksheet>'
    content_types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    workbook = f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="{OFFICE_MAIN}" xmlns:r="{OFFICE_REL}"><sheets><sheet name="{xml_escape(sheet[:31] or "Data")}" sheetId="1" r:id="rId1"/></sheets></workbook>'
    rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships" Target="xl/workbook.xml"/></Relationships>'
    workbook_rels = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types); archive.writestr("_rels/.rels", rels)
        archive.writestr("xl/workbook.xml", workbook); archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        archive.writestr("xl/worksheets/sheet1.xml", worksheet)


def data_work(file_value: str, *, expected_sha256: str, action: str, sheet: str | None = None, request_path: str | None = None, output_path: str | None = None) -> dict[str, Any]:
    source = _source(file_value, expected_sha256)
    if action == "describe":
        return {"processor": {"version": PROCESSOR_VERSION}, "source": {"sha256": expected_sha256}, "sheets": _sheets(source) if source.suffix.lower() == ".xlsx" else []}
    if action == "profile":
        sheets = _sheets(source) if source.suffix.lower() == ".xlsx" else []
        if source.suffix.lower() == ".xlsx" and not sheet:
            return {"processor": {"version": PROCESSOR_VERSION}, "source": {"sha256": expected_sha256}, "status": "sheet_required", "sheets": sheets}
        frame, detail = _load(source, sheet)
        return {"processor": {"version": PROCESSOR_VERSION}, "source": {"sha256": expected_sha256}, "status": "ready", "sheet": sheet, "sheets": sheets, "profile": _profile(frame), "detail": detail}
    request = json.loads(Path(request_path).read_text(encoding="utf-8")) if request_path else {}
    if request.get("sources"):
        return _multi_work(request, action, output_path)
    frame, detail = _load(source, sheet)
    operations = request.get("operations") or {"columns": list(frame.columns)}
    result = _apply(frame, operations)
    if _sha256(source) != expected_sha256:
        raise ValueError("Source changed while Atlas was preparing this result")
    response = {"processor": {"version": PROCESSOR_VERSION}, "source": {"sha256": expected_sha256}, "sheet": sheet, "source_summary": {"rows": len(frame), "columns": len(frame.columns)}, "result_summary": {"rows": len(result), "columns": len(result.columns)}, "columns": [str(name) for name in result.columns], "column_types": _types(frame), "rows": _sample(result, int(request.get("page", 0)), int(request.get("page_size", 50))), "detail": detail}
    if action == "export":
        if not output_path: raise ValueError("Atlas needs a local staging file for this result")
        output = Path(output_path).resolve(); output.parent.mkdir(parents=True, exist_ok=True)
        if source.suffix.lower() == ".csv": result.to_csv(output, index=False, encoding="utf-8-sig")
        else: _write_xlsx(result, output, sheet or "Data")
        response["staged"] = {"path": str(output), "sha256": _sha256(output), "bytes": output.stat().st_size}
    return response
