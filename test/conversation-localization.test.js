import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { localizeConversationSelection } from '../src/conversation-localization.js';

const root = path.resolve('test', '.tmp', 'conversation-localization');
const cliPath = path.resolve('bin', 'atlas.js');

function call(stateDir, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ATLAS_STATE_DIR: stateDir, ATLAS_HOME: path.resolve('.') },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

function selection(overrides = {}) {
  return {
    schema: 'atlas.conversation-selection.v1',
    title: 'Atlas V1.6 product decisions',
    source: {
      host: 'codex',
      thread_id: 'thread-local-test',
      selected_at: '2026-08-31T02:00:00.000Z',
    },
    purpose: 'Bounded context for an implementation worker.',
    decisions: [
      { title: 'Context boundary', content: 'Subagents receive only a named Markdown extract.' },
      { title: 'Runtime boundary', content: 'Atlas stores facts; the Host decides meaning.' },
    ],
    completed: ['Folder View is available.'],
    pending: ['Relationship Map is not implemented.'],
    task_packet: {
      objective: 'Implement one Ledger-backed relationship query.',
      files: ['src/ledger.js', 'src/ui/views/project-resources-view.js'],
      acceptance: ['No relationship is guessed.'],
      prohibited: ['Do not commit or push.'],
    },
    ...overrides,
  };
}

test('conversation localization writes one bounded plain Markdown context file', () => {
  fs.rmSync(root, { recursive: true, force: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  const input = path.join(root, 'selection.json');
  const output = path.join(project, 'docs', 'context.md');
  fs.writeFileSync(input, JSON.stringify(selection()), 'utf8');

  const receipt = localizeConversationSelection({ inputPath: input, outputPath: output, projectRoot: project });

  const markdown = fs.readFileSync(output, 'utf8');
  assert.equal(receipt.schema, 'atlas.conversation-localization.v1');
  assert.equal(receipt.decision_count, 2);
  assert.equal(receipt.output.path, output);
  assert.match(markdown, /^# Atlas V1\.6 product decisions/mu);
  assert.match(markdown, /## Confirmed decisions/u);
  assert.match(markdown, /### Context boundary/u);
  assert.match(markdown, /## Subagent task packet/u);
  assert.doesNotMatch(markdown, /<html|<!doctype/iu);
});

test('conversation localization refuses overwrite and targets outside the Project', () => {
  fs.rmSync(root, { recursive: true, force: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const input = path.join(root, 'selection.json');
  fs.writeFileSync(input, JSON.stringify(selection()), 'utf8');

  assert.throws(
    () => localizeConversationSelection({ inputPath: input, outputPath: path.join(root, 'outside.md'), projectRoot: project }),
    /inside the selected Project/u,
  );

  const output = path.join(project, 'context.md');
  fs.writeFileSync(output, 'existing', 'utf8');
  assert.throws(
    () => localizeConversationSelection({ inputPath: input, outputPath: output, projectRoot: project }),
    /must not already exist/u,
  );
});

test('conversation localization rejects raw conversation dumps without selected decisions', () => {
  fs.rmSync(root, { recursive: true, force: true });
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const input = path.join(root, 'selection.json');
  fs.writeFileSync(input, JSON.stringify(selection({ decisions: [] })), 'utf8');

  assert.throws(
    () => localizeConversationSelection({ inputPath: input, outputPath: path.join(project, 'context.md'), projectRoot: project }),
    /at least one selected decision/u,
  );
});

test('Host CLI localizes a selected conversation into an active Project', () => {
  fs.rmSync(root, { recursive: true, force: true });
  const stateDir = path.join(root, 'state');
  const library = path.join(root, 'library');
  const projectRoot = path.join(library, 'Atlas');
  fs.mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
  const input = path.join(root, 'selection.json');
  fs.writeFileSync(input, JSON.stringify(selection()), 'utf8');
  const adopted = call(stateDir, [
    'root', 'adopt', '--path', library,
    '--type', 'project_workspace', '--content-policy', 'bounded_content',
  ]);
  const project = call(stateDir, ['project', 'create', '--name', 'Atlas', '--path', 'Atlas']);
  call(stateDir, [
    'project', 'attach-root', project.project_id, '--root', adopted.root_id,
    '--reason', 'Bind conversation localization fixture.',
  ]);

  const receipt = call(stateDir, [
    'content', 'localize-conversation', '--input', input,
    '--project', project.project_id, '--output-relative', 'docs/context.md',
    '--actor', 'agent', '--agent', 'Codex', '--model', 'gpt-5.6-sol',
    '--tool', 'codex-desktop', '--client-run-id', 'conversation-localization-test',
  ]);

  assert.equal(receipt.verified, true);
  assert.equal(receipt.project.id, project.project_id);
  assert.equal(receipt.caller.agent, 'Codex');
  assert.equal(fs.existsSync(path.join(projectRoot, 'docs', 'context.md')), true);
});
