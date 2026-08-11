const MAX_CONTEXT_CHARACTERS = 900;

function compactPurposes(contextLinks = []) {
  return [...new Set(contextLinks
    .filter((link) => link?.status === 'active' || link?.active === true || link?.status == null)
    .map((link) => link.purpose)
    .filter(Boolean))]
    .slice(0, 4);
}

function compactRules(rules = [], projectId = null) {
  return rules
    .filter((rule) => (
      rule?.status === 'active'
      && rule.scope?.type !== 'artifact'
      && (rule.scope?.type !== 'project' || rule.scope?.key === projectId)
    ))
    .slice(0, 4)
    .map((rule) => {
      const condition = [
        rule.condition?.origin,
        rule.condition?.kind,
        rule.condition?.extension,
        rule.condition?.data_class,
      ].filter(Boolean).join('/');
      const destination = rule.value?.target_subdirectory
        ?? rule.value?.role
        ?? rule.value?.strategy
        ?? rule.value?.directory
        ?? null;
      return `${rule.kind}${condition ? `(${condition})` : ''}${destination ? `→${destination}` : ''}`;
    });
}

function boundedContext(value) {
  if (value.length <= MAX_CONTEXT_CHARACTERS) return value;
  return `${value.slice(0, MAX_CONTEXT_CHARACTERS - 1)}…`;
}

export function buildCodexSessionContext(event, resolution, activeRules = [], pendingTasks = []) {
  if (event?.hook_event_name !== 'SessionStart') return null;
  if (!event.cwd || !resolution) return null;
  if (resolution.status === 'resolved') {
    const purposes = compactPurposes(resolution.context_links);
    const rules = compactRules(activeRules, resolution.project.id);
    const pending = pendingTasks[0] ?? null;
    const taskStatus = pending
      ? `Pending Task: ${pending.task_id} (${pending.task_status}); run \`atlas agent resume ${pending.task_id} --json\`.`
      : 'Task status: idle; do not run another status query.';
    return boundedContext([
      'Atlas manages this Project. Use the installed `atlas-file-governance` Skill for durable file work.',
      `Project: ${resolution.project.id} (${resolution.project.name}); Root: ${resolution.root.id}.`,
      `Context links: ${purposes.length ? purposes.join(', ') : 'none'}.`,
      `Active routes: ${rules.length ? rules.join(', ') : 'none'}.`,
      taskStatus,
      'Atlas supplies local facts, rules, review, verification, and recovery. The Agent remains responsible for semantic judgment and content.',
    ].join('\n'));
  }
  if (resolution.status === 'setup_required' && resolution.root) {
    const candidates = (resolution.project_candidates ?? []).slice(0, 4);
    if (candidates.length) {
      const candidateLines = candidates.map(({ project, location }) => {
        const routes = compactRules(activeRules, project.id);
        return `- ${project.id} (${project.name}) at ${location.relative_path}; routes: ${routes.length ? routes.join(', ') : 'none'}.`;
      });
      return boundedContext([
        'Atlas recognizes this Workspace Root. The current directory is a Project container, not one Project.',
        `Root: ${resolution.root.id}.`,
        'Project candidates:',
        ...candidateLines,
        'The Agent must select the candidate from the user task; do not rescan when these facts are sufficient. Do not write until one Project is selected.',
      ].join('\n'));
    }
    return boundedContext([
      'Atlas recognizes this Workspace Root, but the current directory is not attached to a Project.',
      `Root: ${resolution.root.id}.`,
      'Use the installed `atlas-file-governance` Skill and perform only the returned Project Location setup action before durable file work.',
    ].join('\n'));
  }
  return null;
}

export function codexSessionStartOutput(event, resolution, activeRules = [], pendingTasks = []) {
  const additionalContext = buildCodexSessionContext(event, resolution, activeRules, pendingTasks);
  if (!additionalContext) return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
}

export const CODEX_HOOK_CONTEXT_LIMIT = MAX_CONTEXT_CHARACTERS;
