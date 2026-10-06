from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import stat
from pathlib import Path

MAX_BYTES = 256 * 1024
MAX_RECORDS = 10_000
MAX_COLUMNS = 50
MAX_CELL_CHARACTERS = 1_200
PARSER_VERSION = "atlas.csv-row.v1"


def _fingerprint(path: Path) -> tuple[str, os.stat_result]:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError("CSV Resource must be a regular non-linked file")
    if info.st_size > MAX_BYTES:
        raise ValueError("CSV Resource exceeds 256 KiB")
    raw = path.read_bytes()
    after = path.lstat()
    identity = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    after_identity = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if identity != after_identity:
        raise ValueError("CSV changed while reading")
    return hashlib.sha256(raw).hexdigest(), info


def inspect_csv_row(file_path: str, expected_sha256: str, *, key_column: str,
                    key_value: str) -> dict:
    if not isinstance(key_column, str) or not key_column or len(key_column) > MAX_CELL_CHARACTERS:
        raise ValueError("CSV key column must be an exact bounded header")
    if not isinstance(key_value, str) or key_value == "" or len(key_value) > MAX_CELL_CHARACTERS:
        raise ValueError("CSV key value must be an exact bounded non-empty value")
    if len(expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_sha256):
        raise ValueError("Expected CSV SHA-256 is invalid")

    target = Path(file_path)
    before_hash, before_stat = _fingerprint(target)
    if before_hash != expected_sha256:
        raise ValueError("CSV changed before row extraction")
    raw = target.read_bytes()
    try:
        text = raw.decode("utf-8-sig", errors="strict")
        reader = csv.reader(io.StringIO(text, newline=""), delimiter=",", strict=True)
        header = next(reader, None)
        if not header or len(header) > MAX_COLUMNS or any(not item.strip() or len(item) > MAX_CELL_CHARACTERS for item in header):
            raise ValueError("CSV requires a bounded, non-empty header row")
        if len(set(header)) != len(header):
            raise ValueError("CSV header names must be unique")
        try:
            key_index = header.index(key_column)
        except ValueError as error:
            raise ValueError("CSV key column does not match an exact header") from error

        match = None
        record_number = 0
        matches = 0
        for record in reader:
            record_number += 1
            if record_number > MAX_RECORDS:
                raise ValueError("CSV exceeds the supported logical-record limit")
            if len(record) != len(header):
                raise ValueError("CSV record field count does not match its header")
            if any(len(value) > MAX_CELL_CHARACTERS for value in record):
                raise ValueError("CSV row exceeds the supported cell text bound")
            if record[key_index] == key_value:
                matches += 1
                if matches == 1:
                    match = (record_number, record)
        if matches == 0 or match is None:
            raise ValueError("CSV row key was not found")
        if matches != 1:
            raise ValueError("CSV row key is not unique")
    except (UnicodeDecodeError, csv.Error, StopIteration) as error:
        raise ValueError("CSV is not valid strict UTF-8 comma-separated data") from error

    after_hash, after_stat = _fingerprint(target)
    identity_before = (before_stat.st_dev, before_stat.st_ino, before_stat.st_size, before_stat.st_mtime_ns)
    identity_after = (after_stat.st_dev, after_stat.st_ino, after_stat.st_size, after_stat.st_mtime_ns)
    if before_hash != after_hash or identity_before != identity_after:
        raise ValueError("CSV changed during row extraction")

    logical_number, values = match
    canonical = json.dumps({"parser": PARSER_VERSION, "header": header, "row": values},
                           ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return {
        "schema": "atlas.csv-row.v1",
        "status": "available",
        "format": "csv",
        "file_sha256": before_hash,
        "bytes": before_stat.st_size,
        "parser_version": PARSER_VERSION,
        "record_number": logical_number,
        "key": {"column": key_column, "value": key_value},
        "headers": header,
        "row_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "cells": [{"column": column, "value": value} for column, value in zip(header, values)],
    }
