import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createLocalModuleService } from '../src/local-module.js';

test('local package preview is non-executing and install is hash-bound and disabled by default', async (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve('test/.tmp'), 'local-module-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const sourcePath = path.join(root, 'package.json');
  const manifest = {
    module_id: 'local.example-transform',
    module_version: '1.0.0',
    adapter: 'text_transform_v1',
    permissions: ['node_full_account'],
    entry_source: "globalThis.localModulePreviewExecuted = true; export function transform(text) { return text.toUpperCase(); }",
  };
  fs.writeFileSync(sourcePath, JSON.stringify(manifest), 'utf8');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  const service = createLocalModuleService({ stateDir: path.join(root, 'state') });
  const preview = service.previewPackage({ filePath: sourcePath });
  assert.equal(preview.sha256, sha256);
  assert.equal(preview.module_id, manifest.module_id);
  assert.equal(preview.permissions[0], 'node_full_account');
  assert.equal(globalThis.localModulePreviewExecuted, undefined);
  const env = { ...process.env, ATLAS_STATE_DIR: path.join(root, 'state') };
  const cliPreview = spawnSync(process.execPath, ['bin/atlas.js', 'module', 'package-preview', '--file', sourcePath, '--json'], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(cliPreview.status, 0, cliPreview.stderr);
  assert.equal(JSON.parse(cliPreview.stdout).data.sha256, sha256);
  assert.equal(globalThis.localModulePreviewExecuted, undefined);
  const cliInstall = spawnSync(process.execPath, ['bin/atlas.js', 'module', 'install', '--file', sourcePath, '--expected-sha256', sha256, '--expected-revision', '0', '--request-key', 'install-1', '--json'], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(cliInstall.status, 0, cliInstall.stderr);
  const installed = JSON.parse(cliInstall.stdout).data;
  assert.equal(installed.enabled, false);
  assert.equal(service.list()[0].enabled, false);
  const replay = service.install({ filePath: sourcePath, expectedSha256: sha256, expectedRevision: 0, requestKey: 'install-1' });
  assert.equal(replay.replayed, true);
  assert.equal(service.revision(), 1);
  fs.writeFileSync(sourcePath, JSON.stringify({ ...manifest, entry_source: 'export function transform(text) { return `changed:${text}`; }' }), 'utf8');
  assert.throws(() => service.install({ filePath: sourcePath, expectedSha256: sha256, expectedRevision: 1, requestKey: 'install-changed' }), { code: 'ATLAS_STATE_CONFLICT' });
  assert.equal(service.list().length, 1);
  await assert.rejects(service.previewTransform({ moduleId: manifest.module_id, text: 'hello' }), { code: 'ATLAS_MODULE_DISABLED' });
  const enabled = service.setEnabled({ moduleId: manifest.module_id, enabled: true, expectedRevision: installed.revision, requestKey: 'enable-1' });
  assert.equal(enabled.enabled, true);
  assert.equal((await service.previewTransform({ moduleId: manifest.module_id, text: 'hello' })).output_text, 'HELLO');
  fs.writeFileSync(installed.package_path, 'tampered', 'utf8');
  await assert.rejects(service.previewTransform({ moduleId: manifest.module_id, text: 'hello' }), { code: /ATLAS_MODULE_PACKAGE_(?:INVALID|TAMPERED)/u });
});
