"""Read-only pages from Node-captured bytes, never from a supplied path."""
import csv
import hashlib
import io
import re
import zipfile
from xml.etree import ElementTree as ET
from .common import validate_office_package, MAX_XML_MEMBER_BYTES
from .delimited import decode_delimited_bytes, detect_delimiter
from .docx_reader import _NoDoctypeBuilder
from .inspector import OFFICE_MAIN, OFFICE_REL, PACKAGE_REL, normalize_xlsx_target, column_index, column_label
from .xlsx_location import _raw_cell

MAX_BYTES = 20 * 1024 * 1024
MAX_ROWS = 10000
PAGE_ROWS = 50
MAX_COLUMNS = 50

def read_table_bytes(content, format, sheet=None, offset=0):
    if len(content) > MAX_BYTES or offset < 0 or offset >= MAX_ROWS or offset % PAGE_ROWS:
        raise ValueError('Invalid table reading size or page')
    warnings = set()
    rows = []
    columns = 0
    total = 0
    truncated = False
    sheets = []
    selected = None
    page_characters = 0

    def record(number, cells):
        nonlocal total, columns, truncated, page_characters
        if total >= MAX_ROWS:
            truncated = True
            return False
        if len(cells) > MAX_COLUMNS:
            warnings.add('columns_clipped')
        columns = max(columns, min(len(cells), MAX_COLUMNS))
        if offset <= total < offset + PAGE_ROWS:
            clipped = []
            for value in cells[:MAX_COLUMNS]:
                remaining = max(0, 200000 - page_characters)
                if len(value) > min(500, remaining):
                    warnings.add('cells_clipped')
                clipped.append(value[:min(500, remaining)])
                page_characters += len(clipped[-1])
            rows.append({'number': number, 'cells': clipped})
        total += 1
        return True

    if format in ('csv', 'tsv'):
        if sheet is not None:
            raise ValueError('Delimited text has no worksheet')
        text, encoding, warning = decode_delimited_bytes(content)
        delimiter, detection = detect_delimiter(text, '.' + format)
        if warning:
            warnings.add('decode_warning')
        parser = csv.reader(io.StringIO(text, newline=''), delimiter=delimiter, strict=True)
        for number, row in enumerate(parser, 1):
            if not record(number, row):
                break
        metadata = {'encoding': encoding, 'delimiter': delimiter, 'delimiter_detection': detection}
    elif format == 'xlsx':
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            validate_office_package(archive)
            names = [entry.filename for entry in archive.infolist()]
            if len(set(names)) != len(names):
                raise ValueError('Duplicate Office package entries')
            def xml(member):
                if archive.getinfo(member).file_size > MAX_XML_MEMBER_BYTES:
                    raise ValueError('Office XML exceeds limit')
                return ET.fromstring(archive.read(member), parser=ET.XMLParser(target=_NoDoctypeBuilder()))
            workbook = xml('xl/workbook.xml')
            rels = xml('xl/_rels/workbook.xml.rels')
            entries = workbook.findall(f'.//{{{OFFICE_MAIN}}}sheet')
            if not entries or len(entries) > 50:
                raise ValueError('Workbook requires 1 to 50 worksheets')
            sheets = [entry.get('name', '') for entry in entries]
            if any(not name for name in sheets) or len(set(sheets)) != len(sheets):
                raise ValueError('Worksheet names are ambiguous')
            selected = sheet if sheet is not None else sheets[0]
            if selected not in sheets:
                raise ValueError('Worksheet does not exist')
            entry = entries[sheets.index(selected)]
            if entry.get('state', 'visible') != 'visible':
                warnings.add('hidden_sheet')
            relations = [r for r in rels.findall(f'{{{PACKAGE_REL}}}Relationship') if r.get('Id') == entry.get(f'{{{OFFICE_REL}}}id')]
            if len(relations) != 1:
                raise ValueError('Worksheet relationship is ambiguous')
            relation = relations[0]
            target = normalize_xlsx_target(relation.get('Target', ''))
            if relation.get('TargetMode') == 'External' or not relation.get('Type', '').endswith('/worksheet') or not target.startswith('xl/') or target not in names:
                raise ValueError('External or missing worksheet is unsupported')
            strings = []
            string_characters = 0
            if 'xl/sharedStrings.xml' in names:
                for item in xml('xl/sharedStrings.xml').findall(f'{{{OFFICE_MAIN}}}si'):
                    value = ''.join(node.text or '' for node in item.iter(f'{{{OFFICE_MAIN}}}t'))
                    string_characters += len(value)
                    if len(strings) >= 100000 or string_characters > 8 * 1024 * 1024:
                        raise ValueError('Shared strings exceed bounded reading limit')
                    strings.append(value)
            worksheet = xml(target)
            if worksheet.find(f'{{{OFFICE_MAIN}}}mergeCells') is not None:
                warnings.add('merged_cells')
            prior_number = 0
            for row in worksheet.findall(f'{{{OFFICE_MAIN}}}sheetData/{{{OFFICE_MAIN}}}row'):
                number = int(row.get('r', '0'))
                if not prior_number < number <= 1048576:
                    raise ValueError('Invalid worksheet row')
                prior_number = number
                values = {}
                for cell in row.findall(f'{{{OFFICE_MAIN}}}c'):
                    coordinate = cell.get('r', '')
                    if not re.fullmatch(r'[A-Z]{1,3}[1-9][0-9]{0,6}', coordinate) or int(re.search(r'\d+', coordinate)[0]) != number:
                        raise ValueError('Invalid worksheet cell')
                    index = column_index(coordinate)
                    if index >= MAX_COLUMNS:
                        warnings.add('columns_clipped')
                        continue
                    if index in values:
                        raise ValueError('Duplicate worksheet cell')
                    value, status, formula, is_formula, _ = _raw_cell(cell, strings)
                    if status == 'unavailable':
                        raise ValueError('Invalid shared string reference')
                    if is_formula:
                        warnings.add('formula_cache')
                    values[index] = value if value is not None else '=' + (formula or '')
                width = max(values, default=-1) + 1
                if not record(number, [values.get(index, '') for index in range(width)]):
                    break
        metadata = {}
        warnings.add('raw_values')
    else:
        raise ValueError('Unsupported table format')
    if offset and offset >= total:
        raise ValueError('Page is outside the supported table rows')
    return {'schema': 'atlas.table-reader.v1', 'sha256': hashlib.sha256(content).hexdigest(),
            'format': format, 'sheets': sheets, 'sheet': selected, 'offset': offset,
            'total_rows': total, 'truncated': truncated, 'warnings': sorted(warnings),
            'columns': [column_label(index) for index in range(columns)], 'rows': rows, **metadata}
