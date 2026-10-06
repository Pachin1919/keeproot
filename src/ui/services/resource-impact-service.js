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

export function buildResourceFocusGraph({ projectId, resource, relationshipFocus, workSessions = [], savedWork = [], impactLanes = null, maxNodes = 50, maxEdges = 100 }) {
  const resourceId = resource?.resource_id ?? resource?.resource?.id ?? null;
  if (!projectId || !resourceId || relationshipFocus?.project_id !== projectId || relationshipFocus?.root_resource_id !== resourceId) {
    return { project_id: projectId ?? null, root_resource_id: resourceId, nodes: [], edges: [], truncated: false, file_verification: 'not_checked' };
  }
  const nodes = new Map(); const edges = new Map();
  const relationshipNodes = relationshipFocus.nodes ?? [];
  const relationshipNodeLimit = Math.max(1, maxNodes - 10);
  let truncated = Boolean(relationshipFocus.truncated) || relationshipNodes.length > relationshipNodeLimit;
  const resourceHref = (id) => `/projects/${encodeURIComponent(projectId)}/resources?resource_id=${encodeURIComponent(id)}`;
  for (const item of relationshipNodes.slice(0, relationshipNodeLimit)) {
    if (!item?.resource_id) continue;
    nodes.set(`resource:${item.resource_id}`, { id: `resource:${item.resource_id}`, kind: 'resource', resource_id: item.resource_id,
      label: String(item.name ?? item.resource_id).slice(0, 256), relative_path: item.relative_path ?? null, hop: item.hop ?? 0, href: resourceHref(item.resource_id) });
  }
  for (const item of relationshipFocus.edges ?? []) {
    const sourceId = `resource:${item.source_resource_id}`; const targetId = `resource:${item.target_id}`;
    if (!nodes.has(sourceId) || !nodes.has(targetId)) continue;
    if (edges.size >= maxEdges) { truncated = true; break; }
    edges.set(item.id, { id: item.id, kind: 'linked_to', relationship_id: item.id, source: sourceId, target: targetId,
      direction: item.direction, hop: item.hop, status: item.status, evidence: item.evidence ?? {}, needs_review: item.needs_review === true, file_verification: 'not_checked' });
  }
  const lanes = Array.isArray(impactLanes) ? impactLanes : buildResourceImpactLanes({ resource,
    workSessions: workSessions.filter((work) => work.project_id === projectId),
    savedWork: savedWork.filter((item) => item.project?.id === projectId || item.project_id === projectId),
  });
  const orderedLanes = [...lanes].sort((left, right) => String(left.work?.session_id).localeCompare(String(right.work?.session_id)));
  for (const lane of orderedLanes) {
    const work = lane.work;
    if (!work?.session_id || (nodes.size >= maxNodes && !nodes.has(`work:${work.session_id}`))) { truncated = true; continue; }
    const workNodeId = `work:${work.session_id}`;
    nodes.set(workNodeId, { id: workNodeId, kind: 'work', session_id: work.session_id, label: work.session_id,
      revision: work.revision, freshness: work.freshness, href: work.href ?? `/work/${encodeURIComponent(work.session_id)}` });
    const sourceEdgeId = `derived:source:${resourceId}:${work.session_id}`;
    if (edges.size < maxEdges) edges.set(sourceEdgeId, { id: sourceEdgeId, kind: 'derived', derived_kind: 'source_to_work',
      source: `resource:${resourceId}`, target: workNodeId, resource_id: resourceId, work_session_id: work.session_id, impact: lane.impact });
    else truncated = true;
    for (const result of [...(lane.results ?? [])].sort((left, right) => String(left.save_id).localeCompare(String(right.save_id)))) {
      if (result?.output_state !== 'verified' || !result.save_id) continue;
      const resultNodeId = `result:${result.save_id}`;
      if (!nodes.has(resultNodeId) && nodes.size >= maxNodes) { truncated = true; break; }
      nodes.set(resultNodeId, { id: resultNodeId, kind: 'result', save_id: result.save_id, resource_id: result.resource_id ?? null,
        label: String(result.name ?? result.save_id).slice(0, 256), output_state: result.output_state, freshness: result.freshness,
        href: result.href ?? `/work/${encodeURIComponent(work.session_id)}/saved?work_id=${encodeURIComponent(result.save_id)}` });
      const resultEdgeId = `derived:result:${work.session_id}:${result.save_id}`;
      if (edges.size < maxEdges) edges.set(resultEdgeId, { id: resultEdgeId, kind: 'derived', derived_kind: 'work_to_result',
        source: workNodeId, target: resultNodeId, work_session_id: work.session_id, save_id: result.save_id, verified: true });
      else truncated = true;
    }
  }
  return { project_id: projectId, root_resource_id: resourceId, depth: relationshipFocus.depth, status: relationshipFocus.status,
    nodes: [...nodes.values()].slice(0, maxNodes), edges: [...edges.values()].slice(0, maxEdges), truncated, file_verification: 'not_checked' };
}
