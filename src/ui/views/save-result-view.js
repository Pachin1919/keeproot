import { escapeHtml, renderFacts, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';

function callerLabel(caller = {}) {
  return [caller.agent, caller.tool, caller.model].filter(Boolean).join(' · ') || 'Not recorded';
}

function verificationLabel(verification) {
  if (!verification) return 'Not yet verified';
  if (typeof verification !== 'object') return String(verification);
  return verification.status ?? verification.sha256 ?? verification.verified_at ?? 'Recorded';
}

export function renderSaveResultView(model, options = {}) {
  const save = model.save ?? {};
  const saveId = String(save.save_id ?? '');
  const base = `/saves/${encodeURIComponent(saveId)}`;
  const prepared = save.status === 'prepared';
  const undone = save.status === 'undone';
  const title = prepared ? 'Review save' : undone ? 'Save undone' : 'Saved result';
  const project = save.project ?? null;
  const source = save.source ?? {};
  const target = save.target ?? {};
  const sourcePath = source.recorded_path ?? source.path ?? null;
  const facts = [
    ['Project', project?.name ?? project?.id ?? 'Not recorded'],
    ['Target', target.relative_path ?? target.path ?? 'Not recorded', true],
    ['Status', save.status ?? 'Not recorded'],
    ['Caller', callerLabel(save.caller)],
    ['Verification', verificationLabel(save.verification)],
    ...(sourcePath ? [['Recorded source', sourcePath, true]] : []),
    ...(source.thread_id ? [['Source thread', source.thread_id]] : []),
  ];
  const preview = model.preview?.text == null ? '' : `<section class="surface"><h2>Preview</h2><pre class="save-result-preview" style="white-space:pre-wrap;max-height:24rem;overflow:auto">${escapeHtml(model.preview.text)}</pre>${model.preview.truncated ? '<p class="muted">Preview is bounded.</p>' : ''}</section>`;
  const execute = prepared ? `<form method="post" action="${base}/execute"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><button class="action-button" type="submit">Save and verify</button></form>` : '';
  const recovery = !prepared && (save.undo_available || save.redo_available)
    ? `${save.undo_available ? `<form method="post" action="${base}/undo"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><button class="action-button action-button-secondary" type="submit">Undo</button></form>` : ''}${save.redo_available ? `<form method="post" action="${base}/redo"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><button class="action-button" type="submit">Redo</button></form>` : ''}` : '';
  const resources = !prepared && save.resources_href ? `<a class="action-button action-button-secondary" href="${escapeHtml(save.resources_href)}">Open Resources</a>` : '';
  const projectHref = project?.id ? `/projects/${encodeURIComponent(project.id)}` : '/projects';
  const body = `<main class="page save-result-page"><div class="page-intro"><div><span class="eyebrow">SAVE</span><h1>${title}</h1><p class="lede">${prepared ? 'Review the target and bounded preview before saving.' : 'Atlas recorded the current Save result and recovery state.'}</p></div><a class="action-button action-button-secondary" href="${escapeHtml(projectHref)}">Back to Project</a></div>${model.notice ? `<section class="surface"><p class="callout warn">${escapeHtml(model.notice)}</p></section>` : ''}<section class="surface">${renderFacts(facts)}<div class="inline-actions">${execute}${recovery}${resources}</div></section>${preview}</main>`;
  return `<!doctype html><html lang="en" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Atlas</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Work', { interactive: true, workspaceHref: '/projects', resourcesHref: save.resources_href, settingsHref: options.settingsHref })}<div class="workspace">${renderTopbar({ section: 'Save', project })}${body}</div></div></body></html>`;
}
