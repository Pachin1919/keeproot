import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { handshakeRuntime } from '../src/runtime-location.js';

export class InstalledSkillDriver {
  constructor({ installRoot, timeoutMs = 15_000 }) {
    this.installRoot = installRoot;
    this.timeoutMs = timeoutMs;
    const handshake = handshakeRuntime({ installRoot, timeoutMs });
    assert.equal(handshake.status, 'ready', JSON.stringify(handshake));
    this.runtime = handshake;
    this.manifest = JSON.parse(fs.readFileSync(path.join(installRoot, 'atlas-install.json'), 'utf8'));
    this.skill = fs.readFileSync(path.join(handshake.skill_root, 'SKILL.md'), 'utf8');
    this.workflows = fs.readFileSync(path.join(handshake.skill_root, 'references', 'workflows.md'), 'utf8');
  }

  acceptsScenario(scenario) {
    assert.equal(typeof scenario.user_request, 'string');
    assert.match(this.skill, /name:\s+atlas-file-governance/u);
    assert.match(this.skill, /installed Atlas Runtime/iu);
    assert.match(this.skill, /recovery/i);
    for (const command of scenario.required_commands ?? []) {
      assert.match(this.workflows, new RegExp(command.replace(' ', '\\s+')));
    }
  }

  call(args, expectedExit = 0) {
    const result = spawnSync(
      this.manifest.node_path,
      [
        ...(this.manifest.node_args ?? []),
        path.join(this.manifest.runtime_path, 'bin', 'atlas.js'), ...args, '--json',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: this.timeoutMs,
        env: {
          ...process.env,
          ATLAS_HOME: this.installRoot,
          ATLAS_STATE_DIR: this.manifest.state_path,
        },
      },
    );
    assert.equal(result.status, expectedExit, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.protocol_version, 'atlas-cli.v1');
    assert.equal(envelope.ok, true);
    return envelope.data;
  }
}
