import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '../src/registry.js';
import { createResourceControl } from '../src/resource-control.js';

function fixture(t, prefix = 'resource-link-suggestion-') {
  const parent = path.resolve('test/.tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, prefix));
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'A');
  const otherRoot = path.join(workspace, 'B');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(otherRoot, { recursive: true });
  const sourcePath = path.join(projectRoot, 'source.md');
  const targetPath = path.join(projectRoot, 'target.md');
  const otherPath = path.join(otherRoot, 'other.md');
  fs.writeFileSync(sourcePath, 'source bytes\n');
  fs.writeFileSync(targetPath, 'target bytes\n');
  fs.writeFileSync(otherPath, 'other bytes\n');
  const registry = new Registry({ stateDir });
  const adopted = registry.adoptRoot({ rootPath: workspace, rootType: 'project_workspace', contentPolicy: 'structure_only' });
  const project = registry.create({ name: 'A', currentPath: 'A' });
  const otherProject = registry.create({ name: 'B', currentPath: 'B' });
  registry.attachRoot(project.project_id, { rootId: adopted.root_id, relativePath: 'A', reason: 'Suggestion fixture.' });
  registry.attachRoot(otherProject.project_id, { rootId: adopted.root_id, relativePath: 'B', reason: 'Suggestion fixture.' });
  const control = createResourceControl({ stateDir, ledger: registry.ledger, registry });
  const source = control.identify({ filePath: sourcePath, project: { id: project.project_id } });
  const target = control.identify({ filePath: targetPath, project: { id: project.project_id } });
  const other = control.identify({ filePath: otherPath, project: { id: otherProject.project_id } });
  const caller = { tool: 'test-host', client_run_id: `suggestion-${path.basename(root)}` };
  t.after(() => { control.dispose(); registry.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const request = (overrides = {}) => ({
    project_id: project.project_id,
    source_resource_id: source.resource_id,
    target: { kind: 'resource', id: target.resource_id },
    type: 'linked_to',
    source_sha256: source.evidence.sha256,
    target_sha256: target.evidence.sha256,
    evidence: { reason: 'The target is the source data table.' },
    ...overrides,
  });
  return { root, stateDir, workspace, projectRoot, sourcePath, targetPath, otherPath, registry, control, project, otherProject, source, target, other, caller, request };
}

test('schema v33 migrates to v34 with a backup and a dedicated candidate table', (t) => {
  const f = fixture(t, 'resource-link-suggestion-migration-');
  f.control.dispose(); f.registry.dispose();
  const dbPath = path.join(f.stateDir, 'ledger.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE IF EXISTS resource_link_candidates; DELETE FROM schema_migrations WHERE version>33; PRAGMA user_version=33;');
  db.close();
  const reopened = new Registry({ stateDir: f.stateDir });
  try {
    assert.equal(reopened.ledger.db.prepare('PRAGMA user_version').get().user_version, 34);
    assert.equal(reopened.ledger.db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', 'resource_link_candidates')?.name, 'resource_link_candidates');
    const backup = new DatabaseSync(path.join(f.stateDir, 'backups/ledger-pre-migration-v33-to-v34.sqlite'), { readOnly: true });
    try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 33); } finally { backup.close(); }
  } finally { reopened.dispose(); }
});

test('Host Resource link suggestion is pending until accepted, replayable, and stale after endpoint changes', (t) => {
  const f = fixture(t);
  const req = f.request();
  const stored = f.control.suggestLinkedResource({ candidate: req, requestKey: 'host-link-request-1', caller: f.caller });
  assert.match(stored.candidate_id, /^RLCAND-/u);
  assert.equal(stored.status, 'pending');
  assert.equal(f.control.linkedResourceRelationships(f.project.project_id, f.source.resource_id).length, 0);
  assert.equal(f.control.relationshipFocus(f.project.project_id, f.source.resource_id).edges.length, 0);
  assert.equal(f.control.suggestLinkedResource({ candidate: req, requestKey: 'host-link-request-1', caller: f.caller }).candidate_id, stored.candidate_id);
  assert.throws(() => f.control.suggestLinkedResource({ candidate: { ...req, evidence: { reason: 'different' } }, requestKey: 'host-link-request-1', caller: f.caller }), (error) => error.code === 'ATLAS_STATE_CONFLICT');
  assert.throws(() => f.control.decideLinkedResourceSuggestion({ projectId: f.project.project_id, candidateId: stored.candidate_id, decision: 'accept', expectedRevision: stored.revision + 1, bindingDigest: stored.binding_digest, caller: { decision_channel: 'ui_confirm', ...f.caller } }), (error) => error.code === 'ATLAS_STATE_CONFLICT');
  fs.writeFileSync(f.targetPath, 'changed target bytes\n');
  const observed = f.control.observe({ filePath: f.targetPath, project: { id: f.project.project_id } });
  f.control.acceptCurrentVersion({ projectId: f.project.project_id, resourceId: f.target.resource_id, expectedCurrentVersion: observed.external_change.current.sha256, caller: f.caller });
  assert.equal(f.control.linkedResourceSuggestion(f.project.project_id, stored.candidate_id).validity, 'stale');
  assert.throws(() => f.control.decideLinkedResourceSuggestion({ projectId: f.project.project_id, candidateId: stored.candidate_id, decision: 'accept', expectedRevision: stored.revision, bindingDigest: stored.binding_digest, caller: { decision_channel: 'ui_confirm', ...f.caller } }), (error) => error.code === 'ATLAS_STATE_CONFLICT');
  const rejected = f.control.decideLinkedResourceSuggestion({ projectId: f.project.project_id, candidateId: stored.candidate_id, decision: 'reject', expectedRevision: stored.revision, bindingDigest: stored.binding_digest, caller: { decision_channel: 'ui_confirm', ...f.caller } });
  assert.equal(rejected.status, 'rejected');
  assert.equal(f.control.linkedResourceRelationships(f.project.project_id, f.source.resource_id).length, 0);
});

test('suggestion enforces same-Project files and acceptance writes one edge and decision receipt', (t) => {
  const f = fixture(t);
  const req = f.request();
  const stored = f.control.suggestLinkedResource({ candidate: req, requestKey: 'host-link-request-2', caller: f.caller });
  const accepted = f.control.decideLinkedResourceSuggestion({ projectId: f.project.project_id, candidateId: stored.candidate_id, decision: 'accept', expectedRevision: stored.revision, bindingDigest: stored.binding_digest, caller: { decision_channel: 'ui_confirm', ...f.caller } });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.receipt.relationship.status, 'active');
  assert.equal(f.control.linkedResourceRelationships(f.project.project_id, f.source.resource_id).length, 1);
  assert.equal(f.control.linkedResourceSuggestion(f.project.project_id, stored.candidate_id).receipt.relationship.id, accepted.receipt.relationship.id);
  assert.equal(f.control.decideLinkedResourceSuggestion({ projectId: f.project.project_id, candidateId: stored.candidate_id, decision: 'accept', expectedRevision: stored.revision, bindingDigest: stored.binding_digest, caller: { decision_channel: 'ui_confirm', ...f.caller } }).receipt.relationship.id, accepted.receipt.relationship.id);
  const foreignRequest = f.request({ target: { kind: 'resource', id: f.other.resource_id } });
  assert.throws(() => f.control.suggestLinkedResource({ candidate: foreignRequest, requestKey: 'cross-project', caller: f.caller }));
});

