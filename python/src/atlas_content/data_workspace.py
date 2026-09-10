from __future__ import annotations

import hashlib
import html
import json
import math
import time
import zipfile
from pathlib import Path
from typing import Any
import pandas as pd

from .common import validate_office_package, xml_root, zip_entry_names
from .delimited import choose_header, indexed_rows, read_delimited_file, unique_headers
from .inspector import (
    MAX_PROFILE_COLUMNS,
    OFFICE_MAIN,
    OFFICE_REL,
    PACKAGE_REL,
    infer_column,
    normalize_xlsx_target,
    sensitive_reason,
    shared_strings,
    worksheet_rows_with_strings,
)


SCHEMA = "atlas.data-workspace.v1"
PROCESSOR_VERSION = "0.2.3"
MAX_ROWS = 50_000
MAX_PREVIEW_ROWS = 2_000
MAX_FILE_BYTES = 256 * 1024 * 1024


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_text(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(value, encoding="utf-8", newline="")
    temporary.replace(path)


def _load_delimited(
    path: Path,
) -> tuple[list[str], list[list[str | None]], list[int], dict[str, Any]]:
    table = read_delimited_file(path, max_rows=MAX_ROWS + 2)
    rows = table.rows
    if not rows:
        return [], [], [], {
            "encoding": table.encoding,
            "delimiter": table.delimiter,
            "delimiter_detection": table.delimiter_detection,
            "decode_warning": table.decode_warning,
            "header_row": None,
            "truncated": table.truncated,
        }
    indexed = indexed_rows(table, maximum_columns=MAX_PROFILE_COLUMNS)
    header_offset, header_row, header = choose_header(indexed)
    width = min(
        MAX_PROFILE_COLUMNS,
        max((max(values.keys(), default=-1) + 1 for _, values in indexed), default=0),
    )
    headers = unique_headers(header, width)
    records: list[list[str | None]] = []
    source_rows: list[int] = []
    truncated = len(rows) - 1 > MAX_ROWS
    for source_row, row in indexed[header_offset + 1:MAX_ROWS + header_offset + 1]:
        values = [row.get(index) for index in range(width)]
        if any(value not in (None, "") for value in values):
            records.append(values)
            source_rows.append(source_row)
    return headers, records, source_rows, {
        "encoding": table.encoding,
        "delimiter": table.delimiter,
        "delimiter_detection": table.delimiter_detection,
        "decode_warning": table.decode_warning,
        "header_row": header_row,
        "truncated": table.truncated or truncated,
    }


def _load_xlsx(
    path: Path,
    selected_sheet: str | None,
) -> tuple[list[str], list[list[str | None]], list[int], dict[str, Any]]:
    if not selected_sheet:
        raise ValueError("XLSX data workspace requires --sheet with one exact worksheet name")
    with zipfile.ZipFile(path) as archive:
        validate_office_package(archive)
        names = zip_entry_names(archive)
        workbook = xml_root(archive, "xl/workbook.xml")
        relationships = xml_root(archive, "xl/_rels/workbook.xml.rels")
        targets = {
            relation.attrib["Id"]: normalize_xlsx_target(relation.attrib["Target"])
            for relation in relationships.findall(f"{{{PACKAGE_REL}}}Relationship")
            if relation.attrib.get("Id") and relation.attrib.get("Target")
        }
        strings, strings_truncated = shared_strings(archive, names)
        all_sheets = workbook.findall(f".//{{{OFFICE_MAIN}}}sheet")
        available = [sheet.attrib.get("name", "") for sheet in all_sheets]
        if selected_sheet not in available:
            raise ValueError(f"Worksheet does not exist: {selected_sheet}; available sheets: {available}")
        sheet = next(item for item in all_sheets if item.attrib.get("name") == selected_sheet)
        member = targets.get(sheet.attrib.get(f"{{{OFFICE_REL}}}id"), "")
        if member not in names:
            raise ValueError(f"Worksheet package part is missing: {selected_sheet}")
        root = xml_root(archive, member)
        rows, rows_truncated = worksheet_rows_with_strings(root, strings)
        header_offset, header_row, header = choose_header(rows)
        width = min(
            MAX_PROFILE_COLUMNS,
            max((max(values.keys(), default=-1) + 1 for _, values in rows), default=0),
        )
        headers = unique_headers(header, width)
        records = []
        source_rows = []
        for source_row, row in rows[header_offset + 1:MAX_ROWS + header_offset + 1]:
            record = [row.get(index) for index in range(width)]
            if any(value not in (None, "") for value in record):
                records.append(record)
                source_rows.append(source_row)
        merged = [
            item.attrib.get("ref", "")
            for item in root.findall(f".//{{{OFFICE_MAIN}}}mergeCell")
            if item.attrib.get("ref")
        ]
        return headers, records, source_rows, {
            "header_row": header_row,
            "sheet": selected_sheet,
            "available_sheets": available,
            "hidden_sheet_count": sum(
                item.attrib.get("state", "visible") != "visible" for item in all_sheets
            ),
            "formula_count": len(root.findall(f".//{{{OFFICE_MAIN}}}f")),
            "merged_ranges": merged[:100],
            "truncated": rows_truncated or strings_truncated or len(records) >= MAX_ROWS,
            "xlsx_dates_are_raw": True,
        }


def _normalize_frame(headers: list[str], records: list[list[str | None]]) -> tuple[pd.DataFrame, dict[str, int]]:
    frame = pd.DataFrame(records, columns=headers, dtype="object")
    trimmed = 0
    blank_to_null = 0
    for name in frame.columns:
        def clean(value: object) -> object:
            nonlocal trimmed, blank_to_null
            if value is None or (isinstance(value, float) and math.isnan(value)):
                return None
            if isinstance(value, str):
                stripped = value.strip()
                if stripped != value:
                    trimmed += 1
                if stripped == "":
                    blank_to_null += 1
                    return None
                return stripped
            return value

        frame[name] = frame[name].map(clean)
    return frame, {"trimmed_cells": trimmed, "blank_cells_normalized": blank_to_null}


def _column_profile(frame: pd.DataFrame) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    columns = []
    sensitive = []
    for name in frame.columns:
        series = frame[name]
        missing = int(series.isna().sum())
        inferred, date_range = infer_column(series, str(name))
        detail: dict[str, Any] = {
            "name": str(name),
            "inferred_type": inferred,
            "missing_count": missing,
            "missing_rate": round(missing / len(frame), 6) if len(frame) else None,
            "distinct_count": int(series.dropna().astype(str).nunique()),
        }
        if date_range:
            detail["date_range"] = date_range
        if inferred == "number":
            numeric = pd.to_numeric(series, errors="coerce").dropna()
            if not numeric.empty:
                detail["numeric_summary"] = {
                    "minimum": float(numeric.min()),
                    "maximum": float(numeric.max()),
                    "mean": round(float(numeric.mean()), 6),
                    "median": round(float(numeric.median()), 6),
                }
        reason = sensitive_reason(str(name), series.tolist())
        if reason:
            sensitive.append({"column": str(name), "reason": reason})
            detail["sensitive"] = True
        columns.append(detail)
    return columns, sensitive


def _quality(
    frame: pd.DataFrame,
    columns: list[dict[str, Any]],
    *,
    truncated: bool,
    source_rows: list[int],
) -> dict[str, Any]:
    duplicate_mask = frame.duplicated(keep="first") if len(frame) else pd.Series(dtype=bool)
    duplicate_rows = [source_rows[int(index)] for index in frame.index[duplicate_mask][:100]]
    missing_cells = int(frame.isna().sum().sum())
    issues = []
    if duplicate_rows:
        issues.append({
            "type": "duplicate_rows",
            "severity": "warning",
            "count": int(duplicate_mask.sum()),
            "sample_source_rows": duplicate_rows,
            "action": "review_before_removal",
        })
    for column in columns:
        if column["missing_count"]:
            issues.append({
                "type": "missing_values",
                "severity": "warning",
                "column": column["name"],
                "count": column["missing_count"],
                "action": "define_business_rule_before_fill_or_drop",
            })
    if truncated:
        issues.append({
            "type": "row_limit_reached",
            "severity": "warning",
            "count": MAX_ROWS,
            "action": "use_a_bounded_extract_or_partition_before_final_metrics",
        })
    return {
        "status": "WARN" if issues else "PASS",
        "row_count": len(frame),
        "column_count": len(frame.columns),
        "missing_cell_count": missing_cells,
        "duplicate_row_count": int(duplicate_mask.sum()) if len(frame) else 0,
        "issues": issues,
        "rule": "No duplicate row was removed and no missing value was filled automatically.",
    }


def _safe_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False).replace("</", "<\\/")


