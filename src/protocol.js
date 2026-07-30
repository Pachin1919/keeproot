export const ATLAS_VERSION = '1.2.0';
export const PROTOCOL_VERSION = 'atlas-cli.v1';

export const CAPABILITIES = Object.freeze({
  protocol_version: PROTOCOL_VERSION,
  atlas_version: ATLAS_VERSION,
  transport: 'local-process-stdio',
  state: 'local-sqlite',
  runtime_installation: {
    format: 'atlas-runtime-install.v1',
    minimum_node_major: 24,
    mode: 'user_scope_offline_copy',
    user_skill: 'atlas-file-governance',
    state_outside_governed_library: true,
  },
  json_flag: '--json',
  workflows: {
    inspect: ['workspace'],
    portfolio: ['inventory', 'show', 'review', 'plan'],
    bootstrap: ['profiles', 'scan', 'recommend', 'contract', 'adopt', 'context', 'propose', 'status', 'show', 'review', 'initialize'],
    tracked_direct: ['begin', 'close', 'status', 'show', 'abort', 'rollback', 'gc'],
    guarded: ['prepare', 'preview', 'approve', 'apply-approved', 'reject', 'revise', 'execute', 'rollback'],
    derived: ['recommend', 'prepare', 'preview', 'approve', 'reject', 'revise', 'execute', 'promote', 'rollback'],
    intake: ['prepare', 'show', 'execute', 'rollback', 'correct', 'batch-plan', 'corrections'],
    evolution: [
      'prepare', 'preview', 'approve', 'reject', 'execute', 'rollback',
      'plan-prepare', 'plan-preview', 'plan-approve', 'plan-reject', 'plan-execute', 'plan-rollback',
    ],
    task: ['discover', 'prepare', 'show', 'fulfill', 'archive-plan', 'complete', 'review-rule', 'rollback'],
    capture: ['localize', 'sample'],
    work: ['stage', 'status', 'release'],
    storage: ['status', 'plan', 'execute'],
    ledger: ['backups', 'restore'],
    analytics: ['install', 'export', 'evaluate', 'show', 'remove'],
    registry: ['create', 'list', 'show', 'evolve', 'move', 'merge'],
    rules: ['list', 'show', 'active', 'history', 'context', 'propose', 'preview', 'approve', 'reject'],
    risk: ['evaluate'],
  },
  guarded_operations: ['single_existing_file_update'],
  derived_operations: ['classified_single_file_create'],
  derived_relation_types: [
    'derived_from', 'summarizes', 'transforms', 'merges', 'extracts_from',
    'supersedes', 'delta_of', 'overlaps', 'appends_to',
  ],
  task_data_classes: ['generated_output', 'temporal_snapshot', 'append_only_data', 'human_writing'],
  task_write_strategies: ['create', 'append', 'delta', 'new_version', 'supersede', 'archive', 'deny'],
  task_registration_records: [
    'output_artifact', 'output_material', 'input_material_lineage',
    'actual_hash', 'write_run', 'rollback_entry',
  ],
  derived_roles: [
    'unclassified', 'raw_input', 'source', 'note', 'journal', 'draft', 'intermediate',
    'report', 'canonical', 'index', 'template', 'archive',
  ],
  derived_role_policy: 'closed_v1_vocabulary',
  bootstrap_library_profiles: ['mixed-minimal', 'personal-knowledge', 'project-work', 'research-writing'],
  bootstrap_scan_modes: ['structure', 'metadata'],
  portfolio_root_types: [
    'managed_library', 'source_repository', 'project_workspace', 'workspace_container', 'shared_asset',
    'installed_application', 'portable_application', 'tool_source', 'package_store',
    'tool_runtime', 'generated_cache', 'system_managed', 'archive_backup', 'unknown',
  ],
  portfolio_relations: ['related', 'infrastructure', 'unrelated', 'excluded', 'unresolved'],
  portfolio_inventory_depth: {
    minimum: 1,
    maximum: 2,
    content_files_read: 0,
    depth_two_requires_explicit_expand: true,
  },
  intake_origins: ['human_submitted', 'human_written', 'agent_generated', 'download'],
  intake_placement_modes: ['profile_route', 'reviewed_correction', 'agent_explicit_target'],
  preference_rule_kinds: [
    'naming', 'placement', 'directory_role', 'storage',
    'content_versioning', 'project_type', 'agent_output',
  ],
  effective_rule_context: {
    maximum_active_rules: 12,
    default_visual_images: 0,
    maximum_visual_images: 8,
    maximum_visual_resolution: '768x432',
  },
  analytics_export: {
    schema: 'atlas.analytics.v1',
    formats: ['jsonl', 'csv'],
    ledger_access: 'node_consistent_read',
    python_access: 'export_files_only',
  },
  analytics_evaluation: {
    schema: 'atlas.analytics.evaluation.v1',
    current_status: 'ready_for_interpretation',
    python_required: true,
    official_metrics: [
      'context_selection_text_byte_rate',
      'recovery_outcome_distribution',
      'rule_reuse_rate',
    ],
    outputs: [
      'manifest.json',
      'measurement-gaps.json',
      'quality.json',
      'metrics.json',
      'anomalies.jsonl',
      'analysis_context.md',
      'report.md',
    ],
  },
  analytics_component: {
    format: 'atlas-analytics-component.v1',
    mode: 'optional_managed_python_venv',
    minimum_python: '3.11',
    network_install_required: true,
    runtime_network_required: false,
    lifecycle: ['install', 'doctor', 'remove'],
  },
  browser_capture: {
    bridge: 'installed_skill_script',
    localize_output: 'managed_work_candidate',
    default_model_visible_body_bytes: 0,
    maximum_sample_characters: 4000,
    completeness_must_be_reported: true,
  },
  intake_kinds: [
    'unclassified', 'raw_input', 'source', 'note', 'journal', 'draft', 'intermediate',
    'report', 'canonical', 'index', 'template', 'archive', 'code', 'demo', 'asset',
  ],
  evolution_operations: [
    'create_directory',
    'move_file',
    'migrate_project',
    'migrate_directory',
    'remove_empty_directory',
  ],
  caller_fields: ['actor', 'agent', 'model', 'tool', 'client_run_id'],
});

