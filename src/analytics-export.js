import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from './paths.js';

export const ANALYTICS_SCHEMA_VERSION = 'atlas.analytics.v1';

const CSV_COLUMNS = Object.freeze([
  'export_schema',
  'record_type',
  'record_id',
  'run_id',
  'project_id',
  'recorded_at',
  'mode',
  'status',
  'rule_version_id',
  'event_type',
  'decision',
  'actor',
  'agent',
  'model',
  'tool',
  'client_run_id',
  'selected_count',
  'excluded_count',
  'input_bytes',
  'selected_bytes',
  'payload_json',
]);

function timestamp() {
  return new Date().toISOString();
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return { invalid_json: true };
  }
}

function rootFingerprint(rootPath) {
  return sha256Buffer(Buffer.from(path.resolve(rootPath).toLowerCase(), 'utf8'));
}

function receiptMetrics(row) {
  const receipt = parseJson(row.receipt_json, {});
  const abortReceipt = parseJson(row.abort_receipt_json, {});
  const rollbackReceipt = parseJson(row.rollback_receipt_json, {});
  return {
    intent_present: Boolean(row.intent),
    intent_characters: row.intent?.length ?? 0,
    root_fingerprint: rootFingerprint(row.root_path),
    closed_at: row.closed_at,
    aborted_at: row.aborted_at,
    rolled_back_at: row.rolled_back_at,
    receipt: {
      policy: receipt?.policy ?? null,
      changed_files: receipt?.changed_files ?? null,
      allowed_changes: receipt?.allowed_changes ?? null,
      scope_violations: Array.isArray(receipt?.scope_violations) ? receipt.scope_violations.length : null,
      violation_kind: receipt?.violation_kind ?? null,
      verified: receipt?.verified ?? null,
      rollback_ready: receipt?.rollback_ready ?? null,
    },
    abort: abortReceipt ? { status: abortReceipt.status ?? null, reason: abortReceipt.reason ?? null } : null,
    rollback: rollbackReceipt ? {
      status: rollbackReceipt.status ?? null,
      restored_files: rollbackReceipt.restored_files ?? null,
      resumed_paths: rollbackReceipt.resumed_paths ?? null,
    } : null,
  };
}

function record({
  recordType,
  recordId,
  runId = null,
  projectId = null,
  recordedAt,
  mode = null,
  status = null,
  ruleVersionId = null,
  eventType = null,
  decision = null,
  actor = null,
  agent = null,
  model = null,
  tool = null,
  clientRunId = null,
  selectedCount = null,
  excludedCount = null,
  inputBytes = null,
  selectedBytes = null,
  payload = null,
}) {
  return {
    export_schema: ANALYTICS_SCHEMA_VERSION,
    record_type: recordType,
    record_id: recordId,
    run_id: runId,
    project_id: projectId,
    recorded_at: recordedAt,
    mode,
    status,
    rule_version_id: ruleVersionId,
    event_type: eventType,
    decision,
    actor,
    agent,
    model,
    tool,
    client_run_id: clientRunId,
    selected_count: selectedCount,
    excluded_count: excludedCount,
    input_bytes: inputBytes,
    selected_bytes: selectedBytes,
    payload,
  };
}

