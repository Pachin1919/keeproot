from __future__ import annotations

import hashlib
from pathlib import Path

from .document_readers import read_pdf

MAX_PDF_BYTES = 256 * 1024 * 1024
MAX_PDF_PAGES = 500
MAX_PDF_PAGE_CODEPOINTS = 100_000
PDF_TEXT_PROFILE = "atlas.pdf-page-text.v1"
PDF_SPATIAL_PROFILE = "atlas.pdf-spatial.v1"
MAX_PDF_SPATIAL_TEXT_CODEPOINTS = 1200
MAX_PDF_TABLES = 20
MAX_PDF_TABLE_CELLS = 100


class _PageTextBudget:
    """Bound each emitted page excerpt while allowing all 500 page records."""

    def __init__(self) -> None:
        self.truncated = False
        self.page_facts: list[dict] = []

    def take(self, value: object, per_value: int = 1200) -> str:
        text = "" if value is None else str(value)
        limit = min(per_value, 1200)
        clipped = len(text) > limit
        if clipped:
            self.truncated = True
        self.page_facts.append({
            "text_characters": len(text),
            "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest() if text else None,
            "text_truncated": clipped,
        })
        return text[:limit]


def _fingerprint(file_path: Path) -> tuple[str, int, int, int]:
    stat = file_path.stat()
    if stat.st_size > MAX_PDF_BYTES:
        raise ValueError("PDF exceeds the 256 MiB page-location limit")
    digest = hashlib.sha256()
    with file_path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    after = file_path.stat()
    if (stat.st_size, stat.st_mtime_ns, stat.st_ino, stat.st_dev) != (
        after.st_size, after.st_mtime_ns, after.st_ino, after.st_dev
    ):
        raise ValueError("PDF changed while its page references were being read")
    return digest.hexdigest(), stat.st_size, stat.st_mtime_ns, stat.st_ino


def inspect_pdf_pages(file_path: str, expected_sha256: str) -> dict:
    target = Path(file_path).resolve(strict=True)
    if len(expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_sha256):
        raise ValueError("Expected PDF SHA-256 is invalid")
    before = _fingerprint(target)
    if before[0] != expected_sha256:
        raise ValueError("PDF changed before page extraction")

    budget = _PageTextBudget()
    result = read_pdf(target, budget)
    if result["page_count"] > MAX_PDF_PAGES:
        raise ValueError("PDF exceeds the 500 page-location limit")
    after = _fingerprint(target)
    if before != after or after[0] != expected_sha256:
        raise ValueError("PDF changed during page extraction")

    pages = []
    for item, facts in zip(result["pages"], budget.page_facts, strict=True):
        text = item["text"] if item["status"] == "text_layer" else None
        pages.append({
            "page": item["page"],
            "status": item["status"],
            "text": text,
            **facts,
            "image_count": item["image_count"],
        })
    return {
        "schema": "atlas.pdf-page-location.v1",
        "file_sha256": expected_sha256,
        "bytes": before[1],
        "page_count": result["page_count"],
        "pages": pages,
    }


