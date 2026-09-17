import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  contentComparisonSupported, contentFilePath,
} from './content-inspection.js';
import {
  normalizeUiPreferences, preferenceHtmlAttributes, preferenceRailStyle, readUiPreferences, resetUiPreferences, writeUiPreferences,
} from './ui/preferences.js';
import { escapeHtml, renderNav } from './ui/components.js';
import { uiStyles } from './ui/styles.js';
import { renderSettingsView } from './ui/views/settings-view.js';
import { renderFileWorkView } from './ui/views/file-work-view.js';
import { renderFileCompareView } from './ui/views/file-compare-view.js';
import { renderProjectFilesView } from './ui/views/project-files-view.js';
import { renderProjectsHomeView, renderProjectOnboardingView } from './ui/views/projects-home-view.js';
import { renderBatchWorkView } from './ui/views/batch-work-view.js';
import { renderProjectResourceFolderGroup, renderProjectResourcesView } from './ui/views/project-resources-view.js';
import { renderDataWorkView } from './ui/views/data-work-view.js';
import { renderActivityFragment, renderActivityView } from './ui/views/activity-view.js';
import { renderSearchView } from './ui/views/search-view.js';
import { browseProjectFiles, projectDirectory, projectPath, searchProjectFiles } from './ui/project-files.js';
import {
  readRecentWorkState, removeRecentWork,
} from './ui/recent-work.js';
import {
  beginCurrentActivity, failCurrentActivity, finishCurrentActivity, readCurrentActivityState,
  resumeCurrentActivity, waitCurrentActivity,
} from './ui/current-activity.js';
import { describeFileReadFailure } from './ui/file-read-failure.js';
import { openLocalFile } from './ui-launcher.js';
import { createDesktopSelectionService } from './ui/services/desktop-selection-service.js';
import { createProjectOnboardingService } from './ui/services/project-onboarding-service.js';
import { createFileWorkService, defaultInspectPurpose } from './ui/services/file-work-service.js';
import { createProjectImportService } from './ui/services/project-import-service.js';
import { createBatchWorkService } from './ui/services/batch-work-service.js';
import { createDataWorkService } from './ui/services/data-work-service.js';
import { createSavedWorkService } from './ui/services/saved-work-service.js';
import { createSaveService } from './save-service.js';
import { createResourceControl } from './resource-control.js';
import { projectResourceHref } from './resource-links.js';
import { runUiContentOperation } from './ui/content-worker-client.js';
import {
  buildProjectResourceDetailModel, buildProjectResourcesModel,
} from './ui/read-model/project-resources-model.js';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_BATCH_FILES = 20;
const CHROMIUM_RESTRICTED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
  5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

function chromiumRestrictedPort(port) {
  return CHROMIUM_RESTRICTED_PORTS.has(Number(port));
}

async function listenOnUsablePort(server, { host, port }) {
  if (port && chromiumRestrictedPort(port)) {
    throw new Error(`Atlas UI cannot use port ${port} because WebView2 blocks it.`);
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve, reject) => {
      const failed = (error) => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(port, host);
    });
    const address = server.address();
    if (!chromiumRestrictedPort(address.port)) return address;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  throw new Error('Atlas UI could not obtain a WebView2-compatible local port.');
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

