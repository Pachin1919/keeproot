import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Registry } from '../src/registry.js';
import { RoundRecovery } from '../src/round-recovery.js';
import { startAtlasUiServer } from '../src/ui-server.js';
import { writeUiPreferences } from '../src/ui/preferences.js';

test('timeline UI previews, rejects unreviewed or stale writes, restores and returns the same Host round', async (t) => {
  fs.mkdirSync('test/.tmp', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('test/.tmp/round-ui-'));
  const workspace = path.join(temp, 'workspace'); const root = path.join(workspace, 'P');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'plan.md'); fs.writeFileSync(file, 'before');
  const stateDir = path.join(temp, 'state'); const registry = new Registry({ stateDir });
  const recovery = new RoundRecovery({ stateDir, registry }); let server;
  t.after(async () => { if (server) await server.close(); recovery.dispose(); registry.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'bounded_content' });
  const projectId = registry.create({ name: 'P', currentPath: 'P' }).project_id;
  registry.attachRoot(projectId, { rootId: adopted.root_id, relativePath: 'P', reason: 'UI fixture' });
  const caller = { actor: 'agent', tool: 'Host-test', client_run_id: 'ui-round' };
  const first = recovery.protect({ projectId, paths: ['plan.md'], label: 'Revise workshop', requestKey: 'start', caller });
  fs.writeFileSync(file, 'after');
  writeUiPreferences(stateDir, { locale: 'zh-CN' });
  server = await startAtlasUiServer({ stateDir, registry, rules: {}, runtime: {} });
  const route = `${server.workspace_url}projects/${projectId}/rounds/${first.round_id}`;
  const page = await fetch(route); assert.equal(page.status, 200);
  const html = await page.text(); const csrf = html.match(/name="csrf" value="([^"]+)"/u)[1];
  const post = (data) => fetch(route, { method: 'POST', body: new URLSearchParams({ csrf, ...data }), redirect: 'manual' });
  const basis = () => { const r = recovery.show({ projectId, roundId: first.round_id }); return { base_revision: String(r.revision), expected_digest: r.current_digest, node_id: first.head_node_id }; };
  const unreviewed = await post({ action: 'restore', ...basis() });
  assert.equal(unreviewed.status, 409);
  const unreviewedHtml = await unreviewed.text();
  assert.match(unreviewedHtml, /Review this recovery again before confirming\./u);
  assert.match(unreviewedHtml, /<details[^>]*>[\s\S]*Review this recovery again before confirming\./u);
  assert.match(unreviewedHtml, /重新预览/u);
  assert.equal((await post({ action: 'preview_restore', ...basis(), csrf: 'bad' })).status, 403);
  const preview = async (action, extra = {}) => {
    const response = await post({ action, ...basis(), ...extra }); assert.equal(response.status, 200);
    const rendered = await response.text();
    const token = rendered.match(/name="preview_token" value="([^"]+)"/u)?.[1];
    assert.ok(token, `expected non-empty preview token for ${action}`);
    return token;
  };
  const staleToken = await preview('preview_restore');
  const staleBasis = basis();
  recovery.checkpoint({
    projectId,
    roundId: first.round_id,
    baseRevision: Number(staleBasis.base_revision),
    expectedDigest: staleBasis.expected_digest,
    label: 'Host checkpoint before restore confirmation',
    requestKey: 'checkpoint-before-stale-preview',
    caller,
  });
  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
  assert.equal((await post({ action: 'restore', preview_token: staleToken, ...staleBasis })).status, 409);
  assert.equal(fs.readFileSync(file, 'utf8'), 'after');
  fs.writeFileSync(file, 'later external');
  assert.equal((await post({ action: 'restore', preview_token: staleToken, ...basis() })).status, 409);
  assert.equal(fs.readFileSync(file, 'utf8'), 'later external');
  const token = await preview('preview_restore');
  assert.equal((await post({ action: 'restore', preview_token: token, ...basis() })).status, 303);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  const restored = recovery.show({ projectId, roundId: first.round_id });
  assert.equal(restored.round_id, first.round_id); assert.ok(restored.revision > first.revision);
  const firstRestoreId = restored.restores.at(-1).restore_id;
  const returnToken = await preview('preview_return', { restore_id: firstRestoreId });
  assert.equal((await post({ action: 'return', preview_token: returnToken, restore_id: firstRestoreId, ...basis() })).status, 303);
  assert.equal(fs.readFileSync(file, 'utf8'), 'later external');
  fs.writeFileSync(file, 'second external');
  const secondRestoreToken = await preview('preview_restore');
  assert.equal((await post({ action: 'restore', preview_token: secondRestoreToken, ...basis() })).status, 303);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  const afterSecondRestore = recovery.show({ projectId, roundId: first.round_id });
  const secondRestoreId = afterSecondRestore.restores.at(-1).restore_id;
  assert.notEqual(secondRestoreId, firstRestoreId);
  const earlierReturnToken = await preview('preview_return', { restore_id: firstRestoreId });
  assert.equal((await post({ action: 'return', preview_token: earlierReturnToken, restore_id: firstRestoreId, ...basis() })).status, 303);
  assert.equal(fs.readFileSync(file, 'utf8'), 'later external');
  const unavailable = await fetch(`${server.workspace_url}projects/OTHER/rounds/${first.round_id}`);
  assert.notEqual(unavailable.status, 200);
});
