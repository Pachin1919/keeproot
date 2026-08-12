import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createOperationSnapshot } from './ui-operation.js';
import { applyUiAction } from './ui-action.js';
import { buildContextModel } from './ui/read-model/context-model.js';
import { buildOperationModel } from './ui/read-model/operation-model.js';
import { buildTaskListModel } from './ui/read-model/task-list-model.js';
import {
  preferenceHtmlAttributes, preferenceRailStyle, readUiPreferences, resetUiPreferences, writeUiPreferences,
} from './ui/preferences.js';
import { escapeHtml, renderNav } from './ui/components.js';
import { uiStyles } from './ui/styles.js';
import { renderContextView } from './ui/views/context-view.js';
import { renderTaskReviewView } from './ui/views/task-review-view.js';
import { renderTasksView } from './ui/views/tasks-view.js';
import { renderSettingsView } from './ui/views/settings-view.js';

const MAX_BODY_BYTES = 8 * 1024;

function bindingDigest(binding) {
  return crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex');
}

function equalSecret(expected, received) {
  const left = Buffer.from(expected ?? '');
  const right = Buffer.from(received ?? '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readForm(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        reject(new Error('Atlas UI action body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(new URLSearchParams(body)));
    request.on('error', reject);
  });
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(html);
}

function sendUiClient(response) {
  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    'x-content-type-options': 'nosniff',
  });
  response.end(fs.readFileSync(new URL('./ui/client.js', import.meta.url), 'utf8'));
}

function safeNotice(error) {
  if (error.code === 'ATLAS_STATE_CONFLICT') {
    return `No action was performed. ${error.message}`;
  }
  return `Action stopped. ${error.message}`;
}

function requireConfirmation(action, form) {
  if (['execute', 'rollback'].includes(action) && form.get('confirmed') !== 'yes') {
    const error = new Error(`Confirm the exact ${action} action before Atlas continues.`);
    error.code = 'ATLAS_CONFIRMATION_REQUIRED';
    throw error;
  }
}

function applyBoundUiAction({
  action, form, stateDir, taskId, services, task, guarded, derived, lifecycle,
}) {
  const snapshot = createOperationSnapshot({ stateDir, taskId, ...services });
  if (action !== 'approve_execute') {
    return applyUiAction({
      stateDir,
      taskId,
      action,
      snapshotPath: snapshot.operation_path,
      reason: form.get('reason'),
      task,
      guarded,
      derived,
      lifecycle,
    });
  }
  const approval = applyUiAction({
    stateDir,
    taskId,
    action: 'approve',
    snapshotPath: snapshot.operation_path,
    reason: 'User approved the exact Candidate in Atlas Desktop.',
    task,
    guarded,
    derived,
    lifecycle,
  });
  const approvedSnapshot = createOperationSnapshot({ stateDir, taskId, ...services });
  const execution = applyUiAction({
    stateDir,
    taskId,
    action: 'execute',
    snapshotPath: approvedSnapshot.operation_path,
    approvalToken: approval.approval_token,
    task,
    guarded,
    derived,
    lifecycle,
  });
  return { ...execution, action: 'approve_execute' };
}

function taskRoute(pathname) {
  const match = pathname.match(/^\/tasks\/([^/]+)(?:\/(action|refresh))?$/u);
  if (!match) return null;
  const taskId = decodeURIComponent(match[1]);
  if (!/^TSK-[A-Za-z0-9-]+$/u.test(taskId)) return null;
  return { taskId, action: match[2] ?? 'view' };
}

