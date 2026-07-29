import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  doctorAnalyticsComponent,
  installAnalyticsComponent,
  removeAnalyticsComponent,
} from '../src/analytics-component.js';

const tempRoot = path.resolve('test', '.tmp', 'analytics-component');

function managedPython(venvRoot) {
  return process.platform === 'win32'
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python');
}

test('optional analytics component installs, diagnoses, repeats, and removes independently', () => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  const installationRoot = path.join(tempRoot, 'installation');
  const runtimeRoot = path.join(installationRoot, 'runtime');
  const sourcePython = path.join(tempRoot, 'source-python.exe');
  fs.mkdirSync(path.join(runtimeRoot, 'python', 'src', 'atlas_analytics'), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'python', 'src', 'atlas_analytics', '__main__.py'), '', 'utf8');
  fs.writeFileSync(sourcePython, '', 'utf8');

  let venvCreates = 0;
  let dependencyInstalls = 0;
  const runProcess = (executable, args) => {
    if (executable === sourcePython && args[0] === '-m' && args[1] === 'venv') {
      venvCreates += 1;
      const target = managedPython(args[2]);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '', 'utf8');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === '-m' && args[1] === 'pip' && args[2] === 'install') {
      dependencyInstalls += 1;
      assert.equal(args.at(-1), 'pandas==3.0.1');
      return { status: 0, stdout: 'installed\n', stderr: '' };
    }
    if (args[0] === '--version') {
      return { status: 0, stdout: 'Python 3.12.4\n', stderr: '' };
    }
    if (args[0] === '-m' && args[1] === 'atlas_analytics' && args[2] === '--help') {
      return { status: 0, stdout: 'usage: atlas_analytics\n', stderr: '' };
    }
    if (args[0] === '-c' && args[1].includes('import json, pandas')) {
      return { status: 0, stdout: '{"pandas":"3.0.1"}\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected invocation' };
  };

  const installed = installAnalyticsComponent({
    installationRoot,
    runtimeRoot,
    sourcePython,
    runProcess,
  });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.runtime_network_access, false);
  assert.deepEqual(installed.dependencies, { pandas: '3.0.1' });
  assert.equal(venvCreates, 1);
  assert.equal(dependencyInstalls, 1);

  const diagnosed = doctorAnalyticsComponent({ installationRoot, runtimeRoot, runProcess });
  assert.equal(diagnosed.status, 'ready');
  assert.equal(diagnosed.mode, 'managed');
  assert.equal(diagnosed.python_version, '3.12.4');
  assert.deepEqual(diagnosed.dependencies, { pandas: '3.0.1' });

  const repeated = installAnalyticsComponent({
    installationRoot,
    runtimeRoot,
    sourcePython,
    runProcess,
  });
  assert.equal(repeated.status, 'already_installed');
  assert.equal(venvCreates, 1);
  assert.equal(dependencyInstalls, 1);

  const removed = removeAnalyticsComponent({ installationRoot });
  assert.equal(removed.status, 'removed');
  assert.equal(fs.existsSync(installed.python_path), false);
  assert.equal(
    doctorAnalyticsComponent({ installationRoot, runtimeRoot, runProcess }).status,
    'not_installed',
  );
});
