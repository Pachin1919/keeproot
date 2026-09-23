// Developer acceptance fixture, not an Atlas product capability. Never uses live user state.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'readback';
assert.ok(['prepare-v19-01', 'prepare-v19-02', 'prepare-v19-03', 'prepare-v19-04', 'readback', 'serve'].includes(mode), 'Use prepare-v19-01, prepare-v19-02, prepare-v19-03, prepare-v19-04, readback, or serve.');
const install = path.resolve(process.argv[3] ?? path.join(repo, 'test/.tmp/v19-01-installed'));
const temp = path.join(repo, 'test/.tmp');
assert.ok(install.startsWith(`${temp}${path.sep}`), 'Acceptance requires a separate installation inside repository test/.tmp.');
for (let item = install; item !== repo; item = path.dirname(item)) {
  assert.equal(fs.lstatSync(item).isSymbolicLink(), false, 'Acceptance installation cannot traverse a link.');
}

const runtime = path.join(install, 'runtime');
const stateDir = path.join(install, 'state');
const wrapper = path.join(install, 'atlas.cmd');
const receiptPath = path.join(install, 'v19-acceptance.json');
assert.ok(fs.existsSync(wrapper), 'Install an isolated Runtime before preparing acceptance.');

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
function cli(args, { failure = false } = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& ${quote(wrapper)} ${[...args, '--json'].map(quote).join(' ')}`], {
    cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  const envelope = JSON.parse(result.stdout);
  if (!failure) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(envelope.ok, true, result.stdout);
  }
  return { status: result.status, envelope };
}

const caller = ['--actor', 'agent', '--agent', 'V1.9 acceptance fixture', '--tool', 'Atlas acceptance fixture', '--model', 'fixture-not-a-model', '--client-run-id', 'v19-01-acceptance'];
const { Registry } = await import(pathToFileURL(path.join(runtime, 'src/registry.js')));

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (mode === 'prepare-v19-01') {
  const root = fs.mkdtempSync(path.join(temp, 'v19-01-acceptance-'));
  const workspace = path.join(root, 'workspace');
  const projectName = path.basename(root);
  const projectDir = path.join(workspace, projectName);
  for (const folder of ['Tables', 'Results']) fs.mkdirSync(path.join(projectDir, folder), { recursive: true });
  const sourcePaths = [];
  const currentSourcePaths = [];
  for (let index = 1; index <= 6; index += 1) {
    const first = index * 2 - 1;
    const second = index * 2;
    const alternate = index === 2;
    const header = alternate ? 'id,source,amount,status' : 'order_id,channel,revenue,status';
    const rows = [
      `${first},Search,${first === 5 ? '' : first * 10},paid`,
      `${second},Social,${second * 10},paid`,
    ];
    if (index === 1) rows.push(rows[0]);
    const sourcePath = path.join(projectDir, 'Tables', `orders-${index}.csv`);
    fs.writeFileSync(sourcePath, `${header}\n${rows.join('\n')}\n`, 'utf8');
    sourcePaths.push(sourcePath);
    const currentRows = rows.map((row, rowIndex) => {
      const cells = row.split(',');
      cells[0] = String(100 + index * 10 + rowIndex);
      if (cells[2]) cells[2] = String(Number(cells[2]) + 1000);
      return cells.join(',');
    });
    const currentSourcePath = path.join(projectDir, 'Tables', `current-orders-${index}.csv`);
    fs.writeFileSync(currentSourcePath, `${header}\n${currentRows.join('\n')}\n`, 'utf8');
    currentSourcePaths.push(currentSourcePath);
  }

  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const project = registry.create({ name: `V1.9 Reuse ${projectName.slice(-6)}`, currentPath: projectName });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: projectName, reason: 'Isolated V19-01 acceptance sample; no real user data.' });
  registry.dispose();

  const requestFile = (name, value) => {
    const target = path.join(root, name);
    fs.writeFileSync(target, JSON.stringify(value, null, 2), 'utf8');
    return target;
  };
  const host = (args, options) => cli([...args, ...caller], options);
  let oldWork = host(['table-work', 'start', '--project', project.project_id, ...sourcePaths.flatMap((sourcePath) => ['--source', sourcePath]), '--intent', 'Normalize and combine six order tables for reuse.']).envelope.data;
  oldWork = host(['table-work', 'prepare', oldWork.session_id, '--base-revision', String(oldWork.revision)]).envelope.data;
  const canonical = new Map([['id', 'order_id'], ['source', 'channel'], ['amount', 'revenue']]);
  const mapping = oldWork.sources.flatMap((source) => source.profile.profile.fields.map((field) => ({
    source_key: source.source_key,
    column: field.name,
    canonical: canonical.get(field.name) ?? field.name,
  })));
  oldWork = host(['table-work', 'align', oldWork.session_id, '--request-file', requestFile('mapping.json', { mapping }), '--base-revision', String(oldWork.revision)]).envelope.data;
  const recipeRequest = {
    combine: 'concatenate',
    source_column: true,
    source_column_name: '__source',
    cast_column: 'revenue',
    cast_type: 'number',
    fill_column: 'revenue',
    fill_value: '0',
    deduplicate_columns: 'order_id',
    sort_column: 'order_id',
    sort_direction: 'asc',
    rename_column: 'revenue',
    rename_to: 'amount',
  };
  oldWork = host(['table-work', 'recipe', oldWork.session_id, '--request-file', requestFile('recipe.json', recipeRequest), '--base-revision', String(oldWork.revision)]).envelope.data;
  oldWork = host(['table-work', 'preview', oldWork.session_id, '--base-revision', String(oldWork.revision)]).envelope.data;
  const oldSave = host(['table-work', 'save', oldWork.session_id, '--folder', 'Results', '--file-name', 'old-result.csv', '--format', 'csv', '--base-revision', String(oldWork.revision), '--request-key', `v19-01-old-result-${oldWork.session_id}`, '--reason', 'Isolated V19-01 acceptance save.']).envelope.data;
  const oldBeforeReuse = host(['table-work', 'show', oldWork.session_id]).envelope.data;
  const oldResultHash = fileSha256(oldSave.result_path);

  const reuseRequest = {
    sources: oldBeforeReuse.sources.map((source, index) => ({ source_key: source.source_key, source: currentSourcePaths[index], sheet: source.sheet })),
  };
  let newWork = host(['table-work', 'reuse', oldWork.session_id, '--base-revision', String(oldBeforeReuse.revision), '--request-file', requestFile('reuse-sources.json', reuseRequest), '--intent', 'Reuse the six-table normalization with this run\'s six Sources.']).envelope.data;
  assert.equal(newWork.reused_from_session_id, oldWork.session_id);
  assert.equal(newWork.revision, 1);
  assert.equal(newWork.preview, null);
  assert.equal(newWork.latest_save_id, null);
  assert.deepEqual(newWork.sources.map((item) => item.source_key), oldBeforeReuse.sources.map((item) => item.source_key));
  assert.deepEqual(newWork.recipe, oldBeforeReuse.recipe);
  assert.equal(newWork.sources.every((item) => item.status === 'pending'), true);
  assert.equal(newWork.sources.every((item, index) => item.resource_id !== oldBeforeReuse.sources[index].resource_id), true);
  newWork = host(['table-work', 'prepare', newWork.session_id, '--base-revision', String(newWork.revision)]).envelope.data;
  assert.equal(newWork.sources.every((item) => item.status === 'ready'), true);
  assert.equal(newWork.mapping_complete, true);
  assert.deepEqual(newWork.mapping.map(({ source_key, column, canonical }) => ({ source_key, column, canonical })), oldBeforeReuse.mapping.map(({ source_key, column, canonical }) => ({ source_key, column, canonical })));
  assert.equal(newWork.mapping.every((item) => currentSourcePaths.some((sourcePath) => item.source_sha256 === fileSha256(sourcePath))), true);
  newWork = host(['table-work', 'preview', newWork.session_id, '--base-revision', String(newWork.revision)]).envelope.data;
  const newSave = host(['table-work', 'save', newWork.session_id, '--folder', 'Results', '--file-name', 'reused-result.csv', '--format', 'csv', '--base-revision', String(newWork.revision), '--request-key', `v19-01-reused-result-${newWork.session_id}`, '--reason', 'Isolated V19-01 acceptance save.']).envelope.data;

  const oldAfterReuse = host(['table-work', 'show', oldWork.session_id]).envelope.data;
  assert.equal(oldAfterReuse.revision, oldBeforeReuse.revision);
  assert.equal(oldAfterReuse.latest_save_id, oldBeforeReuse.latest_save_id);
  assert.deepEqual(oldAfterReuse.mapping, oldBeforeReuse.mapping);
  assert.deepEqual(oldAfterReuse.recipe, oldBeforeReuse.recipe);
  assert.equal(fileSha256(oldSave.result_path), oldResultHash);
  assert.notEqual(newSave.result_path, oldSave.result_path);
  assert.equal(fs.existsSync(oldSave.result_path), true);
  assert.equal(fs.existsSync(newSave.result_path), true);

  const listBeforeStale = host(['table-work', 'list', '--project', project.project_id]).envelope.data;
  const stale = host(['table-work', 'reuse', oldWork.session_id, '--base-revision', String(oldBeforeReuse.revision - 1)], { failure: true });
  assert.notEqual(stale.status, 0);
  assert.equal(stale.envelope.error.code, 'ATLAS_STATE_CONFLICT');
  const listAfterStale = host(['table-work', 'list', '--project', project.project_id]).envelope.data;
  assert.equal(listAfterStale.total, listBeforeStale.total);

  const receipt = {
    slice: 'V19-01',
    install,
    stateDir,
    root,
    project_id: project.project_id,
    project_dir: projectDir,
    source_paths: currentSourcePaths,
    old_source_paths: sourcePaths,
    source_resource_id: oldAfterReuse.sources[0].resource_id,
    old_work_id: oldWork.session_id,
    old_work_revision: oldAfterReuse.revision,
    old_save_id: oldSave.save_id,
    old_result_path: oldSave.result_path,
    old_result_sha256: oldResultHash,
    new_work_id: newWork.session_id,
    new_work_revision: newWork.revision,
    new_save_id: newSave.save_id,
    new_result_path: newSave.result_path,
    new_result_sha256: fileSha256(newSave.result_path),
    work_total: listAfterStale.total,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, receipt: receiptPath, ...receipt }, null, 2));
} else if (mode === 'prepare-v19-02') {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const host = (args, options) => cli([...args, ...caller], options);
  const requestFile = (name, value) => {
    const target = path.join(receipt.root, name);
    fs.writeFileSync(target, JSON.stringify(value, null, 2), 'utf8');
    return target;
  };
  const changedPaths = receipt.source_paths.slice(0, 2);
  const beforeSourceHashes = changedPaths.map(fileSha256);
  const reusedResultHash = fileSha256(receipt.new_result_path);
  fs.appendFileSync(changedPaths[0], '131,Direct,1130,paid\n', 'utf8');
  fs.appendFileSync(changedPaths[1], '141,Referral,1140,paid\n', 'utf8');
  const changedSourceHashes = changedPaths.map(fileSha256);
  changedSourceHashes.forEach((hash, index) => assert.notEqual(hash, beforeSourceHashes[index]));

  const detected = host(['table-work', 'show', receipt.new_work_id]).envelope.data;
  const changedSources = changedPaths.map((changedPath) => detected.sources.find((item) => item.file_path === changedPath));
  assert.equal(changedSources.every((item) => item?.status === 'changed'), true);
  assert.equal(changedSources.every((item) => item?.reconciliation.kind === 'changed'), true);
  changedSources.forEach((item, index) => {
    assert.equal(item.reconciliation.recorded.sha256, beforeSourceHashes[index]);
    assert.equal(item.reconciliation.current.sha256, changedSourceHashes[index]);
  });
  assert.equal(detected.freshness.status, 'needs_review');
  assert.equal(detected.change_review.status, 'needs_review');
  assert.equal(detected.change_review.counts.total, 2);
  assert.equal(detected.change_review.items.length, 2);
  assert.equal(detected.change_review.items.every((item) => item.before?.values?.length && item.after?.values?.length), true);
  assert.match(detected.change_review.note, /Hash.*not a backup/iu);
  const batchRequest = requestFile('v19-02-source-keys.json', { source_keys: changedSources.map((item) => item.source_key) });

  const pinned = host(['table-work', 'reconcile-batch', detected.session_id, '--request-file', batchRequest, '--decision', 'pin-recorded', '--base-revision', String(detected.revision)]).envelope.data;
  assert.equal(pinned.revision, detected.revision + 1);
  assert.equal(changedSources.every((source) => pinned.sources.find((item) => item.source_key === source.source_key).version_policy === 'pinned_version'), true);
  assert.deepEqual(pinned.recipe, detected.recipe);
  assert.deepEqual(pinned.mapping, detected.mapping);
  const pinnedReadback = host(['table-work', 'show', pinned.session_id]).envelope.data;
  assert.equal(pinnedReadback.latest_result.freshness.version_policy, 'mixed');
  assert.equal(pinnedReadback.latest_result.freshness.output_status, 'verified');
  assert.equal(fileSha256(receipt.new_result_path), reusedResultHash);

  const following = host(['table-work', 'reconcile-batch', pinned.session_id, '--request-file', batchRequest, '--decision', 'follow-latest', '--base-revision', String(pinned.revision)]).envelope.data;
  assert.equal(following.revision, pinned.revision + 1);
  assert.equal(changedSources.every((source) => following.sources.find((item) => item.source_key === source.source_key).version_policy === 'follow_latest'), true);
  const adopted = host(['table-work', 'reconcile-batch', following.session_id, '--request-file', batchRequest, '--decision', 'use-current', '--base-revision', String(following.revision)]).envelope.data;
  assert.equal(adopted.revision, following.revision + 1);
  changedSources.forEach((source, index) => assert.equal(adopted.sources.find((item) => item.source_key === source.source_key).fingerprint.sha256, changedSourceHashes[index]));
  assert.equal(adopted.mapping_complete, true);
  assert.equal(adopted.mapping.filter((item) => changedSources.some((source) => source.source_key === item.source_key)).every((item) => changedSourceHashes.includes(item.source_sha256)), true);
  assert.equal(adopted.preview, null);

  const previewed = host(['table-work', 'preview', adopted.session_id, '--base-revision', String(adopted.revision)]).envelope.data;
  const reconciledSave = host(['table-work', 'save', previewed.session_id, '--folder', 'Results', '--file-name', 'reconciled-result.csv', '--format', 'csv', '--base-revision', String(previewed.revision), '--request-key', `v19-02-reconciled-result-${previewed.session_id}`, '--reason', 'Isolated V19-02 acceptance save after explicit Source adoption.']).envelope.data;
  assert.equal(fileSha256(receipt.new_result_path), reusedResultHash);
  assert.notEqual(reconciledSave.result_path, receipt.new_result_path);

  const nextReceipt = {
    ...receipt,
    slice: 'V19-02',
    changed_source_path: changedPaths[0],
    changed_source_paths: changedPaths,
    recorded_source_sha256: beforeSourceHashes[0],
    recorded_source_sha256s: beforeSourceHashes,
    changed_source_sha256: changedSourceHashes[0],
    changed_source_sha256s: changedSourceHashes,
    detected_revision: detected.revision,
    pinned_revision: pinned.revision,
    adopted_revision: adopted.revision,
    reconciled_save_id: reconciledSave.save_id,
    reconciled_result_path: reconciledSave.result_path,
    reconciled_result_sha256: fileSha256(reconciledSave.result_path),
    prior_reused_result_sha256: reusedResultHash,
    reconciled_at: new Date().toISOString(),
  };
  fs.writeFileSync(receiptPath, JSON.stringify(nextReceipt, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, receipt: receiptPath, ...nextReceipt }, null, 2));
} else if (mode === 'prepare-v19-03') {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const host = (args, options) => cli([...args, ...caller], options);
  const before = host(['table-work', 'show', receipt.new_work_id]).envelope.data;
  const changedSourcePath = receipt.changed_source_path ?? receipt.source_paths[0];
  const source = before.sources.find((item) => path.resolve(item.file_path) === path.resolve(changedSourcePath));
  assert.ok(source?.resource_id && source?.fingerprint?.sha256);
  const currentRows = fs.readFileSync(changedSourcePath, 'utf8').trim().split(/\r?\n/u);
  const maxOrderId = Math.max(
    ...currentRows.slice(1).map((line) => Number(line.split(',')[0])).filter(Number.isFinite),
  );
  const nextOrderId = maxOrderId + 1;
  fs.appendFileSync(changedSourcePath, `${nextOrderId},Affiliate,${nextOrderId * 10},paid\n`, 'utf8');
  const impacted = cli(['resource', 'show', source.resource_id, '--project', receipt.project_id]).envelope.data;
  const needsReview = impacted.impact_lanes.find((item) => item.work.session_id === receipt.new_work_id);
  assert.equal(needsReview.source.resource_id, source.resource_id);
  assert.equal(needsReview.source.change_state, 'changed');
  assert.equal(needsReview.impact.status, 'needs_review');
  assert.equal(needsReview.results.some((item) => item.output_state === 'verified'), true);
  assert.equal(needsReview.actions.open_work, `/work/${receipt.new_work_id}`);
  assert.ok(needsReview.actions.open_result);

  const detected = host(['table-work', 'show', receipt.new_work_id]).envelope.data;
  const detectedSource = detected.sources.find((item) => item.resource_id === source.resource_id);
  const pinned = host(['table-work', 'reconcile', detected.session_id, '--source-key', detectedSource.source_key, '--decision', 'pin-recorded', '--base-revision', String(detected.revision)]).envelope.data;
  const containedReadback = cli(['resource', 'show', source.resource_id, '--project', receipt.project_id]).envelope.data;
  const contained = containedReadback.impact_lanes.find((item) => item.work.session_id === receipt.new_work_id);
  assert.equal(contained.source.version_policy, 'pinned_version');
  assert.equal(contained.impact.status, 'contained');
  assert.equal(contained.results.some((item) => item.output_state === 'verified'), true);

  const nextReceipt = {
    ...receipt,
    slice: 'V19-03',
    impact_resource_id: source.resource_id,
    impact_work_id: receipt.new_work_id,
    impact_detected_revision: detected.revision,
    impact_pinned_revision: pinned.revision,
    impact_lane_count: containedReadback.impact_lanes.length,
    impact_status_before_pin: needsReview.impact.status,
    impact_status_after_pin: contained.impact.status,
    impact_result_save_id: contained.results[0]?.save_id ?? null,
    impact_verified_at: new Date().toISOString(),
  };
  fs.writeFileSync(receiptPath, JSON.stringify(nextReceipt, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, receipt: receiptPath, ...nextReceipt }, null, 2));
} else if (mode === 'prepare-v19-04') {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const host = (args, options) => cli([...args, ...caller], options);
  const researchDir = path.join(receipt.project_dir, 'Research');
  const imagesDir = path.join(receipt.project_dir, 'Images');
  const deliveryDir = path.join(receipt.project_dir, 'Delivery');
  for (const folder of [researchDir, imagesDir, deliveryDir]) fs.mkdirSync(folder, { recursive: true });
  const briefPath = path.join(researchDir, 'brief.md');
  const imagePath = path.join(imagesDir, 'reference.png');
  fs.writeFileSync(briefPath, '# V1.9 acceptance brief\n\nSix source tables were reused without changing the original Work or Result.\n', 'utf8');
  fs.copyFileSync(path.join(runtime, 'src/ui/assets/pachin-seal.png'), imagePath);

  const { createResourceControl } = await import(pathToFileURL(path.join(runtime, 'src/resource-control.js')));
  const registry = new Registry({ stateDir });
  const control = createResourceControl({ stateDir, ledger: registry.ledger });
  const project = { id: receipt.project_id };
  const brief = control.identify({ filePath: briefPath, project });
  const image = control.identify({ filePath: imagePath, project });
  control.dispose();
  registry.dispose();

  const created = host(['board', 'create', '--project', receipt.project_id, '--title', 'V1.9 Portable Delivery']).envelope.data;
  const boardRequestPath = path.join(receipt.root, 'v19-04-board.json');
  fs.writeFileSync(boardRequestPath, JSON.stringify({
    title: 'V1.9 Portable Delivery',
    blocks: [
      { type: 'text', text: 'This portable Board carries the selected research, image, and verified table Result.' },
      { type: 'material_reference', resource_id: brief.resource_id, version_policy: 'follow_latest' },
      { type: 'material_reference', resource_id: image.resource_id, version_policy: 'pinned_version' },
      { type: 'result_preview', save_id: receipt.impact_result_save_id ?? receipt.reconciled_save_id, version_policy: 'pinned_version' },
    ],
  }, null, 2), 'utf8');
  const saved = host(['board', 'save', created.board_id, '--project', receipt.project_id, '--base-revision', String(created.revision), '--request-file', boardRequestPath]).envelope.data;
  const shown = host(['board', 'show', saved.board_id, '--project', receipt.project_id]).envelope.data;
  assert.equal(shown.board_id, created.board_id);
  assert.equal(shown.revision, saved.revision);
  assert.deepEqual(shown.blocks.map((block) => block.type), ['text', 'material_reference', 'material_reference', 'result_preview']);
  assert.equal(shown.blocks.every((block) => block.status === 'fresh'), true);
  assert.equal(shown.blocks[1].preview?.kind, 'text');
  assert.match(shown.blocks[1].preview?.content ?? '', /Six source tables/u);
  assert.equal(shown.blocks[2].preview?.kind, 'image');
  assert.match(shown.blocks[2].preview?.content ?? '', new RegExp(`/projects/${receipt.project_id}/boards/${saved.board_id}/blocks/`, 'u'));
  assert.equal(shown.blocks[3].preview?.kind, 'table');
  assert.ok(shown.blocks[3].preview?.content?.columns?.length > 0);
  assert.ok(shown.blocks[3].preview?.content?.rows?.length > 0);

  const editedRequestPath = path.join(receipt.root, 'v19-04-board-edited.json');
  const reorderedBlocks = [shown.blocks[2], { ...shown.blocks[0], text: 'Edited Board summary with the selected image first.' }, shown.blocks[1], shown.blocks[3]];
  fs.writeFileSync(editedRequestPath, JSON.stringify({ title: shown.title, blocks: reorderedBlocks }, null, 2), 'utf8');
  const edited = host(['board', 'save', saved.board_id, '--project', receipt.project_id, '--base-revision', String(saved.revision), '--request-file', editedRequestPath]).envelope.data;
  assert.equal(edited.revision, saved.revision + 1);
  assert.deepEqual(edited.blocks.map((block) => block.block_id), reorderedBlocks.map((block) => block.block_id));
  assert.equal(edited.blocks[0].recorded_sha256, shown.blocks[2].recorded_sha256);
  const boardReferenceReadback = cli(['resource', 'show', brief.resource_id, '--project', receipt.project_id]).envelope.data;
  assert.equal(boardReferenceReadback.board_references.some((item) => item.board_id === saved.board_id), true);

  const relativeTarget = 'Delivery/v19-portable-board.html';
  const targetPath = path.join(receipt.project_dir, ...relativeTarget.split('/'));
  assert.equal(fs.existsSync(targetPath), false);
  const prepared = host(['board', 'export', saved.board_id, '--project', receipt.project_id, '--base-revision', String(edited.revision), '--target', relativeTarget, '--request-key', `v19-04-portable-${saved.board_id}`]).envelope.data;
  assert.equal(prepared.status, 'prepared');
  assert.equal(fs.existsSync(targetPath), false);
  const executed = cli(['save', 'execute', prepared.save_id, '--reason', 'Approved isolated V19-04 portable Board delivery.']).envelope.data;
  assert.equal(executed.status, 'executed');
  const portableHtml = fs.readFileSync(targetPath, 'utf8');
  assert.match(portableHtml, /V1\.9 Portable Delivery/u);
  assert.match(portableHtml, /brief\.md/u);
  assert.match(portableHtml, /reference\.png/u);
  assert.match(portableHtml, /Selected Result/u);
  assert.match(portableHtml, /<table>/u);
  assert.match(portableHtml, /Edited Board summary/u);
  assert.match(portableHtml, /data:[^;]+;base64,/u);
  assert.match(portableHtml, /Missing or not included/u);
  const portableHash = fileSha256(targetPath);
  const undone = cli(['save', 'undo', prepared.save_id]).envelope.data;
  assert.equal(undone.status, 'undone');
  assert.equal(fs.existsSync(targetPath), false);
  const redone = cli(['save', 'redo', prepared.save_id]).envelope.data;
  assert.equal(redone.status, 'executed');
  assert.equal(fileSha256(targetPath), portableHash);

  const nextReceipt = {
    ...receipt,
    slice: 'V19-04',
    board_id: saved.board_id,
    board_revision: edited.revision,
    board_block_count: shown.blocks.length,
    board_brief_resource_id: brief.resource_id,
    board_image_resource_id: image.resource_id,
    board_result_save_id: receipt.impact_result_save_id ?? receipt.reconciled_save_id,
    portable_save_id: prepared.save_id,
    portable_result_path: targetPath,
    portable_result_sha256: portableHash,
    portable_recovery_status: redone.status,
    portable_verified_at: new Date().toISOString(),
  };
  fs.writeFileSync(receiptPath, JSON.stringify(nextReceipt, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, receipt: receiptPath, ...nextReceipt }, null, 2));
} else {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (mode === 'readback') {
    const oldWork = cli(['table-work', 'show', receipt.old_work_id]).envelope.data;
    const newWork = cli(['table-work', 'show', receipt.new_work_id]).envelope.data;
    const listed = cli(['table-work', 'list', '--project', receipt.project_id]).envelope.data;
    console.log(JSON.stringify({
      ok: true,
      old_work: { session_id: oldWork.session_id, revision: oldWork.revision, latest_save_id: oldWork.latest_save_id, recipe: oldWork.recipe, freshness: oldWork.freshness },
      new_work: { session_id: newWork.session_id, revision: newWork.revision, latest_save_id: newWork.latest_save_id, reused_from_session_id: newWork.reused_from_session_id, recipe: newWork.recipe, freshness: newWork.freshness },
      old_result: { path: receipt.old_result_path, sha256: fileSha256(receipt.old_result_path) },
      new_result: { path: receipt.new_result_path, sha256: fileSha256(receipt.new_result_path) },
      board: receipt.board_id ? cli(['board', 'show', receipt.board_id, '--project', receipt.project_id]).envelope.data : null,
      portable_result: receipt.portable_result_path ? { path: receipt.portable_result_path, sha256: fileSha256(receipt.portable_result_path) } : null,
      listed,
    }, null, 2));
  } else {
    const { Intake } = await import(pathToFileURL(path.join(runtime, 'src/intake.js')));
    const { startAtlasUiServer } = await import(pathToFileURL(path.join(runtime, 'src/ui-server.js')));
    const registry = new Registry({ stateDir });
    const intake = new Intake({ stateDir });
    const server = await startAtlasUiServer({ stateDir, registry, intake, rules: {}, runtime: {}, projectRoot: runtime, installationRoot: install });
    console.log(JSON.stringify({
      home: `${server.workspace_url}projects/${receipt.project_id}`,
      resource: `${server.workspace_url}projects/${receipt.project_id}/resources?resource_id=${receipt.source_resource_id}`,
      old_work: `${server.workspace_url}work/${receipt.old_work_id}`,
      new_work: `${server.workspace_url}work/${receipt.new_work_id}`,
      board: receipt.board_id ? `${server.workspace_url}projects/${receipt.project_id}/boards/${receipt.board_id}` : null,
      board_save: receipt.portable_save_id ? `${server.workspace_url}saves/${receipt.portable_save_id}` : null,
      receipt: receiptPath,
    }, null, 2));
    process.on('SIGINT', async () => { await server.close(); intake.dispose(); registry.dispose(); process.exit(0); });
  }
}
