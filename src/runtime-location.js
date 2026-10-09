import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PROTOCOL_VERSION } from './protocol.js';
import { locateInstalledRuntime } from './runtime-install.js';

export const RUNTIME_HANDSHAKE_TIMEOUTS = Object.freeze({ version: 15_000, capabilities: 15_000, doctor: 45_000 });

function failureDetails(result, stages) {
  const command = result.command ?? 'locate';
  const actions = {
    runtime_required: 'Install the Runtime at the selected installation root; use -Install with -PythonPath for a first preview installation.',
    invalid_manifest: 'Inspect the installation manifest and repair it through the installer before reopening the preview.',
    integrity_error: 'Inspect the integrity mismatch and restore the reviewed Runtime and Skill through the installer before reopening.',
    incompatible_protocol: 'Use a Runtime and launcher with the same supported protocol; review the installation before upgrading.',
    timeout: `Inspect the ${command} probe and its reported timeout budget before trying again.`,
    doctor_failed: 'Inspect the returned doctor checks and repair the reported component or state failure before reopening.',
    runtime_error: `Inspect the ${command} process error and the selected Node executable before reopening.`,
    invalid_response: `Inspect the ${command} response; the Runtime must return the supported JSON envelope.`,
  };
  return {
    ...result,
    command,
    message: result.message ?? `Runtime ${command} failed: ${result.status}.`,
    next_step: actions[result.status] ?? 'Inspect the returned Runtime failure before reopening the preview.',
    stages,
  };
}

function parseEnvelope(result, command) {
  if (result.error?.code === 'ETIMEDOUT' || (result.status === null && result.signal)) {
    return { status: 'timeout', command };
  }
  if (result.status !== 0 || result.stderr) {
    return { status: 'runtime_error', command, exit_code: result.status, stderr: result.stderr?.slice(0, 2000), error: result.error ? { code: result.error.code ?? null, message: result.error.message?.slice(0, 2000) } : undefined };
  }
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    return { status: 'invalid_response', command };
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { status: 'invalid_response', command };
  }
  if (envelope.protocol_version !== PROTOCOL_VERSION) {
    return { status: 'incompatible_protocol', command, received_protocol: envelope.protocol_version };
  }
  if (envelope.ok !== true || envelope.command !== command) {
    return { status: 'invalid_response', command, envelope };
  }
  return { status: 'ready', envelope };
}

export function handshakeRuntime({ installRoot, timeoutMs, invoke } = {}) {
  const stages = [];
  const started = performance.now();
  const located = locateInstalledRuntime(installRoot);
  stages.push({ command: 'locate', elapsed_ms: Math.round(performance.now() - started), timeout_ms: null, status: located.status, error_code: null });
  if (located.status !== 'ready') return failureDetails(located, stages);
  if (located.manifest.protocol_version !== PROTOCOL_VERSION) {
    return failureDetails({
      status: 'incompatible_protocol',
      expected_protocol: PROTOCOL_VERSION,
      received_protocol: located.manifest.protocol_version,
    }, stages);
  }
  const run = invoke ?? ((command, options) => spawnSync(
    located.manifest.node_path,
    [
      ...(located.manifest.node_args ?? []),
      path.join(located.manifest.runtime_path, 'bin', 'atlas.js'), command, '--json',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs,
      env: {
        ...process.env,
        ATLAS_HOME: located.install_root,
        ATLAS_STATE_DIR: located.manifest.state_path,
      },
    },
  ));
  const handshakes = {};
  for (const command of ['version', 'capabilities', 'doctor']) {
    const budget = timeoutMs ?? RUNTIME_HANDSHAKE_TIMEOUTS[command];
    const stageStarted = performance.now();
    const result = run(command, { timeoutMs: budget });
    let checked = parseEnvelope(result, command);
    if (checked.status === 'ready' && command === 'doctor' && checked.envelope.data?.status !== 'ok') {
      checked = { status: 'doctor_failed', command, doctor: checked.envelope.data, envelope: checked.envelope };
    }
    stages.push({ command, elapsed_ms: Math.round(performance.now() - stageStarted), timeout_ms: budget, status: checked.status, error_code: result.error?.code ?? (checked.status === 'timeout' ? 'ETIMEDOUT' : null) });
    if (checked.status !== 'ready') return failureDetails(checked, stages);
    handshakes[command] = checked.envelope.data;
  }
  return {
    status: 'ready',
    install_root: located.install_root,
    skill_root: located.manifest.skill_path,
    protocol_version: PROTOCOL_VERSION,
    version: handshakes.version.version,
    capabilities: handshakes.capabilities,
    doctor: handshakes.doctor,
    stages,
  };
}
