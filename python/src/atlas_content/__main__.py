from __future__ import annotations

import argparse
import json
import sys

from .inspector import inspect_file
from .branches import analyze_branches
from .relationships import compare_files


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Inspect one explicit local file without browser or desktop automation."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--file", required=True)
    inspect_parser.add_argument(
        "--purpose", choices=("structure", "content", "data", "visual"), default="content"
    )
    inspect_parser.add_argument("--sheet")
    inspect_parser.add_argument("--max-characters", type=int, default=4000)
    inspect_parser.add_argument("--expected-sha256", required=True)
    compare_parser = subparsers.add_parser("compare")
    compare_parser.add_argument("--left", required=True)
    compare_parser.add_argument("--right", required=True)
    compare_parser.add_argument("--expected-left-sha256", required=True)
    compare_parser.add_argument("--expected-right-sha256", required=True)
    compare_parser.add_argument("--details", action="store_true")
    compare_parser.add_argument("--key-column")
    compare_parser.add_argument("--period-column")
    compare_parser.add_argument("--event-date-column")
    compare_parser.add_argument("--left-sheet")
    compare_parser.add_argument("--right-sheet")
    branches_parser = subparsers.add_parser("branches")
    branches_parser.add_argument("--request", required=True)
    branches_parser.add_argument("--output-dir", required=True)
    workspace_parser = subparsers.add_parser("data-workspace")
    workspace_parser.add_argument("--file", required=True)
    workspace_parser.add_argument("--sheet")
    workspace_parser.add_argument("--output-dir", required=True)
    workspace_parser.add_argument("--expected-sha256", required=True)
    data_work_parser = subparsers.add_parser("data-work")
    data_work_parser.add_argument("--file", required=True)
    data_work_parser.add_argument("--expected-sha256", required=True)
    data_work_parser.add_argument("--action", choices=("describe", "profile", "preview", "export", "details"), required=True)
    data_work_parser.add_argument("--sheet")
    data_work_parser.add_argument("--request")
    data_work_parser.add_argument("--output")
    context_parser = subparsers.add_parser("context-pack")
    context_parser.add_argument("--source-manifest", required=True)
    context_parser.add_argument("--output-dir", required=True)
    context_parser.add_argument("--pack-id", required=True)
    context_parser.add_argument("--purpose", required=True)
    context_parser.add_argument("--include-column", action="append", required=True)
    context_parser.add_argument("--expected-manifest-sha256", required=True)
    pdf_pages_parser = subparsers.add_parser("pdf-pages")
    pdf_pages_parser.add_argument("--file", required=True)
    pdf_pages_parser.add_argument("--expected-sha256", required=True)
    pdf_page_text_parser = subparsers.add_parser("pdf-page-text")
    pdf_page_text_parser.add_argument("--file", required=True)
    pdf_page_text_parser.add_argument("--expected-sha256", required=True)
    pdf_page_text_parser.add_argument("--page", type=int, required=True)
    pdf_page_text_parser.add_argument("--start-codepoint", type=int, default=0)
    pdf_region_parser = subparsers.add_parser("pdf-region")
    pdf_region_parser.add_argument("--file", required=True)
    pdf_region_parser.add_argument("--expected-sha256", required=True)
    pdf_region_parser.add_argument("--page", type=int, required=True)
    pdf_region_parser.add_argument("--x", type=int, required=True)
    pdf_region_parser.add_argument("--y", type=int, required=True)
    pdf_region_parser.add_argument("--width", type=int, required=True)
    pdf_region_parser.add_argument("--height", type=int, required=True)
    pdf_tables_parser = subparsers.add_parser("pdf-tables")
    pdf_tables_parser.add_argument("--file", required=True)
    pdf_tables_parser.add_argument("--expected-sha256", required=True)
    pdf_tables_parser.add_argument("--page", type=int, required=True)
    pdf_tables_parser.add_argument("--table-index", type=int)
    docx_locations_parser = subparsers.add_parser("docx-locations")
    docx_locations_parser.add_argument("--file", required=True)
    docx_locations_parser.add_argument("--expected-sha256", required=True)
    subparsers.add_parser("docx-read")
    table_parser = subparsers.add_parser("table-read")
    table_parser.add_argument("--format", choices=("csv", "tsv", "xlsx"), required=True)
    table_parser.add_argument("--sheet")
    table_parser.add_argument("--offset", type=int, default=0)
    xlsx_locations_parser = subparsers.add_parser("xlsx-locations")
    xlsx_locations_parser.add_argument("--file", required=True)
    xlsx_locations_parser.add_argument("--expected-sha256", required=True)
    xlsx_locations_parser.add_argument("--limit", type=int, default=50)
    xlsx_locations_parser.add_argument("--sheet")
    xlsx_locations_parser.add_argument("--cell")
    xlsx_row_parser = subparsers.add_parser("xlsx-row")
    xlsx_row_parser.add_argument("--file", required=True)
    xlsx_row_parser.add_argument("--expected-sha256", required=True)
    xlsx_row_parser.add_argument("--sheet", required=True)
    xlsx_row_parser.add_argument("--row", type=int)
    xlsx_row_parser.add_argument("--key-column")
    xlsx_row_parser.add_argument("--key-value")
    csv_row_parser = subparsers.add_parser("csv-row")
    csv_row_parser.add_argument("--file", required=True)
    csv_row_parser.add_argument("--expected-sha256", required=True)
    csv_row_parser.add_argument("--key-column", required=True)
    csv_row_parser.add_argument("--key-value", required=True)
    args = parser.parse_args()

    if args.command == "inspect":
        result = inspect_file(
            args.file,
            purpose=args.purpose,
            max_characters=args.max_characters,
            expected_sha256=args.expected_sha256,
            sheet=args.sheet,
        )
    elif args.command == "compare":
        result = compare_files(
            args.left,
            args.right,
            expected_left_sha256=args.expected_left_sha256,
            expected_right_sha256=args.expected_right_sha256,
            details=args.details, key_column=args.key_column, period_column=args.period_column,
            event_date_column=args.event_date_column, left_sheet=args.left_sheet, right_sheet=args.right_sheet,
        )
    elif args.command == "branches":
        result = analyze_branches(args.request, args.output_dir)
    elif args.command == "data-workspace":
        from .data_workspace import build_data_workspace
        result = build_data_workspace(
            args.file,
            args.output_dir,
            expected_sha256=args.expected_sha256,
            sheet=args.sheet,
        )
    elif args.command == "data-work":
        from .data_work import data_work
        result = data_work(args.file, expected_sha256=args.expected_sha256, action=args.action,
                           sheet=args.sheet, request_path=args.request, output_path=args.output)
    elif args.command == "pdf-pages":
        from .pdf_location import inspect_pdf_pages
        result = inspect_pdf_pages(args.file, args.expected_sha256)
    elif args.command == "pdf-page-text":
        from .pdf_location import inspect_pdf_page_text
        result = inspect_pdf_page_text(args.file, args.expected_sha256, args.page, args.start_codepoint)
    elif args.command == "pdf-region":
        from .pdf_location import inspect_pdf_region
        result = inspect_pdf_region(args.file, args.expected_sha256, args.page, args.x, args.y, args.width, args.height)
    elif args.command == "pdf-tables":
        from .pdf_location import inspect_pdf_tables
        result = inspect_pdf_tables(args.file, args.expected_sha256, args.page, args.table_index)
    elif args.command == "docx-read":
        from .docx_reader import read_docx_bytes, MAX_BYTES
        result = read_docx_bytes(sys.stdin.buffer.read(MAX_BYTES + 1))
    elif args.command == "table-read":
        from .table_reader import read_table_bytes, MAX_BYTES
        result = read_table_bytes(sys.stdin.buffer.read(MAX_BYTES + 1), args.format, args.sheet, args.offset)
    elif args.command == "docx-locations":
        from .docx_location import inspect_docx_locations
        result = inspect_docx_locations(args.file, args.expected_sha256)
    elif args.command == "xlsx-locations":
        from .xlsx_location import inspect_xlsx_locations
        result = inspect_xlsx_locations(args.file, args.expected_sha256, sheet_name=args.sheet,
                                        cell_value=args.cell, limit=args.limit)
    elif args.command == "xlsx-row":
        from .xlsx_location import inspect_xlsx_row
        result = inspect_xlsx_row(args.file, args.expected_sha256, sheet_name=args.sheet,
                                  row_number=args.row, key_column=args.key_column, key_value=args.key_value)
    elif args.command == "csv-row":
        from .csv_location import inspect_csv_row
        result = inspect_csv_row(args.file, args.expected_sha256,
                                 key_column=args.key_column, key_value=args.key_value)
    else:
        from .context_pack import build_context_pack
        result = build_context_pack(
            args.source_manifest,
            args.output_dir,
            pack_id=args.pack_id,
            purpose=args.purpose,
            include_columns=args.include_column,
            expected_manifest_sha256=args.expected_manifest_sha256,
        )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from error
