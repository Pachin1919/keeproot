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
    else:
        result = analyze_branches(args.request, args.output_dir)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from error