test('suggestion rejects a linked file endpoint', (t) => {
  const f = fixture(t);
  const symlinkPath = path.join(f.projectRoot, 'link.md');
  try { fs.symlinkSync(f.targetPath, symlinkPath); } catch (error) { t.skip(`File symlink creation is unavailable: ${error.code ?? error.message}`); return; }
  const link = f.control.ledger.resources.create({ kind: 'file', displayName: 'link.md', at: new Date().toISOString() });
  f.control.ledger.resources.ensureLocation({ resourceId: link.id, projectId: f.project.project_id, path: symlinkPath, displayName: 'link.md', evidence: { sha256: f.target.evidence.sha256, bytes: f.target.evidence.bytes, modified_at: f.target.evidence.modified_at }, at: new Date().toISOString() });
  assert.throws(() => f.control.suggestLinkedResource({ candidate: f.request({ target: { kind: 'resource', id: link.id } }), requestKey: 'linked-endpoint', caller: f.caller }));
  assert.equal(f.control.linkedResourceRelationships(f.project.project_id, f.source.resource_id).length, 0);
});

test('a separately changed relationship edge makes a pending suggestion stale', (t) => {
  const f=fixture(t); const candidate=f.request();
  const stored=f.control.suggestLinkedResource({candidate,requestKey:'edge-change-suggestion',caller:f.caller});
  const preview=f.control.previewLinkedResource({operation:'add',candidate,decisionChannel:'host_command'});
  f.control.submitLinkedResource({operation:'add',candidate,previewToken:preview.preview_token,requestKey:'legacy-edge-change',caller:f.caller,decisionChannel:'host_command'});
  assert.equal(f.control.linkedResourceSuggestion(f.project.project_id,stored.candidate_id).validity,'stale');
  assert.throws(()=>f.control.decideLinkedResourceSuggestion({projectId:f.project.project_id,candidateId:stored.candidate_id,decision:'accept',expectedRevision:stored.revision,bindingDigest:stored.binding_digest,requestKey:'stale-edge-accept',caller:{decision_channel:'ui_confirm',...f.caller}}),(error)=>error.code==='ATLAS_STATE_CONFLICT');
  const rejected=f.control.decideLinkedResourceSuggestion({projectId:f.project.project_id,candidateId:stored.candidate_id,decision:'reject',expectedRevision:stored.revision,bindingDigest:stored.binding_digest,requestKey:'stale-edge-reject',caller:{decision_channel:'ui_confirm',...f.caller}});
  assert.equal(rejected.status,'rejected'); assert.equal(f.control.linkedResourceRelationships(f.project.project_id,f.source.resource_id).length,1);
});

