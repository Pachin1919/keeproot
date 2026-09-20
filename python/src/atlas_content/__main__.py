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
    data_work_parser.add_argument("--action", choices=("describe", "profile", "preview", "export"), required=True)
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
