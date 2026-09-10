from __future__ import annotations

import hashlib
import html
import json
import time
from pathlib import Path
from typing import Any

import pandas as pd


SCHEMA = "atlas.context-pack.v1"
PROCESSOR_VERSION = "0.1.0"
MAX_REVIEW_ROWS = 2_000


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


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _render_review(
    *,
    pack_id: str,
    purpose: str,
    source: dict[str, Any],
    included_columns: list[str],
    excluded_columns: list[str],
    quality: dict[str, Any],
    frame: pd.DataFrame,
    attention: dict[str, Any],
) -> str:
    preview = frame.head(MAX_REVIEW_ROWS).where(pd.notna(frame), None).to_dict(orient="records")
    payload = json.dumps({
        "columns": list(frame.columns),
        "rows": preview,
    }, ensure_ascii=False).replace("</", "<\\/")
    issues = "".join(
        f"<li><strong>{html.escape(str(item.get('type', 'issue')))}</strong>"
        f" — {html.escape(str(item.get('column') or item.get('count') or 'review required'))}</li>"
        for item in quality.get("issues", [])
    ) or "<li>No deterministic issue was found in the selected fields.</li>"
    excluded = ", ".join(html.escape(item) for item in excluded_columns) or "None"
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Atlas Context Review</title>
<style>
:root{{--bg:#151d23;--panel:#202a31;--line:#3a4851;--text:#f2f5f5;--muted:#afbbc0;--accent:#76c49d;--warn:#efc56a}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:16px/1.52 "Segoe UI",sans-serif}}
header{{padding:22px 28px;border-bottom:1px solid var(--line);background:#182128}}main{{padding:22px 28px;display:grid;gap:16px}}
h1,h2{{margin:0 0 8px}}h1{{font-size:25px}}h2{{font-size:18px}}p{{margin:5px 0;color:var(--muted)}}
.grid{{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:10px}}.card,.panel{{border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:15px}}
.card strong{{display:block;font-size:21px}}.card span,.small{{color:var(--muted);font-size:13px}}.warn{{color:var(--warn)}}
.table-wrap{{overflow:auto;max-height:52vh;border:1px solid var(--line)}}table{{border-collapse:separate;border-spacing:0;width:100%}}
th,td{{padding:8px 10px;border-right:1px solid #34414a;border-bottom:1px solid #34414a;white-space:nowrap;text-align:left}}
th{{position:sticky;top:0;background:#293741;cursor:pointer}}td.missing{{color:var(--warn);font-style:italic}}
.toolbar{{display:flex;gap:9px;flex-wrap:wrap;margin:10px 0}}input,select,button{{background:#151f25;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:8px 10px}}
input{{min-width:280px}}@media(max-width:780px){{.grid{{grid-template-columns:repeat(2,1fr)}}main,header{{padding-left:14px;padding-right:14px}}}}
</style></head><body><header><h1>Context Review</h1><p>{html.escape(source['name'])} · {html.escape(purpose)}</p></header><main>
<section class="grid"><div class="card"><strong>{len(frame)}</strong><span>rows sent to Agent</span></div>
<div class="card"><strong>{len(included_columns)}</strong><span>business fields included</span></div>
<div class="card"><strong>{attention['pack_payload_bytes']}</strong><span>pack payload bytes</span></div>
<div class="card"><strong>{quality['status']}</strong><span>quality status</span></div></section>
<section class="panel"><h2>What Atlas did locally</h2><p>Read the authorized source once, normalized only low-risk formatting, profiled the selected fields, and preserved source row coordinates. The original file was not changed.</p></section>
<section class="panel"><h2>What the Agent receives</h2><p><strong>Included:</strong> {html.escape(', '.join(included_columns))}</p><p><strong>Excluded:</strong> {excluded}</p><p>Files: context.md, schema.json, quality.json and data.csv. The raw source is not part of the default model input.</p></section>
<section class="panel"><h2>Needs review</h2><ul>{issues}</ul><p class="small">Atlas does not remove duplicates, fill missing values, infer business definitions, or decide whether conflicting facts are correct.</p></section>
<section class="panel"><h2>Traceable data</h2><div class="toolbar"><input id="filter" placeholder="Filter visible rows"><select id="pageSize"><option>25</option><option selected>50</option><option>100</option></select><button id="previous">Previous</button><button id="next">Next</button><span id="position" class="small"></span></div><div class="table-wrap"><table><thead id="head"></thead><tbody id="body"></tbody></table></div><p class="small">__atlas_source_sheet and __atlas_source_row locate each record in the original source. Column names retain the source field identity. Pack: {html.escape(pack_id)}</p></section>
</main><script>
const dataset={payload};let rows=dataset.rows.slice(),page=0,sortKey=null,ascending=true;
const esc=v=>String(v??'').replace(/[&<>\"]/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}}[c]));
function render(){{const q=document.querySelector('#filter').value.toLowerCase(),size=Number(document.querySelector('#pageSize').value);const filtered=rows.filter(r=>!q||dataset.columns.some(c=>String(r[c]??'').toLowerCase().includes(q)));page=Math.min(page,Math.max(0,Math.ceil(filtered.length/size)-1));document.querySelector('#head').innerHTML='<tr>'+dataset.columns.map(c=>`<th data-column="${{esc(c)}}">${{esc(c)}}</th>`).join('')+'</tr>';document.querySelector('#body').innerHTML=filtered.slice(page*size,page*size+size).map(r=>'<tr>'+dataset.columns.map(c=>r[c]==null?'<td class="missing">missing</td>':`<td>${{esc(r[c])}}</td>`).join('')+'</tr>').join('');document.querySelector('#position').textContent=`${{filtered.length?page*size+1:0}}–${{Math.min((page+1)*size,filtered.length)}} of ${{filtered.length}}`;document.querySelectorAll('th').forEach(th=>th.onclick=()=>{{const key=th.dataset.column;if(sortKey===key)ascending=!ascending;else{{sortKey=key;ascending=true}}rows.sort((a,b)=>String(a[key]??'').localeCompare(String(b[key]??''),undefined,{{numeric:true}})*(ascending?1:-1));render()}})}}
document.querySelector('#filter').oninput=()=>{{page=0;render()}};document.querySelector('#pageSize').onchange=()=>{{page=0;render()}};document.querySelector('#previous').onclick=()=>{{page=Math.max(0,page-1);render()}};document.querySelector('#next').onclick=()=>{{page+=1;render()}};render();
</script></body></html>"""


def build_context_pack(
    source_manifest_value: str,
    output_dir_value: str,
    *,
    pack_id: str,
    purpose: str,
    include_columns: list[str],
    expected_manifest_sha256: str,
) -> dict[str, Any]:
    started = time.perf_counter()
    source_manifest_path = Path(source_manifest_value).resolve()
    if _sha256(source_manifest_path) != expected_manifest_sha256:
        raise ValueError("Source Cache manifest changed before Context Pack preparation")
    source_manifest = _read_json(source_manifest_path)
    if source_manifest.get("schema") != "atlas.data-workspace.v1":
        raise ValueError("Context Pack requires an Atlas Data Workspace source manifest")
    files = source_manifest.get("files", {})
    for name in ("profile", "quality", "transform_plan", "normalized", "provenance"):
        item = files.get(name)
        if not item or _sha256(Path(item["path"])) != item.get("sha256"):
            raise ValueError(f"Source Cache file is missing or changed: {name}")
    profile = _read_json(Path(files["profile"]["path"]))
    source_quality = _read_json(Path(files["quality"]["path"]))
    transformations = _read_json(Path(files["transform_plan"]["path"]))
    available_columns = [item["name"] for item in profile["columns"]]
    if not include_columns:
        raise ValueError("Context Pack requires at least one explicit included column")
    if len(set(include_columns)) != len(include_columns):
        raise ValueError("Context Pack included columns must be unique")
    unknown = [name for name in include_columns if name not in available_columns]
    if unknown:
        raise ValueError(f"Context Pack columns do not exist: {unknown}; available: {available_columns}")

    frame = pd.read_csv(files["normalized"]["path"], dtype="object", keep_default_na=False)
    provenance = pd.read_csv(files["provenance"]["path"], dtype="object")
    if len(frame) != len(provenance):
        raise ValueError("Source Cache row provenance does not match normalized data")
    source_sheet = profile.get("selection", {}).get("sheet") or "(delimited file)"
    selected = frame[include_columns].replace({"": None}).copy()
    selected.insert(0, "__atlas_source_row", provenance["source_row"].astype(int))
    selected.insert(0, "__atlas_source_sheet", source_sheet)
    selected_profiles = [item for item in profile["columns"] if item["name"] in include_columns]
    selected_issues = [
        item for item in source_quality.get("issues", [])
        if not item.get("column") or item.get("column") in include_columns
    ]
    quality = {
        "schema": "atlas.context-quality.v1",
        "status": "WARN" if selected_issues else "PASS",
        "row_count": len(selected),
        "selected_column_count": len(include_columns),
        "issues": selected_issues,
        "excluded_issue_count": len(source_quality.get("issues", [])) - len(selected_issues),
        "rule": source_quality.get("rule"),
    }
    schema = {
        "schema": "atlas.context-schema.v1",
        "provenance_columns": ["__atlas_source_sheet", "__atlas_source_row"],
        "business_columns": selected_profiles,
    }
    excluded_columns = [name for name in available_columns if name not in include_columns]
    context_text = "\n".join([
        "# Atlas Context Pack",
        "",
        f"Purpose: {purpose}",
        f"Source: {source_manifest['source']['name']}",
        f"Selection: {source_sheet}",
        f"Rows: {len(selected)}",
        f"Included business fields: {', '.join(include_columns)}",
        f"Excluded business fields: {', '.join(excluded_columns) if excluded_columns else 'None'}",
        f"Quality: {quality['status']}",
        "",
        "Use data.csv as the task evidence. Use schema.json and quality.json for types and uncertainty.",
        "Do not open the raw source by default. If evidence is insufficient, request explicit extra fields or scope.",
        "Atlas applied only low-risk normalization. It did not remove duplicates, fill missing values, or define business meaning.",
        "Each row retains its original sheet and row coordinate.",
        "",
    ])

    output_dir = Path(output_dir_value).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    context_path = output_dir / "context.md"
    schema_path = output_dir / "schema.json"
    quality_path = output_dir / "quality.json"
    data_path = output_dir / "data.csv"
    review_path = output_dir / "review.html"
    manifest_path = output_dir / "manifest.json"
    _atomic_text(context_path, context_text)
    _atomic_text(schema_path, json.dumps(schema, ensure_ascii=False, indent=2) + "\n")
    _atomic_text(quality_path, json.dumps(quality, ensure_ascii=False, indent=2) + "\n")
    data_temporary = data_path.with_name(".data.csv.tmp")
    selected.to_csv(data_temporary, index=False, encoding="utf-8-sig")
    data_temporary.replace(data_path)
    payload_paths = [context_path, schema_path, quality_path, data_path]
    pack_payload_bytes = sum(item.stat().st_size for item in payload_paths)
    attention = {
        "raw_source_bytes": source_manifest["source"]["bytes"],
        "pack_payload_bytes": pack_payload_bytes,
        "selected_data_bytes": data_path.stat().st_size,
        "raw_source_in_default_model_input": False,
        "screenshots_used": 0,
        "browser_used": False,
        "local_rows_processed": len(selected),
    }
    _atomic_text(review_path, _render_review(
        pack_id=pack_id,
        purpose=purpose,
        source=source_manifest["source"],
        included_columns=include_columns,
        excluded_columns=excluded_columns,
        quality=quality,
        frame=selected,
        attention=attention,
    ))
    output_files = {
        name: {"path": str(file_path), "bytes": file_path.stat().st_size, "sha256": _sha256(file_path)}
        for name, file_path in {
            "context": context_path,
            "schema": schema_path,
            "quality": quality_path,
            "data": data_path,
            "review": review_path,
        }.items()
    }
    manifest = {
        "schema": SCHEMA,
        "processor": {"name": "atlas-context-pack", "version": PROCESSOR_VERSION},
        "context_pack_id": pack_id,
        "status": "review_required" if quality["status"] == "WARN" else "ready",
        "purpose": purpose,
        "source": source_manifest["source"],
        "source_cache": {
            "manifest_path": str(source_manifest_path),
            "manifest_sha256": expected_manifest_sha256,
        },
        "selection": {"sheet": source_sheet, "included_columns": include_columns},
        "excluded": {"columns": excluded_columns, "rows": 0},
        "quality": {"status": quality["status"], "issue_count": len(selected_issues)},
        "transformations": transformations["applied_safe_normalization"],
        "uncertainty": {
            "status": "needs_review" if selected_issues else "bounded",
            "items": selected_issues,
        },
        "model_input": [output_files[name] for name in ("context", "schema", "quality", "data")],
        "files": output_files,
        "attention": attention,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
    }
    _atomic_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return {**manifest, "manifest_path": str(manifest_path)}
