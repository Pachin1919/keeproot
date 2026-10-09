import { UI_DISPLAY_NAME } from '../brand.js';
import { referenceRepairHref } from './reference-repair-view.js';
import crypto from 'node:crypto';
import { escapeHtml, renderNav, renderTopbar, renderUiClientScript } from '../components.js';
import { uiStyles } from '../styles.js';
import { normalizeUiLocale, translateUi } from '../i18n.js';

export function renderProjectMoveView(model, options = {}) {
  const h = value => escapeHtml(value ?? '');
  const t = key => translateUi(options.locale, `project_move.${key}`, options.languageCatalog);
  const project = model.project;
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const move = model.move;
  const hidden = (name, value) => `<input type="hidden" name="${name}" value="${h(value)}">`;
  const token = hidden('csrf', options.csrfToken);
  const action = (name, enabled, secondary = false) => enabled ? `<form method="post" action="${h(`${base}/move/${encodeURIComponent(move.move_id)}/${name}`)}">${token}${hidden('expected_revision', move.revision)}${hidden('expected_digest', move.digest)}${hidden('request_key', `UI-MOVE-${crypto.randomUUID()}`)}<button class="action-button${secondary ? ' action-button-secondary' : ''}" type="submit">${h(t(name))}</button></form>` : '';
  const link = (href, key, secondary = false) => `<a class="action-button${secondary ? ' action-button-secondary' : ''}" href="${h(href)}">${h(t(key))}</a>`;
  const facts = pairs => `<dl class="project-move-facts">${pairs.map(([label, value]) => `<dt>${h(label)}</dt><dd>${h(value)}</dd>`).join('')}</dl>`;
  const messages = (title, values) => values?.length ? `<section class="project-move-messages" aria-label="${h(title)}"><h3>${h(title)}</h3><ul>${values.map(value => `<li>${h(value)}</li>`).join('')}</ul></section>` : '';
  const technical = pairs => `<details class="project-move-technical"><summary>${h(t('technical'))}</summary>${facts(pairs)}</details>`;
  const scope = `<details class="project-move-scope"><summary>${h(t('scope_details'))}</summary><p>${h(t('scope'))}</p><p>${h(t('references'))}</p><p>${h(t('rounds'))}</p><p>${h(t('undo_help'))}</p></details>`;
  const caveats = `<p class="project-move-caveats">${h(t('key_caveats'))}</p>`;
  let content;
  if (move) {
    const sourceLabel = ['applied', 'needs_recovery', 'conflict'].includes(move.status) ? 'original' : move.status === 'undone' ? 'current' : 'source';
    const targetLabel = move.status === 'applied' ? 'current' : 'target';
    const actions = move.status === 'applied'
      ? `${link(base, 'continue')}${action('undo', move.can_undo, true)}<a class="action-button action-button-secondary" href="${h(referenceRepairHref(project.id, 'project_move', move, project.id))}">${h(translateUi(options.locale, 'repair.entry', options.languageCatalog))}</a>`
      : move.status === 'undone' ? link(base, 'back')
        : `${action('execute', move.can_execute)}${action('recover', move.can_recover)}${action('undo', move.can_undo, true)}`;
    // The known service warning is shown once in localized caveats. Unknown warnings remain visible.
    const warnings = (move.warnings ?? []).filter(value => value !== 'References in file contents are not rewritten.');
    content = `<section class="surface project-move-preview"><h2>${h(t(`status_${move.status}`))}</h2>${facts([[t(sourceLabel), move.source?.relative_path], [t(targetLabel), move.target?.relative_path]])}<p class="project-move-assurance">${h(t('identity'))}</p>${move.status === 'needs_recovery' ? `<p class="callout warn">${h(t('recovery_help'))}</p>` : ''}${model.notice ? `<p class="callout warn" role="alert">${h(model.notice)}</p>` : ''}${messages(t('conflicts'), move.conflicts)}${messages(t('warnings'), warnings)}${move.status !== 'undone' ? caveats : ''}<div class="inline-actions project-move-actions">${actions}</div><h3>${h(t('summary'))}</h3><dl class="project-move-counts">${['files', 'resources', 'works', 'saves', 'boards'].map(key => `<div><dt>${h(t(key))}</dt><dd>${h(move.summary?.[key] ?? 0)}</dd></div>`).join('')}</dl>${technical([[t('id'), move.project_id], [t('move_id'), move.move_id], [t('root'), model.location?.root_path], [t('source_absolute'), move.source?.path], [t('target_absolute'), move.target?.path], [t('revision'), move.revision], [t('digest'), move.digest], [t('directories'), move.summary?.directories ?? 0], [t('bytes'), move.summary?.bytes ?? 0]])}${scope}</section>`;
  } else {
    content = `<section class="surface"><h2>${h(t('choose'))}</h2>${facts([[t('source'), model.location?.relative_path], [t('root'), model.location?.root_path]])}${model.notice ? `<p class="callout warn" role="alert">${h(model.notice)}</p>` : ''}<form class="project-home-input-form" method="post" action="${h(`${base}/move/prepare`)}">${token}${hidden('request_key', `UI-MOVE-${crypto.randomUUID()}`)}<label for="project-move-target">${h(t('target'))}</label><input id="project-move-target" name="target_relative_path" required maxlength="2048" value="${h(model.target_relative_path)}" aria-describedby="project-move-target-help"><p id="project-move-target-help">${h(t('target_help'))}</p><button class="action-button" type="submit">${h(t('prepare'))}</button></form>${technical([[t('id'), project.id]])}${scope}</section>`;
  }
  const navigation = `<details class="project-move-navigation"><summary>${h(t('other_actions'))}</summary><div class="inline-actions"><a href="${h(base)}">${h(t('back'))}</a><a href="${h(`${base}/resources`)}">${h(t('open_resources'))}</a><a href="${h(`${base}/boards`)}">${h(t('open_boards'))}</a><a href="${h(`${base}/move/new`)}">${h(t('new'))}</a></div></details>`;
  return `<!doctype html><html lang="${normalizeUiLocale(options.locale)}" ${options.htmlAttributes ?? ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${h(t('title'))} · ${UI_DISPLAY_NAME}</title><style>${uiStyles()}</style>${renderUiClientScript(true)}</head><body class="product-workspace-body"><div class="app-shell" style="${h(options.railStyle)}">${renderNav('Projects', { ...options, project: project, interactive: true, workspaceHref: '/projects', resourcesHref: `${base}/resources`, settingsHref: options.settingsHref, locale: options.locale, languageCatalog: options.languageCatalog })}<div class="workspace">${renderTopbar({ section: t('title'), project, locale: options.locale, languageCatalog: options.languageCatalog })}<main class="page project-move"><div class="page-intro"><h1>${h(t('title'))}</h1></div>${content}${navigation}</main></div></div></body></html>`;
}
