import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createSavedWorkService } from '../src/ui/services/saved-work-service.js';

test('untouched default and names without a suffix produce exactly one selected extension', () => {
  const root = fs.mkdtempSync(path.resolve('test/.tmp/filename-feedback-'));
  try {
    fs.mkdirSync(path.join(root, '02_成果'));
    const service = createSavedWorkService({ stateDir: path.join(root, 'state') });
    const destination = (fileName, outputExtension) => service.prepareDestination({
      projectRoot: root, folder: '02_成果', fileName, sourcePath: path.join(root, '本期.csv'), outputExtension,
    });
    assert.equal(path.basename(destination('work-result.xlsx', '.xlsx')), 'work-result.xlsx');
    assert.equal(path.basename(destination('我的成果', '.xlsx')), '我的成果.xlsx');
    assert.equal(path.basename(destination('work-result.csv', '.csv')), 'work-result.csv');
    assert.equal(path.basename(destination('我的成果', '.csv')), '我的成果.csv');
    assert.throws(() => destination('work-result.xlsx', '.csv'), /Use a file name ending in \.csv/u);
    fs.writeFileSync(path.join(root, '02_成果/work-result.xlsx'), 'existing');
    assert.throws(() => destination('work-result.xlsx', '.xlsx'), /already exists/u);
    assert.equal(fs.readFileSync(path.join(root, '02_成果/work-result.xlsx'), 'utf8'), 'existing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