test('a second review window cannot reverse a committed decision and recovery keeps pending suggestions read-only', (t) => {
  const f=fixture(t);
  const stored=f.control.suggestLinkedResource({candidate:f.request(),requestKey:'windowed-link-suggestion',caller:f.caller});
  const otherRegistry=new Registry({stateDir:f.stateDir}); const otherControl=createResourceControl({stateDir:f.stateDir,ledger:otherRegistry.ledger,registry:otherRegistry});
  try {
  const secondWindow=otherControl.linkedResourceSuggestion(f.project.project_id,stored.candidate_id);
  const accepted=f.control.decideLinkedResourceSuggestion({projectId:f.project.project_id,candidateId:stored.candidate_id,decision:'accept',expectedRevision:stored.revision,bindingDigest:stored.binding_digest,requestKey:'window-one-accept',caller:{decision_channel:'ui_confirm',...f.caller}});
  assert.throws(()=>otherControl.decideLinkedResourceSuggestion({projectId:f.project.project_id,candidateId:stored.candidate_id,decision:'reject',expectedRevision:secondWindow.revision,bindingDigest:secondWindow.binding_digest,requestKey:'window-two-reject',caller:{decision_channel:'ui_confirm',...f.caller}}),(error)=>error.code==='ATLAS_STATE_CONFLICT');
  const replay=otherControl.decideLinkedResourceSuggestion({projectId:f.project.project_id,candidateId:stored.candidate_id,decision:'accept',expectedRevision:stored.revision,bindingDigest:stored.binding_digest,requestKey:'window-one-accept',caller:{decision_channel:'ui_confirm',...f.caller}});
  assert.equal(replay.status,'accepted'); assert.equal(replay.receipt.relationship.id,accepted.receipt.relationship.id);
  const pending=otherControl.suggestLinkedResource({candidate:f.request({evidence:{reason:'Recovery protected candidate.'}}),requestKey:'recovery-protected-link',caller:f.caller});
  f.control.ledger.db.prepare('INSERT INTO recovery_rounds(id,project_id,revision,state_json,updated_at) VALUES(?,?,?,?,?)').run('ROUND-LINK-PENDING',f.project.project_id,1,JSON.stringify({pending_restore:{round_id:'ROUND-LINK-PENDING'},resource_ids:[f.source.resource_id,f.target.resource_id]}),new Date().toISOString());
  assert.equal(otherControl.linkedResourceSuggestion(f.project.project_id,pending.candidate_id).status,'pending');
  assert.throws(()=>otherControl.decideLinkedResourceSuggestion({projectId:f.project.project_id,candidateId:pending.candidate_id,decision:'reject',expectedRevision:pending.revision,bindingDigest:pending.binding_digest,requestKey:'recovery-reject',caller:{decision_channel:'ui_confirm',...f.caller}}),(error)=>error.code==='ATLAS_RECOVERY_INCOMPLETE');
  assert.equal(f.control.ledger.db.prepare('SELECT status FROM resource_link_candidates WHERE id=?').get(pending.candidate_id).status,'pending');
  assert.equal(otherControl.linkedResourceRelationships(f.project.project_id,f.source.resource_id).length,1);
  } finally { otherControl.dispose(); otherRegistry.dispose(); }
});

test('accept transaction rolls back a created edge and action if the candidate compare-and-set fails', (t) => {
  const f = fixture(t);
  const stored=f.control.suggestLinkedResource({candidate:f.request(),requestKey:'rollback-link-suggestion',caller:f.caller});
  f.control.ledger.db.exec(`CREATE TRIGGER fail_link_suggestion_decision BEFORE UPDATE ON resource_link_candidates BEGIN SELECT RAISE(ABORT,'injected candidate CAS failure'); END;`);
  assert.throws(()=>f.control.decideLinkedResourceSuggestion({projectId:f.project.project_id,candidateId:stored.candidate_id,decision:'accept',expectedRevision:stored.revision,bindingDigest:stored.binding_digest,requestKey:'rollback-accept',caller:{decision_channel:'ui_confirm',...f.caller}}),/injected candidate CAS failure/u);
  f.control.ledger.db.exec('DROP TRIGGER fail_link_suggestion_decision;');
  assert.equal(f.control.linkedResourceSuggestion(f.project.project_id,stored.candidate_id).status,'pending');
  assert.equal(f.control.linkedResourceRelationships(f.project.project_id,f.source.resource_id).length,0);
  assert.equal(f.control.ledger.db.prepare("SELECT COUNT(*) AS count FROM resource_actions WHERE action_type='link_resource'").get().count,0);
});
