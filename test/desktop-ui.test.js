import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  doctorDesktopUiComponent,
  removeDesktopUiComponent,
  startDesktopUi,
} from '../src/desktop-ui-component.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'bin', 'atlas.js');
const tempRoot = path.join(projectRoot, 'test', '.tmp', 'desktop-ui');

function clean(name) {
  const root = path.join(tempRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test('Desktop UI doctor reports a missing optional component without affecting file governance', () => {
  const installationRoot = clean('doctor-missing');
  const result = doctorDesktopUiComponent({ installationRoot, runtimeRoot: projectRoot });

  assert.equal(result.status, 'not_installed');
  assert.equal(result.installed, false);
  assert.equal(result.required_for_file_governance, false);
  assert.match(result.next_step, /atlas ui install/u);
});

test('Desktop UI start stops explicitly when the component is missing', async () => {
  const installationRoot = clean('start-missing');
  await assert.rejects(
    startDesktopUi({
      url: 'http://127.0.0.1:4318/',
      installationRoot,
      runtimeRoot: projectRoot,
    }),
    (error) => error.code === 'ATLAS_DESKTOP_UI_UNAVAILABLE'
      && /atlas ui install/u.test(error.message),
  );
});

test('Default atlas ui never falls back to a browser when the desktop component is missing', () => {
  const stateDir = path.join(clean('cli-no-fallback'), 'state');
  const result = spawnSync(process.execPath, [cliPath, 'ui', '--json'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ATLAS_HOME: projectRoot,
      ATLAS_STATE_DIR: stateDir,
      ATLAS_DESKTOP_PYTHON: '',
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });

  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'ATLAS_DESKTOP_UI_UNAVAILABLE');
  assert.match(payload.error.message, /atlas ui install/u);
});

test('Removing the Desktop UI keeps Atlas state', () => {
  const installationRoot = clean('remove-preserves-state');
  const componentRoot = path.join(installationRoot, 'desktop-ui');
  const stateFile = path.join(installationRoot, 'state', 'ledger.sqlite');
  fs.mkdirSync(componentRoot, { recursive: true });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(path.join(componentRoot, 'component.json'), '{}', 'utf8');
  fs.writeFileSync(stateFile, 'state', 'utf8');

  const result = removeDesktopUiComponent({ installationRoot });

  assert.equal(result.status, 'removed');
  assert.equal(result.node_governance_preserved, true);
  assert.equal(fs.existsSync(componentRoot), false);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), 'state');
});

test('Desktop client checks the requested picker method independently', async () => {
  const client = fs.readFileSync(path.join(projectRoot, 'src', 'ui', 'client.js'), 'utf8');
  const pickFiles = async () => ({ status: 'selected', queue_id: 'BQS-test' });
  let submitListener = null;
  let processingStatus = null;
  class FakeForm {
    constructor() { this.dataset = {}; this.attributes = {}; }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const context = {
    Date,
    HTMLFormElement: FakeForm,
    document: {
      body: { append: (item) => { processingStatus = item; } },
      createElement: () => ({ className: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
      addEventListener: (name, listener) => { if (name === 'submit') submitListener = listener; },
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    sessionStorage: { getItem: () => null, removeItem: () => {}, setItem: () => {} },
    window: { pywebview: { api: { pick_files: pickFiles } }, setTimeout },
  };
  vm.runInNewContext(client, context);

  const picker = await context.desktopPickerMethod('pick_files');

  assert.equal(typeof picker, 'function');
  assert.deepEqual(await picker(), { status: 'selected', queue_id: 'BQS-test' });
  const form = new FakeForm();
  submitListener({ target: form, submitter: { textContent: 'Inspect' }, preventDefault: () => assert.fail('first submit was stopped') });
  assert.equal(form.attributes['aria-busy'], 'true');
  assert.match(processingStatus.textContent, /Inspect.*working locally/u);
});