export function successEnvelope(command, data) {
  return {
    protocol_version: PROTOCOL_VERSION,
    atlas_version: ATLAS_VERSION,
    ok: true,
    command,
    data,
  };
}

function classifyMessage(message) {
  if (/must remain inside|escapes the root|outside the .* root|resolves outside|symbolic link|junction/i.test(message)) {
    return 'ATLAS_PATH_BOUNDARY';
  }
  if (/not found|does not exist/i.test(message)) return 'ATLAS_NOT_FOUND';
  if (/requires|unknown .* argument|does not accept|accepts at most|pass .* not both|must be one of|must be a supported role| is invalid/i.test(message)) {
    return 'ATLAS_INVALID_ARGUMENT';
  }
  if (/approval|current status|changed (during|after)|no longer match|conflict/i.test(message)) {
    return 'ATLAS_STATE_CONFLICT';
  }
  return 'ATLAS_COMMAND_FAILED';
}

export function errorEnvelope(command, error) {
  const code = error?.code ?? classifyMessage(error?.message ?? String(error));
  const details = {};
  if (Array.isArray(error?.conflicts)) details.conflicts = error.conflicts;
  return {
    protocol_version: PROTOCOL_VERSION,
    atlas_version: ATLAS_VERSION,
    ok: false,
    command: command ?? null,
    error: {
      code,
      message: error?.message ?? String(error),
      retryable: false,
      ...(Object.keys(details).length ? { details } : {}),
    },
  };
}

export function callerFromOptions(options = {}) {
  return {
    actor: options.actor ?? 'unknown',
    agent: options.agent ?? null,
    model: options.model ?? null,
    tool: options.tool ?? 'atlas-cli',
    client_run_id: options.clientRunId ?? null,
  };
}
