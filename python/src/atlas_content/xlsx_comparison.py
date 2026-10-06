"""Strict, explicitly selected XLSX rows; no formula evaluation or header inference."""
import re
import zipfile
from .common import validate_office_package, xml_root
from .xlsx_location import _parse_book, _worksheet_target, _raw_cell, _shared_strings, CELL_PATTERN
from .inspector import OFFICE_MAIN, column_index

MAX_INPUT_BYTES = 16 * 1024 * 1024

def read_selected_table(path, sheet_name):
    if not isinstance(sheet_name, str) or not sheet_name or len(sheet_name) > 31:
        raise ValueError('XLSX requires an exact selected sheet name of at most 31 characters.')
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError('XLSX comparison input exceeds 16 MiB.')
    with zipfile.ZipFile(path) as archive:
        validate_office_package(archive)
        members = [entry.filename for entry in archive.infolist()]
        if len(set(members)) != len(members):
            raise ValueError('Duplicate XLSX ZIP members are unsupported.')
        names, sheets, targets = _parse_book(archive)
        selected = [sheet for sheet in sheets if sheet.attrib['name'] == sheet_name]
        if len(selected) != 1:
            raise ValueError('Selected XLSX sheet does not exist.')
        sheet = selected[0]
        target, status = _worksheet_target(sheet, targets, names)
        if status != 'available':
            raise ValueError('Selected XLSX worksheet is unavailable or external.')
        root = xml_root(archive, target)
        if root.find(f'{{{OFFICE_MAIN}}}mergeCells') is not None:
            raise ValueError('Merged XLSX regions are unsupported for row comparison.')
        strings = _shared_strings(archive, names)
        physical = {}; coordinates = set()
        data = root.find(f'{{{OFFICE_MAIN}}}sheetData')
        if data is None:
            raise ValueError('Selected XLSX sheet requires a row 1 header.')
        for row in data.findall(f'{{{OFFICE_MAIN}}}row'):
            number = row.attrib.get('r', '')
            if not re.fullmatch(r'[1-9][0-9]*', number) or int(number) > 1048576 or int(number) in physical:
                raise ValueError('Invalid or duplicate XLSX row coordinate.')
            number = int(number); values = {}
            for cell in row.findall(f'{{{OFFICE_MAIN}}}c'):
                coordinate = cell.attrib.get('r', '')
                match = CELL_PATTERN.fullmatch(coordinate)
                if not match or int(match.group(2)) != number:
                    raise ValueError('Invalid XLSX cell coordinate or row mismatch.')
                coordinate = coordinate.upper()
                column = column_index(match.group(1).upper())
                if coordinate in coordinates or column >= 50:
                    raise ValueError('Duplicate XLSX cell coordinate or column exceeds 50.')
                coordinates.add(coordinate)
                value, cell_status, _, formula, _ = _raw_cell(cell, strings)
                if formula or cell_status in ('error', 'unavailable'):
                    raise ValueError('XLSX formulas, error cells and unavailable values are unsupported.')
                value = value or ''
                if len(value) > 1200:
                    raise ValueError('XLSX cell exceeds 1200 characters.')
                values[column] = value
            physical[number] = values
            if len(physical) > 10001:
                raise ValueError('XLSX comparison exceeds 10000 physical data rows.')
        header_cells = physical.get(1, {})
        width = max(header_cells, default=-1) + 1
        headers = [header_cells.get(i, '') for i in range(width)]
        if not headers or any(not value.strip() for value in headers) or len(set(headers)) != width:
            raise ValueError('XLSX row 1 requires unique non-empty contiguous headers.')
        rows = []; blank_rows = 0
        for number, values in sorted(physical.items()):
            if number == 1: continue
            if any(column >= width for column in values):
                raise ValueError('XLSX data cell falls outside the header columns.')
            # Only physically present entirely empty rows are excluded. Empty-key
            # rows containing any other value remain records and become uncertain.
            if not any(values.values()):
                blank_rows += 1; continue
            rows.append(dict(zip(headers, [values.get(i, '') for i in range(width)])))
        return headers, rows, {'name': sheet_name, 'visibility': sheet.attrib.get('state', 'visible')}, blank_rows
