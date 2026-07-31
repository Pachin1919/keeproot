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
  <sheets><sheet name="月度运营" sheetId="1" r:id="rId1"/><sheet name="素材库" sheetId="2" r:id="rId2"/></sheets>
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
    <row r="2"><c r="A2" t="inlineStr"><is><t>Campaign A</t></is></c><c r="B2" t="inlineStr"><is><t>2026-07</t></is></c><c r="C2" t="inlineStr"><is><t>LinkedIn</t></is></c><c r="D2" t="inlineStr"><is><t>13800138000</t></is></c></row>
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
  assert.deepEqual(
    first.extraction.sheets[0].header_rows[0].cells.map((cell) => cell.value),
    ['活动', '排期与文案', '联系方式'],
  );
  assert.doesNotMatch(JSON.stringify(first), /13800138000/);
  assert.equal(first.next_action.mode, 'use_local_extraction');

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
  assert.doesNotMatch(JSON.stringify(profile), /13800138000/);
  assert.equal(profile.attention.screenshots_used, 0);
  assert.equal(profile.processor.browser_used, false);
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
