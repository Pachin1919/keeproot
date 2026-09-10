from __future__ import annotations

import hashlib
import json
import math
import re
import zipfile
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

PROCESSOR_VERSION = "1.0.3"
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
    values = frame.iloc[start:start + max(1, min(page_size, 100))].where(pd.notna(frame), None).values.tolist()
    return [[str(value) if value is not None else None for value in row] for row in values]


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
    request = json.loads(Path(request_path).read_text(encoding="utf-8")) if request_path else {}
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