def inspect_pdf_page_text(file_path: str, expected_sha256: str, page_number: int, start_codepoint: int = 0) -> dict:
    """Return one bounded codepoint slice from one verified PDF page."""
    target = Path(file_path).resolve(strict=True)
    if len(expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_sha256):
        raise ValueError("Expected PDF SHA-256 is invalid")
    if not isinstance(page_number, int) or page_number < 1 or page_number > MAX_PDF_PAGES:
        raise ValueError("PDF page must be between 1 and 500")
    if not isinstance(start_codepoint, int) or start_codepoint < 0:
        raise ValueError("PDF text offset is invalid")
    before = _fingerprint(target)
    if before[0] != expected_sha256:
        raise ValueError("PDF changed before page text extraction")

    from pypdf import PdfReader, __version__ as pypdf_version
    from .document_readers import pdf_page_image_count

    page_count = 0
    status = "extraction_failed"
    text = None
    try:
        reader = PdfReader(str(target), strict=False)
        if reader.is_encrypted:
            try:
                unlocked = reader.decrypt("")
            except Exception:
                unlocked = 0
            if not unlocked:
                raise ValueError("Encrypted PDF page text is unavailable")
        page_count = len(reader.pages)
        if page_count > MAX_PDF_PAGES:
            raise ValueError("PDF exceeds the 500 page-location limit")
        if page_number > page_count:
            raise ValueError("Requested PDF page does not exist")
        page = reader.pages[page_number - 1]
        try:
            extracted = page.extract_text()
            text = (extracted or "").strip()
        except Exception:
            text = None
            status = "extraction_failed"
        else:
            if len(text) > MAX_PDF_PAGE_CODEPOINTS:
                raise ValueError("PDF page text exceeds the 100000 codepoint limit")
            if text:
                status = "text_layer"
            else:
                status = "image_only" if pdf_page_image_count(page) else "empty_or_vector"
    except ValueError:
        raise
    except Exception:
        status = "extraction_failed"

    after = _fingerprint(target)
    if before != after or after[0] != expected_sha256:
        raise ValueError("PDF changed during page text extraction")

    result = {
        "schema": "atlas.pdf-page-text.v1",
        "file_sha256": expected_sha256,
        "bytes": before[1],
        "page_count": page_count,
        "page": page_number,
        "status": status,
        "pypdf_version": pypdf_version,
        "extraction_profile": PDF_TEXT_PROFILE,
        "basis": "extracted_text",
        "reading_order": "unverified",
        "spatial_mapping": "unsupported",
        "table_structure": "unsupported",
        "ocr_used": False,
        "source_text_accuracy": "unverified",
        "text": None,
        "start_codepoint": 0,
        "end_codepoint": 0,
        "text_codepoints": None,
        "page_text_sha256": None,
        "segment_sha256": None,
        "next_codepoint": None,
    }
    if status != "text_layer":
        if start_codepoint != 0:
            raise ValueError("Cannot continue a page with unavailable text extraction")
        return result
    assert text is not None
    if start_codepoint >= len(text):
        raise ValueError("PDF text offset is outside the extracted page")
    end_codepoint = min(start_codepoint + 1200, len(text))
    segment = text[start_codepoint:end_codepoint]
    result.update({
        "text": segment,
        "start_codepoint": start_codepoint,
        "end_codepoint": end_codepoint,
        "text_codepoints": len(text),
        "page_text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "segment_sha256": hashlib.sha256(segment.encode("utf-8")).hexdigest(),
        "next_codepoint": end_codepoint if end_codepoint < len(text) else None,
    })
    return result


def _open_spatial_pdf(target: Path, expected_sha256: str, page_number: int):
    before = _fingerprint(target)
    if before[0] != expected_sha256:
        raise ValueError("PDF changed before spatial extraction")
    import pdfplumber
    pdf = pdfplumber.open(str(target))
    if len(pdf.pages) > MAX_PDF_PAGES or page_number < 1 or page_number > len(pdf.pages):
        pdf.close()
        raise ValueError("Requested PDF page is outside the supported page range")
    return pdf, pdf.pages[page_number - 1], before


def inspect_pdf_region(file_path: str, expected_sha256: str, page_number: int,
                       x: int, y: int, width: int, height: int) -> dict:
    """Extract text from a bounded top-left-origin point rectangle."""
    import pdfplumber
    target = Path(file_path).resolve(strict=True)
    if len(expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_sha256):
        raise ValueError("Expected PDF SHA-256 is invalid")
    if any(not isinstance(value, int) for value in (page_number, x, y, width, height)):
        raise ValueError("PDF page and rectangle coordinates must be integers")
    if page_number < 1 or page_number > MAX_PDF_PAGES or min(x, y) < 0 or min(width, height) <= 0:
        raise ValueError("PDF page or rectangle coordinates are outside the supported range")
    pdf, page, before = _open_spatial_pdf(target, expected_sha256, page_number)
    try:
        if x + width > page.width or y + height > page.height:
            raise ValueError("PDF region must remain inside the page bounds")
        bbox = (x, y, x + width, y + height)
        extracted = page.crop(bbox).extract_text() or ""
        text = extracted.strip()
        after = _fingerprint(target)
        if before != after or after[0] != expected_sha256:
            raise ValueError("PDF changed during region extraction")
        if len(text) > MAX_PDF_SPATIAL_TEXT_CODEPOINTS:
            return {"schema": "atlas.pdf-spatial.v1", "mode": "region", "status": "text_truncated",
                    "file_sha256": expected_sha256, "page": page_number, "page_count": len(pdf.pages),
                    "bbox": list(bbox), "text": text[:MAX_PDF_SPATIAL_TEXT_CODEPOINTS], "text_truncated": True,
                    "pdfplumber_version": pdfplumber.__version__, "profile": PDF_SPATIAL_PROFILE,
                    "reading_order": "unverified", "spatial_accuracy": "unverified"}
        return {"schema": "atlas.pdf-spatial.v1", "mode": "region", "status": "text_layer" if text else "empty_region",
                "file_sha256": expected_sha256, "page": page_number, "page_count": len(pdf.pages),
                "bbox": list(bbox), "text": text, "text_truncated": False,
                "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "pdfplumber_version": pdfplumber.__version__, "profile": PDF_SPATIAL_PROFILE,
                "reading_order": "unverified", "spatial_accuracy": "unverified"}
    finally:
        pdf.close()


