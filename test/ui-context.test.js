import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createContextView } from '../src/ui-context.js';
import { openLocalUi } from '../src/ui-launcher.js';
import { renderStatus, statusPresentation } from '../src/ui/components.js';

test('UI status vocabulary explains the recorded state instead of exposing only raw codes', () => {
  assert.deepEqual(statusPresentation('blocked'), {
    label: 'Blocked',
    meaning: 'Atlas stopped the Task because a conflict or policy condition needs attention.',
  });
  assert.match(renderStatus('not_checked'), />Not checked<\/span>/u);
  assert.match(renderStatus('completed'), /title="The Task output was recorded and verified\."/u);
});

test('UI context writes one local HTML view for bounded Project candidates', () => {
  const stateDir = path.resolve('test', '.tmp', 'ui-context');
  fs.rmSync(stateDir, { recursive: true, force: true });
  const registry = {
    ledger: {
      tasks: {
        listPendingByProject() {
          return [{
            task_id: 'TSK-1', task_status: 'ready', intent: 'Prepare a report.',
            target: 'JMCMOTORS_社媒管理/06_分析报告/report.pdf', strategy: 'create',
            write_mode: null, write_status: null, started_at: '2026-08-04T00:00:00.000Z',
            source_set_id: 'SRCSET-1',
          }];
        },
      },
    },
    resolvePath(currentPath) {
      return {
        status: 'setup_required',
        input_path: currentPath,
        root: { id: 'ROOT-1', current_path: path.resolve('test', '.tmp', 'workspace') },
        project_candidates: [{
          project: { id: 'PRJ-1', name: '<JMC & Media>' },
          location: { relative_path: 'JMCMOTORS_社媒管理' },
        }],
      };
    },
  };
  const rules = {
    active() {
      return [{
        id: 'RULE-1',
        status: 'active', kind: 'placement',
        scope: { type: 'project', key: 'PRJ-1' },
        condition: { origin: 'human_submitted', kind: 'report', extension: '.pdf' },
        value: { target_subdirectory: '06_分析报告' },
        created_at: '2026-08-04T00:00:00.000Z',
      }];
    },
    history() {
      return [{
        id: 'RULE-0',
        status: 'superseded', kind: 'placement',
        scope: { type: 'project', key: 'PRJ-1' },
        condition: { origin: 'human_submitted', kind: 'report', extension: '.pdf' },
        value: { target_subdirectory: '05_旧报告' },
        created_at: '2026-08-01T00:00:00.000Z',
        superseded_at: '2026-08-04T00:00:00.000Z',
      }, {
        id: 'RULE-1',
        status: 'active', kind: 'placement',
        scope: { type: 'project', key: 'PRJ-1' },
        condition: { origin: 'human_submitted', kind: 'report', extension: '.pdf' },
        value: { target_subdirectory: '06_分析报告' },
        created_at: '2026-08-04T00:00:00.000Z',
      }];
    },
  };

  const result = createContextView({
    stateDir, currentPath: '.', registry, rules,
    runtime: {
      atlas_version: '1.5.0-alpha.2', node_version: process.versions.node,
      ledger: { integrity: 'ok', schema_version: 20, supported_schema_version: 20 },
      python: { status: 'available' },
    },
  });
  assert.equal(result.status, 'selection_required');
  assert.equal(result.project_count, 1);
  assert.equal(result.active_route_count, 1);
  assert.equal(result.network_used, false);
  assert.equal(result.pending_task_count, 1);
  assert.equal(result.model_visible_body_bytes, 0);
  const model = JSON.parse(fs.readFileSync(result.context_path, 'utf8'));
  assert.equal(model.schema, 'atlas-ui-context-model.v1');
  assert.equal(model.projects[0].pending_tasks[0].task_id, 'TSK-1');
  assert.equal(model.projects[0].pending_tasks[0].source_freshness.status, 'not_checked');
  assert.equal(model.projects[0].routes[0].id, 'RULE-1');
  assert.equal(model.projects[0].rule_history.active_count, 1);
  assert.equal(model.projects[0].rule_history.superseded_count, 1);
  assert.deepEqual(model.projects[0].rule_history.recent[0].changed_value_fields, ['target_subdirectory']);
  assert.equal(model.runtime.ledger.integrity, 'ok');
  assert.equal(model.runtime.processors.find((item) => item.id === 'tabular_profile').status, 'ready');
  assert.equal(model.runtime.processors.find((item) => item.id === 'visual_preview').status, 'deferred');
  const html = fs.readFileSync(result.view_path, 'utf8');
  assert.match(html, /&lt;JMC &amp; Media&gt;/u);
  assert.match(html, /06_分析报告/u);
  assert.match(html, /Source freshness: not_checked/u);
  assert.match(html, /Changed: target_subdirectory/u);
  assert.match(html, /tabular_profile/u);
  assert.doesNotMatch(html, /<JMC & Media>/u);
});

test('UI browser launcher accepts only loopback URLs and uses the platform opener', () => {
  const calls = [];
  const fakeChild = { unref() {} };
  const result = openLocalUi('http://127.0.0.1:4319/', {
    platform: 'win32',
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return fakeChild;
    },
  });
  assert.equal(result.status, 'requested');
  assert.equal(calls[0].command, 'explorer.exe');
  assert.deepEqual(calls[0].args, ['http://127.0.0.1:4319/']);
  assert.throws(() => openLocalUi('https://example.com/', {
    platform: 'win32', spawnProcess: () => fakeChild,
  }), /only a local loopback URL/iu);
});
