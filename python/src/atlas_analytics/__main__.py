from __future__ import annotations

import argparse
import json
import sys

from .evaluation import write_measurement_gap_evaluation
from .reader import load_export, summarize


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate and evaluate a read-only Atlas analytics export."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    summarize_parser = subparsers.add_parser("summarize")
    summarize_parser.add_argument(
        "export_dir", help="Directory containing manifest.json and records.jsonl"
    )
    evaluate_parser = subparsers.add_parser("evaluate")
    evaluate_parser.add_argument("export_dir")
    evaluate_parser.add_argument("--output-dir", required=True)
    evaluate_parser.add_argument("--evaluation-id", required=True)
    args = parser.parse_args()
    if args.command == "evaluate":
        result = write_measurement_gap_evaluation(
            args.export_dir,
            args.output_dir,
            evaluation_id=args.evaluation_id,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0

    manifest, records = load_export(args.export_dir)
    result = {
        "export_schema": manifest["export_schema"],
        "content_hash": manifest["content_hash"],
        "summary": summarize(records),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from error
