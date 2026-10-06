"""Bounded reading from already captured bytes; no document paths or external links."""
from __future__ import annotations

import hashlib
import io
import re
import zipfile
from xml.etree import ElementTree as ET

from .common import MAX_XML_MEMBER_BYTES, validate_office_package
from .docx_location import WORD_MAIN, _paragraph_text

MAX_BYTES = 20 * 1024 * 1024
MAX_CHARACTERS = 200_000
MAX_BLOCKS = 1_000
MAX_CELLS = 10_000


class _NoDoctypeBuilder(ET.TreeBuilder):
    def doctype(self, name, pubid, system):
        raise ValueError("DOCX XML declarations are not supported")


def read_docx_bytes(content: bytes) -> dict:
    if len(content) > MAX_BYTES:
        raise ValueError("DOCX exceeds the 20 MiB reading limit")
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            validate_office_package(archive)
            names = [item.filename for item in archive.infolist()]
            if len(names) != len(set(names)) or "word/document.xml" not in names:
                raise ValueError("DOCX package has duplicate entries or no document body")
            if archive.getinfo("word/document.xml").file_size > MAX_XML_MEMBER_BYTES:
                raise ValueError("DOCX document XML exceeds the reading limit")
            xml = archive.read("word/document.xml")
            if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", xml, re.I):
                raise ValueError("DOCX XML declarations are not supported")
            document = ET.fromstring(xml, parser=ET.XMLParser(target=_NoDoctypeBuilder()))
    except (zipfile.BadZipFile, ET.ParseError, RuntimeError) as error:
        raise ValueError("DOCX package is damaged or cannot be decoded") from error
    ns = f"{{{WORD_MAIN}}}"
    body = document.find(f"{ns}body")
    if body is None:
        raise ValueError("DOCX document has no body")
    warnings = set()
    if any(node.tag in {f"{ns}drawing", f"{ns}pict", f"{ns}object"} for node in body.iter()):
        warnings.add("floating_objects")
    if any(re.fullmatch(r"word/(?:header|footer)\d+\.xml", name) for name in names):
        warnings.add("headers_footers")
    blocks = []
    used = 0
    cells = 0
    truncated = False

    def take(text: str) -> str:
        nonlocal used, truncated
        remaining = MAX_CHARACTERS - used
        if len(text) > remaining:
            truncated = True
        value = text[:remaining]
        used += len(value)
        return value

    for child in body:
        if len(blocks) >= MAX_BLOCKS or used >= MAX_CHARACTERS:
            if child.tag != f"{ns}sectPr":
                truncated = True
            break
        if child.tag == f"{ns}p":
            text = _paragraph_text(child)
            if not text:
                continue
            style = child.find(f"{ns}pPr/{ns}pStyle")
            heading = re.fullmatch(r"(?:Heading|标题)\s*([1-6])", style.get(f"{ns}val", "") if style is not None else "", re.I)
            blocks.append({"kind": "paragraph", "text": take(text), "heading": int(heading[1]) if heading else 0})
        elif child.tag == f"{ns}tbl":
            rows = []
            for row in child.findall(f"{ns}tr"):
                if len(rows) >= 1000 or cells >= MAX_CELLS or used >= MAX_CHARACTERS:
                    truncated = True
                    break
                values = []
                for cell in row.findall(f"{ns}tc"):
                    if len(values) >= 100 or cells >= MAX_CELLS or used >= MAX_CHARACTERS:
                        truncated = True
                        break
                    if cell.find(f".//{ns}tbl") is not None:
                        warnings.add("nested_tables")
                    if cell.find(f"{ns}tcPr/{ns}gridSpan") is not None or cell.find(f"{ns}tcPr/{ns}vMerge") is not None:
                        warnings.add("merged_cells")
                    values.append(take("\n".join(_paragraph_text(p) for p in cell.findall(f"{ns}p"))))
                    cells += 1
                if values:
                    rows.append(values)
            if rows:
                blocks.append({"kind": "table", "rows": rows})
        elif child.tag != f"{ns}sectPr":
            warnings.add("unsupported_blocks")
    return {"schema": "atlas.docx-reader.v1", "sha256": hashlib.sha256(content).hexdigest(),
            "blocks": blocks, "characters": used, "truncated": truncated,
            "warnings": sorted(warnings), "layout_preserved": False}
