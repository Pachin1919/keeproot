#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { codexSessionStartOutput } from '../src/codex-hook.js';
import { Registry } from '../src/registry.js';
import { PreferenceRules } from '../src/preference-rules.js';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readStdin(maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Codex hook input exceeds the local limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const stateDir = path.resolve(option('--state-dir') ?? process.env.ATLAS_STATE_DIR ?? '');
  if (!stateDir || !fs.existsSync(path.join(stateDir, 'ledger.sqlite'))) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }
  const event = JSON.parse(await readStdin());
  if (event.hook_event_name !== 'SessionStart' || !event.cwd) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }
  const registry = new Registry({ stateDir });
  try {
    const resolution = registry.resolvePath(event.cwd);
    const preferences = new PreferenceRules({ stateDir, ledger: registry.ledger });
    const activeRules = resolution.root
      ? preferences.active({ root: resolution.root.current_path })
      : [];
    const pendingTasks = resolution.status === 'resolved'
      ? registry.ledger.tasks.listPendingByProject(resolution.project.id, { limit: 1 })
      : [];
    process.stdout.write(JSON.stringify(codexSessionStartOutput(
      event, resolution, activeRules, pendingTasks,
    )));
  } finally {
    registry.dispose();
  }
}

main().catch(() => {
  // Host integration must fail open and stay quiet. Atlas file operations still fail closed.
  process.stdout.write(JSON.stringify({ continue: true }));
});
