from __future__ import annotations

import hashlib
import os
import stat
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from .common import MAX_XML_MEMBER_BYTES, validate_office_package, xml_root, zip_entry_names

WORD_MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MAX_DOCX_BYTES = 64 * 1024 * 1024
MAX_LOCATIONS = 2_000
MAX_TEXT_CHARS = 1_200


def _fingerprint(file_path: Path) -> tuple[str, os.stat_result]:
    before = file_path.lstat()
    if not stat.S_ISREG(before.st_mode) or file_path.is_symlink():
        raise ValueError("DOCX must be a regular file, not a symbolic link")
    if before.st_size > MAX_DOCX_BYTES:
        raise ValueError("DOCX exceeds the 64 MiB content-location limit")
    digest = hashlib.sha256()
    with file_path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    after = file_path.lstat()
    if (before.st_size, before.st_mtime_ns, before.st_ino, before.st_dev) != (
        after.st_size, after.st_mtime_ns, after.st_ino, after.st_dev
    ):
        raise ValueError("DOCX changed while its locations were being read")
    return digest.hexdigest(), before


def _paragraph_text(paragraph: ET.Element) -> str:
    chunks: list[str] = []
    excluded = {f"{{{WORD_MAIN}}}{name}" for name in ("drawing", "pict", "object", "txbxContent")}

    def append_text(node: ET.Element) -> None:
        if node.tag in excluded:
            return
        if node.tag == f"{{{WORD_MAIN}}}t":
            chunks.append(node.text or "")
        elif node.tag == f"{{{WORD_MAIN}}}tab":
            chunks.append("\t")
        elif node.tag in (f"{{{WORD_MAIN}}}br", f"{{{WORD_MAIN}}}cr"):
            chunks.append("\n")
        for child in node:
            append_text(child)

    append_text(paragraph)
    return "".join(chunks).strip()


def _location(kind: str, text: str, **coordinates: int) -> dict | None:
    if not text:
        return None
    full_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    truncated = len(text) > MAX_TEXT_CHARS
    return {
        "kind": kind,
        **coordinates,
        "text": text[:MAX_TEXT_CHARS],
        "text_characters": len(text),
        "text_sha256": full_hash,
        "text_truncated": truncated,
        "text_complete": not truncated,
    }


def inspect_docx_locations(file_path: str, expected_sha256: str) -> dict:
    target = Path(file_path)
    if len(expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_sha256):
        raise ValueError("Expected DOCX SHA-256 is invalid")
    before_hash, before_stat = _fingerprint(target)
    if before_hash != expected_sha256:
        raise ValueError("DOCX changed before location extraction")

    try:
        with zipfile.ZipFile(target) as archive:
            validate_office_package(archive)
            names = zip_entry_names(archive)
            if "word/document.xml" not in names:
                raise ValueError("DOCX package is missing word/document.xml")
            detail = archive.getinfo("word/document.xml")
            if detail.file_size > MAX_XML_MEMBER_BYTES:
                raise ValueError("DOCX document XML exceeds the local extraction limit")
            document = xml_root(archive, "word/document.xml")
    except (zipfile.BadZipFile, OSError, ET.ParseError) as error:
        raise ValueError("DOCX package is damaged or cannot be read") from error

    body = document.find(f"{{{WORD_MAIN}}}body")
    if body is None:
        raise ValueError("DOCX document is missing its body")
    locations: list[dict] = []
    floating_tags = {f"{{{WORD_MAIN}}}{name}" for name in ("drawing", "pict", "object")}
    unsupported = {"nested_tables": 0,
                   "floating_objects": sum(node.tag in floating_tags for node in body.iter())}
    paragraph_index = 0
    table_index = 0
    truncated_locations = 0
    for child in list(body):
        if child.tag == f"{{{WORD_MAIN}}}p":
            paragraph_index += 1
            item = _location("paragraph", _paragraph_text(child), paragraph_index=paragraph_index)
            if item:
                locations.append(item)
        elif child.tag == f"{{{WORD_MAIN}}}tbl":
            table_index += 1
            for row_index, row in enumerate(child.findall(f"{{{WORD_MAIN}}}tr"), start=1):
                for column_index, cell in enumerate(row.findall(f"{{{WORD_MAIN}}}tc"), start=1):
                    paragraphs = [_paragraph_text(paragraph) for paragraph in cell.findall(f"{{{WORD_MAIN}}}p")]
                    value = "\n".join(text for text in paragraphs if text)
                    item = _location("table_cell", value, table_index=table_index, row=row_index, column=column_index)
                    if item:
                        locations.append(item)
                    if cell.find(f".//{{{WORD_MAIN}}}tbl") is not None:
                        unsupported["nested_tables"] += 1
        if len(locations) >= MAX_LOCATIONS:
            break

    after_hash, after_stat = _fingerprint(target)
    if before_hash != after_hash or (before_stat.st_size, before_stat.st_mtime_ns, before_stat.st_ino, before_stat.st_dev) != (
        after_stat.st_size, after_stat.st_mtime_ns, after_stat.st_ino, after_stat.st_dev
    ):
        raise ValueError("DOCX changed during location extraction")
    truncated_locations = sum(1 for item in locations if item["text_truncated"])
    return {
        "schema": "atlas.docx-location.v1",
        "file_sha256": expected_sha256,
        "bytes": before_stat.st_size,
        "locations": locations,
        "location_count": len(locations),
        "locations_truncated": len(locations) >= MAX_LOCATIONS,
        "text_truncated_count": truncated_locations,
        "unsupported": unsupported,
        "page_numbers_supported": False,
    }
