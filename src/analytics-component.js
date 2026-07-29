import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ANALYTICS_COMPONENT_FORMAT = 'atlas-analytics-component.v1';
export const ANALYTICS_COMPONENT_VERSION = '0.3.0';
export const MINIMUM_PYTHON = Object.freeze({ major: 3, minor: 11 });
export const ANALYTICS_REQUIREMENTS = Object.freeze(['pandas==3.0.1']);

function componentPaths(installationRootInput) {
  const installationRoot = path.resolve(installationRootInput);
  const componentRoot = path.join(installationRoot, 'python');
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

function runPython(executable, args, { runtimeRoot, runProcess = spawnSync, timeout = 60_000 } = {}) {
  const pythonSourceRoot = path.join(runtimeRoot, 'python', 'src');
  return runProcess(executable, args, {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      PYTHONPATH: [pythonSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
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

function verifyModule(executable, options) {
  const result = runPython(executable, ['-m', 'atlas_analytics', '--help'], {
    ...options,
    timeout: 15_000,
  });
  return result.error || result.status !== 0
    ? {
      status: 'unavailable',
      message: result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`,
    }
    : { status: 'ready' };
}

function probePandas(executable, options) {
  const result = runPython(executable, [
    '-c',
    'import json, pandas; print(json.dumps({"pandas": pandas.__version__}))',
  ], {
    ...options,
    timeout: 15_000,
  });
  if (result.error || result.status !== 0) {
    return {
      status: 'unavailable',
      message: result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`,
    };
  }
  try {
    const payload = JSON.parse(result.stdout.trim());
    return { status: 'ready', pandas_version: payload.pandas };
  } catch (error) {
    return { status: 'unavailable', message: `Pandas version probe failed: ${error.message}` };
  }
}

export function doctorAnalyticsComponent({
  installationRoot,
  runtimeRoot,
  configuredPath = process.env.ATLAS_PYTHON,
  runProcess = spawnSync,
} = {}) {
  const locations = componentPaths(installationRoot);
  if (fs.existsSync(locations.manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(locations.manifestPath, 'utf8'));
      if (manifest.component_format !== ANALYTICS_COMPONENT_FORMAT) {
        return { status: 'invalid', mode: 'managed', message: 'Analytics component manifest is incompatible.' };
      }
      if (manifest.component_version !== ANALYTICS_COMPONENT_VERSION) {
        return {
          status: 'upgrade_required',
          mode: 'managed',
          installed: true,
          component_version: manifest.component_version,
          required_component_version: ANALYTICS_COMPONENT_VERSION,
          next_step: 'Run atlas analytics remove, then install the matching component.',
        };
      }
      const probe = probePython(locations.pythonPath, { runtimeRoot, runProcess });
      if (probe.status !== 'ready') return { ...probe, mode: 'managed' };
      const module = verifyModule(locations.pythonPath, { runtimeRoot, runProcess });
      if (module.status !== 'ready') return { ...module, mode: 'managed', python_path: locations.pythonPath };
      const pandas = probePandas(locations.pythonPath, { runtimeRoot, runProcess });
      if (pandas.status !== 'ready') return { ...pandas, mode: 'managed', python_path: locations.pythonPath };
      return {
        status: 'ready',
        mode: 'managed',
        installed: true,
        component_version: manifest.component_version,
        python_path: locations.pythonPath,
        python_version: probe.python_version,
        dependencies: { pandas: pandas.pandas_version },
        installation_network_access: true,
        runtime_network_access: false,
        ledger_access: false,
        library_access: false,
      };
    } catch (error) {
      return { status: 'invalid', mode: 'managed', message: error.message };
    }
  }

  if (configuredPath) {
    const probe = probePython(path.resolve(configuredPath), { runtimeRoot, runProcess });
    if (probe.status === 'ready') {
      const module = verifyModule(probe.python_path, { runtimeRoot, runProcess });
      if (module.status === 'ready') {
        const pandas = probePandas(probe.python_path, { runtimeRoot, runProcess });
        if (pandas.status !== 'ready') {
          return { ...pandas, mode: 'external_override', python_path: probe.python_path };
        }
        return {
          status: 'ready',
          mode: 'external_override',
          installed: false,
          component_version: ANALYTICS_COMPONENT_VERSION,
          python_path: probe.python_path,
          python_version: probe.python_version,
          dependencies: { pandas: pandas.pandas_version },
          installation_network_access: false,
          runtime_network_access: false,
          ledger_access: false,
          library_access: false,
        };
      }
      return { ...module, mode: 'external_override', python_path: probe.python_path };
    }
    return { ...probe, mode: 'external_override' };
  }

  return {
    status: 'not_installed',
    mode: 'managed',
    installed: false,
    required_for_file_governance: false,
    next_step: 'Run atlas analytics install --python <python-3.11-or-newer>.',
  };
}

export function installAnalyticsComponent({
  installationRoot,
  runtimeRoot,
  sourcePython = process.env.ATLAS_PYTHON,
  runProcess = spawnSync,
} = {}) {
  const locations = componentPaths(installationRoot);
  const current = doctorAnalyticsComponent({
    installationRoot,
    runtimeRoot,
    configuredPath: null,
    runProcess,
  });
  if (current.status === 'ready') return { ...current, status: 'already_installed' };
  if (fs.existsSync(locations.manifestPath) || fs.existsSync(locations.venvRoot)) {
    const error = new Error('Managed analytics component exists but is not healthy; remove it before reinstalling.');
    error.code = 'ATLAS_STATE_CONFLICT';
    throw error;
  }
  if (!sourcePython) {
    const error = new Error('analytics install requires --python <python-3.11-or-newer> or ATLAS_PYTHON.');
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  const source = path.resolve(sourcePython);
  const sourceProbe = probePython(source, { runtimeRoot, runProcess });
  if (sourceProbe.status !== 'ready') {
    const error = new Error(
      sourceProbe.status === 'old'
        ? `Atlas analytics requires Python ${MINIMUM_PYTHON.major}.${MINIMUM_PYTHON.minor} or newer.`
        : `Python is unavailable: ${sourceProbe.message ?? source}`,
    );
    error.code = 'ATLAS_CAPABILITY_UNAVAILABLE';
    throw error;
  }
  if (!fs.existsSync(path.join(runtimeRoot, 'python', 'src', 'atlas_analytics', '__main__.py'))) {
    throw new Error('Atlas analytics Python source is missing from the Runtime.');
  }

  fs.mkdirSync(locations.componentRoot, { recursive: true });
  if (fs.lstatSync(locations.componentRoot).isSymbolicLink()) {
    throw new Error(`Analytics component root cannot be a symbolic link: ${locations.componentRoot}`);
  }
  const stageVenv = path.join(locations.componentRoot, `.venv-stage-${crypto.randomUUID()}`);
  let installedVenv = false;
  try {
    const created = runPython(source, ['-m', 'venv', stageVenv], {
      runtimeRoot,
      runProcess,
      timeout: 120_000,
    });
    if (created.error || created.status !== 0) {
      throw new Error(
        `Python virtual environment creation failed: ${created.error?.message ?? created.stderr?.trim() ?? `exit ${created.status}`}`,
      );
    }
    const stagedPython = process.platform === 'win32'
      ? path.join(stageVenv, 'Scripts', 'python.exe')
      : path.join(stageVenv, 'bin', 'python');
    const stagedProbe = probePython(stagedPython, { runtimeRoot, runProcess });
    if (stagedProbe.status !== 'ready') {
      throw new Error(`Managed Python validation failed: ${stagedProbe.message ?? stagedProbe.status}`);
    }
    const dependencyInstall = runPython(stagedPython, [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-input',
      '--only-binary=:all:',
      ...ANALYTICS_REQUIREMENTS,
    ], {
      runtimeRoot,
      runProcess,
      timeout: 300_000,
    });
    if (dependencyInstall.error || dependencyInstall.status !== 0) {
      throw new Error(
        `Analytics dependency installation failed: ${
          dependencyInstall.error?.message
          ?? dependencyInstall.stderr?.trim()
          ?? `exit ${dependencyInstall.status}`
        }`,
      );
    }
    const module = verifyModule(stagedPython, { runtimeRoot, runProcess });
    if (module.status !== 'ready') throw new Error(`Atlas analytics module validation failed: ${module.message}`);
    const pandas = probePandas(stagedPython, { runtimeRoot, runProcess });
    if (pandas.status !== 'ready') throw new Error(`Pandas validation failed: ${pandas.message}`);

    fs.renameSync(stageVenv, locations.venvRoot);
    installedVenv = true;
    const manifest = {
      component_format: ANALYTICS_COMPONENT_FORMAT,
      component_version: ANALYTICS_COMPONENT_VERSION,
      python_version: stagedProbe.python_version,
      source_python: sourceProbe.python_path,
      installed_at: new Date().toISOString(),
      dependencies: { pandas: pandas.pandas_version },
      installation_network_access: true,
      runtime_network_access: false,
      ledger_access: false,
      library_access: false,
    };
    const manifestTemp = `${locations.manifestPath}.tmp-${process.pid}`;
    fs.writeFileSync(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(manifestTemp, locations.manifestPath);
    return {
      status: 'installed',
      mode: 'managed',
      component_version: ANALYTICS_COMPONENT_VERSION,
      python_path: locations.pythonPath,
      python_version: stagedProbe.python_version,
      dependencies: { pandas: pandas.pandas_version },
      installation_network_access: true,
      runtime_network_access: false,
    };
  } catch (error) {
    fs.rmSync(stageVenv, { recursive: true, force: true });
    if (installedVenv && !fs.existsSync(locations.manifestPath)) {
      fs.rmSync(locations.venvRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

export function removeAnalyticsComponent({ installationRoot } = {}) {
  const locations = componentPaths(installationRoot);
  const existed = fs.existsSync(locations.venvRoot) || fs.existsSync(locations.manifestPath);
  if (fs.existsSync(locations.venvRoot)) {
    if (fs.lstatSync(locations.venvRoot).isSymbolicLink()) {
      throw new Error(`Refusing to remove a linked analytics environment: ${locations.venvRoot}`);
    }
    fs.rmSync(locations.venvRoot, { recursive: true, force: true });
  }
  fs.rmSync(locations.manifestPath, { force: true });
  if (fs.existsSync(locations.componentRoot)
      && fs.lstatSync(locations.componentRoot).isDirectory()
      && fs.readdirSync(locations.componentRoot).length === 0) {
    fs.rmdirSync(locations.componentRoot);
  }
  return {
    status: existed ? 'removed' : 'already_removed',
    component: 'analytics_python',
    file_governance_available: true,
    state_preserved: true,
  };
}
