import { MODULE_PROTOCOL_VERSION } from './protocol.js';

export const CAPTURE_SOURCE_MODULE_DESCRIPTOR = Object.freeze({
  protocol: MODULE_PROTOCOL_VERSION,
  module_id: 'atlas.capture-source',
  module_version: '1.0.0',
  contract: 'static_first_party',
  actions: Object.freeze(['inspect-export', 'prepare-export', 'capture-url', 'capture-markdown', 'show', 'read']),
});

const ACTIONS = new Set(CAPTURE_SOURCE_MODULE_DESCRIPTOR.actions);

function moduleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw moduleError('ATLAS_MODULE_INVALID_REQUEST', `${label} must be an object.`);
  }
  return value;
}

export function createCaptureSourceModule({ captureSource, availability = null } = {}) {
  if (!captureSource || typeof captureSource.inspectExport !== 'function'
    || typeof captureSource.prepareExport !== 'function' || typeof captureSource.prepare !== 'function'
    || typeof captureSource.show !== 'function' || typeof captureSource.read !== 'function') {
    throw new Error('Capture Source Module requires the Capture Source service.');
  }

  const invoke = async (request) => {
    record(request, 'Module request');
    if (request.protocol !== MODULE_PROTOCOL_VERSION) {
      throw moduleError('ATLAS_MODULE_PROTOCOL_UNSUPPORTED', `Unsupported Module protocol: ${request.protocol ?? '(missing)'}.`);
    }
    if (request.module_id !== CAPTURE_SOURCE_MODULE_DESCRIPTOR.module_id) {
      throw moduleError('ATLAS_MODULE_NOT_FOUND', `Unknown Module: ${request.module_id ?? '(missing)'}.`);
    }
    const action = request.action;
    if (!ACTIONS.has(action)) {
      throw moduleError('ATLAS_MODULE_ACTION_UNSUPPORTED', `Capture Source action is unsupported: ${action ?? '(missing)'}.`);
    }
    const parameters = record(request.parameters ?? {}, 'Module action parameters');
    const projectId = request.project_id == null ? null : String(request.project_id).trim();
    if (action !== 'inspect-export' && !projectId) {
      throw moduleError('ATLAS_MODULE_PROJECT_REQUIRED', 'This Capture Source action requires a Project ID.');
    }
    if (request.project_id != null && !projectId) {
      throw moduleError('ATLAS_MODULE_PROJECT_INVALID', 'Project ID must be a non-empty string.');
    }
    availability?.assertActionEnabled?.(CAPTURE_SOURCE_MODULE_DESCRIPTOR.module_id, action);

    let data;
    if (action === 'inspect-export') {
      data = captureSource.inspectExport(parameters);
    } else if (action === 'prepare-export') {
      data = await captureSource.prepareExport({ ...parameters, projectId });
    } else if (action === 'capture-url') {
      data = await captureSource.prepare({ ...parameters, projectId });
    } else if (action === 'capture-markdown') {
      if(typeof captureSource.prepareMarkdown!=='function')throw moduleError('ATLAS_MODULE_ACTION_UNSUPPORTED','This Runtime does not provide public Markdown preparation.');
      data = await captureSource.prepareMarkdown({ ...parameters, projectId });
    } else if (action === 'show') {
      const saveId = parameters.saveId ?? parameters.save_id;
      if (typeof saveId !== 'string' || !saveId.trim()) throw moduleError('ATLAS_MODULE_INVALID_REQUEST', 'Capture Source show requires a Save ID.');
      data = captureSource.show(saveId, { projectId });
    } else {
      const saveId = parameters.saveId ?? parameters.save_id;
      if (typeof saveId !== 'string' || !saveId.trim()) throw moduleError('ATLAS_MODULE_INVALID_REQUEST', 'Capture Source read requires a Save ID.');
      data = captureSource.read(saveId, { projectId, cursor: parameters.cursor ?? null, characters: parameters.characters ?? 4_000, mode: parameters.mode ?? 'full' });
    }

    return {
      protocol: MODULE_PROTOCOL_VERSION,
      module_id: CAPTURE_SOURCE_MODULE_DESCRIPTOR.module_id,
      module_version: CAPTURE_SOURCE_MODULE_DESCRIPTOR.module_version,
      status: 'ok',
      action,
      project_id: projectId,
      data,
    };
  };

  return {
    describe: () => {
      const current = availability?.get?.(CAPTURE_SOURCE_MODULE_DESCRIPTOR.module_id) ?? { enabled: true, revision: 0 };
      return { ...CAPTURE_SOURCE_MODULE_DESCRIPTOR, actions: [...CAPTURE_SOURCE_MODULE_DESCRIPTOR.actions], enabled: current.enabled, revision: current.revision };
    },
    invoke,
  };
}
