import path from 'node:path';

function rulesForProject(activeRules, projectId) {
  return activeRules.filter((rule) => (
    rule.status === 'active'
    && rule.scope?.type !== 'artifact'
    && (rule.scope?.type !== 'project' || rule.scope?.key === projectId)
  )).slice(0, 8);
}

function ruleAppliesToProject(rule, projectId) {
  return rule.scope?.type !== 'artifact'
    && (rule.scope?.type !== 'project' || rule.scope?.key === projectId);
}

function ruleSeriesKey(rule) {
  return JSON.stringify({
    scope: rule.scope,
    kind: rule.kind,
    condition: rule.condition ?? {},
  });
}

function changedValueFields(before, after) {
  const keys = [...new Set([
    ...Object.keys(before?.value ?? {}),
    ...Object.keys(after?.value ?? {}),
  ])].sort();
  return keys.filter((key) => JSON.stringify(before?.value?.[key]) !== JSON.stringify(after?.value?.[key]));
}

function ruleHistorySummary(history, projectId) {
  const relevant = history.filter((rule) => ruleAppliesToProject(rule, projectId));
  const series = new Map();
  for (const rule of relevant) {
    const key = ruleSeriesKey(rule);
    const items = series.get(key) ?? [];
    items.push(rule);
    series.set(key, items);
  }
  const recent = [...relevant]
    .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))
    .slice(0, 12)
    .map((rule) => {
      const sequence = (series.get(ruleSeriesKey(rule)) ?? [])
        .sort((left, right) => String(left.created_at ?? '').localeCompare(String(right.created_at ?? '')));
      const index = sequence.findIndex((item) => (item.rule_id ?? item.id) === (rule.rule_id ?? rule.id));
      const previous = index > 0 ? sequence[index - 1] : null;
      return {
        rule_id: rule.rule_id ?? rule.id,
        rule_version_id: rule.rule_version_id ?? null,
        status: rule.status,
        kind: rule.kind,
        scope: rule.scope,
        summary: rule.summary ?? null,
        created_at: rule.created_at,
        superseded_at: rule.superseded_at ?? null,
        previous_rule_id: previous?.rule_id ?? previous?.id ?? null,
        changed_value_fields: changedValueFields(previous, rule),
      };
    });
  return {
    active_count: relevant.filter((rule) => rule.status === 'active').length,
    superseded_count: relevant.filter((rule) => rule.status === 'superseded').length,
    recent,
    truncated: relevant.length > recent.length,
  };
}

function normalizeTask(task) {
  return {
    task_id: task.task_id,
    task_status: task.task_status,
    intent: task.intent,
    target: task.target,
    strategy: task.strategy,
    write_mode: task.write_mode,
    write_status: task.write_status,
    started_at: task.started_at,
    closed_at: task.closed_at ?? null,
    rolled_back_at: task.rolled_back_at ?? null,
    primary_source: task.primary_source ?? null,
    selected_source_count: task.selected_source_count ?? 0,
    source_set_id: task.source_set_id ?? null,
    source_freshness: task.source_set_id
      ? { status: 'not_checked', reason_code: 'explicit_refresh_required' }
      : { status: 'unavailable', reason_code: 'task_has_no_source_set' },
  };
}

function tasksForProject(registry, projectId) {
  const repository = registry.ledger?.tasks;
  const all = repository?.listForUiByProject
    ? repository.listForUiByProject(projectId, { limit: 500 })
    : (repository?.listPendingByProject(projectId, { limit: 8 }) ?? []);
  return all.map(normalizeTask);
}

function projectEntry(registry, activeRules, ruleHistory, project, location, relationship) {
  const tasks = tasksForProject(registry, project.id);
  const pending = tasks.filter((task) => !['completed', 'rolled_back', 'rejected', 'cancelled', 'blocked'].includes(task.task_status));
  return {
    relationship,
    project,
    location,
    task_status: pending.length ? `${pending[0].task_status} / ${pending[0].task_id}` : 'idle',
    pending_tasks: pending,
    tasks,
    task_history_truncated: tasks.length >= 500,
    routes: rulesForProject(activeRules, project.id),
    rule_history: ruleHistorySummary(ruleHistory, project.id),
  };
}

function processorCapabilities(runtime) {
  if (!runtime) return [];
  const pythonReady = ['ready', 'available'].includes(runtime.python?.status);
  return [
    { id: 'direct_text_catalog', status: 'ready', runtime: 'node', network_used: false },
    { id: 'public_web_capture', status: 'ready', runtime: 'node', network_used: true },
    { id: 'document_extraction', status: pythonReady ? 'ready' : 'unavailable', runtime: 'python', network_used: false },
    { id: 'tabular_profile', status: pythonReady ? 'ready' : 'unavailable', runtime: 'python+pandas+sqlite', network_used: false },
    { id: 'chat_branch_deduplication', status: pythonReady ? 'ready' : 'unavailable', runtime: 'python', network_used: false },
    { id: 'visual_preview', status: 'deferred', runtime: null, network_used: false },
  ];
}

export function buildContextModel({ currentPath, registry, rules, runtime = null }) {
  if (!currentPath || !registry || !rules) {
    throw new Error('Atlas UI context model requires currentPath, Registry and rules.');
  }
  const resolvedPath = path.resolve(currentPath);
  const resolution = registry.resolvePath(resolvedPath);
  const activeRules = resolution.root
    ? rules.active({ root: resolution.root.current_path })
    : [];
  const ruleHistory = resolution.root && typeof rules.history === 'function'
    ? rules.history({ root: resolution.root.current_path })
    : activeRules;
  let projects = [];
  let overview = false;
  if (resolution.status === 'resolved') {
    projects = [projectEntry(
      registry, activeRules, ruleHistory, resolution.project, resolution.location, 'Current Project',
    )];
  } else {
    projects = (resolution.project_candidates ?? []).slice(0, 8).map(({ project, location }) => (
      projectEntry(registry, activeRules, ruleHistory, project, location, 'Candidate')
    ));
  }
  if (!projects.length && typeof registry.list === 'function' && typeof registry.show === 'function') {
    overview = true;
    projects = registry.list().filter((project) => project.status === 'active').slice(0, 24).flatMap((project) => {
      const detail = registry.show(project.id);
      if (!detail.location?.root_path) return [];
      const projectRules = rules.active({ root: detail.location.root_path });
      const history = typeof rules.history === 'function'
        ? rules.history({ root: detail.location.root_path })
        : projectRules;
      return [projectEntry(registry, projectRules, history, project, detail.location, 'Managed Project')];
    });
  }
  return {
    schema: 'atlas-ui-context-model.v1',
    generated_at: new Date().toISOString(),
    current_path: resolvedPath,
    resolution_status: overview ? 'overview' : resolution.status,
    status_label: resolution.status === 'resolved'
      ? 'Atlas resolved the current Project.'
      : (projects.length
        ? (resolution.root
          ? 'Atlas found Project candidates under this Workspace Root.'
          : 'Atlas shows managed Projects because the launch directory is not registered.')
        : 'Atlas needs Root or Project Location setup.'),
    root: resolution.root ? { id: resolution.root.id, current_path: resolution.root.current_path } : null,
    projects,
    runtime: runtime ? { ...runtime, processors: processorCapabilities(runtime) } : null,
  };
}
