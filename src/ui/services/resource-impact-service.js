import path from 'node:path';
import { savedResultFreshness, savedResultState, sourceVersionPolicy } from './saved-work-service.js';

function sourceChangeState(resource, source) {
  if (['missing', 'changed', 'moved'].includes(source?.status)) return source.status;
  if (['missing', 'changed'].includes(resource?.external_change?.status)) return resource.external_change.status;
  return resource?.external_change?.status ?? source?.status ?? 'not_checked';
}

function resultForWork(savedWork, work) {
  return savedWork.filter((item) => item.project?.id === work.project_id || item.project_id === work.project_id)
    .filter((item) => item.parameters?.work_session_id === work.session_id
      || item.work_id === work.latest_save_id
      || item.save_id === work.latest_save_id);
}

function impactFor({ changeState, versionPolicy, work, results }) {
  const outputIssue = results.find((item) => ['changed', 'missing_source', 'undone'].includes(item.output_state));
  if (outputIssue) {
    const detail = outputIssue.output_state === 'missing_source' ? 'is missing' : outputIssue.output_state === 'changed' ? 'changed after Save' : 'was undone';
    return { status: 'needs_review', label: 'Needs review', reason: `Saved Result ${outputIssue.name} ${detail}.` };
  }
  if (['changed', 'moved', 'missing'].includes(changeState)) {
    if (versionPolicy === 'pinned_version') {
      return { status: 'contained', label: 'Pinned impact', reason: `The Source is ${changeState}, but this Work is pinned to its recorded version.` };
    }
    return { status: 'needs_review', label: 'Needs review', reason: `The followed Source is ${changeState}; review this Work and its Results.` };
  }
  if (work.freshness?.status === 'needs_review') return { status: 'needs_review', label: 'Needs review', reason: work.freshness.reason ?? 'This Work needs review.' };
  return { status: 'fresh', label: 'Fresh', reason: 'The Source, Work, and recorded Results have no known impact requiring review.' };
}

export function buildResourceImpactLanes({ resource, workSessions = [], savedWork = [] }) {
  const resourceId = resource?.resource_id ?? resource?.resource?.id ?? null;
  if (!resourceId) return [];
  return workSessions
    .filter((work) => work.project_id && work.sources?.some((source) => source.resource_id === resourceId))
    .map((work) => {
      const source = work.sources.find((item) => item.resource_id === resourceId);
      const changeState = sourceChangeState(resource, source);
      const versionPolicy = source?.version_policy ?? 'follow_latest';
      const results = resultForWork(savedWork, work).map((item) => {
        const outputState = savedResultState(item);
        const freshness = savedResultFreshness(item, {
          sourceFreshness: work.freshness,
          versionPolicy: sourceVersionPolicy(work.sources, item.version_policy),
        });
        const saveId = item.save_id ?? item.work_id;
        return {
          save_id: saveId,
          resource_id: item.resource_id ?? null,
          name: path.basename(item.result_path ?? saveId),
          path: item.result_path ?? null,
          output_state: outputState,
          freshness,
          href: `/work/${encodeURIComponent(work.session_id)}/saved?work_id=${encodeURIComponent(item.work_id ?? saveId)}`,
        };
      });
      const impact = impactFor({ changeState, versionPolicy, work, results });
      return {
        source: {
          resource_id: resourceId,
          name: resource.name ?? resource.resource?.display_name ?? path.basename(resource.path ?? source?.file_path ?? resourceId),
          path: resource.file_path ?? resource.path ?? source?.file_path ?? null,
          change_state: changeState,
          version_policy: versionPolicy,
        },
        work: {
          session_id: work.session_id,
          revision: work.revision,
          recipe_version: work.recipe?.version ?? 1,
          freshness: work.freshness ?? null,
          href: `/work/${encodeURIComponent(work.session_id)}`,
        },
        results,
        impact,
        actions: {
          open_work: `/work/${encodeURIComponent(work.session_id)}`,
          open_result: results[0]?.href ?? null,
          resource_context: resource.desktop_href ?? null,
          relink_resource: changeState === 'missing' ? resource.desktop_href ?? null : null,
        },
      };
    });
}
