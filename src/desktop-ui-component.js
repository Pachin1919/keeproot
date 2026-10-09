import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DESKTOP_UI_COMPONENT_FORMAT = 'atlas-desktop-ui-component.v1';
export const DESKTOP_UI_COMPONENT_VERSION = '0.2.1';
export const DESKTOP_UI_REQUIREMENTS = Object.freeze([
  'pywebview==6.2.1',
  'pandas==3.0.1',
  'pypdf==6.14.2',
  'pdfplumber==0.11.10',
]);
const MINIMUM_PYTHON = Object.freeze({ major: 3, minor: 11 });

function componentPaths(installationRootInput) {
  const installationRoot = path.resolve(installationRootInput);
  const componentRoot = path.join(installationRoot, 'desktop-ui');
  const venvRoot = path.join(componentRoot, 'venv');
  return {
    installationRoot,
    componentRoot,
    venvRoot,
    manifestPath: path.join(componentRoot, 'component.json'),
    pythonPath: process.platform === 'win32'
      ? path.join(venvRoot, 'Scripts', 'python.exe')
      : path.join(venvRoot, 'bin', 'python'),
  };
}

function pythonEnvironment(runtimeRoot, extra = {}) {
  return {
    ...process.env,
    ...extra,
    PYTHONPATH: [path.join(runtimeRoot, 'python', 'src'), process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
}

function runPython(executable, args, {
  runtimeRoot, runProcess = spawnSync, timeout = 60_000,
} = {}) {
  return runProcess(executable, args, {
    cwd: runtimeRoot,
    env: pythonEnvironment(runtimeRoot),
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function probePython(executable, options) {
  try {
    if (!fs.statSync(executable).isFile()) {
      return { status: 'unavailable', python_path: executable, message: 'Python path is not a file.' };
    }
  } catch (error) {
    return { status: 'unavailable', python_path: executable, message: error.message };
  }
  const result = runPython(executable, ['--version'], { ...options, timeout: 15_000 });
  if (result.error || result.status !== 0) {
    return {
      status: 'unavailable',
      python_path: executable,
      message: result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`,
    };
  }
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = text.match(/Python\s+(\d+)\.(\d+)\.(\d+)/u);
  if (!match) {
    return { status: 'unavailable', python_path: executable, message: 'Python version could not be parsed.' };
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  return {
    status: major > MINIMUM_PYTHON.major
      || (major === MINIMUM_PYTHON.major && minor >= MINIMUM_PYTHON.minor)
      ? 'ready'
      : 'old',
    python_path: path.resolve(executable),
    python_version: `${major}.${minor}.${patch}`,
  };
}

function probeModule(executable, options) {
  const result = runPython(executable, [
    '-c',
    [
      'import importlib.metadata as metadata',
      'import json',
      'import atlas_desktop',
      'import pandas',
      'import pypdf',
      'import pdfplumber',
      'import webview',
      'print(json.dumps({"pywebview": metadata.version("pywebview"), "pandas": metadata.version("pandas"), "pypdf": metadata.version("pypdf"), "pdfplumber": metadata.version("pdfplumber")}))',
    ].join('; '),
  ], { ...options, timeout: 20_000 });
  if (result.error || result.status !== 0) {
    return {
      status: 'unavailable',
      message: result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`,
    };
  }
  try {
    const dependencies = JSON.parse(result.stdout.trim());
    return { status: 'ready', dependencies };
  } catch (error) {
    return { status: 'unavailable', message: `Desktop UI dependency probe failed: ${error.message}` };
  }
}

function removeInside(target, parent) {
  const resolvedTarget = path.resolve(target);
  const resolvedParent = path.resolve(parent);
  const relative = path.relative(resolvedParent, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove an unverified Desktop UI path: ${resolvedTarget}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

export function doctorDesktopUiComponent({
  installationRoot,
  runtimeRoot,
  configuredPath = process.env.ATLAS_DESKTOP_PYTHON,
  runProcess = spawnSync,
} = {}) {
  const locations = componentPaths(installationRoot);
  const inspect = (pythonPath, mode, installed, componentVersion = DESKTOP_UI_COMPONENT_VERSION) => {
    const python = probePython(pythonPath, { runtimeRoot, runProcess });
    if (python.status !== 'ready') return { ...python, mode, installed };
    const module = probeModule(python.python_path, { runtimeRoot, runProcess });
    if (module.status !== 'ready') {
      return { ...module, mode, installed, python_path: python.python_path };
    }
    return {
      status: 'ready',
      mode,
      installed,
      component_version: componentVersion,
      python_path: python.python_path,
      python_version: python.python_version,
      dependencies: module.dependencies,
      ledger_access: false,
      library_access: false,
      transport: 'loopback_url_only',
      external_browser: false,
    };
  };

  if (fs.existsSync(locations.manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(locations.manifestPath, 'utf8'));
      if (manifest.component_format !== DESKTOP_UI_COMPONENT_FORMAT) {
        return { status: 'invalid', mode: 'managed', installed: true, message: 'Desktop UI manifest is incompatible.' };
      }
      if (manifest.component_version !== DESKTOP_UI_COMPONENT_VERSION) {
        return {
          status: 'upgrade_required',
          mode: 'managed',
          installed: true,
          component_version: manifest.component_version,
          required_component_version: DESKTOP_UI_COMPONENT_VERSION,
        };
      }
      return inspect(locations.pythonPath, 'managed', true, manifest.component_version);
    } catch (error) {
      return { status: 'invalid', mode: 'managed', installed: true, message: error.message };
    }
  }

  if (configuredPath) return inspect(path.resolve(configuredPath), 'external_override', false);

  return {
    status: 'not_installed',
    mode: 'managed',
    installed: false,
    required_for_file_governance: false,
    next_step: 'Run atlas ui install --python <python-3.11-or-newer>.',
  };
}

export function installDesktopUiComponent({
  installationRoot,
  runtimeRoot,
  sourcePython = process.env.ATLAS_DESKTOP_PYTHON,
  runProcess = spawnSync,
} = {}) {
  const locations = componentPaths(installationRoot);
  const current = doctorDesktopUiComponent({
    installationRoot, runtimeRoot, configuredPath: null, runProcess,
  });
  if (current.status === 'ready') return { ...current, status: 'already_installed' };
  const upgrading = current.status === 'upgrade_required';
  if (!upgrading && (fs.existsSync(locations.manifestPath) || fs.existsSync(locations.venvRoot))) {
    const error = new Error('Managed Desktop UI exists but is not healthy; remove it before reinstalling.');
    error.code = 'ATLAS_STATE_CONFLICT';
    throw error;
  }
  if (!sourcePython) {
    const error = new Error('ui install requires --python <python-3.11-or-newer> or ATLAS_DESKTOP_PYTHON.');
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  if (!fs.existsSync(path.join(runtimeRoot, 'python', 'src', 'atlas_desktop', '__main__.py'))) {
    throw new Error('Atlas Desktop UI Python source is missing from the Runtime.');
  }
  const source = path.resolve(sourcePython);
  const sourceProbe = probePython(source, { runtimeRoot, runProcess });
  if (sourceProbe.status !== 'ready') {
    const error = new Error(
      sourceProbe.status === 'old'
        ? `Atlas Desktop UI requires Python ${MINIMUM_PYTHON.major}.${MINIMUM_PYTHON.minor} or newer.`
        : `Python is unavailable: ${sourceProbe.message ?? source}`,
    );
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }

  fs.mkdirSync(locations.componentRoot, { recursive: true });
  if (fs.lstatSync(locations.componentRoot).isSymbolicLink()) {
    throw new Error(`Desktop UI component root cannot be a symbolic link: ${locations.componentRoot}`);
  }
  const stageVenv = path.join(locations.componentRoot, `.venv-stage-${crypto.randomUUID()}`);
  const backupVenv = path.join(locations.componentRoot, `.venv-backup-${crypto.randomUUID()}`);
  const previousManifest = upgrading ? fs.readFileSync(locations.manifestPath, 'utf8') : null;
  let previousVenvMoved = false;
  let stagedVenvInstalled = false;
  try {
    const created = runPython(source, ['-m', 'venv', stageVenv], {
      runtimeRoot, runProcess, timeout: 120_000,
    });
    if (created.error || created.status !== 0) {
      throw new Error(`Desktop UI environment creation failed: ${created.error?.message ?? created.stderr?.trim() ?? `exit ${created.status}`}`);
    }
    const stagedPython = process.platform === 'win32'
      ? path.join(stageVenv, 'Scripts', 'python.exe')
      : path.join(stageVenv, 'bin', 'python');
    const installed = runPython(stagedPython, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...DESKTOP_UI_REQUIREMENTS,
    ], { runtimeRoot, runProcess, timeout: 300_000 });
    if (installed.error || installed.status !== 0) {
      throw new Error(`Desktop UI dependency installation failed: ${installed.error?.message ?? installed.stderr?.trim() ?? `exit ${installed.status}`}`);
    }
    const verified = probeModule(stagedPython, { runtimeRoot, runProcess });
    if (verified.status !== 'ready') throw new Error(`Desktop UI validation failed: ${verified.message}`);
    if (upgrading) {
      fs.renameSync(locations.venvRoot, backupVenv);
      previousVenvMoved = true;
    }
    fs.renameSync(stageVenv, locations.venvRoot);
    stagedVenvInstalled = true;
    const manifest = {
      component_format: DESKTOP_UI_COMPONENT_FORMAT,
      component_version: DESKTOP_UI_COMPONENT_VERSION,
      python_version: sourceProbe.python_version,
      dependencies: verified.dependencies,
      installed_at: new Date().toISOString(),
      runtime_network_access: false,
      ledger_access: false,
      library_access: false,
    };
    fs.writeFileSync(locations.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (previousVenvMoved) removeInside(backupVenv, locations.componentRoot);
    return doctorDesktopUiComponent({
      installationRoot, runtimeRoot, configuredPath: null, runProcess,
    });
  } catch (error) {
    if (fs.existsSync(stageVenv)) removeInside(stageVenv, locations.componentRoot);
    if (upgrading) {
      if (stagedVenvInstalled && fs.existsSync(locations.venvRoot)) {
        removeInside(locations.venvRoot, locations.componentRoot);
      }
      if (previousVenvMoved && fs.existsSync(backupVenv)) {
        fs.renameSync(backupVenv, locations.venvRoot);
      }
      if (previousManifest !== null) fs.writeFileSync(locations.manifestPath, previousManifest, 'utf8');
    }
    if (!fs.existsSync(locations.venvRoot) && !fs.existsSync(locations.manifestPath)) {
      try {
        if (fs.readdirSync(locations.componentRoot).length === 0) fs.rmdirSync(locations.componentRoot);
      } catch {}
    }
    throw error;
  }
}

export function removeDesktopUiComponent({ installationRoot } = {}) {
  const locations = componentPaths(installationRoot);
  if (!fs.existsSync(locations.componentRoot)) {
    return { status: 'not_installed', component_root: locations.componentRoot };
  }
  removeInside(locations.componentRoot, locations.installationRoot);
  return {
    status: 'removed',
    component_root: locations.componentRoot,
    node_governance_preserved: true,
    state_preserved: true,
  };
}

export async function startDesktopUi({
  url,
  installationRoot,
  runtimeRoot,
  pickerRegistrationUrl,
  pickerToken,
  configuredPath = process.env.ATLAS_DESKTOP_PYTHON,
  spawnProcess = spawn,
  readyTimeoutMs = 15_000,
} = {}) {
  const capability = doctorDesktopUiComponent({ installationRoot, runtimeRoot, configuredPath });
  if (capability.status !== 'ready') {
    const error = new Error(
      capability.next_step
        ?? `Atlas Desktop UI is unavailable: ${capability.message ?? capability.status}`,
    );
    error.code = 'ATLAS_DESKTOP_UI_UNAVAILABLE';
    throw error;
  }
  const storageRoot = path.join(path.resolve(installationRoot), 'desktop-ui', 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });
  const child = spawnProcess(capability.python_path, [
    '-m', 'atlas_desktop', '--url', url, '--storage-path', storageRoot,
    ...(pickerRegistrationUrl && pickerToken
      ? ['--picker-registration-url', pickerRegistrationUrl, '--picker-token', pickerToken]
      : []),
  ], {
    cwd: runtimeRoot,
    env: pythonEnvironment(runtimeRoot),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const closed = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Atlas Desktop UI did not become ready within ${readyTimeoutMs}ms.`));
    }, readyTimeoutMs);
    const fail = (failure) => {
      clearTimeout(timer);
      reject(failure instanceof Error ? failure : new Error(failure));
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('ATLAS_DESKTOP_UI_READY')) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => fail(`Atlas Desktop UI could not start: ${error.message}`));
    child.once('exit', (code) => {
      if (!stdout.includes('ATLAS_DESKTOP_UI_READY')) {
        if (stderr.includes('ATLAS_DESKTOP_UI_ALREADY_RUNNING')) {
          const error = new Error('Atlas Desktop is already open. Close the existing window before starting another session.');
          error.code = 'ATLAS_DESKTOP_UI_ALREADY_RUNNING';
          fail(error);
        } else {
          fail(`Atlas Desktop UI exited before opening (${code}): ${stderr.trim() || stdout.trim()}`);
        }
      }
    });
  });
  return {
    status: ready ? 'ready' : 'failed',
    pid: child.pid,
    python_path: capability.python_path,
    python_version: capability.python_version,
    renderer: 'webview2',
    external_browser: false,
    closed,
    close() {
      if (child.exitCode == null && !child.killed) child.kill();
    },
  };
}