def _render_review(
    source: dict[str, Any],
    profile: dict[str, Any],
    quality: dict[str, Any],
    frame: pd.DataFrame,
) -> str:
    preview = frame.head(MAX_PREVIEW_ROWS).where(pd.notna(frame), None).to_dict(orient="records")
    payload = _safe_json({
        "columns": [str(name) for name in frame.columns],
        "rows": preview,
        "sensitive": [item["column"] for item in profile["sensitive_columns"]],
    })
    issues = "".join(
        f"<li><strong>{html.escape(item['type'])}</strong> — {html.escape(str(item.get('column') or item.get('count')))}</li>"
        for item in quality["issues"]
    ) or "<li>No deterministic quality issue was found.</li>"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas data review — {html.escape(source['name'])}</title>
<style>
:root{{--bg:#172027;--panel:#202a32;--line:#3b4851;--text:#edf2f3;--muted:#aebbc0;--accent:#7fc7a4;--warn:#efc56a}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI",sans-serif}}
header{{position:sticky;top:0;z-index:3;padding:20px 26px;background:#172027f2;border-bottom:1px solid var(--line)}}
h1{{font-size:22px;margin:0 0 5px}}p{{margin:5px 0;color:var(--muted)}}main{{padding:22px 26px;display:grid;gap:18px}}
.cards{{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:10px}}.card,.panel{{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px}}
.card b{{display:block;font-size:22px}}.card span{{color:var(--muted)}}.warn{{color:var(--warn)}}
.toolbar{{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}}input,select,button{{background:#152028;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:8px 10px}}
input{{min-width:260px}}button{{cursor:pointer}}button:hover{{border-color:var(--accent)}}.table-wrap{{overflow:auto;max-height:58vh;border:1px solid var(--line)}}
table{{border-collapse:separate;border-spacing:0;width:100%;background:#182229}}th,td{{padding:8px 10px;border-right:1px solid #334049;border-bottom:1px solid #334049;white-space:nowrap;text-align:left}}
th{{position:sticky;top:0;background:#26343d;cursor:pointer;z-index:2}}td.missing{{color:var(--warn);font-style:italic}}.foot{{font-size:13px;color:var(--muted)}}
@media(max-width:760px){{.cards{{grid-template-columns:repeat(2,1fr)}}main,header{{padding-left:14px;padding-right:14px}}}}
</style></head><body>
<header><h1>Data review</h1><p>{html.escape(source['name'])} · local processing only · original file unchanged</p></header>
<main><section class="cards">
<div class="card"><b>{quality['row_count']}</b><span>rows profiled</span></div>
<div class="card"><b>{quality['column_count']}</b><span>columns</span></div>
<div class="card"><b>{quality['missing_cell_count']}</b><span>missing cells</span></div>
<div class="card"><b>{quality['duplicate_row_count']}</b><span>duplicate rows</span></div>
</section>
<section class="panel"><h2>Quality status: <span class="{'warn' if quality['status'] != 'PASS' else ''}">{quality['status']}</span></h2><ul>{issues}</ul><p>No row was deleted and no missing value was filled automatically.</p></section>
<section class="panel"><h2>Review table</h2><div class="toolbar"><input id="filter" placeholder="Filter visible rows"><select id="pageSize"><option>25</option><option selected>50</option><option>100</option></select><button id="previous">Previous</button><button id="next">Next</button><span id="position" class="foot"></span></div><div class="table-wrap"><table><thead id="head"></thead><tbody id="body"></tbody></table></div><p class="foot">Showing at most {MAX_PREVIEW_ROWS} rows in this local review. Click a column heading to sort. Machine-readable normalized data is saved beside this page.</p></section>
</main><script>
const dataset={payload};let rows=dataset.rows.slice(),sortKey=null,ascending=true,page=0;
const esc=v=>String(v??'').replace(/[&<>\"]/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}}[c]));
function render(){{const query=document.querySelector('#filter').value.toLowerCase();const size=Number(document.querySelector('#pageSize').value);const filtered=rows.filter(r=>!query||dataset.columns.some(c=>String(r[c]??'').toLowerCase().includes(query)));const max=Math.max(0,Math.ceil(filtered.length/size)-1);page=Math.min(page,max);document.querySelector('#head').innerHTML='<tr>'+dataset.columns.map(c=>`<th data-column="${{esc(c)}}">${{esc(c)}}${{dataset.sensitive.includes(c)?' · private':''}}</th>`).join('')+'</tr>';document.querySelector('#body').innerHTML=filtered.slice(page*size,page*size+size).map(r=>'<tr>'+dataset.columns.map(c=>r[c]==null?'<td class="missing">missing</td>':`<td>${{esc(r[c])}}</td>`).join('')+'</tr>').join('');document.querySelector('#position').textContent=`${{filtered.length? page*size+1:0}}–${{Math.min((page+1)*size,filtered.length)}} of ${{filtered.length}}`;document.querySelectorAll('th').forEach(th=>th.onclick=()=>{{const key=th.dataset.column;if(sortKey===key)ascending=!ascending;else{{sortKey=key;ascending=true}}rows.sort((a,b)=>String(a[key]??'').localeCompare(String(b[key]??''),undefined,{{numeric:true}})*(ascending?1:-1));render()}})}}
document.querySelector('#filter').oninput=()=>{{page=0;render()}};document.querySelector('#pageSize').onchange=()=>{{page=0;render()}};document.querySelector('#previous').onclick=()=>{{page=Math.max(0,page-1);render()}};document.querySelector('#next').onclick=()=>{{page+=1;render()}};render();
</script></body></html>"""


def build_data_workspace(
    file_value: str,
    output_dir_value: str,
    *,
    expected_sha256: str,
    sheet: str | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    source_path = Path(file_value).resolve()
    if not source_path.exists() or not source_path.is_file():
        raise ValueError(f"Input must be one existing regular file: {source_path}")
    if source_path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"Data input exceeds the {MAX_FILE_BYTES} byte local workspace limit")
    if _sha256(source_path) != expected_sha256:
        raise ValueError("Input Hash changed before local data preparation")
    extension = source_path.suffix.lower()
    if extension in {".csv", ".tsv"}:
        headers, records, source_rows, load = _load_delimited(source_path)
    elif extension == ".xlsx":
        headers, records, source_rows, load = _load_xlsx(source_path, sheet)
    else:
        raise ValueError("Data workspace currently supports CSV, TSV, and one exact XLSX sheet")
    if not headers:
        raise ValueError("No usable header row was found")
    frame, normalization = _normalize_frame(headers, records)
    columns, sensitive = _column_profile(frame)
    quality = _quality(
        frame,
        columns,
        truncated=bool(load.get("truncated")),
        source_rows=source_rows,
    )
    output_dir = Path(output_dir_value).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    source = {
        "path": str(source_path),
        "name": source_path.name,
        "bytes": source_path.stat().st_size,
        "sha256": expected_sha256,
    }
    profile = {
        "schema": "atlas.data-profile.v1",
        "source": source,
        "selection": {"sheet": sheet},
        "load": load,
        "row_count": len(frame),
        "column_count": len(frame.columns),
        "columns": columns,
        "sensitive_columns": sensitive,
        "limits": {"maximum_rows": MAX_ROWS, "maximum_columns": MAX_PROFILE_COLUMNS},
    }
    transformations = {
        "schema": "atlas.data-transform-plan.v1",
        "applied_safe_normalization": [
            {"operation": "trim_outer_whitespace", "affected_cells": normalization["trimmed_cells"]},
            {"operation": "blank_to_null", "affected_cells": normalization["blank_cells_normalized"]},
            {"operation": "make_headers_unique", "output_headers": list(frame.columns)},
        ],
        "not_applied_without_business_rule": [
            "remove_duplicates", "fill_missing_values", "drop_rows", "join_sources",
            "derive_metrics", "rename_business_fields", "convert_units",
        ],
    }
    profile_path = output_dir / "profile.json"
    quality_path = output_dir / "quality.json"
    transform_path = output_dir / "transform-plan.json"
    normalized_path = output_dir / "normalized.csv"
    provenance_path = output_dir / "provenance.csv"
    review_path = output_dir / "review.html"
    _atomic_text(profile_path, json.dumps(profile, ensure_ascii=False, indent=2) + "\n")
    _atomic_text(quality_path, json.dumps(quality, ensure_ascii=False, indent=2) + "\n")
    _atomic_text(transform_path, json.dumps(transformations, ensure_ascii=False, indent=2) + "\n")
    normalized_temporary = normalized_path.with_name(".normalized.csv.tmp")
    frame.to_csv(normalized_temporary, index=False, encoding="utf-8-sig")
    normalized_temporary.replace(normalized_path)
    provenance_temporary = provenance_path.with_name(".provenance.csv.tmp")
    pd.DataFrame({"normalized_row": range(1, len(frame) + 1), "source_row": source_rows}).to_csv(
        provenance_temporary, index=False, encoding="utf-8-sig"
    )
    provenance_temporary.replace(provenance_path)
    _atomic_text(review_path, _render_review(source, profile, quality, frame))
    files = {
        name: {"path": str(path), "bytes": path.stat().st_size, "sha256": _sha256(path)}
        for name, path in {
            "profile": profile_path,
            "quality": quality_path,
            "transform_plan": transform_path,
            "normalized": normalized_path,
            "provenance": provenance_path,
            "review": review_path,
        }.items()
    }
    manifest = {
        "schema": SCHEMA,
        "processor": {"name": "atlas-local-data-workspace", "version": PROCESSOR_VERSION},
        "source": source,
        "selection": {"sheet": sheet},
        "status": "partial" if load.get("truncated") else "complete",
        "summary": {
            "rows": len(frame),
            "columns": len(frame.columns),
            "missing_cells": quality["missing_cell_count"],
            "duplicate_rows": quality["duplicate_row_count"],
            "quality": quality["status"],
        },
        "files": files,
        "attention": {
            "model_visible_body_bytes": 0,
            "screenshots_used": 0,
            "browser_used": False,
            "external_application_used": False,
            "local_rows_processed": len(frame),
        },
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        "limitations": [
            "Safe normalization does not remove rows, fill missing values, or define business metrics.",
            "XLSX date serials and number formats are not interpreted in processor version 0.1.0.",
            f"The human review includes at most {MAX_PREVIEW_ROWS} rows; normalized.csv contains all locally processed rows.",
        ],
    }
    manifest_path = output_dir / "manifest.json"
    _atomic_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return {**manifest, "manifest_path": str(manifest_path)}
