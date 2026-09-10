from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from pathlib import Path


DELIMITERS = (",", "\t", ";", "|")
HEADER_HINT = re.compile(
    r"(name|date|time|month|year|country|category|activity|platform|campaign|status|"
    r"姓名|名称|日期|时间|月份|国家|分类|活动|平台|渠道|项目|岗位|职责|联系方式|账号|链接|文案)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class DelimitedTable:
    rows: list[list[str]]
    source_rows: list[int]
    encoding: str
    delimiter: str
    delimiter_detection: str
    truncated: bool
    decode_warning: str | None = None


def header_score(row: dict[int, str], position: int) -> float:
    values = [value.strip() for value in row.values() if value.strip()]
    if not values:
        return float("-inf")
    hint_count = sum(1 for value in values if HEADER_HINT.search(value))
    phone_like = sum(1 for value in values if re.fullmatch(r"\+?\d[\d\s-]{8,}", value))
    long_values = sum(1 for value in values if len(value) > 80)
    uniqueness = len(set(values)) / len(values)
    return (
        hint_count * 6
        + min(len(values), 12)
        + uniqueness * 2
        - phone_like * 8
        - long_values * 3
        - position * 0.15
    )


def choose_header(
    rows: list[tuple[int, dict[int, str]]],
) -> tuple[int, int, dict[int, str]]:
    if not rows:
        return 0, 0, {}
    candidates = rows[:12]
    best_index = max(
        range(len(candidates)),
        key=lambda index: header_score(candidates[index][1], index),
    )
    row_number, values = candidates[best_index]
    return best_index, row_number, values


def unique_headers(header: dict[int, str], width: int) -> list[str]:
    result = []
    used: dict[str, int] = {}
    for index in range(width):
        base = header.get(index, "").strip() or f"column_{column_label(index)}"
        count = used.get(base, 0) + 1
        used[base] = count
        result.append(base if count == 1 else f"{base}_{count}")
    return result


def column_label(index: int) -> str:
    value = index + 1
    result = ""
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(ord("A") + remainder) + result
    return result


def indexed_rows(
    table: DelimitedTable,
    *,
    maximum_columns: int,
    maximum_cell_characters: int | None = None,
) -> list[tuple[int, dict[int, str]]]:
    result: list[tuple[int, dict[int, str]]] = []
    for row_number, row in zip(table.source_rows, table.rows, strict=True):
        values: dict[int, str] = {}
        for index, value in enumerate(row[:maximum_columns]):
            if value == "":
                continue
            values[index] = (
                value[:maximum_cell_characters]
                if maximum_cell_characters is not None
                else value
            )
        result.append((row_number, values))
    return result


def _nul_encoding(raw: bytes) -> str | None:
    if len(raw) < 8 or len(raw) % 2:
        return None
    pairs = len(raw) // 2
    even_nuls = raw[0::2].count(0)
    odd_nuls = raw[1::2].count(0)
    threshold = max(4, pairs // 20)
    if odd_nuls >= threshold and odd_nuls > even_nuls * 4:
        return "utf-16-le"
    if even_nuls >= threshold and even_nuls > odd_nuls * 4:
        return "utf-16-be"
    return None


def decode_delimited_bytes(raw: bytes) -> tuple[str, str, str | None]:
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig"), "utf-8-sig", None
    if raw.startswith(b"\xff\xfe"):
        return raw.decode("utf-16-le")[1:], "utf-16-le", None
    if raw.startswith(b"\xfe\xff"):
        return raw.decode("utf-16-be")[1:], "utf-16-be", None

    nul_encoding = _nul_encoding(raw)
    if nul_encoding:
        try:
            return raw.decode(nul_encoding), nul_encoding, None
        except UnicodeDecodeError:
            pass

    for encoding in ("utf-8", "gb18030", "cp1252"):
        try:
            return raw.decode(encoding), encoding, None
        except UnicodeDecodeError:
            continue
    return (
        raw.decode("utf-8", errors="replace"),
        "utf-8-replacement",
        "Some source bytes could not be decoded exactly.",
    )


def _parsed_rows(text: str, delimiter: str, limit: int | None = None) -> tuple[list[list[str]], list[int], bool]:
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    rows: list[list[str]] = []
    source_rows: list[int] = []
    truncated = False
    for row in reader:
        if limit is not None and len(rows) >= limit:
            truncated = True
            break
        rows.append(row)
        source_rows.append(reader.line_num)
    return rows, source_rows, truncated


def _delimiter_score(text: str, delimiter: str) -> tuple[float, int]:
    try:
        rows, _, _ = _parsed_rows(text, delimiter, limit=200)
    except csv.Error:
        return float("-inf"), 0
    widths = [len(row) for row in rows if row]
    if not widths:
        return float("-inf"), 0
    frequencies: dict[int, int] = {}
    for width in widths:
        frequencies[width] = frequencies.get(width, 0) + 1
    modal_width, modal_count = max(frequencies.items(), key=lambda item: (item[1], item[0]))
    if modal_width <= 1:
        return float("-inf"), modal_width
    consistency = modal_count / len(widths)
    return consistency * 100 + min(modal_width, 100) - len(frequencies), modal_width


def detect_delimiter(text: str, suffix: str = "") -> tuple[str, str]:
    sample = text[:32_768]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters="".join(DELIMITERS))
        return dialect.delimiter, "sniffer"
    except csv.Error:
        scored = sorted(
            ((_delimiter_score(sample, delimiter), delimiter) for delimiter in DELIMITERS),
            key=lambda item: item[0],
            reverse=True,
        )
        if scored and scored[0][0][0] != float("-inf"):
            return scored[0][1], "consistent_columns"
        return ("\t", "extension_fallback") if suffix.lower() == ".tsv" else (",", "extension_fallback")


def read_delimited_file(
    path: Path,
    *,
    max_bytes: int | None = None,
    max_rows: int | None = None,
) -> DelimitedTable:
    with path.open("rb") as stream:
        raw = stream.read(max_bytes + 1) if max_bytes is not None else stream.read()
    bytes_truncated = max_bytes is not None and len(raw) > max_bytes
    if bytes_truncated:
        raw = raw[:max_bytes]
        if len(raw) % 2 and _nul_encoding(raw[:-1]):
            raw = raw[:-1]
    text, encoding, decode_warning = decode_delimited_bytes(raw)
    delimiter, detection = detect_delimiter(text, path.suffix)
    rows, source_rows, rows_truncated = _parsed_rows(text, delimiter, limit=max_rows)
    return DelimitedTable(
        rows=rows,
        source_rows=source_rows,
        encoding=encoding,
        delimiter=delimiter,
        delimiter_detection=detection,
        truncated=bytes_truncated or rows_truncated,
        decode_warning=decode_warning,
    )