function publicRecords(source) {
  const records = [];
  for (const row of source.runs) {
    records.push(record({
      recordType: 'run',
      recordId: row.id,
      runId: row.id,
      recordedAt: row.started_at,
      mode: row.mode,
      status: row.status,
      ruleVersionId: row.rule_version_id,
      actor: row.actor,
      agent: row.agent,
      model: row.model,
      tool: row.tool,
      clientRunId: row.client_run_id,
      payload: receiptMetrics(row),
    }));
  }
  for (const row of source.predictions) {
    records.push(record({
      recordType: 'prediction',
      recordId: row.id,
      runId: row.run_id,
      recordedAt: row.created_at,
      eventType: row.kind,
      payload: parseJson(row.payload_json, {}),
    }));
  }
  for (const row of source.labels) {
    records.push(record({
      recordType: 'label',
      recordId: row.id,
      runId: row.run_id,
      recordedAt: row.created_at,
      eventType: row.name,
      decision: row.value,
      payload: {
        subject_prediction_id: row.subject_prediction_id,
        source: row.source,
        details: parseJson(row.details_json, {}),
      },
    }));
  }
  for (const row of source.policyDecisions) {
    records.push(record({
      recordType: 'policy_decision',
      recordId: row.id,
      runId: row.run_id,
      recordedAt: row.created_at,
      ruleVersionId: row.rule_version_id,
      decision: row.decision,
      payload: {
        reason: row.reason,
        details: parseJson(row.details_json, {}),
      },
    }));
  }
  for (const row of source.operationEvents) {
    records.push(record({
      recordType: 'operation_event',
      recordId: row.id,
      runId: row.run_id,
      recordedAt: row.occurred_at,
      eventType: row.event_type,
      payload: parseJson(row.payload_json, {}),
    }));
  }
  for (const row of source.ruleVersions) {
    records.push(record({
      recordType: 'rule_version',
      recordId: row.id,
      recordedAt: row.created_at,
      ruleVersionId: row.id,
      status: 'immutable',
      payload: {
        name: row.name,
        version: row.version,
        definition: parseJson(row.definition_json, {}),
      },
    }));
  }
  for (const row of source.preferenceRules) {
    records.push(record({
      recordType: 'preference_rule',
      recordId: row.id,
      runId: row.run_id,
      recordedAt: row.created_at,
      ruleVersionId: row.rule_version_id,
      eventType: row.kind,
      status: row.status,
      payload: {
        scope_type: row.scope_type,
        scope_key: row.scope_key,
        condition_hash: row.condition_hash,
        condition: parseJson(row.condition_json, {}),
        value: parseJson(row.value_json, {}),
        priority: row.priority,
        summary: row.summary,
        basis: row.basis,
        evidence: parseJson(row.evidence_json, []),
        superseded_at: row.superseded_at,
      },
    }));
  }
  for (const row of source.taskContracts) {
    records.push(record({
      recordType: 'task_contract',
      recordId: row.contract_id,
      runId: row.run_id,
      projectId: row.project_id,
      recordedAt: row.completed_at ?? row.started_at,
      status: row.completed_at ? 'completed' : 'prepared',
      ruleVersionId: row.environment_rule_version_id,
      selectedCount: Number(row.selected_count),
      excludedCount: Number(row.excluded_count),
      inputBytes: Number(row.input_bytes),
      selectedBytes: Number(row.selected_bytes),
      payload: {
        contract_hash: row.contract_hash,
        underlying_run_id: row.underlying_run_id,
        input_count: Number(row.input_count),
        request: parseJson(row.request_json, {}),
        contract: parseJson(row.contract_json, {}),
        completion: parseJson(row.completion_receipt_json, null),
      },
    }));
  }
  for (const row of source.changes) {
    records.push(record({
      recordType: 'file_change',
      recordId: row.id,
      runId: row.run_id,
      recordedAt: row.started_at,
      eventType: row.change_type,
      decision: row.allowed ? 'allowed' : 'outside_scope',
      payload: {
        path_fingerprint: sha256Buffer(Buffer.from(row.path.toLowerCase(), 'utf8')),
        before_kind: row.before_kind,
        before_hash: row.before_hash,
        after_kind: row.after_kind,
        after_hash: row.after_hash,
      },
    }));
  }
  for (const row of source.materialDerivations) {
    records.push(record({
      recordType: 'material_derivation',
      recordId: `${row.output_material_id}:${row.input_material_id}:${row.relation_type}`,
      runId: row.run_id,
      recordedAt: row.created_at,
      eventType: row.relation_type,
      payload: {
        output_material_id: row.output_material_id,
        input_material_id: row.input_material_id,
        ordinal: row.ordinal,
      },
    }));
  }
  return records.sort((left, right) => (
    String(left.recorded_at).localeCompare(String(right.recorded_at))
    || left.record_type.localeCompare(right.record_type)
    || left.record_id.localeCompare(right.record_id)
  ));
}

