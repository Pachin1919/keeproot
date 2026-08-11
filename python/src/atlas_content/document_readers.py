from __future__ import annotations

import re
import zipfile
from pathlib import Path

from .common import CharacterBudget, validate_office_package, xml_root, zip_entry_names

WORD_MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
DRAWING_MAIN = "http://schemas.openxmlformats.org/drawingml/2006/main"
PRESENTATION_MAIN = "http://schemas.openxmlformats.org/presentationml/2006/main"
MAX_PDF_PAGES = 500


def numeric_member_sort(name: str) -> tuple[int, str]:
    match = re.search(r"(\d+)\.xml$", name)
    return (int(match.group(1)) if match else 0, name)


def read_pptx(file_path: Path, budget: CharacterBudget) -> dict:
    with zipfile.ZipFile(file_path) as archive:
        validate_office_package(archive)
        names = zip_entry_names(archive)
        slide_members = sorted(
            (name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
            key=numeric_member_sort,
        )
        slides = []
        for index, member in enumerate(slide_members[:100], start=1):
            root = xml_root(archive, member)
            text = "\n".join(
                node.text or "" for node in root.iter(f"{{{DRAWING_MAIN}}}t") if node.text
            )
            note_member = f"ppt/notesSlides/notesSlide{index}.xml"
            notes = ""
            if note_member in names:
                note_root = xml_root(archive, note_member)
                notes = "\n".join(
                    node.text or ""
                    for node in note_root.iter(f"{{{DRAWING_MAIN}}}t")
                    if node.text
                )
            slides.append({
                "slide": index,
                "text": budget.take(text, 1200),
                "notes": budget.take(notes, 800),
                "shape_count": len(root.findall(f".//{{{PRESENTATION_MAIN}}}sp")),
                "image_count": len(root.findall(f".//{{{PRESENTATION_MAIN}}}pic")),
                "table_count": len(root.findall(f".//{{{DRAWING_MAIN}}}tbl")),
            })
            if budget.used >= budget.limit:
                break
        return {
            "kind": "pptx",
            "status": "partial" if len(slide_members) > len(slides) or budget.truncated else "complete",
            "slide_count": len(slide_members),
            "slides": slides,
        }


def read_docx(file_path: Path, budget: CharacterBudget) -> dict:
    with zipfile.ZipFile(file_path) as archive:
        validate_office_package(archive)
        names = zip_entry_names(archive)
        if "word/document.xml" not in names:
            raise ValueError("DOCX package is missing word/document.xml")
        root = xml_root(archive, "word/document.xml")
        paragraphs = []
        all_paragraphs = root.findall(f".//{{{WORD_MAIN}}}p")
        stopped_early = False
        for paragraph in all_paragraphs:
            value = "".join(
                node.text or "" for node in paragraph.iter(f"{{{WORD_MAIN}}}t")
            ).strip()
            if value:
                paragraphs.append(budget.take(value, 1000))
            if budget.used >= budget.limit:
                stopped_early = True
                break
        return {
            "kind": "docx",
            "status": "partial" if stopped_early or budget.truncated else "complete",
            "paragraph_count": len(all_paragraphs),
            "table_count": len(root.findall(f".//{{{WORD_MAIN}}}tbl")),
            "paragraphs": paragraphs,
        }


def pdf_page_image_count(page) -> int:
    resources = page.get("/Resources")
    if resources is None:
        return 0
    resources = resources.get_object()
    objects = resources.get("/XObject")
    if objects is None:
        return 0
    objects = objects.get_object()
    return sum(
        1
        for reference in objects.values()
        if reference.get_object().get("/Subtype") == "/Image"
    )


def read_pdf(file_path: Path, budget: CharacterBudget) -> dict:
    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise ValueError("PDF inspection requires the managed pypdf component") from error

    if file_path.stat().st_size > 256 * 1024 * 1024:
        raise ValueError("PDF exceeds the 256 MiB bounded local-inspection limit")
    reader = PdfReader(str(file_path), strict=False)
    if reader.is_encrypted:
        try:
            unlocked = reader.decrypt("")
        except Exception as error:
            raise ValueError("Encrypted PDF could not be opened locally") from error
        if not unlocked:
            raise ValueError("Encrypted PDF requires a password; Atlas did not inspect its pages")
    total_pages = len(reader.pages)
    inspected_pages = min(total_pages, MAX_PDF_PAGES)
    pages = []
    image_only_pages = []
    empty_or_vector_pages = []
    text_layer_page_count = 0
    total_text_characters = 0
    for index in range(inspected_pages):
        page = reader.pages[index]
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        text = text.strip()
        text_characters = len(text)
        total_text_characters += text_characters
        image_count = pdf_page_image_count(page)
        if text_characters:
            status = "text_layer"
            text_layer_page_count += 1
        elif image_count:
            status = "image_only"
            image_only_pages.append(index + 1)
        else:
            status = "empty_or_vector"
            empty_or_vector_pages.append(index + 1)
        pages.append({
            "page": index + 1,
            "status": status,
            "text_characters": text_characters,
            "image_count": image_count,
            "text": budget.take(text, 1200),
        })
    return {
        "kind": "pdf",
        "status": "partial" if total_pages > inspected_pages or budget.truncated else "complete",
        "page_count": total_pages,
        "inspected_page_count": inspected_pages,
        "text_layer_page_count": text_layer_page_count,
        "total_text_characters": total_text_characters,
        "image_only_pages": image_only_pages,
        "empty_or_vector_pages": empty_or_vector_pages,
        "pages": pages,
        "ocr_used": False,
        "limits": {"maximum_pages": MAX_PDF_PAGES},
    }
