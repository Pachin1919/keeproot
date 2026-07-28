import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PROTOCOL_VERSION } from './protocol.js';
import { locateInstalledRuntime } from './runtime-install.js';

function parseEnvelope(result, command) {
  if (result.error?.code === 'ETIMEDOUT' || (result.status === null && result.signal)) {
    return { status: 'timeout', command };
  }
  if (result.status !== 0 || result.stderr) {
    return { status: 'runtime_error', command, exit_code: result.status, stderr: result.stderr };
  }
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
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

export function handshakeRuntime({ installRoot, timeoutMs = 15_000, invoke } = {}) {
  const located = locateInstalledRuntime(installRoot);
  if (located.status !== 'ready') return located;
  if (located.manifest.protocol_version !== PROTOCOL_VERSION) {
    return {
      status: 'incompatible_protocol',
      expected_protocol: PROTOCOL_VERSION,
      received_protocol: located.manifest.protocol_version,
    };
  }
  const run = invoke ?? ((command) => spawnSync(
    located.manifest.node_path,
    [
      ...(located.manifest.node_args ?? []),
      path.join(located.manifest.runtime_path, 'bin', 'atlas.js'), command, '--json',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      env: {
        ...process.env,
        ATLAS_HOME: located.install_root,
        ATLAS_STATE_DIR: located.manifest.state_path,
      },
    },
  ));
  const handshakes = {};
  for (const command of ['version', 'capabilities', 'doctor']) {
    const checked = parseEnvelope(run(command), command);
    if (checked.status !== 'ready') return checked;
    handshakes[command] = checked.envelope.data;
  }
  if (handshakes.doctor.status !== 'ok') return { status: 'doctor_failed', doctor: handshakes.doctor };
  return {
    status: 'ready',
    install_root: located.install_root,
    skill_root: located.manifest.skill_path,
    protocol_version: PROTOCOL_VERSION,
    version: handshakes.version.version,
    capabilities: handshakes.capabilities,
    doctor: handshakes.doctor,
  };
}