function errorView(message, workspaceHref = '/') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas stopped</title><style>${uiStyles()}</style><script src="/ui.js" defer></script></head><body><div class="app-shell">${renderNav('Workspace', { interactive: true, workspaceHref })}<main class="page"><section class="surface"><h1>Atlas stopped this action</h1><p>${escapeHtml(message)}</p><p><a class="text-link" href="${escapeHtml(workspaceHref)}">Return to Workspace</a></p></section></main></div></body></html>`;
}

export async function startTaskReviewServer({
  stateDir,
  taskId,
  task,
  guarded,
  derived,
  lifecycle,
  host = '127.0.0.1',
  port = 0,
  refreshSources = false,
}) {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const preferences = readUiPreferences(stateDir);
  const displayOptions = {
    htmlAttributes: preferenceHtmlAttributes(preferences),
    railStyle: preferenceRailStyle(preferences),
  };
  let notice = null;
  const services = { task, guarded, derived };
  const sourceFreshness = refreshSources
    ? task.sourceStatus(taskId, { caller: { actor: 'system', tool: 'atlas-ui' } })
    : null;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname === '/ui.js' && request.method === 'GET') {
        sendUiClient(response);
        return;
      }
      if (url.pathname === '/' && request.method === 'GET') {
        const model = buildOperationModel({ taskId, ...services, sourceFreshness });
        sendHtml(response, 200, renderTaskReviewView(model, {
          actionEndpoint: '/action',
          csrfToken,
          bindingDigest: bindingDigest(model.action_binding),
          notice,
          interactive: true,
          ...displayOptions,
        }));
        notice = null;
        return;
      }
      if (url.pathname === '/action' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const before = buildOperationModel({ taskId, ...services, sourceFreshness });
        if (!equalSecret(bindingDigest(before.action_binding), form.get('binding'))) {
          const error = new Error('The Task or Candidate changed. Review the refreshed page before acting.');
          error.code = 'ATLAS_STATE_CONFLICT';
          throw error;
        }
        requireConfirmation(form.get('action'), form);
        const result = applyBoundUiAction({
          action: form.get('action'), form, stateDir, taskId, services,
          task, guarded, derived, lifecycle,
        });
        notice = `${result.action} recorded: ${result.status}.`;
        response.writeHead(303, { location: '/', 'cache-control': 'no-store' });
        response.end();
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found.');
    } catch (error) {
      const model = buildOperationModel({ taskId, ...services, sourceFreshness });
      sendHtml(response, error.code === 'ATLAS_STATE_CONFLICT' ? 409 : 400, renderTaskReviewView(model, {
        actionEndpoint: '/action',
        csrfToken,
        bindingDigest: bindingDigest(model.action_binding),
        notice: safeNotice(error),
        interactive: true,
        ...displayOptions,
      }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    schema: 'atlas-ui-session.v1',
    task_id: taskId,
    host,
    port: address.port,
    url: `http://${host}:${address.port}/`,
    network_scope: 'loopback_only',
    source_freshness: sourceFreshness?.status ?? 'not_checked',
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export async function startAtlasUiServer({
  stateDir,
  currentPath,
  registry,
  rules,
  runtime,
  task,
  guarded,
  derived,
  lifecycle,
  initialTaskId = null,
  host = '127.0.0.1',
  port = 0,
  refreshSources = false,
}) {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  let preferences = readUiPreferences(stateDir);
  const displayOptions = () => ({
    htmlAttributes: preferenceHtmlAttributes(preferences),
    railStyle: preferenceRailStyle(preferences),
    settingsHref: '/settings',
  });
  const notices = new Map();
  const sourceFreshness = new Map();
  const services = { task, guarded, derived };

  const context = (selectedProjectId = null) => {
    const model = buildContextModel({ currentPath, registry, rules, runtime });
    if (!selectedProjectId) return model;
    const selected = model.projects.find((entry) => entry.project.id === selectedProjectId);
    if (!selected) {
      const error = new Error('The selected Project is not available in this Atlas Workspace.');
      error.code = 'ATLAS_PATH_BOUNDARY';
      throw error;
    }
    return { ...model, selected_project_id: selectedProjectId, status_label: `Selected Project: ${selected.project.name}` };
  };

  const operation = (taskId) => {
    const model = buildOperationModel({
      taskId,
      ...services,
      sourceFreshness: sourceFreshness.get(taskId) ?? null,
    });
    const allowed = new Set(context().projects.map((entry) => entry.project.id));
    if (taskId !== initialTaskId && !allowed.has(model.project.id)) {
      const error = new Error('This Task is outside the Projects shown in the current Atlas Workspace.');
      error.code = 'ATLAS_PATH_BOUNDARY';
      throw error;
    }
    return model;
  };

  let settleClosed;
  const closed = new Promise((resolve) => { settleClosed = resolve; });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${host}`);
    try {
      if (url.pathname === '/ui.js' && request.method === 'GET') {
        sendUiClient(response);
        return;
      }
      if (url.pathname === '/' && request.method === 'GET') {
        sendHtml(response, 200, renderContextView(context(), {
          interactive: true,
          workspaceHref: '/',
          projectBasePath: '/projects/',
          taskBasePath: '/tasks/',
          stopEndpoint: '/session/stop',
          csrfToken,
          ...displayOptions(),
        }));
        return;
      }
      if (url.pathname === '/settings' && request.method === 'GET') {
        sendHtml(response, 200, renderSettingsView({ preferences, runtime }, {
          workspaceHref: '/', csrfToken, saved: url.searchParams.get('saved') === '1',
        }));
        return;
      }
      if (url.pathname === '/settings' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        preferences = form.get('action') === 'reset'
          ? resetUiPreferences(stateDir)
          : writeUiPreferences(stateDir, {
              theme: form.get('theme'),
              accent: form.get('accent'),
              contrast: form.get('contrast'),
              text_size: form.get('text_size'),
              density: form.get('density'),
              project_rail_width: form.get('project_rail_width'),
              app_rail_width: form.get('app_rail_width'),
              show_technical_ids: form.get('show_technical_ids'),
            });
        response.writeHead(303, { location: '/settings?saved=1', 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (url.pathname === '/tasks' && request.method === 'GET') {
        const model = buildTaskListModel(context(), {
          q: url.searchParams.get('q'),
          project: url.searchParams.get('project'),
          status: url.searchParams.get('status'),
          sort: url.searchParams.get('sort'),
          page: url.searchParams.get('page'),
        });
        sendHtml(response, 200, renderTasksView(model, { workspaceHref: '/', ...displayOptions() }));
        return;
      }
      const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/u);
      if (projectMatch && request.method === 'GET') {
        const projectId = decodeURIComponent(projectMatch[1]);
        sendHtml(response, 200, renderContextView(context(projectId), {
          interactive: true,
          projectDetail: true,
          workspaceHref: '/',
          projectBasePath: '/projects/',
          taskBasePath: '/tasks/',
          stopEndpoint: '/session/stop',
          csrfToken,
          ...displayOptions(),
        }));
        return;
      }
      const route = taskRoute(url.pathname);
      if (route?.action === 'view' && request.method === 'GET') {
        if (refreshSources && !sourceFreshness.has(route.taskId)) {
          sourceFreshness.set(route.taskId, task.sourceStatus(route.taskId, {
            caller: { actor: 'system', tool: 'atlas-ui' },
          }));
        }
        const model = operation(route.taskId);
        sendHtml(response, 200, renderTaskReviewView(model, {
          actionEndpoint: `/tasks/${encodeURIComponent(route.taskId)}/action`,
          csrfToken,
          bindingDigest: bindingDigest(model.action_binding),
          notice: notices.get(route.taskId) ?? null,
          interactive: true,
          workspaceHref: '/',
          ...displayOptions(),
          refreshEndpoint: model.sources.freshness.status === 'unavailable'
            ? null
            : `/tasks/${encodeURIComponent(route.taskId)}/refresh`,
        }));
        notices.delete(route.taskId);
        return;
      }
      if (route?.action === 'refresh' && request.method === 'GET') {
        sourceFreshness.set(route.taskId, task.sourceStatus(route.taskId, {
          caller: { actor: 'system', tool: 'atlas-ui' },
        }));
        response.writeHead(303, {
          location: `/tasks/${encodeURIComponent(route.taskId)}`,
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }
      if (route?.action === 'action' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const before = operation(route.taskId);
        if (!equalSecret(bindingDigest(before.action_binding), form.get('binding'))) {
          const error = new Error('The Task or Candidate changed. Review the refreshed page before acting.');
          error.code = 'ATLAS_STATE_CONFLICT';
          throw error;
        }
        requireConfirmation(form.get('action'), form);
        const result = applyBoundUiAction({
          action: form.get('action'), form, stateDir, taskId: route.taskId, services,
          task, guarded, derived, lifecycle,
        });
        notices.set(route.taskId, `${result.action} recorded: ${result.status}.`);
        response.writeHead(303, {
          location: `/tasks/${encodeURIComponent(route.taskId)}`,
          'cache-control': 'no-store',
        });
        response.end();
        return;
      }
      if (url.pathname === '/session/stop' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        sendHtml(response, 200, '<!doctype html><html><head><meta charset="utf-8"><title>Atlas stopped</title></head><body><main><h1>Atlas stopped</h1><p>You can close this tab.</p></main></body></html>');
        setImmediate(() => server.close());
        return;
      }
      sendHtml(response, 404, errorView('The requested Atlas page does not exist.'));
    } catch (error) {
      const route = taskRoute(url.pathname);
      if (route) {
        try {
          const model = operation(route.taskId);
          sendHtml(response, error.code === 'ATLAS_STATE_CONFLICT' ? 409 : 400, renderTaskReviewView(model, {
            actionEndpoint: `/tasks/${encodeURIComponent(route.taskId)}/action`,
            csrfToken,
            bindingDigest: bindingDigest(model.action_binding),
            notice: safeNotice(error),
            interactive: true,
            workspaceHref: '/',
            ...displayOptions(),
          }));
          return;
        } catch {
          // Fall through to the bounded error page.
        }
      }
      sendHtml(response, error.code === 'ATLAS_PATH_BOUNDARY' ? 403 : 400, errorView(safeNotice(error)));
    }
  });
  server.once('close', settleClosed);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const workspaceUrl = `http://${host}:${address.port}/`;
  return {
    schema: 'atlas-ui-session.v1',
    host,
    port: address.port,
    url: initialTaskId ? `${workspaceUrl}tasks/${encodeURIComponent(initialTaskId)}` : workspaceUrl,
    workspace_url: workspaceUrl,
    network_scope: 'loopback_only',
    closed,
    close: () => new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
