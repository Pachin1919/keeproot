import { escapeHtml, renderFacts, renderNav, renderStatus } from '../components.js';
import { uiStyles } from '../styles.js';

function sourceList(sources) {
  if (!sources.length) return '<p class="muted">No source selected.</p>';
  return `<ul class="path-list">${sources.map((source) => `
    <li class="path-item">
      <strong class="mono">${escapeHtml(source.path)}</strong><br>
      <span class="muted">${escapeHtml(source.byte_size)} bytes / ${escapeHtml(source.content_hash)}</span>
    </li>`).join('')}</ul>`;
}

function sourceFreshness(freshness) {
  const counts = freshness.counts ?? {};
  return `<div class="surface-flat">
    <h3>Source freshness</h3>
    ${renderStatus(freshness.status)}
    <p class="muted">${escapeHtml(freshness.attention)}</p>
    ${freshness.counts ? renderFacts([
    ['Current', counts.current ?? 0],
    ['Changed', counts.stale_source ?? 0],
    ['Missing', counts.missing_source ?? 0],
    ['Moved', counts.moved_same_content ?? 0],
  ]) : ''}
  </div>`;
}

function policyPanel(model) {
  const decision = model.policy.latest;
  if (!decision) return '<p class="muted">No PolicyDecision recorded.</p>';
  return `${renderStatus(decision.decision)}
    <p>${escapeHtml(decision.reason)}</p>
    ${renderFacts([
    ['Decision ID', decision.id, true],
    ['RuleVersion', decision.rule_version_id, true],
  ])}`;
}

function attentionPanel(attention) {
  if (!attention) return '<p class="muted">No effective rule attention was recorded for this Task.</p>';
  const conflicts = attention.conflicts ?? [];
  const gaps = attention.gaps ?? [];
  return `${renderStatus(attention.status)}${renderFacts([
    ['Applied rules', attention.applied_rule_ids.join(', ') || 'None'],
    ['Eligible rules', attention.eligible_rule_ids.join(', ') || 'None'],
    ['Conflicts', conflicts.length],
    ['Gaps', gaps.length],
  ])}${conflicts.length || gaps.length
    ? `<p class="muted">${escapeHtml([...conflicts, ...gaps].join(' / '))}</p>` : ''}`;
}

function diffPanel(model) {
  if (!model.write?.candidate) return '<p class="muted">The Agent has not staged a Candidate yet.</p>';
  return `${renderFacts([
    ['Target', model.write.candidate.target, true],
    ['ChangeSet', model.write.candidate.change_set_id, true],
    ['Candidate Hash', model.write.candidate.content_hash, true],
    ['Diff Hash', model.write.candidate.diff_hash, true],
  ])}
  <div class="surface-flat"><pre class="diff">${escapeHtml(model.write.candidate.diff_text)}</pre></div>`;
}

function receiptPanel(model) {
  const receipt = model.completion_receipt ?? model.write?.execution_receipt ?? null;
  if (!receipt) return '<p class="muted">No execution Receipt yet.</p>';
  return `<div class="receipt">
    <strong>${escapeHtml(receipt.status ?? 'recorded')}</strong>
    ${renderFacts([
    ['Verified', receipt.verified === true ? 'yes' : 'not recorded'],
    ['Target', receipt.target, true],
    ['Run', receipt.write_run_id ?? receipt.run_id, true],
  ])}
  </div>`;
}

function actionForm(action, options) {
  const needsReason = ['approve', 'reject'].includes(action);
  return `<form class="action-form" method="post" action="${escapeHtml(options.actionEndpoint)}">
    <input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}">
    <input type="hidden" name="binding" value="${escapeHtml(options.bindingDigest)}">
    <input type="hidden" name="action" value="${escapeHtml(action)}">
    ${needsReason ? `<label class="label" for="reason-${escapeHtml(action)}">Reason</label>
      <input class="action-input" id="reason-${escapeHtml(action)}" name="reason" required maxlength="500" autocomplete="off">` : ''}
    <button class="action-button${action === 'reject' || action === 'rollback' ? ' action-button-secondary' : ''}" type="submit">${escapeHtml(action)}</button>
  </form>`;
}

function actionPanel(model, options) {
  const actions = model.ui_state.allowed_actions;
  return `<section class="surface">
    <span class="label">Current state</span>
    ${renderStatus(model.ui_state.state)}
    ${options.notice ? `<p class="action-notice">${escapeHtml(options.notice)}</p>` : ''}
    <div class="action-summary">
      ${actions.length
    ? `<p>Allowed now: <strong>${escapeHtml(actions.join(' / '))}</strong></p>`
    : '<p class="muted">No direct user action is available in this state.</p>'}
      ${options.actionEndpoint && actions.length
    ? actions.map((action) => actionForm(action, options)).join('')
    : '<p class="muted">This saved page is read-only. Start the local Task Review session to act.</p>'}
    </div>
  </section>`;
}

export function renderTaskReviewView(model, options = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Atlas Task Review</title>
  <style>${uiStyles()}</style>
</head>
<body>
  <div class="app-shell">
    ${renderNav('Tasks')}
    <div class="workspace">
      <header class="topbar">
        <div><span class="label">${escapeHtml(model.project.id)}</span><strong class="mono">${escapeHtml(model.task.id)}</strong></div>
        ${renderStatus(model.ui_state.state)}
      </header>
      <main class="page">
        <h1>Task review</h1>
        <p class="muted">User request: ${escapeHtml(model.task.intent)}</p>
        <div class="page-grid">
          <div class="main-column">
            <section class="surface"><h2>Sources used</h2>${sourceList(model.sources.selected)}${sourceFreshness(model.sources.freshness)}</section>
            <section class="surface"><h2>Proposed change</h2>${renderFacts([
    ['Strategy', model.proposal.strategy],
    ['Target', model.proposal.target, true],
    ['Role', model.proposal.role],
    ['Relationship', model.proposal.relation_type],
  ])}<p class="muted">${escapeHtml(model.proposal.reason)}</p></section>
            <section class="surface"><h2>Diff</h2>${diffPanel(model)}</section>
            <section class="surface"><h2>Receipt</h2>${receiptPanel(model)}</section>
          </div>
          <aside class="side-column">
            ${actionPanel(model, options)}
            <section class="surface"><h2>Effective rules</h2>${attentionPanel(model.attention)}</section>
            <section class="surface"><h2>Atlas PolicyDecision</h2>${policyPanel(model)}</section>
            <section class="surface"><h2>Recovery</h2>${renderStatus(model.rollback.status)}<p class="muted">${escapeHtml(model.rollback.precondition ?? 'Recovery is not available in the current state.')}</p></section>
            <section class="callout"><strong>Responsibility boundary</strong><br>The Agent produced the Candidate. Atlas measured the scope, applied policy, recorded the exact Diff, and controls execution and recovery.</section>
          </aside>
        </div>
      </main>
    </div>
  </div>
</body>
</html>`;
}
