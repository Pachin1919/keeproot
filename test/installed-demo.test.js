import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { installRuntime } from '../src/runtime-install.js';
import { isPathInside } from '../src/paths.js';
import { prepareProductDemo, loadProductDemo, serveProductDemo } from '../scripts/demo.js';

let fixture;
function installedFixture() {
  if (fixture) return fixture;
  const python = process.env.ATLAS_TEST_PYTHON;
  assert.ok(python && fs.existsSync(python), 'verified Python is required for this delivery check');
  const directory = path.resolve('test/.tmp/v20-installed-demo-test');
  const installRoot = path.join(directory, 'installation');
  const skillRoot = path.join(directory, 'skill');
  const receipt = installRuntime({ sourceRoot: process.cwd(), installRoot, skillRoot, nodePath: process.execPath, operation: 'upgrade' });
  assert.ok(['installed', 'upgraded'].includes(receipt.status));
  const demo = prepareProductDemo({ python, installRoot });
  fs.writeFileSync(path.join(directory, `sample-${demo.demo_id}.json`), JSON.stringify(demo, null, 2));
  fixture = { python, directory, installRoot, receipt, demo };
  return fixture;
}

test('installed sample uses the actual installed CLI, retains isolated identities and reopens through its UI', async (t) => {
  const { python, installRoot, receipt, demo } = installedFixture();
  let session;
  t.after(async () => { if (session) await session.close(); });
  assert.ok(isPathInside(installRoot, demo.state_dir), 'installed mode cannot fall back to source state');
  assert.ok(isPathInside(installRoot, demo.workspace));
  assert.equal(demo.installation_root, installRoot);
  assert.equal(demo.runtime_sha256, receipt.runtime_sha256);
  const rows = fs.readFileSync(demo.result_path, 'utf8').replace(/^\uFEFF/u, '').trim().split(/\r?\n/u);
  assert.deepEqual(rows, ['id,region,amount', '1,北区,100', '2,南区,80', '3,北区,20']);
  const reopened = loadProductDemo(demo.demo_id, { installRoot });
  assert.equal(reopened.work_id, demo.work_id);
  assert.equal(reopened.result_resource_id, demo.result_resource_id);
  assert.equal(reopened.save_id, demo.save_id);
  session = await serveProductDemo(reopened, { python, installRoot });
  const page = await (await fetch(session.url)).text();
  assert.match(page, /Keeproot/u);
  assert.match(page, /金额合计200/u);
  const settings = await (await fetch(`${new URL(session.url).origin}/settings`)).text();
  assert.ok(settings.includes(receipt.runtime_sha256.slice(0, 12)), 'UI build must come from this installation');
  await session.close(); session = null;
  assert.ok(fs.existsSync(demo.result_path));
});

test('installed sample refuses a forged external or different-Board URL before serving it', async (t) => {
  const { python, installRoot, demo } = installedFixture();
  let unexpectedSession;
  t.after(async () => { if (unexpectedSession) await unexpectedSession.close(); });
  for (const board_href of ['https://example.test/unrequested', '/projects/PRJ-other/boards/BRD-other']) {
    await assert.rejects(async () => {
      unexpectedSession = await serveProductDemo({ ...demo, board_href }, { python, installRoot });
    }, /manifest|identity|match/u);
  }
});

test('installed sample refuses missing and linked installation roots without creating sample state', (t) => {
  const { python, directory, installRoot } = installedFixture();
  const missing = path.join(directory, 'not-installed');
  fs.mkdirSync(missing, { recursive: true });
  assert.throws(() => prepareProductDemo({ python, installRoot: missing }), /installation is unavailable/u);
  assert.equal(fs.existsSync(path.join(missing, 'state')), false);
  assert.equal(fs.existsSync(path.join(missing, 'demo-samples')), false);
  const linked = path.join(directory, `linked-${Date.now()}`);
  fs.symlinkSync(installRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.unlinkSync(linked));
  const before = fs.readdirSync(path.join(installRoot, 'state/demos')).sort();
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
  assert.throws(() => prepareProductDemo({ python, installRoot: linked }));
  assert.deepEqual(fs.readdirSync(path.join(installRoot, 'state/demos')).sort(), before);
});
