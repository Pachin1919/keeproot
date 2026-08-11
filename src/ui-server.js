import crypto from 'node:crypto';
import http from 'node:http';
import { createOperationSnapshot } from './ui-operation.js';
import { applyUiAction } from './ui-action.js';
import { buildOperationModel } from './ui/read-model/operation-model.js';
import { renderTaskReviewView } from './ui/views/task-review-view.js';

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
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(html);
}

function safeNotice(error) {
  if (error.code === 'ATLAS_STATE_CONFLICT') {
    return `No action was performed. ${error.message}`;
  }
  return `Action stopped. ${error.message}`;
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
  let notice = null;
  const services = { task, guarded, derived };
  const sourceFreshness = refreshSources
    ? task.sourceStatus(taskId, { caller: { actor: 'system', tool: 'atlas-ui' } })
    : null;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname === '/' && request.method === 'GET') {
        const model = buildOperationModel({ taskId, ...services, sourceFreshness });
        sendHtml(response, 200, renderTaskReviewView(model, {
          actionEndpoint: '/action',
          csrfToken,
          bindingDigest: bindingDigest(model.action_binding),
          notice,
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
        const snapshot = createOperationSnapshot({ stateDir, taskId, ...services });
        const result = applyUiAction({
          stateDir,
          taskId,
          action: form.get('action'),
          snapshotPath: snapshot.operation_path,
          reason: form.get('reason'),
          task,
          guarded,
          derived,
          lifecycle,
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
