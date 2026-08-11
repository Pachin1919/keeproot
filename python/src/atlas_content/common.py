from __future__ import annotations

import zipfile
from xml.etree import ElementTree as ET

MAX_ZIP_ENTRIES = 10_000
MAX_ZIP_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
MAX_XML_MEMBER_BYTES = 32 * 1024 * 1024


class CharacterBudget:
    def __init__(self, limit: int) -> None:
        if limit < 500 or limit > 20_000:
            raise ValueError("max_characters must be between 500 and 20000")
        self.limit = limit
        self.used = 0
        self.truncated = False

    def take(self, value: object, per_value: int = 500) -> str:
        text = "" if value is None else str(value)
        remaining = max(0, self.limit - self.used)
        allowed = min(per_value, remaining)
        if len(text) > allowed:
            self.truncated = True
        result = text[:allowed]
        self.used += len(result)
        return result


def xml_root(archive: zipfile.ZipFile, name: str) -> ET.Element:
    detail = archive.getinfo(name)
    if detail.file_size > MAX_XML_MEMBER_BYTES:
        raise ValueError(f"Office XML member exceeds the local extraction limit: {name}")
    with archive.open(name) as stream:
        return ET.parse(stream).getroot()


def zip_entry_names(archive: zipfile.ZipFile) -> set[str]:
    return {item.filename for item in archive.infolist()}


def validate_office_package(archive: zipfile.ZipFile) -> None:
    entries = archive.infolist()
    if len(entries) > MAX_ZIP_ENTRIES:
        raise ValueError("Office package contains too many entries for bounded local extraction")
    if sum(item.file_size for item in entries) > MAX_ZIP_UNCOMPRESSED_BYTES:
        raise ValueError("Office package exceeds the bounded uncompressed-size limit")
