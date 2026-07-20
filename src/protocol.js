export const ATLAS_VERSION = '0.1.0';
export const PROTOCOL_VERSION = 'atlas-cli.v1';

export const CAPABILITIES = Object.freeze({
  protocol_version: PROTOCOL_VERSION,
  atlas_version: ATLAS_VERSION,
  transport: 'local-process-stdio',
  state: 'local-sqlite',
  json_flag: '--json',
  workflows: {
    bootstrap: ['profiles', 'scan', 'recommend', 'context', 'propose', 'status', 'show', 'review', 'initialize'],
    tracked_direct: ['begin', 'close', 'status', 'show', 'abort', 'rollback', 'gc'],
    guarded: ['prepare', 'preview', 'approve', 'reject', 'revise', 'execute', 'rollback'],
    derived: ['recommend', 'prepare', 'preview', 'approve', 'reject', 'revise', 'execute', 'promote', 'rollback'],
    work: ['stage', 'status', 'release'],
    storage: ['status', 'plan', 'execute'],
    registry: ['create', 'list', 'show', 'move', 'merge'],
    rules: ['list', 'show'],
    risk: ['evaluate'],
  },
  guarded_operations: ['single_existing_file_update'],
  derived_operations: ['classified_single_file_create'],
  derived_relation_types: ['derived_from', 'summarizes', 'transforms', 'merges', 'extracts_from'],
  derived_roles: [
    'unclassified', 'raw_input', 'source', 'note', 'journal', 'draft', 'intermediate',
    'report', 'canonical', 'index', 'template', 'archive',
  ],
  derived_role_policy: 'closed_v1_vocabulary',
  bootstrap_library_profiles: ['mixed-minimal', 'personal-knowledge', 'project-work', 'research-writing'],
  bootstrap_scan_modes: ['structure', 'metadata'],
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
  if (/approval|current status|changed during|no longer match|conflict/i.test(message)) {
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
