export const ATLAS_VERSION = '1.9.0-rc.1';
export const PROTOCOL_VERSION = 'atlas-cli.v1';
export const MODULE_PROTOCOL_VERSION = 'atlas.module.v1';

// Current callable additions. CLI help and Host discovery consume this same data.
export const CURRENT_COMMAND_GUIDE = Object.freeze([
  { commands: ['handoff create', 'handoff list', 'handoff show', 'handoff read'],
    purpose: 'Read or create a bounded continuation for an existing Table Work.',
    required: '--project; create also --request-file; show/read also handoff_id',
    returns: 'handoff_id, digest, status, current Work revision and bounded context',
    on_failure: 'Read current Work and source status; resolve stale facts before creating a new Handoff.',
    example: 'atlas handoff list --project <project_id> --json' },
  { commands: ['module list', 'module package-preview', 'module package-list', 'module install', 'module preview', 'module save', 'module enable', 'module disable'],
    purpose: 'Discover processing availability and explicitly manage trusted local Module packages.',
    required: 'preview/save: module_id, --project, --resource; mutations require current revision or package hash and request key',
    returns: 'Module identity, availability revision, package preview or transformation/Save result',
    on_failure: 'Read module list/package-preview again; do not bypass disabled modules or package hash checks.',
    example: 'atlas module list --json' },
  { commands: ['project move prepare', 'project move show', 'project move execute', 'project move undo', 'project move recover'],
    purpose: 'Preview and perform a supported same-Root Project tree move.',
    required: '--request-file; show/execute/undo/recover also move_id; mutations bind expectedRevision and expectedDigest',
    returns: 'move_id, revision, digest, preview, status and recovery facts',
    on_failure: 'Read show; retain pending journal and use recover only for the recorded operation. Never force overwrite.',
    example: 'atlas project move show <move_id> --request-file <project-request.json> --json' },
  { commands: ['project membership prepare', 'project membership show', 'project membership execute', 'project membership undo', 'project membership recover'],
    purpose: 'Preview supported Project split/merge or partition_existing without moving files.',
    required: '--request-file; actions after prepare also operation_id; mutations bind expectedRevision and expectedDigest',
    returns: 'operation_id, revision, digest, boundary and file-change preview, status',
    on_failure: 'Read show and conflicts; preserve files and current boundaries; recover only the pending recorded operation.',
    example: 'atlas project membership show <operation_id> --request-file <project-request.json> --json' },
  { commands: ['document update inspect', 'document update prepare', 'document update show', 'document update decide', 'document update execute', 'document update undo', 'document update recover', 'document update batch prepare', 'document update batch show', 'document update batch advance'],
    purpose: 'Review and update an existing UTF-8 Markdown/text Resource; preserve external later edits.',
    required: '--project; inspect/prepare also --resource; writes require request key and caller; execute/undo/recover bind expected revision and current SHA-256',
    returns: 'operation identity, revision, baseline, Diff, decision, file and recovery status',
    on_failure: 'Read current operation; retain later edits; Windows NTFS/TxF is required for writes.',
    example: 'atlas capabilities --json' },
  { commands: ['table-work focus', 'table-work details', 'content locate', 'content read-ref', 'view row-candidates submit', 'view row-candidates show'],
    purpose: 'Continue analysis with bounded detail, exact version-bound content references and row candidate decisions.',
    required: 'Work actions: session_id and --base-revision; content references: --project and Resource/ref; candidates: --project',
    returns: 'current revision, bounded rows/references or candidate batch and decisions',
    on_failure: 'Read current Work/Resource; regenerate references after source changes; never use sorting position as row identity.',
    example: 'atlas table-work details <session_id> --base-revision <revision> --offset 0 --limit 20 --json' },
]);

