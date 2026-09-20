// Developer acceptance fixture, not an Atlas product capability. Never uses live user state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'serve';
assert.ok(['prepare', 'serve', 'readback'].includes(mode), 'Use prepare, serve, or readback.');
const install = path.resolve(process.argv[3] ?? path.join(repo, 'test/.tmp/host-closure-installed'));
const temp = path.join(repo, 'test/.tmp');
assert.ok(install.startsWith(`${temp}${path.sep}`), 'Acceptance requires a separate installation inside repository test/.tmp.');
for (let item = install; item !== repo; item = path.dirname(item)) {
  assert.equal(fs.lstatSync(item).isSymbolicLink(), false, 'Acceptance installation cannot traverse a link.');
}
const runtime = path.join(install, 'runtime');
const stateDir = path.join(install, 'state');
const receiptPath = path.join(install, 'v18-acceptance.json');
const wrapper = path.join(install, 'atlas.cmd');
assert.ok(fs.existsSync(wrapper), 'Install an isolated Runtime before preparing acceptance.');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function cli(args, { failure = false } = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& ${quote(wrapper)} ${[...args, '--json'].map(quote).join(' ')}`], { cwd: repo, encoding: 'utf8', windowsHide: true });
  const envelope = JSON.parse(result.stdout);
  if (!failure) { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(envelope.ok, true, result.stdout); }
  return envelope;
}
const metadata = ['--tool', 'Atlas acceptance fixture', '--model', 'fixture-not-a-model', '--client-run-id', 'v18-rc-acceptance'];
const { Registry } = await import(pathToFileURL(path.join(runtime, 'src/registry.js')));

if (mode === 'prepare') {
  const root = fs.mkdtempSync(path.join(temp, 'v18-acceptance-'));
  const workspace = path.join(root, 'workspace');
  const projectName = path.basename(root);
  const projectDir = path.join(workspace, projectName);
  for (const folder of ['Research', 'Images', 'Tables', 'Results']) fs.mkdirSync(path.join(projectDir, folder), { recursive: true });
  const notes = [
    ['01-local.md', '# Local-first tools\nThe source files remain on your own device.\n'],
    ['02-collaboration.md', '# Shared work\nA person reviews AI suggestions before they become file attributes.\n'],
    ['03-review.md', '# Review queue\nThis note discusses reading priorities, not project management.\n'],
  ];
  for (const [name, body] of notes) fs.writeFileSync(path.join(projectDir, 'Research', name), body);
  fs.copyFileSync(path.join(runtime, 'src/ui/assets/pachin-seal.png'), path.join(projectDir, 'Images/seal.png'));
  fs.writeFileSync(path.join(projectDir, 'Images/vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#55745c"/></svg>');
  const sources = [];
  for (let index = 1; index <= 5; index++) {
    const first = index * 2 - 1; const second = index * 2;
    const header = index === 2 ? 'id,source,amount,status' : 'order_id,channel,revenue,status';
    const rows = [`${first},Search,${index === 3 ? '' : first * 10},paid`, `${second},Social,${second * 10},paid`];
    if (index === 1) rows.push(rows[0]);
    const source = path.join(projectDir, `Tables/orders-${index}.csv`);
    fs.writeFileSync(source, `${header}\n${rows.join('\n')}\n`); sources.push(source);
  }
  const python = path.join(install, 'desktop-ui/venv/Scripts/python.exe');
  assert.ok(fs.existsSync(python), 'Install the Desktop/content component in the isolated Runtime first.');
  const workbook = path.join(projectDir, 'Tables/orders-6.xlsx');
  // Reuse Atlas's dependency-free XLSX writer; pandas ExcelWriter requires an
  // optional engine that the installed Runtime intentionally does not ship.
  const workbookScript = `import sys,zipfile
from pathlib import Path
sys.path.insert(0,sys.argv[2])
import pandas as pd
from atlas_content.data_work import _write_xlsx
output=Path(sys.argv[1])
_write_xlsx(pd.DataFrame({"order_id":[11,12],"channel":["Search","Social"],"revenue":[110,120],"status":["paid","paid"]}),output,"Orders")
with zipfile.ZipFile(output) as z: parts={name:z.read(name) for name in z.namelist()}
parts["xl/workbook.xml"]=parts["xl/workbook.xml"].replace(b'</sheets>',b'<sheet name="Notes" sheetId="2" r:id="rId2"/></sheets>')
parts["xl/_rels/workbook.xml.rels"]=parts["xl/_rels/workbook.xml.rels"].replace(b'</Relationships>',b'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
parts["[Content_Types].xml"]=parts["[Content_Types].xml"].replace(b'</Types>',b'<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
parts["xl/worksheets/sheet2.xml"]=b'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Choose Orders for the table workflow</t></is></c></row></sheetData></worksheet>'
with zipfile.ZipFile(output,"w",zipfile.ZIP_DEFLATED) as z:
 for name,body in parts.items(): z.writestr(name,body)
`;
  const generated = spawnSync(python, ['-c', workbookScript, workbook, path.join(runtime, 'python/src')], { encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr); sources.push(workbook);
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: `V1.8 Acceptance ${projectName.slice(-6)}`, currentPath: projectName });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: projectName, reason: 'Isolated acceptance sample; no real user data.' });
  registry.dispose();
  const request = (name, value) => { const target = path.join(root, name); fs.writeFileSync(target, JSON.stringify(value, null, 2)); return target; };
  const views = {};
  for (const [key, name, folder, viewMode] of [['research', 'Research review', 'Research', 'table'], ['images', 'Image materials', 'Images', 'cards'], ['tables', 'Six source tables', 'Tables', 'table']]) {
    views[key] = cli(['view', 'save', '--project', project.project_id, '--request-file', request(`${key}-view.json`, { name, mode: viewMode, config: { scope: { path: folder } } }), ...metadata]).data;
  }
  const research = cli(['view', 'evaluate', views.research.view_id, '--limit', '10']).data;
  const batch = cli(['view', 'candidates', 'submit', '--project', project.project_id, '--request-file', request('research-candidates.json', {
    scope: { view_id: views.research.view_id }, property: { name: 'Topic', kind: 'text' },
    candidates: research.members.map((member, index) => ({ resource_id: member.resource_id, source_version: member.fact_version, value: ['Local tools', 'AI collaboration', 'Project management'][index], evidence: 'Deliberate sample proposal; inspect the note title before accepting.' })),
  }), ...metadata]).data;
  const workCaller = ['--actor', 'agent', '--agent', 'Acceptance fixture', ...metadata];
  let work = cli(['table-work', 'start', '--project', project.project_id, ...sources.flatMap(source => ['--source', source]), '--intent', 'Combine six order tables, fill missing revenue with 0, remove repeated order_id, and preserve source names.', ...workCaller]).data;
  work = cli(['table-work', 'prepare', work.session_id, '--base-revision', String(work.revision), ...workCaller]).data;
  // Leave the workbook sheet and alignment for the independent user-side chain.
  const receipt = { version: '1.8.0-rc.1', root, install, stateDir, project_id: project.project_id, projectDir, views, batch_id: batch.batch_id, work_id: work.session_id, expected: { source_count: 6, raw_rows: 13, clean_rows: 12, output_columns: 5, missing_revenue_order_id: 5 }, created_at: new Date().toISOString() };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ok: true, receipt: receiptPath, project_id: receipt.project_id, work_id: receipt.work_id, expected: receipt.expected }, null, 2));
} else {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (mode === 'readback') {
    const work = cli(['table-work', 'show', receipt.work_id]).data;
    const candidates = cli(['view', 'candidates', 'show', receipt.batch_id, '--project', receipt.project_id]).data;
    const discovered = cli(['table-work', 'list', '--project', receipt.project_id]).data;
    console.log(JSON.stringify({
      project_id: receipt.project_id,
      work: { session_id: work.session_id, revision: work.revision, source_count: work.sources.length, recipe: work.recipe, latest_save_id: work.latest_save_id },
      candidates: candidates.candidates.map(item => ({ resource_name: item.resource_name, proposed_value: item.value, decision: item.decision?.action ?? null, current_value: item.current_value?.value ?? null, application_status: item.application_status, source_status: item.source_status })),
      discovered,
    }, null, 2));
  } else {
    const { Intake } = await import(pathToFileURL(path.join(runtime, 'src/intake.js')));
    const { startAtlasUiServer } = await import(pathToFileURL(path.join(runtime, 'src/ui-server.js')));
    const registry = new Registry({ stateDir }); const intake = new Intake({ stateDir });
    const server = await startAtlasUiServer({ stateDir, registry, intake, rules: {}, runtime: {}, projectRoot: runtime, installationRoot: install });
    console.log(JSON.stringify({ url: `${server.workspace_url}projects/${receipt.project_id}`, research: `${server.workspace_url}${receipt.views.research.desktop_href.slice(1)}`, images: `${server.workspace_url}${receipt.views.images.desktop_href.slice(1)}`, tables: `${server.workspace_url}${receipt.views.tables.desktop_href.slice(1)}`, work: `${server.workspace_url}work/${receipt.work_id}`, receipt: receiptPath }, null, 2));
    process.on('SIGINT', async () => { await server.close(); intake.dispose(); registry.dispose(); process.exit(0); });
  }
}