function csvCell(value) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeDataset(stageDir, records) {
  const jsonlPath = path.join(stageDir, 'records.jsonl');
  const csvPath = path.join(stageDir, 'records.csv');
  const jsonl = records.map((item) => JSON.stringify(item)).join('\n') + (records.length ? '\n' : '');
  const csvRows = [
    CSV_COLUMNS.join(','),
    ...records.map((item) => CSV_COLUMNS.map((column) => (
      csvCell(column === 'payload_json' ? item.payload : item[column])
    )).join(',')),
  ];
  fs.writeFileSync(jsonlPath, jsonl, { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(csvPath, `${csvRows.join('\r\n')}\r\n`, { encoding: 'utf8', flag: 'wx' });
  return {
    'records.jsonl': { sha256: sha256File(jsonlPath), bytes: fs.statSync(jsonlPath).size },
    'records.csv': { sha256: sha256File(csvPath), bytes: fs.statSync(csvPath).size },
  };
}

export function exportAnalytics({
  ledger,
  stateDir: stateDirInput,
  exportName = null,
} = {}) {
  if (!ledger || typeof ledger.readAnalyticsSource !== 'function') {
    throw new Error('analytics export requires an Atlas Ledger');
  }
  const stateDir = path.resolve(stateDirInput);
  const generatedAt = timestamp();
  const safeName = exportName ?? `EXP-${generatedAt.replace(/[-:.TZ]/gu, '').slice(0, 14)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(safeName)) {
    throw new Error('Analytics export name must use 1-80 letters, numbers, dot, underscore, or hyphen.');
  }
  const exportsRoot = path.join(stateDir, 'analytics', 'exports');
  const outputDir = path.join(exportsRoot, safeName);
  if (!isPathInside(exportsRoot, outputDir)) throw new Error('Analytics export path escapes its state directory.');
  if (fs.existsSync(outputDir)) throw new Error(`Analytics export already exists: ${safeName}`);

  const stageRoot = path.join(stateDir, 'tmp');
  const stageDir = path.join(stageRoot, `analytics-${crypto.randomUUID()}`);
  fs.mkdirSync(exportsRoot, { recursive: true });
  fs.mkdirSync(stageDir, { recursive: false });
  try {
    const source = ledger.readAnalyticsSource();
    const records = publicRecords(source);
    const files = writeDataset(stageDir, records);
    const manifest = {
      export_schema: ANALYTICS_SCHEMA_VERSION,
      ledger_schema: source.ledgerSchema,
      generated_at: generatedAt,
      record_count: records.length,
      source_range: {
        first_recorded_at: records[0]?.recorded_at ?? null,
        last_recorded_at: records.at(-1)?.recorded_at ?? null,
        first_record_id: records[0]?.record_id ?? null,
        last_record_id: records.at(-1)?.record_id ?? null,
      },
      privacy: {
        classification: 'local_private',
        absolute_roots: 'sha256_fingerprint',
        file_paths: 'sha256_fingerprint_in_file_change_records',
      },
      files,
      content_hash: sha256Buffer(Buffer.from(
        Object.entries(files).map(([name, detail]) => `${name}:${detail.sha256}`).join('\n'),
        'utf8',
      )),
    };
    const manifestPath = path.join(stageDir, 'manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    fs.renameSync(stageDir, outputDir);
    return {
      export_schema: ANALYTICS_SCHEMA_VERSION,
      output_dir: outputDir,
      manifest_path: path.join(outputDir, 'manifest.json'),
      record_count: records.length,
      content_hash: manifest.content_hash,
    };
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}
