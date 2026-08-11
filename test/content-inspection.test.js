import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve('.');
const tempRoot = path.join(projectRoot, 'test', '.tmp', 'content-inspection');
const cliPath = path.join(projectRoot, 'bin', 'atlas.js');
const managedPython = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Atlas',
  'python',
  'venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const pythonPath = process.env.ATLAS_TEST_PYTHON
  ?? (fs.existsSync(managedPython) ? managedPython : null);

function createWorkbook(target) {
  const script = String.raw`
import sys, zipfile
target = sys.argv[1]
parts = {
  "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>""",
  "xl/workbook.xml": """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="月度运营" sheetId="1" r:id="rId1"/><sheet name="素材库" sheetId="2" state="hidden" r:id="rId2"/></sheets>
</workbook>""",
  "xl/_rels/workbook.xml.rels": """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>""",
  "xl/worksheets/sheet1.xml": """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:D3"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>活动</t></is></c><c r="B1" t="inlineStr"><is><t>排期与文案</t></is></c><c r="D1" t="inlineStr"><is><t>联系方式</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Campaign A</t></is></c><c r="B2" t="inlineStr"><is><t>2026-07</t></is></c><c r="C2"><f>CONCAT("Linked","In")</f><v>LinkedIn</v></c><c r="D2" t="inlineStr"><is><t>13800138000</t></is></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Campaign A</t></is></c><c r="B3" t="inlineStr"><is><t>2026-07</t></is></c><c r="C3" t="inlineStr"><is><t>LinkedIn</t></is></c><c r="D3" t="inlineStr"><is><t>13800138000</t></is></c></row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="B1:C1"/></mergeCells>
</worksheet>""",
  "xl/worksheets/sheet2.xml": """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A2"/>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>素材库</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>模板</t></is></c></row>
  </sheetData>
</worksheet>""",
}
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, content in parts.items():
        archive.writestr(name, content)
`;
  const result = spawnSync(pythonPath, ['-c', script, target], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

function createPdf(target) {
  const script = String.raw`
import sys
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

writer = PdfWriter()
page = writer.add_blank_page(width=612, height=792)
font = DictionaryObject({
    NameObject('/Type'): NameObject('/Font'),
    NameObject('/Subtype'): NameObject('/Type1'),
    NameObject('/BaseFont'): NameObject('/Helvetica'),
})
font_ref = writer._add_object(font)
page[NameObject('/Resources')] = DictionaryObject({
    NameObject('/Font'): DictionaryObject({NameObject('/F1'): font_ref})
})
content = DecodedStreamObject()
content.set_data(b'BT /F1 12 Tf 72 720 Td (Local PDF text layer) Tj ET')
page[NameObject('/Contents')] = writer._add_object(content)

image_page = writer.add_blank_page(width=612, height=792)
image = DecodedStreamObject()
image.set_data(bytes([128]))
image.update({
    NameObject('/Type'): NameObject('/XObject'),
    NameObject('/Subtype'): NameObject('/Image'),
    NameObject('/Width'): NumberObject(1),
    NameObject('/Height'): NumberObject(1),
    NameObject('/ColorSpace'): NameObject('/DeviceGray'),
    NameObject('/BitsPerComponent'): NumberObject(8),
})
image_ref = writer._add_object(image)
image_page[NameObject('/Resources')] = DictionaryObject({
    NameObject('/XObject'): DictionaryObject({NameObject('/Im0'): image_ref})
})
with open(sys.argv[1], 'wb') as stream:
    writer.write(stream)
`;
  const result = spawnSync(pythonPath, ['-c', script, target], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

function createPresentation(target) {
  const script = String.raw`
import sys, zipfile
target = sys.argv[1]
parts = {
  "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>""",
  "ppt/slides/slide1.xml": """<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Quarterly campaign summary</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>""",
  "ppt/notesSlides/notesSlide1.xml": """<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Internal speaker note</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>""",
}
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, content in parts.items():
        archive.writestr(name, content)
`;
  const result = spawnSync(pythonPath, ['-c', script, target], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

function invoke(stateDir, ...args) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ATLAS_STATE_DIR: stateDir,
      ATLAS_PYTHON: pythonPath,
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

test('content inspect reads workbook structure locally without browser, Office, or screenshots', {
  skip: pythonPath ? false : `No local Python is available on ${os.platform()}.`,
}, () => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  const stateDir = path.join(tempRoot, 'state');
  const workbook = path.join(tempRoot, '运营总表.xlsx');
  createWorkbook(workbook);

  const first = invoke(
    stateDir,
    'content', 'inspect',
    '--file', workbook,
    '--purpose', 'structure',
    '--sheet', '月度运营',
  );
  assert.equal(first.schema, 'atlas.content-inspection.v1');
  assert.equal(first.cache_hit, false);
  assert.equal(first.processor.language, 'python');
  assert.equal(first.processor.browser_used, false);
  assert.equal(first.processor.external_application_used, false);
  assert.equal(first.attention.screenshots_used, 0);
  assert.equal(first.extraction.kind, 'xlsx');
  assert.equal(first.extraction.sheet_count, 2);
  assert.deepEqual(first.extraction.sheets.map((sheet) => sheet.name), ['月度运营']);
  assert.deepEqual(first.extraction.sheets[0].merged_ranges, ['B1:C1']);
  assert.equal(first.extraction.sheets[0].formula_count, 1);
  assert.deepEqual(
    first.extraction.sheets[0].header_rows[0].cells.map((cell) => cell.value),
    ['活动', '排期与文案', '联系方式'],
  );
  assert.doesNotMatch(JSON.stringify(first), /13800138000/);
  assert.equal(first.next_action.mode, 'use_local_extraction');

  const overview = invoke(
    stateDir,
    'content', 'inspect',
    '--file', workbook,
    '--purpose', 'structure',
  );
  assert.equal(overview.extraction.hidden_sheet_count, 1);
  assert.equal(overview.extraction.sheets[1].visibility, 'hidden');

  const second = invoke(
    stateDir,
    'content', 'inspect',
    '--file', workbook,
    '--purpose', 'structure',
    '--sheet', '月度运营',
  );
  assert.equal(second.cache_hit, true);
  assert.equal(second.source.sha256, first.source.sha256);
  assert.equal(second.inspection_id, first.inspection_id);
  assert.equal(fs.existsSync(path.join(stateDir, 'ledger.sqlite')), false);
});

test('content inspect profiles one workbook sheet with Pandas and SQL without returning row values', {
  skip: pythonPath ? false : `No local Python is available on ${os.platform()}.`,
}, () => {
  fs.mkdirSync(tempRoot, { recursive: true });
  const stateDir = path.join(tempRoot, 'data-state');
  const workbook = path.join(tempRoot, '运营数据.xlsx');
  createWorkbook(workbook);

  const profile = invoke(
    stateDir,
    'content', 'inspect',
    '--file', workbook,
    '--purpose', 'data',
    '--sheet', '月度运营',
  );
  assert.equal(profile.extraction.kind, 'tabular_profile');
  assert.equal(profile.extraction.engine, 'pandas+sqlite');
  assert.equal(profile.extraction.sheet, '月度运营');
  assert.equal(profile.extraction.row_count, 2);
  assert.equal(profile.extraction.duplicate_row_count, 1);
  assert.equal(profile.extraction.cross_check.status, 'pass');
  assert.equal(profile.extraction.sensitive_columns[0].column, '联系方式');
  assert.equal(profile.extraction.formula_count, 1);
  assert.doesNotMatch(JSON.stringify(profile), /13800138000/);
  assert.equal(profile.attention.screenshots_used, 0);
  assert.equal(profile.processor.browser_used, false);
});

test('content inspect extracts PDF text locally and identifies image-only pages without screenshots', {
  skip: pythonPath ? false : `No local Python is available on ${os.platform()}.`,
}, () => {
  fs.mkdirSync(tempRoot, { recursive: true });
  const stateDir = path.join(tempRoot, 'pdf-state');
  const pdf = path.join(tempRoot, 'local-source.pdf');
  createPdf(pdf);

  const result = invoke(
    stateDir,
    'content', 'inspect',
    '--file', pdf,
    '--purpose', 'content',
  );
  assert.equal(result.extraction.kind, 'pdf');
  assert.equal(result.extraction.page_count, 2);
  assert.equal(result.extraction.text_layer_page_count, 1);
  assert.deepEqual(result.extraction.image_only_pages, [2]);
  assert.match(result.extraction.pages[0].text, /Local PDF text layer/);
  assert.equal(result.extraction.pages[0].text_characters, 20);
  assert.equal(result.extraction.pages[1].status, 'image_only');
  assert.equal(result.attention.screenshots_used, 0);
  assert.equal(result.processor.browser_used, false);
  assert.equal(result.next_action.mode, 'use_local_extraction_with_gaps');
});

test('content inspect extracts presentation text before recommending any visual preview', {
  skip: pythonPath ? false : `No local Python is available on ${os.platform()}.`,
}, () => {
  fs.mkdirSync(tempRoot, { recursive: true });
  const stateDir = path.join(tempRoot, 'ppt-state');
  const presentation = path.join(tempRoot, 'report.pptx');
  createPresentation(presentation);

  const content = invoke(
    stateDir,
    'content', 'inspect',
    '--file', presentation,
    '--purpose', 'content',
  );
  assert.equal(content.extraction.kind, 'pptx');
  assert.equal(content.extraction.slide_count, 1);
  assert.match(content.extraction.slides[0].text, /Quarterly campaign summary/);
  assert.match(content.extraction.slides[0].notes, /Internal speaker note/);
  assert.equal(content.next_action.mode, 'use_local_extraction');
  assert.equal(content.attention.screenshots_used, 0);

  const visual = invoke(
    stateDir,
    'content', 'inspect',
    '--file', presentation,
    '--purpose', 'visual',
  );
  assert.equal(visual.next_action.mode, 'bounded_visual_preview');
  assert.equal(visual.next_action.visual_budget.maximum_images, 4);
  assert.equal(visual.next_action.visual_budget.maximum_resolution, '640x360');
  assert.equal(visual.attention.screenshots_used, 0);
  assert.equal(visual.processor.external_application_used, false);
});

test('content compare uses Python to identify JSONL containment and new messages without returning bodies', {
  skip: pythonPath ? false : `No local Python is available on ${os.platform()}.`,
}, () => {
  fs.mkdirSync(tempRoot, { recursive: true });
  const stateDir = path.join(tempRoot, 'relationship-state');
  fs.rmSync(stateDir, { recursive: true, force: true });
  const older = path.join(tempRoot, '聊天记录-旧.jsonl');
  const newer = path.join(tempRoot, '聊天记录-新.jsonl');
  const rewritten = path.join(tempRoot, '聊天记录-同ID改写.jsonl');
  const independentLeft = path.join(tempRoot, '独立-A.md');
  const independentRight = path.join(tempRoot, '独立-B.md');
  const records = [
    { message_id: 'm1', timestamp: '2026-05-01T10:00:00Z', role: 'user', content: 'first' },
    { message_id: 'm2', timestamp: '2026-05-02T10:00:00Z', role: 'assistant', content: 'second' },
    { message_id: 'm3', timestamp: '2026-05-03T10:00:00Z', role: 'user', content: 'third' },
  ];
  fs.writeFileSync(older, `${records.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  fs.writeFileSync(newer, `${[...records, {
    message_id: 'm4', timestamp: '2026-07-01T10:00:00Z', role: 'assistant', content: 'new period',
  }].map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  fs.writeFileSync(rewritten, `${records.map((item) => JSON.stringify(
    item.message_id === 'm2' ? { ...item, content: 'rewritten second' } : item,
  )).join('\n')}\n`, 'utf8');
  fs.writeFileSync(independentLeft, 'alpha\nbeta\n', 'utf8');
  fs.writeFileSync(independentRight, 'gamma\ndelta\n', 'utf8');

  const first = invoke(
    stateDir,
    'content', 'compare',
    '--left', older,
    '--right', newer,
  );
  assert.equal(first.schema, 'atlas.content-relationship.v1');
  assert.equal(first.relation.type, 'left_contained_by_right');
  assert.equal(first.relation.basis, 'message_id_subset');
  assert.equal(first.evidence.shared_message_id_count, 3);
  assert.deepEqual(first.evidence.right_new_message_ids, ['m4']);
  assert.equal(first.coverage.left.start, '2026-05-01T10:00:00+00:00');
  assert.equal(first.coverage.right.end, '2026-07-01T10:00:00+00:00');
  assert.equal(first.attention.screenshots_used, 0);
  assert.equal(first.processor.language, 'python');
  assert.doesNotMatch(JSON.stringify(first), /new period|first|second|third/);
  assert.equal(first.cache_hit, false);

  const second = invoke(
    stateDir,
    'content', 'compare',
    '--left', older,
    '--right', newer,
  );
  assert.equal(second.cache_hit, true);
  assert.equal(second.relationship_id, first.relationship_id);

  const changed = invoke(
    stateDir,
    'content', 'compare',
    '--left', older,
    '--right', rewritten,
  );
  assert.equal(changed.relation.type, 'overlap');
  assert.equal(changed.relation.basis, 'message_id_intersection_with_changed_content');
  assert.deepEqual(changed.evidence.changed_message_ids, ['m2']);
  assert.doesNotMatch(JSON.stringify(changed), /rewritten second/);

  const identical = invoke(
    stateDir,
    'content', 'compare',
    '--left', older,
    '--right', older,
  );
  assert.equal(identical.relation.type, 'identical');
  assert.equal(identical.relation.basis, 'sha256');

  const independent = invoke(
    stateDir,
    'content', 'compare',
    '--left', independentLeft,
    '--right', independentRight,
  );
  assert.equal(independent.relation.type, 'independent');
  assert.equal(independent.relation.semantic_claim, false);
  assert.equal(fs.existsSync(path.join(stateDir, 'ledger.sqlite')), false);
});

test('content branches builds one local prefix tree and avoids repeated branch records', {
  skip: pythonPath ? false : `No local Python is available on ${os.platform()}.`,
}, () => {
  fs.mkdirSync(tempRoot, { recursive: true });
  const stateDir = path.join(tempRoot, 'branch-state');
  fs.rmSync(stateDir, { recursive: true, force: true });
  const files = ['branch-a.jsonl', 'branch-b.jsonl', 'branch-c.jsonl']
    .map((name) => path.join(tempRoot, name));
  const record = (messageId, content, parentMessageId = null) => ({
    schema: 'atlas.chat-message.v1',
    conversation_id: 'source-specific',
    message_id: messageId,
    parent_message_id: parentMessageId,
    timestamp: '2026-08-03T00:00:00Z',
    role: messageId.startsWith('u') ? 'user' : 'assistant',
    content,
    source_url: `https://example.com/${messageId}`,
  });
  const common = [record('u1', 'question'), record('a1', 'answer', 'u1')];
  const sharedPair = record('u2', 'follow-up', 'a1');
  const branches = [
    [...common, sharedPair, record('a2', 'branch A', 'u2')],
    [...common, sharedPair, record('a3', 'branch B', 'u2')],
    [...common, record('u3', 'branch C', 'a1')],
  ];
  for (const [index, filePath] of files.entries()) {
    fs.writeFileSync(filePath, `${branches[index].map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  }

  const first = invoke(
    stateDir,
    'content', 'branches',
    ...files.flatMap((filePath) => ['--file', filePath]),
  );
  assert.equal(first.schema, 'atlas.chat-branch-set.v1');
  assert.equal(first.relation.type, 'branched_conversation');
  assert.equal(first.evidence.source_count, 3);
  assert.equal(first.evidence.input_record_count, 11);
  assert.equal(first.evidence.deduplicated_record_count, 6);
  assert.equal(first.evidence.duplicate_records_avoided, 5);
  assert.equal(first.segments[0].record_count, 2);
  assert.deepEqual(first.sources[0].segment_chain.slice(0, 2), first.sources[1].segment_chain.slice(0, 2));
  assert.notDeepEqual(first.sources[0].segment_chain, first.sources[2].segment_chain);
  assert.equal(first.attention.model_visible_body_bytes, 0);
  assert.equal(first.segments.every((segment) => fs.existsSync(segment.path)), true);
  assert.equal(JSON.stringify(first).includes('branch A'), false);
  assert.equal(first.cache_hit, false);

  const second = invoke(
    stateDir,
    'content', 'branches',
    ...files.flatMap((filePath) => ['--file', filePath]),
  );
  assert.equal(second.cache_hit, true);
  assert.equal(second.branch_set_id, first.branch_set_id);
});
