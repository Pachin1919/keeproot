import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Bootstrap } from '../src/bootstrap.js';

const tempRoot = path.resolve('test', '.tmp');

function setup(name, directories = []) {
  const caseRoot = path.join(tempRoot, name);
  fs.rmSync(caseRoot, { recursive: true, force: true });
  const root = path.join(caseRoot, 'library');
  const stateDir = path.join(caseRoot, 'state');
  fs.mkdirSync(root, { recursive: true });
  for (const directory of directories) fs.mkdirSync(path.join(root, directory), { recursive: true });
  return { root, stateDir };
}

function open(t, stateDir) {
  const bootstrap = new Bootstrap({ stateDir });
  t.after(() => bootstrap.dispose());
  return bootstrap;
}

test('golden structure fixtures cover empty, English, Chinese, and disordered libraries with bounded questions', (t) => {
  const fixtures = [
    { name: 'empty', directories: [], expectedProfile: 'mixed-minimal', expected: {} },
    {
      name: 'english-project', directories: ['Inbox', 'Projects', 'Templates', 'Archive'],
      expectedProfile: 'project-work', expected: { inbox: 'Inbox', projects: 'Projects', templates: 'Templates', archive: 'Archive' },
    },
    {
      name: 'chinese-personal', directories: ['收件箱', '项目', '领域', '资料', '日记', '归档'],
      expectedProfile: 'personal-knowledge',
      expected: { inbox: '收件箱', projects: '项目', areas: '领域', resources: '资料', journal: '日记', archive: '归档' },
    },
    {
      name: 'disordered', directories: ['杂项', '临时旧文件', '项目'],
      expectedProfile: 'project-work', expected: { projects: '项目' },
    },
  ];
  for (const fixture of fixtures) {
    const { root, stateDir } = setup(`bootstrap-golden-${fixture.name}`, fixture.directories);
    const bootstrap = open(t, stateDir);
    const scan = bootstrap.scan({ root, scanMode: 'structure' });
    const contract = bootstrap.contract(scan.scan_id);
    assert.equal(contract.profile.id, fixture.expectedProfile, fixture.name);
    assert.ok(contract.questions.length <= 3, fixture.name);
    for (const [role, expectedPath] of Object.entries(fixture.expected)) {
      const mapping = contract.zones.find((item) => item.area_role === role);
      assert.equal(mapping?.current_path, expectedPath, `${fixture.name}:${role}`);
    }
    const expectedMapped = Object.keys(fixture.expected).length;
    const mapped = contract.zones.filter((item) => item.status === 'mapped').length;
    assert.equal(mapped, expectedMapped, `${fixture.name}: false-positive mapping`);
  }
});

test('metadata scan bounds Markdown extraction even when one file is very large', (t) => {
  const { root, stateDir } = setup('bootstrap-large-file');
  const large = path.join(root, 'large.md');
  fs.writeFileSync(large, `---\ntags: [large]\n---\n# Large\n${'x'.repeat(3 * 1024 * 1024)}`, 'utf8');
  const bootstrap = open(t, stateDir);
  const receipt = bootstrap.scan({ root, scanMode: 'metadata' });
  const entry = bootstrap.show(receipt.scan_id).entries.find((item) => item.path === 'large.md');
  assert.equal(entry.metadata.title, 'Large');
  assert.equal(entry.metadata.truncated, true);
  assert.ok(receipt.content_bytes_read < entry.byteSize * 2);
  assert.equal(receipt.content_bytes_read, entry.byteSize + (2 * 1024 * 1024));
});

for (const mutation of ['add', 'delete']) {
  test(`Bootstrap rejects a library where a path is ${mutation === 'add' ? 'added' : 'deleted'} during enumeration`, (t) => {
    const { root, stateDir } = setup(`bootstrap-enumeration-${mutation}`);
    fs.writeFileSync(path.join(root, 'baseline.md'), '# Baseline\n', 'utf8');
    if (mutation === 'delete') fs.writeFileSync(path.join(root, 'remove.md'), '# Remove\n', 'utf8');
    const bootstrap = open(t, stateDir);
    const originalRead = fs.readdirSync;
    let injected = false;
    fs.readdirSync = function mutateAfterEnumeration(directory, options) {
      const result = originalRead.call(this, directory, options);
      if (!injected && path.resolve(String(directory)) === path.resolve(root)) {
        injected = true;
        if (mutation === 'add') fs.writeFileSync(path.join(root, 'added.md'), '# Added\n', 'utf8');
        else fs.rmSync(path.join(root, 'remove.md'));
      }
      return result;
    };
    try {
      assert.throws(() => bootstrap.scan({ root, scanMode: 'structure' }), /changed while Bootstrap was scanning|Root changed/i);
    } finally {
      fs.readdirSync = originalRead;
    }
    assert.equal(injected, true);
    assert.deepEqual(bootstrap.status(), []);
  });
}