export function currentCommandHelp() {
  return CURRENT_COMMAND_GUIDE.map(item => `  ${item.example}\n    ${item.purpose}\n    Required: ${item.required}\n    Returns: ${item.returns}\n    On failure: ${item.on_failure}`).join('\n');
}

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
    handoff: ['create', 'list', 'show', 'read'],
    module: ['list', 'package-preview', 'package-list', 'install', 'preview', 'save', 'enable', 'disable'],
    project_membership: ['prepare', 'show', 'execute', 'undo', 'recover'],
    project_move: ['prepare', 'show', 'execute', 'undo', 'recover'],
    document_update: ['inspect', 'prepare', 'show', 'decide', 'execute', 'undo', 'recover', 'batch prepare', 'batch show', 'batch advance'],
    ui: ['start', 'install', 'doctor', 'remove'],
    inspect: ['workspace'],
    portfolio: ['inventory', 'show', 'review', 'plan'],
    bootstrap: ['profiles', 'scan', 'recommend', 'contract', 'adopt', 'context', 'propose', 'status', 'show', 'review', 'initialize', 'connect'],
    tracked_direct: ['begin', 'close', 'status', 'show', 'abort', 'rollback', 'gc'],
    guarded: ['prepare', 'preview', 'approve', 'apply-approved', 'reject', 'revise', 'execute', 'rollback'],
    derived: ['recommend', 'prepare', 'preview', 'approve', 'reject', 'revise', 'execute', 'promote', 'rollback'],
    intake: ['prepare', 'show', 'correct', 'batch-plan', 'corrections'],
    save: ['plan', 'prepare', 'review', 'show', 'execute', 'undo', 'redo', 'directory-prepare', 'directory-show'],
    table_work: ['start', 'show', 'reuse', 'reconcile', 'reconcile-batch', 'add-source', 'remove-source', 'prepare', 'sheet', 'align', 'recipe', 'preview', 'save', 'list'],
    board: ['list', 'create', 'show', 'save', 'export'],
    round: ['list', 'show', 'protect', 'extend', 'checkpoint', 'restore', 'return', 'resume'],
    resource_views: ['list', 'evaluate', 'files', 'candidates-submit', 'candidates-show', 'row-candidates-submit', 'row-candidates-show', 'properties', 'save'],
    resource_facts: ['show'],
    evolution: [
      'prepare', 'preview', 'approve', 'reject', 'execute', 'rollback',
      'plan-prepare', 'plan-preview', 'plan-approve', 'plan-reject', 'plan-execute', 'plan-rollback',
    ],
    capture: ['fetch', 'localize', 'sample', 'source-prepare', 'source-inspect-export', 'source-prepare-export', 'source-show', 'source-read'],
    content: ['inspect', 'compare', 'branches', 'prepare-data', 'localize-conversation'],
    work: ['stage', 'status', 'release'],
    storage: ['status', 'plan', 'execute'],
    ledger: ['backups', 'restore'],
    workspace_root: ['adopt', 'list', 'show', 'relocate'],
    catalog: ['update', 'search'],
    registry: [
      'create', 'list', 'show', 'evolve', 'move', 'merge',
      'resolve', 'attach-root', 'relocate', 'link-context', 'context-links', 'unlink-context',
    ],
    rules: ['list', 'show', 'active', 'history', 'context', 'propose', 'preview', 'approve', 'reject'],
    risk: ['evaluate'],
  },
  product_entrypoints: {
    current_product: {
      status: 'supported_current',
      commands: [
        ...CURRENT_COMMAND_GUIDE.flatMap(item => item.commands),
        'ui', 'ui install', 'ui doctor', 'ui remove',
        'save plan', 'save prepare', 'save review', 'save show', 'save execute', 'save undo', 'save redo', 'save directory prepare', 'save directory show',
        'table-work start', 'table-work show', 'table-work reuse', 'table-work reconcile', 'table-work reconcile-batch', 'table-work add-source', 'table-work remove-source',
        'table-work prepare', 'table-work sheet', 'table-work align', 'table-work recipe', 'table-work preview', 'table-work save', 'table-work list',
        'board list', 'board create', 'board show', 'board save', 'board export',
        'view list', 'view evaluate', 'view files', 'view properties', 'view candidates submit', 'view candidates show', 'view save',
        'content localize-conversation',
        'capture source prepare', 'capture source show', 'capture source read',
        'capture source inspect-export', 'capture source prepare-export',
        'resource show',
      ],
      purpose: 'Current Project/Resource work, processing, verified saving, source capture, reviewed evolution and bounded Host continuation.',
      command_guide: CURRENT_COMMAND_GUIDE,
    },
    supporting_foundation: {
      status: 'internal_or_host_support',
      commands: [
        'inspect', 'content', 'capture', 'work', 'storage', 'ledger',
        'workspace_root', 'registry', 'rules', 'risk', 'catalog',
      ],
      purpose: 'Deterministic local facts and services used by current or planned product flows.',
    },
    developer_diagnostic: {
      status: 'not_a_user_workflow',
      commands: ['doctor', 'portfolio'],
      purpose: 'Development, installation, and Ledger diagnostics.',
    },
    internal_foundation: {
      status: 'not_a_product_entrypoint',
      commands: ['bootstrap', 'tracked_direct', 'guarded', 'derived', 'intake', 'evolution'],
      purpose: 'Existing local safety services retained only where current code still consumes them.',
    },
  },
  legacy_fallback: false,
  document_update: {
    batch: 'same_Project_1_to_20_reviewed_current_distinct_Resources; one_item_per_advance; frozen_manifest_revision_digest; persistent_partial_progress; no_implicit_recovery',
    recovery_guard: 'pending_UPD_blocks_round_mutations; pending_round_blocks_batch; changed_round_history_requires_new_batch',
    formats: ['md', 'txt'],
    confirmation: 'suggestion_decision_then_explicit_apply',
    write_support: 'Windows_NTFS_with_TxF_only; unsupported_fails_closed',
    identity: 'same_Resource_and_file_identity',
    recovery: 'explicit_revision_and_current_hash_bound; never_retries_write',
    undo: 'refuses_later_document_changes',
  },
  round_recovery: {
    status: 'experimental',
    scope: [
      'declared_regular_files_not_registered_as_resources',
      'explicit_active_single_location_resources_with_declared_paths',
      'explicit_open_work_sessions_with_declared_resource_sources',
      'existing_boards_with_text_and_explicit_material_references',
      'explicit_executed_save_files_sources_work_and_result_preview_boards',
      'new_save_outputs_in_predeclared_absent_slots_with_identity_and_receipt_retention',
    ],
    protect_request: {
      paths: '0_to_64_exact_project_relative_files_at_least_one_file_or_board',
      resourceIds: 'optional_up_to_64_active_same_project_single_location_resources; each active file path must be declared in paths',
      workIds: 'optional_up_to_20_open_same_project_work_sessions; every Work Source Resource must be in resourceIds',
      saveIds: 'optional_up_to_64_executed_same_project_saves; output, inputs, Source Resources, Work and consuming Boards must be explicitly selected; receipt remains unchanged',
      saveTargets: 'optional_exact_absent_paths_also_in_paths; declare_before_any_Save_for_the_path; completed_Save_identity_is_read_from_existing_receipt',
    },
    work_restore: {
        restores: ['source_configuration', 'mapping', 'recipe', 'latest_save_pointer'],
      revision: 'advances',
      preview: 'cleared',
    },
    resource_restore: {
      restores: 'accepted_baseline',
      audit: 'appends_round_restore_without_deleting_original_action',
    },
    unsupported: [
      'cross_project_recovery', 'moved_or_multi_location_or_missing_resources',
        'save_undo_redo_status_transition_during_round', 'new_save_without_predeclared_output_slot', 'undeclared_material_reference',
      'conversation', 'unsaved_editor_buffers',
    ],
    mutation_basis: ['baseRevision', 'expectedDigest_from_fresh_show'],
    extension: 'explicit_additions_before_modification; old_nodes_keep_original_state; added_objects_use_their_first_protected_baseline',
    restore_creates_insurance: true,
    return_target: 'specific_restore_id',
    ui_available: true,
  },
  table_work: {
    session: 'persistent_project_work_session',
    source_formats: ['csv', 'xlsx'],
    semantic_authority: 'user_or_host_proposal',
    deterministic_execution: 'atlas_local_processor',
    save_service_required: true,
  },
  board: {
    block_types: ['material_reference', 'text', 'result_preview'],
    version_policies: ['follow_latest', 'pinned_version'],
    portable_delivery: 'self_contained_html_via_save_service',
    semantic_authority: 'user_or_host_proposal',
  },
  resource_views: {
    modes: ['files', 'table', 'cards'],
    host_access: 'read_write_views_and_submit_bounded_candidates',
    evaluation_completeness: ['complete', 'partial', 'unknown'],
    semantic_property_write: 'candidate_preview_with_user_decision',
    property_candidate_limit: 10,
    property_kinds: ['text', 'single', 'multi'],
    list_files_scope: 'explicit_required',
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
  cross_project_context: {
    status: 'callable',
    setup_preflight: 'structured_required_actions',
    root_identity: 'stable_root_id_with_path_history',
    project_location: 'one_active_location_per_project',
    context_links: 'versioned_and_reusable',
    candidate_selection: 'local_incremental_catalog',
    resource_selection: 'explicit_local_inputs',
    read_boundary: 'multiple_adopted_roots',
    write_boundary: 'one_target_root',
    cross_project_work: 'planned_for_current_product_routes',
    project_identity: 'local_git_remote_and_manifest_signals',
    location_recovery: 'exact_candidate_verification_without_drive_scan',
    root_location_recovery: 'project_identity_anchors_and_relative_paths',
    project_location_recovery: 'project_identity_exact_candidate',
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
  desktop_ui_component: {
    format: 'atlas-desktop-ui-component.v1',
    mode: 'optional_managed_python_venv',
    minimum_python: '3.11',
    renderer: 'webview2',
    transport: 'loopback_url_only',
    external_browser_default: false,
    browser_debug_flag: '--browser',
    ledger_access: false,
    library_access: false,
    lifecycle: ['install', 'doctor', 'remove'],
  },
  browser_capture: {
    bridge: 'installed_skill_script',
    public_http_fetch: 'bounded_static_text_without_browser_or_credentials',
    public_http_max_bytes: 8388608,
    localize_output: 'managed_work_candidate',
    default_model_visible_body_bytes: 0,
    maximum_sample_characters: 4000,
    completeness_must_be_reported: true,
    chat_normalization: {
      schema: 'atlas.chat-message.v1',
      output: 'managed_jsonl_work',
      fields: [
        'conversation_id', 'message_id', 'parent_message_id', 'ordinal', 'timestamp',
        'role', 'content', 'source', 'source_url',
      ],
      deterministic_id_fallback: true,
      compatible_relationship_processor: 'atlas.content-relationship.v1',
      branch_set: {
        schema: 'atlas.chat-branch-set.v1',
        input: '2_to_12_normalized_jsonl_files',
        output: 'deduplicated_local_prefix_tree',
        model_visible_body_bytes: 0,
      },
    },
  },
  local_content_inspection: {
    schema: 'atlas.content-inspection.v1',
    processor: 'optional_python_with_pandas_sqlite_for_tabular_profiles',
    supported_extensions: [
      '.txt', '.md', '.markdown', '.json', '.jsonl', '.xml', '.yaml', '.yml',
      '.html', '.htm', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.sql',
      '.csv', '.tsv', '.xlsx', '.pdf', '.pptx', '.docx',
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
  local_content_relationship: {
    xlsx_details: 'two_XLSX_inputs_explicit_left_sheet_and_right_sheet; raw_cells_only; formulas_errors_merges_refused; compressed_input_16MiB',
    schema: 'atlas.content-relationship.v1',
    processor: 'optional_python_deterministic_text_table_and_jsonl_comparison',
    command: 'content compare',
    inputs: 'two_exact_regular_files',
    outputs: ['identical', 'left_contained_by_right', 'right_contained_by_left', 'overlap', 'independent', 'unknown'],
    message_identity: 'message_id_plus_semantic_message_hash',
    timestamp_basis: 'record_timestamp_only',
    returns_file_bodies: false,
    detailed_output: 'explicit_--details_only; bounded_MD_TXT_blocks_CSV_TSV_XLSX_keyed_rows_and_JSONL_message_facts',
    returns_file_bodies_with_details: 'bounded_samples_only',
    detailed_table_keys: 'explicit_key_column_and_optional_literal_period_column; duplicates_or_empty_keys_are_uncertain',
    detailed_time_sources: ['current_file_mtime', 'explicit_ISO_event_date_column_or_JSONL_record_timestamp', 'literal_business_period_column'],
    detailed_limits: { input_bytes: 262144, xlsx_input_bytes: 16777216, text_blocks: 2000, records: 10000, columns: 50, entries: 100, entry_characters: 2000, returned_characters: 24000 },
    network_used: false,
    browser_used: false,
    screenshots_used: 0,
  },
  local_data_workspace: {
    schema: 'atlas.data-workspace.v1',
    status: 'experimental_unreleased',
    processor: 'optional_python_pandas_local_review_workspace',
    command: 'content prepare-data',
    supported_extensions: ['.csv', '.tsv', '.xlsx'],
    outputs: ['manifest.json', 'profile.json', 'quality.json', 'transform-plan.json', 'normalized.csv', 'review.html'],
    source_files_modified: false,
    model_visible_body_bytes: 0,
    browser_used: false,
    screenshots_used: 0,
    product_evidence: 'local_fixture_only',
    token_savings_claim: false,
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
    'migrate_cross_root',
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