def inspect_pdf_tables(file_path: str, expected_sha256: str, page_number: int,
                       table_index: int | None = None) -> dict:
    """List detected tables or return a bounded selected table with cell text."""
    import pdfplumber
    target = Path(file_path).resolve(strict=True)
    if len(expected_sha256) != 64 or any(char not in "0123456789abcdef" for char in expected_sha256):
        raise ValueError("Expected PDF SHA-256 is invalid")
    if not isinstance(page_number, int) or page_number < 1 or page_number > MAX_PDF_PAGES:
        raise ValueError("PDF page must be between 1 and 500")
    if table_index is not None and (not isinstance(table_index, int) or table_index < 1):
        raise ValueError("PDF table index must be a positive integer")
    pdf, page, before = _open_spatial_pdf(target, expected_sha256, page_number)
    try:
        tables = page.find_tables()
        if len(tables) > MAX_PDF_TABLES:
            after = _fingerprint(target)
            if before != after or after[0] != expected_sha256:
                raise ValueError("PDF changed during table detection")
            return {"schema": "atlas.pdf-spatial.v1", "mode": "tables", "status": "table_limit_exceeded",
                    "file_sha256": expected_sha256, "page": page_number, "page_count": len(pdf.pages),
                    "tables": [], "pdfplumber_version": pdfplumber.__version__, "profile": PDF_SPATIAL_PROFILE}
        if table_index is None:
            items = [{"table_index": index + 1, "bbox": list(table.bbox),
                      "row_count": len(table.rows),
                      "column_count": max((len(row.cells) for row in table.rows), default=0)}
                     for index, table in enumerate(tables)]
            status = "tables_found" if items else "no_tables"
            after = _fingerprint(target)
            if before != after or after[0] != expected_sha256:
                raise ValueError("PDF changed during table detection")
            return {"schema": "atlas.pdf-spatial.v1", "mode": "tables", "status": status,
                    "file_sha256": expected_sha256, "page": page_number, "page_count": len(pdf.pages),
                    "tables": items, "pdfplumber_version": pdfplumber.__version__, "profile": PDF_SPATIAL_PROFILE}
        if table_index > len(tables):
            raise ValueError("Requested PDF table does not exist on this page")
        table = tables[table_index - 1]
        rows = table.extract() or []
        count = sum(len(row or []) for row in rows)
        if count > MAX_PDF_TABLE_CELLS:
            after = _fingerprint(target)
            if before != after or after[0] != expected_sha256:
                raise ValueError("PDF changed during table extraction")
            return {"schema": "atlas.pdf-spatial.v1", "mode": "table", "status": "cell_limit_exceeded",
                    "file_sha256": expected_sha256, "page": page_number, "page_count": len(pdf.pages),
                    "table_index": table_index, "bbox": list(table.bbox), "cells": [],
                    "pdfplumber_version": pdfplumber.__version__, "profile": PDF_SPATIAL_PROFILE}
        cells = []
        for row_index, row in enumerate(rows, 1):
            for column_index, value in enumerate(row or [], 1):
                full_text = (value or "").strip()
                cells.append({"row": row_index, "column": column_index,
                              "text": full_text[:MAX_PDF_SPATIAL_TEXT_CODEPOINTS],
                              "text_truncated": len(full_text) > MAX_PDF_SPATIAL_TEXT_CODEPOINTS,
                              "text_sha256": hashlib.sha256(full_text.encode("utf-8")).hexdigest()})
        after = _fingerprint(target)
        if before != after or after[0] != expected_sha256:
            raise ValueError("PDF changed during table extraction")
        return {"schema": "atlas.pdf-spatial.v1", "mode": "table", "status": "table_cells",
                "file_sha256": expected_sha256, "page": page_number, "page_count": len(pdf.pages),
                "table_index": table_index, "bbox": list(table.bbox), "cells": cells,
                "pdfplumber_version": pdfplumber.__version__, "profile": PDF_SPATIAL_PROFILE,
                "reading_order": "unverified", "spatial_accuracy": "unverified",
                "table_structure": "unverified"}
    finally:
        pdf.close()
