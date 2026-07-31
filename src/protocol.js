export const ATLAS_VERSION = '1.3.3';
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
    task: [
      'discover', 'prepare', 'discover-context', 'context-candidates',
      'prepare-context', 'source-set', 'show', 'fulfill', 'archive-plan',
      'complete', 'review-rule', 'rollback',
    ],
    capture: ['localize', 'sample'],
    content: ['inspect'],
    work: ['stage', 'status', 'release'],
    storage: ['status', 'plan', 'execute'],
    ledger: ['backups', 'restore'],
    analytics: ['install', 'export', 'evaluate', 'show', 'remove'],
    workspace_root: ['adopt', 'list', 'show'],
    catalog: ['update', 'search'],
    registry: [
      'create', 'list', 'show', 'evolve', 'move', 'merge',
      'attach-root', 'link-context', 'context-links', 'unlink-context',
    ],
    rules: ['list', 'show', 'active', 'history', 'context', 'propose', 'preview', 'approve', 'reject'],
    risk: ['evaluate'],
  },
  guarded_operations: ['single_existing_file_update'],
  guarded_review: {
    path: 'state_work_read_only_copy',
    authoritative_source: 'candidate_blob',
  },
  derived_operations: ['classified_single_file_create'],
  derived_relation_types: [
    'derived_from', 'summarizes', 'transforms', 'merges', 'extracts_from',
    'supersedes', 'delta_of', 'overlaps', 'appends_to',
  ],
  task_data_classes: ['generated_output', 'temporal_snapshot', 'append_only_data', 'human_writing'],
  cross_project_context: {
    status: 'callable',
    setup_preflight: 'structured_required_actions',
    root_identity: 'stable_root_id_with_path_history',
    project_location: 'one_active_location_per_project',
    context_links: 'versioned_and_reusable',
    candidate_selection: 'local_incremental_catalog',
    source_set: 'immutable_selected_inputs',
    read_boundary: 'multiple_adopted_roots',
    write_boundary: 'one_target_root',
    multi_root_task_contract: true,
  },
  local_catalog: {
    schema: 'atlas-catalog-candidates.v1',
    indexed_extensions: ['.md', '.markdown', '.txt'],
      search: 'sqlite_fts5_trigram_with_local_short_term_fallback',
    incremental: true,
    model_visible_full_body: false,
    processor: {
      name: 'atlas-direct-text',
      version: '1.0.0',
      cache_key: 'size_mtime_parser_version_with_hash_revalidation_on_selection',
    },
  },
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
  local_content_inspection: {
    schema: 'atlas.content-inspection.v1',
    processor: 'optional_python_with_pandas_sqlite_for_tabular_profiles',
    supported_extensions: [
      '.txt', '.md', '.markdown', '.json', '.jsonl', '.xml', '.yaml', '.yml',
      '.html', '.htm', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.sql',
      '.csv', '.tsv', '.xlsx', '.pptx', '.docx',
    ],
    exact_file_only: true,
    network_used: false,
    browser_used: false,
    external_application_used: false,
    screenshots_used: 0,
    tabular_profile: {
      purpose: 'data',
      exact_sheet_required_for_xlsx: true,
      engine: 'pandas+sqlite',
      returns_raw_rows: false,
    },
    visual_fallback: {
      maximum_images: 4,
      maximum_resolution: '640x360',
      only_when_purpose_is_visual: true,
    },
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
  const details = error?.details && typeof error.details === 'object'
    ? { ...error.details }
    : {};
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
