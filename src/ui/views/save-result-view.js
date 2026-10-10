import { UI_DISPLAY_NAME } from '../brand.js';
import { escapeHtml, renderFacts, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';
import { WORK_COPY_KEYS } from '../work-messages.js';

export function renderSaveResultView(model, options = {}) {
  const t = (key, values = {}) => translateUi(options.locale, key, options.languageCatalog).replace(/\{(\w+)\}/gu, (match, name) => String(values[name] ?? match));
  const h = (key, values) => escapeHtml(t(key, values));
  const fact = (value) => WORK_COPY_KEYS[value] ? t(WORK_COPY_KEYS[value]) : value;
  const policy = (value) => ({ pinned_version: t('work.pin_recorded'), follow_latest: t('work.follow_latest'), mixed: t('work.mixed_policy') })[value] ?? value;

function callerLabel(caller = {}) {
  return [caller.agent, caller.tool, caller.model].filter(Boolean).join(' · ') || t('work.not_recorded');
}

function verificationLabel(verification) {
  if (!verification) return t('work.not_verified');
  if (typeof verification !== 'object') return String(verification);
  return fact(verification.status) ?? verification.sha256 ?? verification.verified_at ?? t('work.recorded');
}


  const save = model.save ?? {};
  const saveId = String(save.save_id ?? '');
  const base = `/saves/${encodeURIComponent(saveId)}`;
  const prepared = save.status === 'prepared';
  const undone = save.status === 'undone';
  const statusTitle = prepared ? t('work.review_save') : undone ? t('work.save_undone') : save.verified === false ? t('work.result_not_current') : t('work.saved_and_verified');
  const project = save.project ?? null;
  const source = save.source ?? {};
  const boardDelivery = model.board_delivery;
  const target = save.target ?? {};
  const targetPath = target.relative_path ?? target.path ?? '';
  const title = targetPath.split(/[\\/]/u).filter(Boolean).at(-1) || statusTitle;
  const sourcePath = source.recorded_path ?? source.path ?? null;
  const facts = [
    [t('work.project'), project?.name ?? project?.id ?? t('work.not_recorded')],
    [t('work.target'), target.relative_path ?? target.path ?? t('work.not_recorded'), true],
    [t('work.status'), fact(save.status) ?? t('work.not_recorded')],
    [t('work.caller'), callerLabel(save.caller)],
    [t('work.verification'), verificationLabel(save.verification)],
    ...(boardDelivery ? [[t('work.board_snapshot'), `${boardDelivery.snapshot_revision} · ${t('work.board_current_revision', { revision: boardDelivery.current_revision ?? 'unknown' })}`]] : []),
    ...(sourcePath ? [[t('work.recorded_source'), sourcePath, true]] : []),
    ...(source.thread_id ? [[t('work.source_thread'), source.thread_id]] : []),
  ];
  const preview = model.preview?.text == null ? '' : `<section class="surface"><h2>${h('work.preview')}</h2><pre class="save-result-preview" style="white-space:pre-wrap;max-height:24rem;overflow:auto">${escapeHtml(model.preview.text)}</pre>${model.preview.truncated ? `<p class="muted">${h('work.preview_bounded')}</p>` : ''}</section>`;
  const capture = model.capture_source ? `<section class="surface"><h2>${escapeHtml(t('capture.readable'))}</h2><p>${escapeHtml(model.capture_source.scope)} · ${escapeHtml(model.capture_source.completeness)}</p><pre class="save-result-preview" style="white-space:pre-wrap;max-height:24rem;overflow:auto">${escapeHtml(model.capture_source.excerpt)}</pre><div class="inline-actions"><a class="action-button action-button-secondary" href="/projects/${encodeURIComponent(project?.id ?? '')}/capture-source/${encodeURIComponent(saveId)}">${escapeHtml(t('capture.details'))}</a><a class="action-button action-button-secondary" href="/projects/${encodeURIComponent(project?.id ?? '')}/capture-source/${encodeURIComponent(saveId)}/raw">${escapeHtml(t('capture.original'))}</a></div></section>` : '';
  const previewRevision = model.preview_revision == null ? '' : `<input type="hidden" name="preview_revision" value="${escapeHtml(model.preview_revision)}">`;
  const toolboxReturn=model.toolbox_return ? `<input type="hidden" name="return_to" value="${escapeHtml(model.toolbox_return)}">` : '';
  const toolboxExit=model.toolbox_return ? `<a class="action-button action-button-secondary" href="${escapeHtml(model.toolbox_return)}">${h('toolbox.exit')}</a>` : '';
  const execute = prepared ? `<form method="post" action="${base}/execute"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}">${previewRevision}${toolboxReturn}<button class="action-button" type="submit">${h('work.save_verify')}</button></form>` : '';
  const recovery = !prepared && (save.undo_available || save.redo_available)
    ? `${save.undo_available ? `<form method="post" action="${base}/undo"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><button class="action-button action-button-secondary" type="submit">${h('work.undo')}</button>${toolboxReturn}</form>` : ''}${save.redo_available ? `<form method="post" action="${base}/redo"><input type="hidden" name="csrf" value="${escapeHtml(model.csrf ?? '')}"><button class="action-button" type="submit">${h('work.redo')}</button>${toolboxReturn}</form>` : ''}` : '';
  const resources = !prepared && save.resources_href ? `<a class="action-button" href="${escapeHtml(save.resources_href)}">${h('work.open_saved')}</a>` : '';
  const protectedRounds = (model.protected_rounds ?? []).map((round) => `<a class="action-button action-button-secondary" href="/projects/${encodeURIComponent(project?.id ?? '')}/rounds/${encodeURIComponent(round.round_id)}">${h('modules.local_return_round')}${model.protected_rounds.length > 1 ? ` · ${escapeHtml(round.label)}` : ''}</a>`).join('');
  const boardSnapshot = boardDelivery ? `<section class="surface"><p>${h('work.board_snapshot_notice', { snapshot: boardDelivery.snapshot_revision, current: boardDelivery.current_revision ?? 'unknown' })}</p></section>` : '';
  const workSessionId = save.parameters?.work_session_id ?? source.session_id;
  const workHref = workSessionId ? `/work/${encodeURIComponent(workSessionId)}` : source.kind === 'board_delivery' && source.board_id && project?.id ? `/projects/${encodeURIComponent(project.id)}/boards/${encodeURIComponent(source.board_id)}` : null;
  const continuation = workHref ? `<a class="action-button action-button-secondary" href="${escapeHtml(workHref)}">${h('workspace.return_work')}</a>` : '';
  const materials = project?.id ? `<a class="action-button action-button-secondary" href="/projects/${encodeURIComponent(project.id)}/resources">${h('workspace.materials')}</a>` : '';
  const projectHref = project?.id ? `/projects/${encodeURIComponent(project.id)}` : '/projects';
  const body = `<main class="page save-result-page"><div class="page-intro"><div><span class="eyebrow">${escapeHtml(statusTitle)}</span><h1>${escapeHtml(title)}</h1><p class="lede">${prepared ? t('work.review_target') : statusTitle}</p></div><a class="action-button action-button-secondary" href="${escapeHtml(projectHref)}">${h('work.back_project')}</a></div>${model.notice ? `<section class="surface"><p class="callout warn">${escapeHtml(model.notice)}</p></section>` : ''}${boardSnapshot}<section class="surface save-result-actions"><div class="inline-actions">${execute}${toolboxExit}${resources}${continuation}${materials}${protectedRounds}${recovery}</div><details class="save-result-verification"><summary>${h('work.verification_details')}</summary>${renderFacts(facts)}</details></section>${capture}${preview}</main>`;
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · ${UI_DISPLAY_NAME}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body><div class="app-shell" style="${escapeHtml(options.railStyle ?? '')}">${renderNav('Work', { ...options, project: project, interactive: true, workspaceHref: '/projects', resourcesHref: save.resources_href, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('work.saved_result'), ...options, project })}${body}</div></div></body></html>`;
}