function sendHtml(response, statusCode, html, { desktopBridge = false } = {}) {
  response.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'${desktopBridge ? " 'unsafe-eval'" : ''}; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(html);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function redirect(response, location) {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
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

const UI_IMAGE_ASSETS = new Map([
  ['/ui/atlas-paper-texture.png', 'atlas-paper-texture.png'],
  ['/ui/pachin-seal.png', 'pachin-seal.png'],
  ['/ui/pachin-calligraphy.png', 'pachin-calligraphy.png'],
]);

function sendUiImage(response, fileName) {
  response.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(new URL(`./ui/assets/${fileName}`, import.meta.url)).pipe(response);
}

function safeNotice(error) {
  if (error.code === 'ATLAS_STATE_CONFLICT') {
    return `No action was performed. ${error.message}`;
  }
  return `Action stopped. ${error.message}`;
}

function settingsReturnHref(value) {
  const candidate = String(value ?? '').trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/projects';
  try {
    const parsed = new URL(candidate, 'http://atlas.local');
    if (parsed.origin !== 'http://atlas.local') return '/projects';
    return /^\/(?:projects(?:\/|$)|files(?:\/|$)|activity(?:\/|$)|search(?:\/|$)|import(?:\/|$))/u.test(parsed.pathname)
      ? `${parsed.pathname}${parsed.search}`
      : '/projects';
  } catch {
    return '/projects';
  }
}

function errorView(message, workspaceHref = '/projects') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Atlas stopped</title><style>${uiStyles()}</style><script src="/ui.js" defer></script></head><body><div class="app-shell">${renderNav('Projects', { interactive: true, workspaceHref })}<main class="page"><section class="surface"><h1>Atlas stopped this action</h1><p>${escapeHtml(message)}</p><p><a class="text-link" href="${escapeHtml(workspaceHref)}">Return to Projects</a></p></section></main></div></body></html>`;
}

export async function startAtlasUiServer({
  stateDir,
  currentPath = null,
  registry,
  rules,
  runtime,
  intake,
  projectRoot,
  installationRoot,
  host = '127.0.0.1',
  port = 0,
  desktopPickerEnabled = false,
  runContentOperation = runUiContentOperation,
  runProjectImportSaveFn = null,
  writeUiPreferencesFn = writeUiPreferences,
  resetUiPreferencesFn = resetUiPreferences,
  now = Date.now,
  temporaryRecordLifetimeMs = 30 * 60 * 1000,
  selectionSweepIntervalMs = 60_000,
  queueLifetimeMs = temporaryRecordLifetimeMs,
  resourceControl: injectedResourceControl = null,
}) {
  const sendPage = (response, statusCode, html) => sendHtml(response, statusCode, html, {
    desktopBridge: desktopPickerEnabled,
  });
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const uiClientRunId = `UI-${crypto.randomUUID()}`;
  let preferences = readUiPreferences(stateDir);
  const displayOptions = () => ({
    htmlAttributes: preferenceHtmlAttributes(preferences),
    railStyle: preferenceRailStyle(preferences),
    settingsHref: '/settings',
  });
  const notices = new Map();
  const comparisons = new Map();
  const imports = new Map();
  const batchResults = new Map();
  const batchImports = new Map();
  const desktopSelections = createDesktopSelectionService({ maxBatchFiles: MAX_BATCH_FILES, now, queueLifetimeMs });
  const projectOnboarding = createProjectOnboardingService({ registry });
  const projectImportSaveRunner = runProjectImportSaveFn ?? (intake?.stateDir
    ? (imported) => runContentOperation('project-import-save', { stateDir, imported })
    : null);
  const resourceControl = injectedResourceControl ?? createResourceControl({ stateDir, ledger: registry?.ledger ?? null });
  const ownsResourceControl = !injectedResourceControl;
  const saveService = intake ? createSaveService({ stateDir, intake, resourceControl }) : null;
  const projectImport = createProjectImportService({
    stateDir, registry, saveService, runSaveOperation: projectImportSaveRunner,
  });
  const fileWork = createFileWorkService({
    stateDir,
    projectForFile: projectImport.projectForFile,
    runContentOperation,
    resourceControl,
  });
  const savedWork = createSavedWorkService({ stateDir, saveService });
  const dataWork = createDataWorkService({
    stateDir,
    projectRoot,
    installationRoot,
    runDataWorkFn: (args) => runContentOperation('data-work', args),
    fingerprintFn: (filePath) => runContentOperation('fingerprint', { filePath }),
  });
  const desktopPickerToken = desktopPickerEnabled ? crypto.randomBytes(32).toString('hex') : null;
  const temporaryRecordExpired = (value) => (
    value?.job_status !== 'running'
    && now() - (value?.updated_at ?? value?.created_at ?? 0) > temporaryRecordLifetimeMs
  );
  const batchImportRecord = (batchImportId) => {
    if (!/^BIM-[a-f0-9]{32}$/u.test(batchImportId ?? '')) return null;
    const value = batchImports.get(batchImportId);
    if (!value || temporaryRecordExpired(value)) {
      batchImports.delete(batchImportId);
      return null;
    }
    return value;
  };
  const selectionExpiry = setInterval(() => {
    const currentTime = now();
    desktopSelections.expire();
    for (const [comparisonId, value] of comparisons) {
      if (currentTime - value.created_at > 5 * 60 * 1000) comparisons.delete(comparisonId);
    }
    for (const [importId, value] of imports) {
      if (currentTime - value.created_at > temporaryRecordLifetimeMs) {
        if (value.activity_id) finishCurrentActivity(stateDir, value.activity_id);
        imports.delete(importId);
      }
    }
    for (const [batchId, value] of batchResults) {
      if (!value.pending && currentTime - (value.updated_at ?? value.created_at) > temporaryRecordLifetimeMs) batchResults.delete(batchId);
    }
    for (const [batchImportId, value] of batchImports) {
      if (temporaryRecordExpired(value)) batchImports.delete(batchImportId);
    }
    dataWork.expire();
  }, selectionSweepIntervalMs);
  selectionExpiry.unref?.();

  const batchResult = (batchId) => {
    if (!/^BRS-[a-f0-9]{32}$/u.test(batchId ?? '')) return null;
    const value = batchResults.get(batchId);
    if (!value || (!value.pending && now() - (value.updated_at ?? value.created_at) > temporaryRecordLifetimeMs)) {
      batchResults.delete(batchId);
      return null;
    }
    return value;
  };

  const importRecord = (importId) => {
    if (!/^IMP-[a-f0-9]{32}$/u.test(importId ?? '')) return null;
    const value = imports.get(importId);
    if (!value || now() - value.created_at > temporaryRecordLifetimeMs) {
      if (value?.activity_id) finishCurrentActivity(stateDir, value.activity_id);
      imports.delete(importId);
      return null;
    }
    return value;
  };

  const projectReturnHref = (work, requestedHref) => {
    const projectId = work?.project?.id;
    const fallback = projectId ? `/projects/${encodeURIComponent(projectId)}/resources` : '/files';
    const candidate = String(requestedHref ?? '');
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
    try {
      const parsed = new URL(candidate, 'http://atlas.local');
      if (parsed.origin !== 'http://atlas.local') return fallback;
      const allowedQuery = new URLSearchParams();
      const keep = (name) => {
        const value = parsed.searchParams.get(name);
        if (value && value.length <= 2048) allowedQuery.set(name, value);
      };
      if (parsed.pathname === '/activity') {
        keep('selected');
        keep('import');
        return `${parsed.pathname}${allowedQuery.size ? `?${allowedQuery}` : ''}`;
      }
      if (!projectId) return fallback;
      const projectBase = `/projects/${encodeURIComponent(projectId)}`;
      if (parsed.pathname === projectBase) return projectBase;
      if (parsed.pathname === `${projectBase}/resources`) keep('path');
      else if (parsed.pathname === `${projectBase}/files`) keep('dir');
      else return fallback;
      return `${parsed.pathname}${allowedQuery.size ? `?${allowedQuery}` : ''}`;
    } catch {
      return fallback;
    }
  };

  const fileWorkReturnHref = (workId, requestedHref) => {
    const encodedWorkId = encodeURIComponent(workId);
    const fallback = `/files/result/${encodedWorkId}`;
    const candidate = String(requestedHref ?? '');
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return fallback;
    try {
      const parsed = new URL(candidate, 'http://atlas.local');
      if (parsed.origin !== 'http://atlas.local') return fallback;
      if (parsed.pathname === fallback) return `${parsed.pathname}${parsed.search}`;
      if (parsed.pathname === '/files/continue' && parsed.searchParams.get('work_id') === workId) {
        return `${parsed.pathname}${parsed.search}`;
      }
    } catch {
      return fallback;
    }
    return fallback;
  };

  const activeProjects = () => projectImport.activeProjects();

  const renderBatch = (response, model, statusCode = 200) => sendPage(response, statusCode, renderBatchWorkView(model, {
    csrfToken, workspaceHref: '/projects', ...displayOptions(),
  }));

  const returnAfterOnboarding = (form, projectId) => {
    const workId = form.get('return_work_id');
    if (workId && fileWork.recentWorkById(workId)) return `/files/add-to-project?work_id=${encodeURIComponent(workId)}`;
    const batchId = form.get('return_batch_id');
    if (batchId && batchResult(batchId)) return `/files/batch-result/${encodeURIComponent(batchId)}`;
    const dataWorkId = form.get('return_data_work_id');
    if (dataWorkId && dataWork.session(dataWorkId)) {
      dataWork.attachProject(dataWorkId, projectEntry(projectId).project);
      return `/data-work/${encodeURIComponent(dataWorkId)}/save`;
    }
    return `/projects/${encodeURIComponent(projectId)}`;
  };
  const projectsHomeModel = () => {
    const recentState = readRecentWorkState(stateDir);
    let projects;
    try {
      projects = registry.list().filter((project) => project.status === 'active');
    } catch {
      return { projects: [], error: 'Atlas could not read the Project registry. Your local folders were not changed.' };
    }
    const entries = projects.map((project) => {
      const recentItems = recentState.items;
      const work = recentItems.filter((item) => item.project?.id === project.id);
      const savedState = savedWork.stateForProject(project.id);
      const candidates = [
        ...work.map((item) => ({
          name: path.basename(item.file_path),
          file_path: item.file_path,
          happened_at: [item.inspected_at, item.last_continued_at].filter(Boolean).sort().at(-1),
          actor: item.initiated_by?.channel === 'host' ? item.initiated_by.agent || 'Execution Host' : 'Atlas Desktop',
          action: 'read',
        })),
        ...savedState.items.map((item) => ({
          name: path.basename(item.result_path),
          file_path: item.result_path,
          happened_at: item.created_at,
          actor: 'Atlas',
          action: 'saved',
        })),
      ].filter((item) => item.happened_at).sort((left, right) => String(right.happened_at).localeCompare(String(left.happened_at)));
      const recentResource = candidates[0] ?? null;
      let detail = null;
      try { detail = registry.show(project.id); } catch { /* This Project alone remains unavailable. */ }
      let folder = detail?.location?.root_path ? path.resolve(detail.location.root_path, detail.location.relative_path ?? '') : null;
      let folderAvailable = false;
      let folderIssue = null;
      try {
        folder = projectDirectory(detail?.location);
        folderAvailable = true;
      } catch (error) {
        folderIssue = detail?.location
          ? (fs.existsSync(folder ?? '') ? 'Atlas cannot verify this Project folder.' : 'This Project folder is no longer at its recorded location.')
          : 'This Project has no active local folder.';
      }
      return {
        id: project.id,
        name: project.name,
        folder: folder ?? 'Not available',
        folder_display: folder ? path.basename(folder) || folder : 'Location unavailable',
        folder_available: folderAvailable,
        folder_issue: folderIssue,
        relink_href: !folderAvailable && detail?.location ? `/projects/${encodeURIComponent(project.id)}/relink` : null,
        remove_href: folderAvailable ? null : `/projects/${encodeURIComponent(project.id)}/remove`,
        recent_resource: recentResource ? { name: recentResource.name, file_path: recentResource.file_path } : null,
        recent_activity_at: recentResource?.happened_at ?? null,
        recent_activity_text: recentResource
          ? `${recentResource.actor} ${recentResource.action} this ${new Date(recentResource.happened_at).toLocaleString()}`
          : null,
      };
    }).sort((left, right) => {
      if (left.recent_activity_at && right.recent_activity_at) return right.recent_activity_at.localeCompare(left.recent_activity_at);
      if (left.recent_activity_at) return -1;
      if (right.recent_activity_at) return 1;
      if (left.folder_available !== right.folder_available) return left.folder_available ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return {
      projects: entries,
      selected_project_id: entries.find((entry) => entry.folder_available)?.id ?? entries[0]?.id ?? null,
      notice: recentState.error ? 'Recent Project work could not be loaded. Registered Projects are still available.' : null,
    };
  };
  const renderProjectsHome = (response, extra = {}, statusCode = 200) => sendPage(response, statusCode, renderProjectsHomeView({
    ...projectsHomeModel(),
    ...extra,
  }, {
    workspaceHref: '/projects', ...displayOptions(),
  }));
  const renderOnboarding = (response, model) => sendPage(response, 200, renderProjectOnboardingView(model, {
    csrfToken, desktop_picker_enabled: desktopPickerEnabled, workspaceHref: '/projects', ...displayOptions(),
  }));
  const inspectionFact = (inspection) => {
    const extraction = inspection?.extraction ?? {};
    const profile = extraction.profile ?? extraction.data_profile ?? {};
    if (Array.isArray(extraction.sheets)) return `${extraction.sheets.length} sheet${extraction.sheets.length === 1 ? '' : 's'}`;
    if (Number.isFinite(profile.row_count) && Number.isFinite(profile.column_count)) return `${profile.row_count} rows, ${profile.column_count} fields`;
    if (Number.isFinite(extraction.page_count)) return `${extraction.page_count} page${extraction.page_count === 1 ? '' : 's'}`;
    if (Number.isFinite(extraction.paragraph_count)) return `${extraction.paragraph_count} paragraphs`;
    if (Number.isFinite(extraction.slide_count)) return `${extraction.slide_count} slide${extraction.slide_count === 1 ? '' : 's'}`;
    if (extraction.kind === 'text') return 'Local text ready';
    return extraction.status === 'unsupported' ? 'Unsupported file type' : 'Local inspection ready';
  };
  const batchWork = createBatchWorkService({ fileWork, projectImport, inspectionFact });

  const renderFiles = (response, model, statusCode = 200) => {
    sendPage(response, statusCode, renderFileWorkView(model, {
      csrfToken,
      workspaceHref: '/projects',
      projectBasePath: '/projects/',
      fileBackHref: model.back_href ?? '/files',
      fileCurrentHref: model.current_href ?? null,
      ...displayOptions(),
    }));
  };

  const renderCompare = (response, model, statusCode = 200) => {
    sendPage(response, statusCode, renderFileCompareView(model, {
      csrfToken,
      workspaceHref: '/projects',
      compareHref: model.compare_href,
      backHref: model.back_href,
      openEndpoint: model.open_endpoint,
      navCurrent: model.nav_current,
      ...displayOptions(),
    }));
  };
  const projectEntry = (projectId) => {
    const project = activeProjects().find((item) => item.id === projectId);
    if (!project) throw new Error('The selected Project is not available.');
    const location = registry.show(projectId).location;
    return { project, location, root: projectDirectory(location), base: `/projects/${encodeURIComponent(projectId)}` };
  };
  const renderProjectFiles = (response, entry, data, extra = {}) => sendPage(response, 200, renderProjectFilesView({ ...entry, ...data, ...extra }, { csrfToken, ...displayOptions() }));
  const renderProjectResources = (response, model, statusCode = 200) => sendPage(response, statusCode, renderProjectResourcesView(model, { csrfToken, ...displayOptions() }));
  const renderDataWork = (response, model, statusCode = 200) => sendPage(response, statusCode, renderDataWorkView({ ...model, csrf: csrfToken }, displayOptions()));

  const recentWorkModel = () => {
    const recent = readRecentWorkState(stateDir);
    return { recent_work: recent.items, recent_work_error: Boolean(recent.error) };
  };
  const renderFilesHome = (response, notice, statusCode = 200) => renderBatch(response, {
    mode: 'empty-selection', notice, desktop_picker_enabled: desktopPickerEnabled,
  }, statusCode);
  const activityResourceHref = (item) => {
    if (!item.project?.id || !item.file_path) return null;
    try {
      const source = fs.lstatSync(path.resolve(item.file_path));
      if (!source.isFile() || source.isSymbolicLink()) return null;
      const entry = projectEntry(item.project.id);
      const relative = path.relative(entry.root, path.resolve(item.file_path));
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
      const activityKey = item.activity_id ?? item.work_id ?? null;
      const returnQuery = activityKey ? `&from=activity&activity=${encodeURIComponent(activityKey)}` : '';
      return `${entry.base}/resources?path=${encodeURIComponent(relative.replaceAll('\\', '/'))}${returnQuery}`;
    } catch {
      return null;
    }
  };
  const activityModel = (selectedActivityKey = null, importId = null) => {
    const current = readCurrentActivityState(stateDir);
    const recent = recentWorkModel();
    const saves = savedWork.activityItems();
    return {
      ...recent,
      recent_work: [...recent.recent_work
        .filter((item) => !saves.some((save) => save.save_id === item.project_transfer?.run_id))
        .map((item) => ({ ...item, status: 'completed', resource_href: activityResourceHref(item) })), ...saves]
        .filter((item, index, all) => all.findIndex((other) => (other.save_id ?? other.work_id) === (item.save_id ?? item.work_id)) === index),
      current_activity: current.items.map((item) => ({ ...item, resource_href: activityResourceHref(item) })),
      current_activity_error: Boolean(current.error),
      selected_activity_key: selectedActivityKey,
      import_status_href: /^BIM-[a-f0-9]{32}$/u.test(importId ?? '') ? `/activity/import-status?import_id=${encodeURIComponent(importId)}` : null,
    };
  };
  const renderActivity = (response, statusCode = 200, selectedActivityKey = null, importId = null) => {
    sendPage(response, statusCode, renderActivityView(activityModel(selectedActivityKey, importId), {
      csrfToken,
      workspaceHref: '/projects',
      ...displayOptions(),
    }));
  };
  const activityStateSignature = () => ['current-activity.json', 'recent-work.json', 'saved-work.json'].map((name) => {
    try {
      const stat = fs.statSync(path.join(stateDir, 'ui', name));
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${name}:missing`;
    }
  }).join('|');
  const globalSearchModel = (query) => {
    const term = String(query ?? '').trim();
    const items = [];
    const unavailable = [];
    const seen = new Set();
    let truncated = false;
    const matches = (...values) => values.some((value) => String(value ?? '').toLocaleLowerCase().includes(term.toLocaleLowerCase()));
    const addItem = (item) => {
      const key = `${item.kind}:${item.href ?? ''}:${item.name ?? ''}`;
      if (seen.has(key)) return;
      if (items.length >= 100) { truncated = true; return; }
      seen.add(key);
      items.push(item);
    };
    const resourceHref = (projectId, filePath) => {
      try {
        const entry = projectEntry(projectId);
        const relative = path.relative(entry.root, path.resolve(filePath));
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
        return `${entry.base}/resources?path=${encodeURIComponent(relative.replaceAll('\\', '/'))}`;
      } catch {
        return null;
      }
    };
    for (const project of activeProjects()) {
      if (term && matches(project.name)) {
        addItem({
          kind: 'project', project_id: project.id, project_name: project.name, name: project.name,
          href: `/projects/${encodeURIComponent(project.id)}/resources`,
        });
      }
      if (!term || items.length >= 100) continue;
      try {
        const entry = projectEntry(project.id);
        const found = searchProjectFiles(entry.root, term);
        truncated ||= found.truncated;
        for (const item of found.items) {
          addItem({
            ...item,
            kind: 'file',
            project_id: project.id,
            project_name: project.name,
            href: `${entry.base}/resources?path=${encodeURIComponent(item.relative_path)}`,
          });
        }
        const savedState = savedWork.stateForProject(project.id);
        for (const item of savedState.items) {
          const sourceName = path.basename(item.source_path);
          const resultName = path.basename(item.result_path);
          if (!matches(sourceName, resultName, item.source_path, item.result_path)) continue;
          const href = resourceHref(project.id, item.result_path) ?? `${entry.base}/resources`;
          addItem({
            kind: 'relationship',
            project_id: project.id,
            project_name: project.name,
            name: `${sourceName} → ${resultName}`,
            detail: `${project.name} · source to created work`,
            href,
          });
        }
      } catch {
        unavailable.push(project.id);
      }
    }
    if (term) {
      const activeProjectIds = new Set(activeProjects().map((project) => project.id));
      const current = readCurrentActivityState(stateDir).items.map((item) => ({ ...item, search_status: String(item.status ?? 'running').replaceAll('_', ' ') }));
      const recent = readRecentWorkState(stateDir).items.map((item) => ({ ...item, search_status: 'completed' }));
      for (const item of [...current, ...recent]) {
        if (!item.project?.id || !activeProjectIds.has(item.project.id)) continue;
        const activityKey = item.activity_id ?? item.work_id;
        const activityStatus = String(item.search_status).toLocaleLowerCase();
        const label = ['running', 'in progress', 'in_progress'].includes(activityStatus)
          ? 'In progress'
          : activityStatus === 'waiting' ? 'Waiting'
            : activityStatus === 'failed' ? 'Failed'
              : activityStatus === 'interrupted' ? 'Interrupted'
                : activityStatus === 'completed' ? 'Completed' : 'Information incomplete';
        if (!activityKey || !matches(path.basename(item.file_path), item.file_path, item.project.name, label, item.result_summary?.label)) continue;
        addItem({
          kind: 'activity',
          project_id: item.project.id,
          project_name: item.project.name,
          name: path.basename(item.file_path),
          detail: `${item.project.name} · ${label}`,
          href: `/activity?selected=${encodeURIComponent(activityKey)}`,
        });
      }
    }
    return { query: term, items, unavailable, truncated };
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
      if (url.pathname === '/favicon.ico' && request.method === 'GET') {
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (request.method === 'GET' && UI_IMAGE_ASSETS.has(url.pathname)) {
        sendUiImage(response, UI_IMAGE_ASSETS.get(url.pathname));
        return;
      }
      if (url.pathname === '/desktop/selection' && request.method === 'POST') {
        if (!desktopPickerToken || !equalSecret(desktopPickerToken, request.headers['x-atlas-desktop-token'])) {
          sendJson(response, 403, { ok: false });
          return;
        }
        const form = await readForm(request);
        const kind = form.get('kind') === 'folder' ? 'folder' : 'file';
        const mode = form.get('mode') === 'multiple' ? 'multiple' : 'single';
        const rawPaths = form.getAll('file_path').filter(Boolean);
        try {
          const registered = form.get('flow') === 'import'
            ? desktopSelections.registerImport({ kind, paths: rawPaths, queueId: form.get('queue_id') })
            : desktopSelections.register({ kind, mode, paths: rawPaths });
          if (registered.kind === 'queue') {
            sendJson(response, 200, { ok: true, queue_id: registered.queue.queue_id, count: registered.queue.items.length });
            return;
          }
          sendJson(response, 200, {
            ok: true,
            selection_id: registered.selection.selection_id,
            name: path.basename(registered.selection.path),
            purpose: kind === 'file' ? defaultInspectPurpose(registered.selection.path) : null,
          });
        } catch (error) {
          sendJson(response, 400, { ok: false, error: error.message });
        }
        return;
      }
      const selectedMatch = url.pathname.match(/^\/files\/selected\/(SEL-[a-f0-9]{32})$/u);
      if (selectedMatch && request.method === 'GET') {
        const selected = desktopSelections.selection(selectedMatch[1], { kind: 'file' });
        if (!selected) {
          renderFilesHome(response, 'The selected file is no longer available. Choose it again.', 410);
          return;
        }
        renderFiles(response, {
          mode: 'selected',
          selected: {
            selection_id: selected.selection_id,
            file_path: selected.path,
            name: path.basename(selected.path),
            purpose: defaultInspectPurpose(selected.path),
          },
        });
        return;
      }
      if (url.pathname === '/files' && request.method === 'GET') {
        const notice = notices.get('files') ?? null;
        notices.delete('files');
        renderFilesHome(response, notice);
        return;
      }
      if (url.pathname === '/activity' && request.method === 'GET') {
        renderActivity(response, 200, url.searchParams.get('selected'), url.searchParams.get('import'));
        return;
      }
      if (url.pathname === '/activity/import-status' && request.method === 'GET') {
        const imported = batchImportRecord(url.searchParams.get('import_id'));
        if (!imported) {
          sendJson(response, 410, { ok: false, status: 'unavailable', href: '/files' });
          return;
        }
        sendJson(response, 200, { ok: true, status: imported.job_status ?? 'waiting', href: imported.result_href ?? null });
        return;
      }
      if (url.pathname === '/activity/fragment' && request.method === 'GET') {
        sendHtml(response, 200, renderActivityFragment(activityModel(url.searchParams.get('selected')), { csrfToken }), { desktopBridge: desktopPickerEnabled });
        return;
      }
      if (url.pathname === '/activity/events' && request.method === 'GET') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-content-type-options': 'nosniff',
        });
        response.write('event: ready\ndata: connected\n\n');
        let signature = activityStateSignature();
        const interval = setInterval(() => {
          const next = activityStateSignature();
          if (next !== signature) {
            signature = next;
            response.write(`event: change\ndata: ${JSON.stringify(signature)}\n\n`);
          } else {
            response.write(': heartbeat\n\n');
          }
        }, 1500);
        request.on('close', () => clearInterval(interval));
        return;
      }
      if (url.pathname === '/activity/dismiss' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        finishCurrentActivity(stateDir, form.get('activity_id'));
        redirect(response, '/activity');
        return;
      }
      const queueMatch = url.pathname.match(/^\/files\/queue\/(BQS-[a-f0-9]{32})$/u);
      if (queueMatch && request.method === 'GET') {
        const queue = desktopSelections.queue(queueMatch[1]);
        const importId = url.searchParams.get('import');
        const imported = batchImportRecord(importId);
        if (!queue && imported?.queue_id === queueMatch[1] && imported.job_status === 'completed' && imported.result_href) {
          redirect(response, imported.result_href);
          return;
        }
        renderBatch(response, queue
          ? {
            mode: 'selection-set', queue_id: queue.queue_id, items: queue.items,
            projects: projectImport.projectChoices(), destination: queue.destination ?? null,
            import_result: queue.import_result ?? [],
            import_status: imported?.job_status ?? null,
            import_status_href: `/activity/import-status?import_id=${encodeURIComponent(importId ?? '')}`,
            activity_href: `/activity?import=${encodeURIComponent(importId ?? '')}`,
          }
          : { mode: 'unavailable' }, queue ? 200 : 410);
        return;
      }
      if (url.pathname === '/files/queue/remove' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        const queue = desktopSelections.queue(form.get('queue_id'));
        if (!queue) throw new Error('That temporary file selection is no longer available.');
        desktopSelections.removeFromQueue(queue.queue_id, form.get('item_id'));
        redirect(response, `/files/queue/${encodeURIComponent(queue.queue_id)}`);
        return;
      }
      if (url.pathname === '/files/queue/clear' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        desktopSelections.clearQueue(form.get('queue_id'));
        redirect(response, '/files');
        return;
      }
      if (url.pathname === '/files/queue/inspect' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        const queue = desktopSelections.queue(form.get('queue_id'));
        if (!queue || !queue.items.length) throw new Error('Choose local files again before importing them.');
        const project = projectImport.projectChoices().find((item) => item.id === form.get('project_id'));
        queue.destination = {
          project_id: form.get('project_id'), project_name: project?.name ?? null, folder: form.get('folder'),
        };
        queue.updated_at = Date.now();
        const items = await batchWork.inspectQueueAsync(queue.items.filter((item) => item.actionable !== false));
        const batchId = `BRS-${crypto.randomBytes(16).toString('hex')}`;
        const result = {
          batch_id: batchId, queue_id: queue.queue_id, created_at: Date.now(), items,
          inspected_count: items.filter((item) => item.status === 'inspected').length,
        };
        batchResults.set(batchId, result);
        const workIds = items.filter((item) => item.status === 'inspected' && !item.project).map((item) => item.work_id);
        const prepared = batchWork.prepareImports({ workIds, projectId: form.get('project_id'), folder: form.get('folder'), attemptKey: batchId });
        const byWork = new Map(items.filter((item) => item.work_id).map((item) => [item.work_id, item]));
        const preparedItems = prepared.map((item) => ({ ...item, item_id: byWork.get(item.work_id)?.item_id ?? null }));
        for (const resultItem of items.filter((item) => item.status !== 'inspected')) {
          const selectedItem = queue.items.find((item) => item.item_id === resultItem.item_id);
          if (selectedItem) { selectedItem.reason = resultItem.error ?? resultItem.fact ?? 'This item could not be imported.'; selectedItem.actionable = false; }
        }
        for (const preparedItem of preparedItems.filter((item) => !item.prepared)) {
          const selectedItem = queue.items.find((item) => item.item_id === preparedItem.item_id);
          if (selectedItem) { selectedItem.reason = preparedItem.status; selectedItem.actionable = false; }
        }
        const unpreparedItems = items.filter((item) => item.status !== 'inspected' || item.project).map((item) => ({
          item_id: item.item_id, work_id: item.work_id ?? null, name: item.name, target_path: null,
          status: item.project ? 'Already belongs to a Project' : item.error ?? item.fact ?? 'Not available',
        }));
        const batchImportId = `BIM-${crypto.randomBytes(16).toString('hex')}`;
        batchImports.set(batchImportId, {
          batch_import_id: batchImportId, batch_id: batchId, queue_id: queue.queue_id,
          created_at: Date.now(), items: preparedItems.filter((item) => item.prepared),
          review_items: [...preparedItems, ...unpreparedItems], executed: false,
        });
        redirect(response, `/files/batch-review/${encodeURIComponent(batchImportId)}`);
        return;
      }
      const batchResultMatch = url.pathname.match(/^\/files\/batch-result\/(BRS-[a-f0-9]{32})$/u);
      if (batchResultMatch && request.method === 'GET') {
        const result = batchResult(batchResultMatch[1]);
        renderBatch(response, result ? { mode: 'batch-result', ...result } : { mode: 'unavailable' }, result ? 200 : 410);
        return;
      }
      if (url.pathname === '/files/batch-add-to-project' && request.method === 'GET') {
        const form = url.searchParams;
        const result = batchResult(form.get('batch_id'));
        if (!result) throw new Error('That temporary batch result is no longer available.');
        const allowed = new Set(result.items.filter((item) => item.status === 'inspected' && !item.project).map((item) => item.work_id));
        const workIds = [...new Set(form.getAll('work_id').filter((id) => allowed.has(id)))];
        if (!workIds.length) throw new Error('Choose at least one inspected external file.');
        renderBatch(response, { mode: 'batch-add', batch_id: result.batch_id, work_ids: workIds, projects: activeProjects() });
        return;
      }
      const batchReviewMatch = url.pathname.match(/^\/files\/batch-review\/(BIM-[a-f0-9]{32})$/u);
      if (batchReviewMatch && request.method === 'GET') {
        const imported = batchImportRecord(batchReviewMatch[1]);
        if (!imported) { renderBatch(response, { mode: 'unavailable' }, 410); return; }
        renderBatch(response, {
          mode: 'batch-review', batch_id: imported.batch_id, batch_import_id: imported.batch_import_id,
          queue_id: imported.queue_id ?? null, items: imported.review_items, prepared_count: imported.items.length,
        });
        return;
      }
      if (url.pathname === '/files/batch-add-to-project/review' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        if (!intake) throw new Error('The existing Atlas file intake service is not available.');
        const result = batchResult(form.get('batch_id'));
        if (!result) throw new Error('That temporary batch result is no longer available.');
        const allowed = new Set(result.items.filter((item) => item.status === 'inspected' && !item.project).map((item) => item.work_id));
        const workIds = [...new Set(form.getAll('work_id').filter((id) => allowed.has(id)))];
        if (!workIds.length) throw new Error('Choose at least one inspected external file.');
        const batchImportId = `BIM-${crypto.randomBytes(16).toString('hex')}`;
        const items = batchWork.prepareImports({
          workIds,
          projectId: form.get('project_id'),
          folder: form.get('folder'),
          attemptKey: batchImportId,
        });
        const preparedItems = items.filter((item) => item.prepared);
        batchImports.set(batchImportId, { batch_import_id: batchImportId, batch_id: result.batch_id, created_at: Date.now(), items: preparedItems, review_items: items, executed: false });
        redirect(response, `/files/batch-review/${encodeURIComponent(batchImportId)}`);
        return;
      }
      if (url.pathname === '/files/batch-add-to-project/save' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        const imported = batchImportRecord(form.get('batch_import_id'));
        if (!imported || imported.executed) throw new Error('These prepared destinations are no longer available. Review them again.');
        const result = batchResult(imported.batch_id);
        if (!imported.queue_id) {
          imported.executed = true;
          const saved = await batchWork.saveImportsAsync(imported.items);
          if (saved.some((item) => item.error_code === 'ATLAS_PROJECTION_PENDING')) imported.executed = false;
          if (result) {
            for (const savedItem of saved) {
              const row = result.items.find((item) => item.work_id === savedItem.work_id);
              if (!row) continue;
              if (savedItem.status === 'saved') row.project = savedItem.work.project;
              else row.error = savedItem.error;
            }
          }
          redirect(response, result ? `/files/batch-result/${encodeURIComponent(result.batch_id)}` : '/files');
          return;
        }
        const queue = desktopSelections.setQueuePending(imported.queue_id, true);
        if (!queue) throw new Error('This Selection Set is no longer available. Start a new Import.');
        imported.executed = true;
        imported.job_status = 'running';
        imported.updated_at = now();
        if (result) {
          result.pending = true;
          result.updated_at = now();
        }
        const activities = new Map(imported.items.map((item) => {
          try {
            const activity = beginCurrentActivity({
              stateDir, filePath: fileWork.recentWorkById(item.work_id)?.file_path ?? item.prepared.target_path, purpose: 'import', project: item.prepared.project,
              caller: { actor: 'user', tool: 'atlas-ui' }, channel: 'desktop',
              resourceId: fileWork.recentWorkById(item.work_id)?.resource_id ?? null,
            });
            return [item.work_id, activity.activity_id];
          } catch {
            return [item.work_id, null];
          }
        }));
        const updateActivity = (activityId, update) => {
          if (!activityId) return;
          try { update(activityId); } catch {}
        };
        const finishImport = (status, href) => {
          imported.job_status = status;
          imported.result_href = href;
          imported.updated_at = now();
        };
        const queueHref = `/files/queue/${encodeURIComponent(imported.queue_id)}`;
        redirect(response, `/files/queue/${encodeURIComponent(imported.queue_id)}?import=${encodeURIComponent(imported.batch_import_id)}`);
        const runImportJob = async () => {
          try {
            const saved = await batchWork.saveImportsAsync(imported.items);
            let failed = false;
            let projectionPending = false;
            for (const savedItem of saved) {
              const row = result?.items.find((item) => item.work_id === savedItem.work_id)
                ?? imported.review_items.find((item) => item.work_id === savedItem.work_id);
              if (!row) continue;
              if (savedItem.status === 'saved') {
                row.project = savedItem.work.project;
                desktopSelections.removeFromQueue(queue.queue_id, row.item_id);
                const entry = projectEntry(savedItem.work.project.id);
                const relative = path.relative(entry.root, savedItem.work.file_path).replaceAll('\\', '/');
                queue.import_result = [...(queue.import_result ?? []), {
                  name: path.basename(savedItem.work.file_path), target: relative,
                  href: projectResourceHref(entry.base, relative, savedItem.work.resource_id),
                }];
                updateActivity(activities.get(savedItem.work_id), (activityId) => finishCurrentActivity(stateDir, activityId));
              } else {
                failed = true;
                const pendingProjection = savedItem.error_code === 'ATLAS_PROJECTION_PENDING';
                if (pendingProjection) projectionPending = true;
                row.error = savedItem.error;
                const selectedItem = queue.items.find((item) => item.item_id === row.item_id);
                if (selectedItem) { selectedItem.reason = savedItem.error; selectedItem.actionable = pendingProjection; }
                if (pendingProjection || /already exists/u.test(savedItem.error ?? '')) {
                  updateActivity(activities.get(savedItem.work_id), (activityId) => waitCurrentActivity({
                    stateDir, activityId, reason: savedItem.error,
                    recoveryHref: queueHref, recoveryLabel: pendingProjection ? 'Retry Recent Work projection' : 'Return to Import',
                  }));
                } else {
                  updateActivity(activities.get(savedItem.work_id), (activityId) => failCurrentActivity({
                    stateDir, activityId, error: savedItem.error,
                    recoveryHref: queueHref, recoveryLabel: 'Return to Import',
                  }));
                }
              }
            }
            const remaining = queue.items.length;
            const firstSaved = saved.find((item) => item.status === 'saved')?.work ?? null;
            if (!remaining && firstSaved?.project?.id && firstSaved.file_path) {
              desktopSelections.clearQueue(imported.queue_id);
              const entry = projectEntry(firstSaved.project.id);
              const relative = path.relative(entry.root, firstSaved.file_path).replaceAll('\\', '/');
              finishImport('completed', projectResourceHref(entry.base, relative, firstSaved.resource_id));
            } else {
              finishImport(projectionPending ? 'partial' : (failed ? 'failed' : 'partial'), queueHref);
            }
            if (projectionPending) imported.executed = false;
          } catch (error) {
            finishImport('failed', queueHref);
            for (const activityId of activities.values()) {
              updateActivity(activityId, (currentActivityId) => failCurrentActivity({
                stateDir, activityId: currentActivityId, error,
                recoveryHref: queueHref,
                recoveryLabel: 'Return to Import',
              }));
            }
          } finally {
            desktopSelections.setQueuePending(imported.queue_id, false);
            if (result) {
              result.pending = false;
              result.updated_at = now();
            }
            imported.updated_at = now();
          }
        };
        setImmediate(() => {
          void runImportJob().catch(() => {
            imported.job_status = 'failed';
            imported.result_href = queueHref;
            imported.updated_at = Date.now();
            try { desktopSelections.setQueuePending(imported.queue_id, false); } catch {}
          });
        });
        return;
      }
      if (url.pathname === '/projects/add-existing' && request.method === 'GET') {
        renderOnboarding(response, {
          mode: 'add-existing',
          return_work_id: url.searchParams.get('return_work_id'),
          return_batch_id: url.searchParams.get('return_batch_id'),
          return_data_work_id: url.searchParams.get('return_data_work_id'),
        });
        return;
      }
      const projectRemoveMatch = url.pathname.match(/^\/projects\/([^/]+)\/remove(?:\/(confirm))?$/u);
      if (projectRemoveMatch) {
        const projectId = decodeURIComponent(projectRemoveMatch[1]);
        const operation = projectRemoveMatch[2] ?? null;
        const detail = registry.show(projectId);
        if (!operation && request.method === 'GET') {
          renderOnboarding(response, { mode: 'remove', project_id: projectId, project_name: detail.name });
          return;
        }
        if (operation === 'confirm' && request.method === 'POST') {
          const form = await readForm(request);
          if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
          projectOnboarding.removeUnavailableProject(projectId);
          redirect(response, '/projects?removed=1');
          return;
        }
      }
      const projectRelinkMatch = url.pathname.match(/^\/projects\/([^/]+)\/relink(?:\/(preview|confirm))?$/u);
      if (projectRelinkMatch) {
        const projectId = decodeURIComponent(projectRelinkMatch[1]);
        const operation = projectRelinkMatch[2] ?? null;
        const detail = registry.show(projectId);
        const previousFolder = detail.location?.root_path
          ? path.resolve(detail.location.root_path, detail.location.relative_path ?? '')
          : 'Unavailable';
        if (!operation && request.method === 'GET') {
          renderOnboarding(response, { mode: 'relink', project_id: projectId, project_name: detail.name, previous_folder: previousFolder });
          return;
        }
        if (operation === 'preview' && request.method === 'POST') {
          const form = await readForm(request);
          if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
          const selected = desktopSelections.selection(form.get('folder_selection_id'), { kind: 'folder' });
          if (!selected) throw new Error('Choose the moved Project folder again.');
          const query = new URLSearchParams({ folder_selection_id: selected.selection_id });
          redirect(response, `/projects/${encodeURIComponent(projectId)}/relink/preview?${query}`);
          return;
        }
        if (operation === 'preview' && request.method === 'GET') {
          const selected = desktopSelections.selection(url.searchParams.get('folder_selection_id'), { kind: 'folder' });
          if (!selected) { redirect(response, `/projects/${encodeURIComponent(projectId)}/relink`); return; }
          renderOnboarding(response, { mode: 'relink-preview', project_id: projectId, project_name: detail.name, previous_folder: previousFolder, folder: selected.path, folder_selection_id: selected.selection_id });
          return;
        }
        if (operation === 'confirm' && request.method === 'POST') {
          const form = await readForm(request);
          if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
          const selected = desktopSelections.selection(form.get('folder_selection_id'), { consume: true, kind: 'folder' });
          if (!selected) throw new Error('Choose the moved Project folder again.');
          projectOnboarding.relinkFolder(projectId, selected.path);
          redirect(response, `/projects/${encodeURIComponent(projectId)}/resources`);
          return;
        }
      }
      if (url.pathname === '/projects/new' && request.method === 'GET') {
        renderOnboarding(response, {
          mode: 'new',
          return_work_id: url.searchParams.get('return_work_id'),
          return_batch_id: url.searchParams.get('return_batch_id'),
          return_data_work_id: url.searchParams.get('return_data_work_id'),
        });
        return;
      }
      if (url.pathname === '/projects/add-existing/preview' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        const selected = desktopSelections.selection(form.get('folder_selection_id'), { kind: 'folder' });
        if (!selected) throw new Error('Choose the local folder again before adding it as a Project.');
        const query = new URLSearchParams({ folder_selection_id: selected.selection_id, return_work_id: form.get('return_work_id') ?? '', return_batch_id: form.get('return_batch_id') ?? '', return_data_work_id: form.get('return_data_work_id') ?? '' });
        redirect(response, `/projects/add-existing/preview?${query}`);
        return;
      }
      if (url.pathname === '/projects/add-existing/preview' && request.method === 'GET') {
        const selected = desktopSelections.selection(url.searchParams.get('folder_selection_id'), { kind: 'folder' });
        if (!selected) { redirect(response, '/projects/add-existing'); return; }
        renderOnboarding(response, { mode: 'existing-preview', folder_selection_id: selected.selection_id, folder: selected.path, name: path.basename(selected.path), return_work_id: url.searchParams.get('return_work_id'), return_batch_id: url.searchParams.get('return_batch_id'), return_data_work_id: url.searchParams.get('return_data_work_id') });
        return;
      }
      if (url.pathname === '/projects/new/preview' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        const selected = desktopSelections.selection(form.get('folder_selection_id'), { kind: 'folder' });
        if (!selected) throw new Error('Choose the parent folder again before creating a Project.');
        const preview = projectOnboarding.previewNewProject(selected.path, form.get('name'));
        const query = new URLSearchParams({ folder_selection_id: selected.selection_id, name: preview.name, return_work_id: form.get('return_work_id') ?? '', return_batch_id: form.get('return_batch_id') ?? '', return_data_work_id: form.get('return_data_work_id') ?? '' });
        redirect(response, `/projects/new/preview?${query}`);
        return;
      }
      if (url.pathname === '/projects/new/preview' && request.method === 'GET') {
        const selected = desktopSelections.selection(url.searchParams.get('folder_selection_id'), { kind: 'folder' });
        if (!selected) { redirect(response, '/projects/new'); return; }
        const preview = projectOnboarding.previewNewProject(selected.path, url.searchParams.get('name'));
        renderOnboarding(response, { mode: 'new-preview', folder_selection_id: selected.selection_id, folder: preview.parent, name: preview.name, target: preview.target, target_exists: preview.target_exists, return_work_id: url.searchParams.get('return_work_id'), return_batch_id: url.searchParams.get('return_batch_id'), return_data_work_id: url.searchParams.get('return_data_work_id') });
        return;
      }
      if (url.pathname === '/projects/add-existing/create' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        const selected = desktopSelections.selection(form.get('folder_selection_id'), { consume: true, kind: 'folder' });
        if (!selected) throw new Error('Choose the local folder again before adding it as a Project.');
        const registered = projectOnboarding.registerFolder(selected.path, form.get('name') || path.basename(selected.path));
        redirect(response, returnAfterOnboarding(form, registered.project.id));
        return;
      }
      if ((url.pathname === '/projects/new/create' || url.pathname === '/projects/new/use-existing') && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        const selected = desktopSelections.selection(form.get('folder_selection_id'), { consume: true, kind: 'folder' });
        if (!selected) throw new Error('Choose the parent folder again before creating a Project.');
        const registered = projectOnboarding.createOrUseProject({
          parentPath: selected.path,
          name: form.get('name'),
          create: url.pathname === '/projects/new/create',
        });
        redirect(response, returnAfterOnboarding(form, registered.project.id));
        return;
      }
      if (url.pathname === '/data-work/start' && request.method === 'GET') {
        const work = fileWork.recentWorkById(url.searchParams.get('work_id'));
        if (!work) {
          renderFilesHome(response, 'This Recent Work item is no longer available. Choose a local file again.', 410);
          return;
        }
        const project = work.project ?? projectImport.projectForFile(work.file_path) ?? null;
        const inspection = fileWork.cachedInspection(work);
        const knownSheets = inspection?.extraction?.sheets ?? null;
        const started = await dataWork.begin({ filePath: work.file_path, project, knownSheets });
        redirect(response, `/data-work/${encodeURIComponent(started.session_id)}`);
        return;
      }
      const projectDataWorkMatch = url.pathname.match(/^\/projects\/([^/]+)\/data-work$/u);
      if (projectDataWorkMatch && request.method === 'GET') {
        const entry = projectEntry(decodeURIComponent(projectDataWorkMatch[1]));
        const source = contentFilePath(projectPath(entry.root, url.searchParams.get('path') ?? ''));
        const started = await dataWork.begin({ filePath: source, project: entry.project });
        redirect(response, `/data-work/${encodeURIComponent(started.session_id)}`);
        return;
      }
      const dataWorkMatch = url.pathname.match(/^\/data-work\/(DWT-[a-f0-9]{32})(?:\/(action|save|save\/review|save\/confirm|saved))?$/u);
      if (dataWorkMatch) {
        const [, sessionId, operation] = dataWorkMatch;
        const session = dataWork.session(sessionId);
        if (!session) {
          renderDataWork(response, { mode: 'unavailable', back_href: '/files' }, 410);
          return;
        }
        const backHref = session.project?.id ? `/projects/${encodeURIComponent(session.project.id)}/files` : '/files';
        if (!operation && request.method === 'GET') {
          const noticeKey = `data-work:${sessionId}`;
          const notice = notices.get(noticeKey) ?? null;
          notices.delete(noticeKey);
          if (path.extname(session.file_path).toLowerCase() === '.xlsx' && !session.sheet) {
            renderDataWork(response, { mode: 'sheet', session, back_href: backHref, notice }); return;
          }
          const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
          await dataWork.page(sessionId, page);
          renderDataWork(response, { mode: 'table', session, page, back_href: backHref, notice }); return;
        }
        if (operation === 'action' && request.method === 'POST') {
          const form = await readForm(request); if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
          try {
            const action = form.get('action');
            if (action === 'sheet') await dataWork.selectSheet(sessionId, form.get('sheet'));
            else await dataWork.change(sessionId, action, { search: form.get('search'), column: form.get('column'), operator: form.get('operator'), value: form.get('value'), filter_id: form.get('filter_id'), direction: form.get('direction'), columns: form.getAll('column'), column_mode: form.get('column_mode'), remove_empty_rows: form.get('remove_empty_rows') === 'yes', remove_duplicates: form.get('remove_duplicates') === 'yes' });
            redirect(response, `/data-work/${encodeURIComponent(sessionId)}`); return;
          } catch (error) {
            notices.set(`data-work:${sessionId}`, safeNotice(error));
            redirect(response, `/data-work/${encodeURIComponent(sessionId)}`); return;
          }
        }
        if (operation === 'save' && request.method === 'GET') {
          const noticeKey = `data-work:${sessionId}`;
          const notice = notices.get(noticeKey) ?? null;
          notices.delete(noticeKey);
          renderDataWork(response, { mode: 'save', session, projects: projectImport.projectChoices(), back_href: backHref, notice }); return;
        }
        if (operation === 'save/review' && request.method === 'GET') {
          try {
            const entry = projectEntry(url.searchParams.get('project_id'));
            const target = savedWork.prepareDestination({
              projectRoot: entry.root,
              folder: url.searchParams.get('folder'),
              fileName: url.searchParams.get('file_name'),
              sourcePath: session.file_path,
            });
            const current = dataWork.session(sessionId);
            if (!current.staged_path || !current.staged) throw new Error('The staged result is no longer available. Review the save again.');
            renderDataWork(response, { mode: 'review', session: current, save: { project: entry.project, folder: url.searchParams.get('folder'), file_name: path.basename(target), target }, back_href: backHref }); return;
          } catch (error) {
            notices.set(`data-work:${sessionId}`, safeNotice(error));
            redirect(response, `/data-work/${encodeURIComponent(sessionId)}/save`); return;
          }
        }
        if (operation === 'save/review' && request.method === 'POST') {
          const form = await readForm(request); if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
          try {
            const entry = projectEntry(form.get('project_id')); const target = savedWork.prepareDestination({ projectRoot: entry.root, folder: form.get('folder'), fileName: form.get('file_name'), sourcePath: session.file_path });
            await dataWork.stage(sessionId);
            const query = new URLSearchParams({ project_id: entry.project.id, folder: form.get('folder'), file_name: path.basename(target) });
            redirect(response, `/data-work/${encodeURIComponent(sessionId)}/save/review?${query}`); return;
          } catch (error) {
            notices.set(`data-work:${sessionId}`, safeNotice(error));
            redirect(response, `/data-work/${encodeURIComponent(sessionId)}/save`); return;
          }
        }
        if (operation === 'save/confirm' && request.method === 'POST') {
          const form = await readForm(request); if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
          try {
            const entry = projectEntry(form.get('project_id')); const current = dataWork.session(sessionId);
            if (!current.staged_path || !current.staged) throw new Error('The staged result is no longer available. Review the save again.');
            const fileName = path.basename(form.get('file_name')).normalize('NFC');
            const requestKey = `${sessionId}:${entry.project.id}:${form.get('folder')}:${fileName}`;
          const sourceProject = projectImport.projectForFile(current.file_path);
          const record = savedWork.save({ project: entry.project, projectRoot: entry.root, root: entry.location.root_path, folder: form.get('folder'), fileName, stagedPath: current.staged_path, expectedCandidateHash: current.staged.sha256, sourcePath: current.file_path, sourceFingerprint: current.source_fingerprint, sourceResourceId: resourceControl.identify({ filePath: current.file_path, project: sourceProject }).resource_id, requestKey, caller: { actor: 'user', tool: 'atlas-ui', client_run_id: sessionId }, parameters: { ...current.operations, sheet: current.sheet }, resultSummary: { rows: current.preview.result_summary.rows, columns: current.preview.result_summary.columns, sheet: current.sheet, format: path.extname(current.file_path).slice(1).toUpperCase() } });
            dataWork.clearStage(sessionId);
            redirect(response, `/data-work/${encodeURIComponent(sessionId)}/saved?work_id=${encodeURIComponent(record.work_id)}`); return;
          } catch (error) {
            notices.set(`data-work:${sessionId}`, safeNotice(error));
            redirect(response, `/data-work/${encodeURIComponent(sessionId)}/save`); return;
          }
        }
        if (operation === 'saved' && request.method === 'GET') {
          const record = savedWork.find(url.searchParams.get('work_id'));
          if (!record) {
            notices.set(`data-work:${sessionId}`, 'The saved result is no longer available.');
            redirect(response, `/data-work/${encodeURIComponent(sessionId)}`); return;
          }
          renderDataWork(response, { mode: 'saved', session, record, back_href: backHref }); return;
        }
      }
      if (url.pathname === '/data-work/undo' && request.method === 'POST') {
        const form = await readForm(request); if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        const projectId = String(form.get('project_id') ?? '');
        const existing = savedWork.find(String(form.get('work_id') ?? ''));
        if (!existing || existing.project?.id !== projectId) throw new Error('The requested saved result is unavailable in this Project.');
        const record = savedWork.undo(existing.work_id);
        redirect(response, record.resources_href ?? `/projects/${encodeURIComponent(projectId)}/resources`); return;
      }
      if (url.pathname === '/data-work/redo' && request.method === 'POST') {
        const form = await readForm(request); if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        const projectId = String(form.get('project_id') ?? '');
        const existing = savedWork.find(String(form.get('work_id') ?? ''));
        if (!existing || existing.project?.id !== projectId) throw new Error('The requested saved result is unavailable in this Project.');
        const record = savedWork.redo(existing.work_id);
        redirect(response, record.resources_href ?? `/projects/${encodeURIComponent(projectId)}/resources`); return;
      }
      const projectResourceActionMatch = url.pathname.match(/^\/projects\/([^/]+)\/resources\/actions\/(keep|relink|forget|remove-reference|redo-save)$/u);
      if (projectResourceActionMatch && request.method === 'POST') {
        const [, encodedId, action] = projectResourceActionMatch;
        const entry = projectEntry(decodeURIComponent(encodedId));
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const resourceId = String(form.get('resource_id') ?? '');
        const facts = resourceControl.projectResources(entry.project.id, { refresh: true });
        const fact = facts.find((item) => item.resource_id === resourceId);
        if (!fact) throw new Error('The requested Resource is unavailable in this Project.');
        const caller = { tool: 'atlas-ui', client_run_id: uiClientRunId };
        if (action === 'redo-save') {
          const record = savedWork.find(String(form.get('work_id') ?? ''));
          if (!record || record.resource_id !== resourceId || record.project?.id !== entry.project.id || record.write?.redo_available !== true) throw new Error('The requested saved Resource is unavailable in this Project.');
          savedWork.redo(record.work_id);
        } else if (action === 'keep') resourceControl.keepRecord(resourceId, { caller });
        else if (action === 'relink') {
          const selected = desktopSelections.selection(form.get('selection_id'), { consume: true, kind: 'file' });
          if (!selected) throw new Error('The selected file is no longer available. Choose it again.');
          resourceControl.relink({ resourceId, filePath: selected.path, caller });
        } else {
          const relationshipId = String(form.get('relationship_id') ?? '');
          const relationship = (fact.relationships ?? []).find((item) => item.id === relationshipId
            && item.status === 'active' && item.target_kind === 'project' && item.target_id === entry.project.id);
          if (!relationship) throw new Error('The requested relationship is unavailable in this Project.');
          if (action === 'forget') resourceControl.forgetRelationship(relationshipId, { caller });
          else resourceControl.removeReference(relationshipId, { caller });
        }
        redirect(response, `${entry.base}/resources?resource_id=${encodeURIComponent(resourceId)}`);
        return;
      }
      const projectResourcesMatch = url.pathname.match(/^\/projects\/([^/]+)\/resources(?:\/(detail))?$/u);
      if (projectResourcesMatch && request.method === 'GET') {
        const [, encodedId, resourceAction] = projectResourcesMatch;
        const entry = projectEntry(decodeURIComponent(encodedId));
        const recentWork = readRecentWorkState(stateDir).items;
        const currentActivity = readCurrentActivityState(stateDir).items;
        const savedState = savedWork.stateForProject(entry.project.id);
        const projectNames = new Map(registry.list().map((project) => [project.id, project.name]));
        const resourceFacts = resourceControl.projectResources(entry.project.id, { refresh: true }).map((fact) => ({
          ...fact,
          relationships: (fact.relationships ?? []).map((relationship) => relationship.target_kind === 'project'
            ? { ...relationship, target_name: projectNames.get(relationship.target_id) ?? relationship.target_id }
            : relationship),
        }));
        if (resourceAction === 'detail') {
          if (savedState.error) {
            renderProjectResources(response, buildProjectResourcesModel({
              ...entry, recentWork, currentActivity, resourceFacts, savedWork: [], savedWorkError: true,
            }));
            return;
          }
          renderProjectResources(response, buildProjectResourceDetailModel({
            ...entry, recentWork, currentActivity, resourceFacts, savedWork: savedState.items,
            relativePath: url.searchParams.get('path') ?? '',
          }));
          return;
        }
        const activityKey = url.searchParams.get('from') === 'activity' ? url.searchParams.get('activity') : null;
        const activityReturnHref = activityKey ? `/activity?selected=${encodeURIComponent(activityKey)}` : null;
        const resourcesModel = buildProjectResourcesModel({
          ...entry, recentWork, currentActivity, resourceFacts, savedWork: savedState.items, savedWorkError: Boolean(savedState.error),
          focusedPath: url.searchParams.get('path'), focusedResourceId: url.searchParams.get('resource_id'), selectedFolderPath: url.searchParams.get('folder'), stateDir, activityReturnHref,
        });
        if (url.searchParams.get('fragment') === 'folder-files') {
          sendHtml(response, 200, renderProjectResourceFolderGroup(resourcesModel));
          return;
        }
        renderProjectResources(response, resourcesModel);
        return;
      }
      const projectResourceOpenMatch = url.pathname.match(/^\/projects\/([^/]+)\/resources\/open$/u);
      if (projectResourceOpenMatch && request.method === 'POST') {
        const entry = projectEntry(decodeURIComponent(projectResourceOpenMatch[1]));
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
        const relativePath = String(form.get('path') ?? '');
        openLocalFile(contentFilePath(projectPath(entry.root, relativePath)));
        redirect(response, `${entry.base}/resources?path=${encodeURIComponent(relativePath)}`);
        return;
      }
      const projectFilesMatch = url.pathname.match(/^\/projects\/([^/]+)\/(files|search|compare)(?:\/(open|inspect|run))?$/u);
      if (projectFilesMatch) {
        const [, encodedId, action, operation] = projectFilesMatch;
        const entry = projectEntry(decodeURIComponent(encodedId));
        if (action === 'files' && !operation && request.method === 'GET') {
          const data = browseProjectFiles(entry.root, url.searchParams.get('dir') ?? '');
          const noticeKey = `project-files:${entry.project.id}`;
          const notice = notices.get(noticeKey) ?? null;
          notices.delete(noticeKey);
          renderProjectFiles(response, entry, data, { notice }); return;
        }
        if (action === 'search' && !operation && request.method === 'GET') {
          const data = searchProjectFiles(entry.root, url.searchParams.get('q'));
          renderProjectFiles(response, entry, data, { directory: 'Search results', query: url.searchParams.get('q') ?? '' }); return;
        }
        if (action === 'files' && operation && request.method === 'POST') {
          const form = await readForm(request);
          if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
          const filePath = projectPath(entry.root, form.get('path'));
          if (operation === 'open') { openLocalFile(contentFilePath(filePath)); redirect(response, `${entry.base}/files?dir=${encodeURIComponent(path.dirname(form.get('path')).replaceAll('\\', '/'))}`); return; }
          try {
            const inspected = await fileWork.inspectAsync({ filePath, purpose: defaultInspectPurpose(filePath), sheet: null, maxCharacters: 4000, project: entry.project });
            redirect(response, `/files/result/${encodeURIComponent(inspected.work.work_id)}?return_to=${encodeURIComponent(`${entry.base}/files`)}`); return;
          } catch (error) {
            const failure = describeFileReadFailure(error);
            notices.set(`project-files:${entry.project.id}`, `${failure.title}. ${failure.action}`);
            redirect(response, `${entry.base}/files?dir=${encodeURIComponent(path.dirname(form.get('path')).replaceAll('\\', '/'))}`); return;
          }
        }
        if (action === 'compare' && !operation && request.method === 'GET') {
          const choices = searchProjectFiles(entry.root, '', { acceptFile: (item) => contentComparisonSupported(item.relative_path) }).items;
          renderCompare(response, {
            mode: 'project-choose', choices, compare_action: `${entry.base}/compare/run`,
            compare_href: `${entry.base}/compare`, back_href: `${entry.base}/files`, nav_current: 'Projects',
          }); return;
        }
        if (action === 'compare' && operation === 'run' && request.method === 'POST') {
          const form = await readForm(request);
          if (!equalSecret(csrfToken, form.get('csrf'))) throw new Error('Atlas UI session token is invalid.');
          const choices = searchProjectFiles(entry.root, '', { acceptFile: (item) => contentComparisonSupported(item.relative_path) }).items;
          const allowed = new Set(choices.map((item) => item.relative_path));
          const left = form.get('left'); const right = form.get('right');
          const choiceModel = (notice = null) => ({
            mode: 'project-choose', choices, left, right, notice,
            compare_action: `${entry.base}/compare/run`, compare_href: `${entry.base}/compare`,
            back_href: `${entry.base}/files`, nav_current: 'Projects',
          });
          if (!allowed.has(left) || !allowed.has(right)) {
            renderCompare(response, choiceModel('Choose two supported files from this Project.'), 400); return;
          }
          if (left === right) {
            renderCompare(response, choiceModel('Choose two different files.'), 400); return;
          }
          try {
            const leftPath = projectPath(entry.root, left); const rightPath = projectPath(entry.root, right);
            const comparison = await runContentOperation('compare', {
              stateDir, projectRoot, installationRoot, leftPath, rightPath,
            });
            const comparisonId = `CMP-${crypto.randomBytes(16).toString('hex')}`;
            comparisons.set(comparisonId, {
              created_at: Date.now(), left_path: leftPath, right_path: rightPath, comparison,
              compare_href: `${entry.base}/compare`, back_href: entry.base, nav_current: 'Projects',
            });
            redirect(response, `/compare/result/${encodeURIComponent(comparisonId)}`); return;
          } catch (error) {
            renderCompare(response, choiceModel(safeNotice(error)), error.code === 'ATLAS_STATE_CONFLICT' ? 409 : 400); return;
          }
        }
      }
      if (url.pathname === '/compare' && request.method === 'GET') {
        renderCompare(response, { mode: 'choose', desktop_picker_enabled: desktopPickerEnabled });
        return;
      }
      const compareSelectionMatch = url.pathname.match(/^\/compare\/selected\/(left|right)\/(SEL-[a-f0-9]{32})$/u);
      if (compareSelectionMatch && request.method === 'GET') {
        const [, side, selectionId] = compareSelectionMatch;
        const selected = desktopSelections.selection(selectionId, { kind: 'file' });
        const leftSelectionId = side === 'right' ? url.searchParams.get('left') : null;
        const left = side === 'left' ? selected : desktopSelections.selection(leftSelectionId, { kind: 'file' });
        const right = side === 'right' ? selected : null;
        if (!selected || (side === 'right' && !left)) {
          renderCompare(response, { mode: 'unsupported', message: 'One selected file is no longer available. Choose it again.' }, 410);
          return;
        }
        renderCompare(response, {
          mode: 'choose',
          left: { selection_id: left.selection_id, path: left.path, name: path.basename(left.path) },
          right: right ? { selection_id: right.selection_id, path: right.path, name: path.basename(right.path) } : null,
          desktop_picker_enabled: desktopPickerEnabled,
        });
        return;
      }
      if (url.pathname === '/compare/run' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const left = desktopSelections.selection(form.get('left_selection_id'), { kind: 'file' });
        const right = desktopSelections.selection(form.get('right_selection_id'), { kind: 'file' });
        if (!left || !right) throw new Error('Choose both local files again before comparing them.');
        left.used = true;
        right.used = true;
        try {
          const comparison = await runContentOperation('compare', {
            stateDir, projectRoot, installationRoot, leftPath: left.path, rightPath: right.path,
          });
          const comparisonId = `CMP-${crypto.randomBytes(16).toString('hex')}`;
          comparisons.set(comparisonId, {
            created_at: Date.now(), left_path: left.path, right_path: right.path, comparison,
            compare_href: '/compare', back_href: '/files', nav_current: 'Files',
          });
          redirect(response, `/compare/result/${encodeURIComponent(comparisonId)}`);
        } catch (error) {
          const unsupported = /Unsupported content relationship extension/i.test(error.message);
          renderCompare(response, {
            mode: 'unsupported',
            message: unsupported ? error.message : `Comparison is unavailable: ${error.message}`,
          }, unsupported ? 422 : 400);
        }
        return;
      }
      const compareResultMatch = url.pathname.match(/^\/compare\/result\/(CMP-[a-f0-9]{32})$/u);
      if (compareResultMatch && request.method === 'GET') {
        const stored = comparisons.get(compareResultMatch[1]);
        if (!stored?.comparison) {
          renderCompare(response, {
            mode: 'unsupported',
            message: 'This comparison is no longer available. Choose the files again.',
          }, 410);
          return;
        }
        renderCompare(response, {
          mode: 'result', comparison_id: compareResultMatch[1], comparison: stored.comparison,
          compare_href: stored.compare_href, back_href: stored.back_href, nav_current: stored.nav_current,
        });
        return;
      }
      if (url.pathname === '/compare/open-original' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const comparison = comparisons.get(form.get('comparison_id'));
        const filePath = form.get('side') === 'left' ? comparison?.left_path : comparison?.right_path;
        if (!filePath) throw new Error('Atlas can open only a file chosen for this comparison.');
        openLocalFile(contentFilePath(filePath));
        redirect(response, '/compare');
        return;
      }
      if (url.pathname === '/files/inspect' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const work = form.get('work_id') ? fileWork.recentWorkById(form.get('work_id')) : null;
        if (form.get('work_id') && !work) {
          renderFilesHome(response, 'This Recent Work item is no longer available. Choose a local file again.', 410);
          return;
        }
        const selected = work ? null : desktopSelections.selection(form.get('selection_id'), { consume: true, kind: 'file' });
        if (!work && !selected) {
          renderFilesHome(response, 'The selected file is no longer available. Choose it again before inspecting.', 410);
          return;
        }
        const filePath = work?.file_path ?? selected.path;
        const inspect = {
          purpose: form.get('purpose') || work?.inspect.purpose || defaultInspectPurpose(filePath),
          sheet: form.get('sheet') || null,
          maxCharacters: work?.inspect.max_characters ?? 4000,
        };
        const project = work?.project ?? projectImport.projectForFile(filePath) ?? null;
        const activity = beginCurrentActivity({
          stateDir,
          filePath,
          purpose: inspect.purpose,
          project,
          channel: 'desktop',
          resourceId: resourceControl.identify({ filePath, project })?.resource_id ?? null,
        });
        try {
          const inspected = await fileWork.inspectAsync({ filePath, ...inspect });
          finishCurrentActivity(stateDir, activity.activity_id);
          const returnTo = projectReturnHref(inspected.work, form.get('return_to'));
          redirect(response, `/files/result/${encodeURIComponent(inspected.work.work_id)}?return_to=${encodeURIComponent(returnTo)}`);
        } catch (error) {
          failCurrentActivity({ stateDir, activityId: activity.activity_id, error });
          const failure = describeFileReadFailure(error);
          if (work) {
            notices.set(`file:${work.work_id}`, failure);
            const returnTo = projectReturnHref(work, form.get('return_to'));
            redirect(response, `/files/result/${encodeURIComponent(work.work_id)}?return_to=${encodeURIComponent(returnTo)}`);
          } else {
            notices.set('files', failure);
            redirect(response, '/files');
          }
        }
        return;
      }
      const fileResultMatch = url.pathname.match(/^\/files\/result\/(RWK-[a-f0-9-]{36})$/u);
      if (fileResultMatch && request.method === 'GET') {
        const existing = fileWork.recentWorkById(fileResultMatch[1]);
        if (!existing) {
          renderFilesHome(response, 'This Recent Work item is no longer available. Choose a local file again.', 410);
          return;
        }
        const backHref = projectReturnHref(existing, url.searchParams.get('return_to'));
        const currentHref = `${url.pathname}${url.search}`;
        const notice = notices.get(`file:${existing.work_id}`) ?? null;
        notices.delete(`file:${existing.work_id}`);
        try {
          const continued = await fileWork.continueWorkAsync(existing.work_id);
          renderFiles(response, { ...continued, mode: continued.mode === 'unchanged' ? 'ready' : continued.mode, back_href: backHref, current_href: currentHref, notice });
        } catch (error) {
          renderFiles(response, {
            mode: 'read-failed', work: existing, failure: describeFileReadFailure(error),
            back_href: backHref, current_href: currentHref, notice,
          }, 409);
        }
        return;
      }
      if (url.pathname === '/files/continue' && ['GET', 'POST'].includes(request.method)) {
        const form = request.method === 'POST' ? await readForm(request) : url.searchParams;
        if (request.method === 'POST') {
          if (!equalSecret(csrfToken, form.get('csrf'))) {
            response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Atlas UI session token is invalid.');
            return;
          }
          const existing = fileWork.recentWorkById(form.get('work_id'));
          if (!existing) {
            renderFilesHome(response, 'This Recent Work item is no longer available. Choose a local file again.', 410);
            return;
          }
          const backHref = projectReturnHref(existing, form.get('return_to'));
          redirect(response, `/files/continue?work_id=${encodeURIComponent(existing.work_id)}&return_to=${encodeURIComponent(backHref)}`);
          return;
        }
        const existing = fileWork.recentWorkById(form.get('work_id'));
        if (!existing) {
          renderFilesHome(response, 'This Recent Work item is no longer available. Choose a local file again.', 410);
          return;
        }
        const backHref = projectReturnHref(existing, form.get('return_to'));
        const currentHref = `${url.pathname}${url.search}`;
        try {
          const continued = await fileWork.continueWorkAsync(existing.work_id);
          renderFiles(response, { ...continued, back_href: backHref, current_href: currentHref });
        } catch (error) {
          renderFiles(response, {
            mode: 'read-failed', work: existing, failure: describeFileReadFailure(error), back_href: backHref, current_href: currentHref,
          }, 409);
        }
        return;
      }
      if (url.pathname === '/files/open-original' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const work = fileWork.recentWorkById(form.get('work_id'));
        const selected = work ? null : desktopSelections.selection(form.get('selection_id'), { kind: 'file' });
        const filePath = work?.file_path ?? selected?.path;
        if (!filePath) throw new Error('Atlas can open only a file selected in this session or recorded in Recent Work.');
        openLocalFile(contentFilePath(filePath));
        redirect(response, work ? fileWorkReturnHref(work.work_id, form.get('return_to')) : `/files/selected/${encodeURIComponent(selected.selection_id)}`);
        return;
      }
      if (url.pathname === '/files/remove' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        removeRecentWork(stateDir, form.get('work_id'));
        notices.set('files', 'Atlas forgot this saving point. The local file and cached result were not deleted.');
        redirect(response, '/files');
        return;
      }
      if (url.pathname === '/files/add-to-project' && request.method === 'GET') {
        const work = fileWork.recentWorkById(url.searchParams.get('work_id'));
        if (!work) throw new Error('This Recent Work item is no longer available.');
        if (work.project?.id || projectImport.projectForFile(work.file_path)?.id) {
          const project = work.project ?? projectImport.projectForFile(work.file_path);
          redirect(response, `/projects/${encodeURIComponent(project.id)}`);
          return;
        }
        renderFiles(response, { mode: 'add-to-project', work, projects: projectImport.projectChoices() });
        return;
      }
      if (url.pathname === '/files/add-to-project/review' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const work = fileWork.recentWorkById(form.get('work_id'));
        if (!work) throw new Error('This Recent Work item is no longer available.');
        const importId = `IMP-${crypto.randomBytes(16).toString('hex')}`;
        try {
          const prepared = projectImport.prepare({
            work,
            projectId: form.get('project_id'),
            folder: form.get('folder'),
            attemptKey: importId,
          });
          imports.set(importId, { ...prepared });
          redirect(response, `/files/add-to-project/review?import_id=${encodeURIComponent(importId)}`);
        } catch (error) {
          if (error.code !== 'ATLAS_IMPORT_TARGET_EXISTS' || !error.target) throw error;
          const recoveryHref = `/files/add-to-project/conflict?import_id=${encodeURIComponent(importId)}`;
          const activity = beginCurrentActivity({
            stateDir,
            filePath: work.file_path,
            purpose: 'import',
            resourceId: work.resource_id ?? null,
            project: error.target.project,
            channel: 'desktop',
          });
          const reason = `A file named ${path.basename(error.target.target_path)} already exists in ${error.target.project.name}. Choose a new name or another existing folder.`;
          waitCurrentActivity({ stateDir, activityId: activity.activity_id, reason, recoveryHref, recoveryLabel: 'Choose another destination' });
          imports.set(importId, {
            created_at: Date.now(),
            work_id: work.work_id,
            project: error.target.project,
            folder: form.get('folder'),
            target_path: error.target.target_path,
            target: error.target.target,
            target_file_name: path.basename(work.file_path),
            conflict: true,
            executed: false,
            activity_id: activity.activity_id,
          });
          redirect(response, recoveryHref);
        }
        return;
      }
      if (url.pathname === '/files/add-to-project/conflict' && request.method === 'GET') {
        const imported = importRecord(url.searchParams.get('import_id'));
        if (!imported?.conflict) {
          renderFilesHome(response, 'This import choice is no longer available. Start again from the local file.', 410);
          return;
        }
        const work = fileWork.recentWorkById(imported.work_id);
        const project = projectImport.projectChoices().find((item) => item.id === imported.project.id && item.available);
        if (!work || !project) {
          failCurrentActivity({ stateDir, activityId: imported.activity_id, error: new Error('The file or Project needed for this import is no longer available.') });
          imports.delete(url.searchParams.get('import_id'));
          renderFilesHome(response, 'The file or Project needed for this import is no longer available.', 410);
          return;
        }
        renderFiles(response, {
          mode: 'project-conflict',
          import_id: url.searchParams.get('import_id'),
          work,
          project: imported.project,
          folders: project.folders,
          folder: imported.folder,
          file_name: imported.target_file_name,
          target_path: imported.target_path,
          reason: readCurrentActivityState(stateDir).items.find((item) => item.activity_id === imported.activity_id)?.error_message
            ?? 'A file already exists at this destination.',
        });
        return;
      }
      if (url.pathname === '/files/add-to-project/conflict/resolve' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const importId = form.get('import_id');
        const imported = importRecord(importId);
        if (!imported?.conflict) {
          renderFilesHome(response, 'This import choice is no longer available. Start again from the local file.', 410);
          return;
        }
        const work = fileWork.recentWorkById(imported.work_id);
        if (!work) {
          failCurrentActivity({ stateDir, activityId: imported.activity_id, error: new Error('The local file is no longer available.') });
          imports.delete(importId);
          renderFilesHome(response, 'The local file is no longer available. Choose it again.', 410);
          return;
        }
        try {
          const prepared = projectImport.prepare({
            work,
            projectId: imported.project.id,
            folder: form.get('folder'),
            attemptKey: importId,
            targetFileName: form.get('file_name'),
          });
          resumeCurrentActivity({ stateDir, activityId: imported.activity_id });
          imports.set(importId, { ...prepared, activity_id: imported.activity_id, conflict: false });
          redirect(response, `/files/add-to-project/review?import_id=${encodeURIComponent(importId)}`);
        } catch (error) {
          if (error.code === 'ATLAS_IMPORT_TARGET_EXISTS' && error.target) {
            const recoveryHref = `/files/add-to-project/conflict?import_id=${encodeURIComponent(importId)}`;
            const reason = `A file named ${path.basename(error.target.target_path)} already exists in ${error.target.project.name}. Choose a new name or another existing folder.`;
            waitCurrentActivity({ stateDir, activityId: imported.activity_id, reason, recoveryHref, recoveryLabel: 'Choose another destination' });
            imports.set(importId, { ...imported, folder: form.get('folder'), target_path: error.target.target_path, target: error.target.target, target_file_name: form.get('file_name') });
            redirect(response, recoveryHref);
          } else if (/file name|destination folder/u.test(String(error?.message ?? ''))) {
            waitCurrentActivity({ stateDir, activityId: imported.activity_id, reason: String(error.message), recoveryHref: `/files/add-to-project/conflict?import_id=${encodeURIComponent(importId)}`, recoveryLabel: 'Choose another destination' });
            imports.set(importId, { ...imported, folder: form.get('folder'), target_file_name: form.get('file_name') });
            redirect(response, `/files/add-to-project/conflict?import_id=${encodeURIComponent(importId)}`);
          } else {
            failCurrentActivity({ stateDir, activityId: imported.activity_id, error });
            imports.delete(importId);
            redirect(response, `/files/result/${encodeURIComponent(work.work_id)}`);
          }
        }
        return;
      }
      if (url.pathname === '/files/add-to-project/conflict/cancel' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const imported = importRecord(form.get('import_id'));
        if (!imported?.conflict) {
          renderFilesHome(response, 'This import choice is no longer available. Start again from the local file.', 410);
          return;
        }
        finishCurrentActivity(stateDir, imported.activity_id);
        imports.delete(form.get('import_id'));
        redirect(response, `/files/result/${encodeURIComponent(imported.work_id)}`);
        return;
      }
      if (url.pathname === '/files/add-to-project/review' && request.method === 'GET') {
        const importId = url.searchParams.get('import_id');
        const prepared = importRecord(importId);
        if (!prepared || prepared.executed) throw new Error('This prepared destination is no longer available. Review it again.');
        const work = fileWork.recentWorkById(prepared.work_id);
        if (!work) throw new Error('This Recent Work item is no longer available.');
        renderFiles(response, { mode: 'project-review', work, project: prepared.project, prepared: { ...prepared.prepared, target_path: prepared.target_path }, import_id: importId });
        return;
      }
      if (url.pathname === '/files/add-to-project/save' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const imported = importRecord(form.get('import_id'));
        if (!imported || imported.executed) throw new Error('This prepared destination is no longer available. Review it again.');
        imported.executed = true;
        try {
          const work = projectImport.save(imported);
          if (imported.activity_id) finishCurrentActivity(stateDir, imported.activity_id);
          imports.delete(form.get('import_id'));
          notices.set(`file:${work.work_id}`, `Saved to ${imported.project.name}. Atlas verified the Project file.`);
          redirect(response, `/files/result/${encodeURIComponent(work.work_id)}?return_to=${encodeURIComponent(`/projects/${work.project.id}/resources`)}`);
        } catch (error) {
          const work = fileWork.recentWorkById(imported.work_id);
          if (!work) throw error;
          if (error.code === 'ATLAS_PROJECTION_PENDING') {
            imported.executed = false;
            if (imported.activity_id) waitCurrentActivity({
              stateDir, activityId: imported.activity_id, reason: error.message,
              recoveryHref: `/files/continue?work_id=${encodeURIComponent(work.work_id)}`,
              recoveryLabel: 'Retry Recent Work projection',
            });
            notices.set(`file:${work.work_id}`, { title: 'Atlas saved and verified the Project file', action: 'Recent Work still needs to be updated. Retry Add to Project with the same destination.' });
          } else {
            if (imported.activity_id) failCurrentActivity({ stateDir, activityId: imported.activity_id, error });
            imports.delete(form.get('import_id'));
            notices.set(`file:${work.work_id}`, { title: 'Atlas could not save this Project file', action: 'Review the failure in Activity.' });
          }
          redirect(response, `/files/result/${encodeURIComponent(work.work_id)}`);
        }
        return;
      }
      if (url.pathname === '/files/add-to-project/undo' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const work = fileWork.recentWorkById(form.get('work_id'));
        projectImport.undo(work);
        notices.set('files', 'The saved Project file was removed. The original local file was not changed.');
        redirect(response, '/files');
        return;
      }
      if (url.pathname === '/files/add-to-project/redo' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        const work = fileWork.recentWorkById(form.get('work_id'));
        const redone = projectImport.redo(work);
        notices.set('files', 'The Project file was restored. The original local file was not changed.');
        redirect(response, `/files/result/${encodeURIComponent(redone.work_id)}`);
        return;
      }
      if (url.pathname === '/' && request.method === 'GET') {
        if (!currentPath) {
          redirect(response, '/projects');
          return;
        }
        const resolution = registry.resolvePath(currentPath);
        if (resolution.status === 'resolved' && resolution.project?.id) {
          redirect(response, `/projects/${encodeURIComponent(resolution.project.id)}/resources`);
          return;
        }
        renderProjectsHome(response, {
          notice: 'The folder opened with Atlas is not a registered Project. Choose a Project or add this folder.',
        }, 404);
        return;
      }
      if (url.pathname === '/projects' && request.method === 'GET') {
        if (url.searchParams.get('removed') === '1') renderProjectsHome(response, { notice: 'The unavailable Project was removed from Atlas. No local files were deleted.' });
        else renderProjectsHome(response);
        return;
      }
      if (url.pathname === '/search' && request.method === 'GET') {
        sendPage(response, 200, renderSearchView(globalSearchModel(url.searchParams.get('q')), displayOptions()));
        return;
      }
      if (url.pathname === '/settings' && request.method === 'GET') {
        const returnHref = settingsReturnHref(url.searchParams.get('return_to'));
        sendPage(response, 200, renderSettingsView({ preferences, runtime }, {
          workspaceHref: '/projects', csrfToken, saved: url.searchParams.get('saved') === '1', returnHref,
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
        const returnHref = settingsReturnHref(form.get('return_to'));
        const draft = normalizeUiPreferences(form.get('action') === 'reset' ? {} : {
              theme: form.get('selected_theme') ?? form.get('theme'),
              accent: form.get('selected_accent') ?? form.get('accent'),
              contrast: form.get('contrast'),
              text_size: form.get('text_size'),
              density: form.get('density'),
              project_rail_width: form.get('project_rail_width'),
              app_rail_width: form.get('app_rail_width'),
              context_card_delay: form.get('context_card_delay'),
              reduce_motion: form.get('reduce_motion'),
              show_technical_ids: form.get('show_technical_ids'),
            });
        try {
          preferences = form.get('action') === 'reset'
            ? resetUiPreferencesFn(stateDir)
            : writeUiPreferencesFn(stateDir, draft);
        } catch (error) {
          sendPage(response, 409, renderSettingsView({ preferences: draft, runtime }, {
            workspaceHref: '/projects', csrfToken, error: safeNotice(error), returnHref,
          }));
          return;
        }
        const redirectSearch = new URLSearchParams({ saved: '1' });
        if (form.has('return_to')) redirectSearch.set('return_to', returnHref);
        response.writeHead(303, { location: `/settings?${redirectSearch}`, 'cache-control': 'no-store' });
        response.end();
        return;
      }
      const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/u);
      if (projectMatch && request.method === 'GET') {
        const projectId = decodeURIComponent(projectMatch[1]);
        projectEntry(projectId);
        redirect(response, `/projects/${encodeURIComponent(projectId)}/resources`);
        return;
      }
      if (url.pathname === '/session/stop' && request.method === 'POST') {
        const form = await readForm(request);
        if (!equalSecret(csrfToken, form.get('csrf'))) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Atlas UI session token is invalid.');
          return;
        }
        sendPage(response, 200, '<!doctype html><html><head><meta charset="utf-8"><title>Atlas stopped</title></head><body><main><h1>Atlas stopped</h1><p>You can close this tab.</p></main></body></html>');
        setImmediate(() => server.close());
        return;
      }
      sendPage(response, 404, errorView('The requested Atlas page does not exist.'));
    } catch (error) {
      sendPage(response, error.code === 'ATLAS_PATH_BOUNDARY' ? 403 : 400, errorView(safeNotice(error)));
    }
  });
  let address;
  try {
    address = await listenOnUsablePort(server, { host, port });
  } catch (error) {
    clearInterval(selectionExpiry);
    desktopSelections.clear();
    if (ownsResourceControl) resourceControl.dispose();
    throw error;
  }
  server.once('close', () => {
    clearInterval(selectionExpiry);
    desktopSelections.clear();
    if (ownsResourceControl) resourceControl.dispose();
    settleClosed();
  });
  const workspaceUrl = `http://${host}:${address.port}/`;
  const projectsUrl = `${workspaceUrl}projects`;
  return {
    schema: 'atlas-ui-session.v1',
    host,
    port: address.port,
    url: currentPath ? workspaceUrl : projectsUrl,
    workspace_url: workspaceUrl,
    desktop_picker: desktopPickerEnabled ? {
      registration_url: `${workspaceUrl}desktop/selection`,
      token: desktopPickerToken,
    } : null,
    network_scope: 'loopback_only',
    closed,
    close: () => new Promise((resolve, reject) => {
      if (!server.listening) {
        if (ownsResourceControl) resourceControl.dispose();
        resolve();
        return;
      }
      server.close((error) => {
        if (ownsResourceControl) resourceControl.dispose();
        error ? reject(error) : resolve();
      });
    }),
  };
}
