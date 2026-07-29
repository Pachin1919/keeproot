from __future__ import annotations

import argparse
import json

from .reader import load_export, summarize


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate and summarize a read-only Atlas analytics export."
    )
    parser.add_argument("export_dir", help="Directory containing manifest.json and records.jsonl")
    args = parser.parse_args()
    manifest, records = load_export(args.export_dir)
    result = {
        "export_schema": manifest["export_schema"],
        "content_hash": manifest["content_hash"],
        "summary": summarize(records),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
