import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPathInside, normalizeStateDir } from '../src/paths.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonKeys = ['ATLAS_CONTENT_PYTHON', 'ATLAS_TEST_PYTHON', 'ATLAS_PYTHON', 'ATLAS_DESKTOP_PYTHON'];
function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`A regular, unlinked file is required: ${file}`);
  return file;
}

// A command wrapper around the existing demo and Runtime CLI, with no service assembly.
export function isolationCommand({ repositoryRoot = repo, mode, installRoot, stateDir, python, demoId, testFiles = [], namePattern }, environment = process.env) {
  const root = fs.realpathSync.native(path.resolve(repositoryRoot));
  const env = { ...environment };
  delete env.ATLAS_HOME; delete env.ATLAS_STATE_DIR;
  for (const key of pythonKeys) delete env[key];
  env.PIP_CACHE_DIR = path.join(root, '.atlas/cache/pip');
  let args;
  if (mode === 'demo' || mode === 'tests') {
    if (!python) throw Error('Source demo/tests require an explicit trusted --python path.');
    const selected = regularFile(path.resolve(python));
    env.ATLAS_CONTENT_PYTHON = selected; env.ATLAS_TEST_PYTHON = selected; env.ATLAS_PYTHON = selected;
    if (mode === 'demo') {
      args = [path.join(root, 'scripts/demo.js'), '--python', selected];
      if (demoId) {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(demoId)) throw Error('Use the UUID printed by the existing demo.');
        args.push('--resume', demoId);
      }
      args.push('--serve');
    } else {
      if (!testFiles.length) throw Error('Name the directly affected test files; no default full suite.');
      const files = testFiles.map(input => {
        const file = path.resolve(root, input);
        if (!isPathInside(path.join(root, 'test'), file) || !file.endsWith('.test.js')) throw Error('Only named repository test files are supported.');
        normalizeStateDir(root, path.dirname(file));
        return regularFile(file);
      });
      args = ['--test', '--test-concurrency=1', '--test-timeout=30000'];
      if (namePattern) args.push(`--test-name-pattern=${namePattern}`);
      args.push(...files);
    }
  } else if (mode === 'installed-ui' || mode === 'doctor') {
    if (!installRoot) throw Error('Name the isolated --install-root under repository test/.tmp.');
    const install = path.resolve(root, installRoot), tmp = path.join(root, 'test/.tmp');
    if (!isPathInside(tmp, install) || install === tmp) throw Error('Development installations must be isolated under test/.tmp.');
    normalizeStateDir(root, install);
    const manifestFile = regularFile(path.join(install, 'atlas-install.json'));
    if (fs.statSync(manifestFile).size > 16 * 1024) throw Error('Installation manifest is too large.');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const runtime = path.join(install, 'runtime');
    if (manifest.install_format !== 'atlas-runtime-install.v1' || path.resolve(manifest.runtime_path ?? '') !== runtime) throw Error('Installation manifest and Runtime root do not match.');
    normalizeStateDir(install, runtime);
    const selectedState = normalizeStateDir(runtime, path.resolve(stateDir ?? manifest.state_path), install);
    env.ATLAS_HOME = install; env.ATLAS_STATE_DIR = selectedState;
    if (python) throw Error('Installed checks use managed Python; do not override it with --python.');
    args = [regularFile(path.join(runtime, 'bin/atlas.js')), ...(mode === 'doctor' ? ['doctor', '--json'] : ['ui', '--no-open', '--port', '0', '--json'])];
  } else throw Error('Mode must be demo, tests, installed-ui, or doctor.');
  return { cwd: root, command: process.execPath, args, env };
}

async function main() {
  const input = { testFiles: [], modules: [] };
  const values = new Map([['--mode','mode'],['--python','python'],['--install-root','installRoot'],['--state','stateDir'],['--demo-id','demoId'],['--name-pattern','namePattern'],['--timeout-ms','timeoutMs']]);
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) {
    console.log('Atlas development isolation: --mode demo|tests|installed-ui|doctor; --python <trusted 3.11+> for source; --demo-id <UUID> to reopen; --install-root <test/.tmp/...> [--state <inside installation>]; --test <named test file> (repeatable) [--name-pattern <pattern>] [--require-python-module <module>] [--timeout-ms <budget>] [--print]. No external/native browser is opened.');
    return;
  }
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--print') input.print = true;
    else if (args[i] === '--test') input.testFiles.push(args[++i]);
    else if (args[i] === '--require-python-module') input.modules.push(args[++i]);
    else if (values.has(args[i])) input[values.get(args[i])] = args[++i];
    else throw Error(`Unknown development argument: ${args[i]}`);
  }
  const command = isolationCommand(input);
  if (input.print) {
    console.log(JSON.stringify({ mode: input.mode, cwd: command.cwd, args: command.args, state_dir: command.env.ATLAS_STATE_DIR ?? null, installation_root: command.env.ATLAS_HOME ?? null, content_python: command.env.ATLAS_CONTENT_PYTHON ?? 'managed', test_python: command.env.ATLAS_TEST_PYTHON ?? null }));
    return;
  }
  if (input.python) {
    const probe = spawnSync(input.python, ['--version'], { encoding:'utf8', windowsHide:true, timeout:15000 });
    const version = /Python (\d+)\.(\d+)/u.exec(`${probe.stdout ?? ''}\n${probe.stderr ?? ''}`);
    if (probe.status !== 0 || !version || Number(version[1]) < 3 || Number(version[1]) === 3 && Number(version[2]) < 11) throw Error('A trusted Python 3.11+ is required before starting the check.');
    for (const module of input.modules) {
      if (!/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/u.test(module ?? '')) throw Error('Use a Python module name.');
      const check = spawnSync(input.python, ['-c', `import importlib.util; raise SystemExit(0 if importlib.util.find_spec(${JSON.stringify(module)}) else 1)`], { encoding:'utf8', windowsHide:true, timeout:15000 });
      if (check.status !== 0) throw Error(`Selected Python is missing ${module}; use a verified isolation with this module. No test or UI was started.`);
    }
  }
  const timeout = input.timeoutMs === undefined ? (input.mode === 'tests' ? 120000 : input.mode === 'doctor' ? 45000 : 0) : Number(input.timeoutMs);
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 900000 || input.mode === 'tests' && timeout === 0) throw Error('Use an explicit process budget up to 900000ms; tests require a finite budget.');
  await new Promise((resolve,reject) => {
    const child = spawn(command.command, command.args, { cwd:command.cwd, env:command.env, stdio:'inherit', windowsHide:true });
    let timer, grace;
    const stop = () => { if (!grace) grace = setTimeout(() => child.kill('SIGTERM'), 1500); };
    process.once('SIGINT',stop); process.once('SIGTERM',stop);
    if (timeout) timer = setTimeout(() => { console.error('Development process budget exhausted; retain its evidence before another attempt.'); child.kill('SIGTERM'); },timeout);
    child.once('error',reject);
    child.once('close',code => { clearTimeout(timer); clearTimeout(grace); process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop); process.exitCode = code ?? 1; resolve(); });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode=1; });
