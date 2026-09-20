const configurations = {
  app: {
    property: '--app-rail-width',
    railSelector: '#atlas-primary-nav',
    minimum: 68,
    maximum: 360,
    compactThreshold: 96,
  },
  project: {
    property: '--project-rail-width',
    railSelector: '#atlas-project-rail',
    minimum: 220,
    maximum: 420,
  },
};

function storageGet(kind, key) {
  try { return window[kind]?.getItem(key) ?? null; } catch { return null; }
}

function storageSet(kind, key, value) {
  try { window[kind]?.setItem(key, value); } catch {}
}

function storageRemove(kind, key) {
  try { window[kind]?.removeItem(key); } catch {}
}

const topbar = document.querySelector('.topbar[data-current-project-id]');
const currentProjectId = topbar?.dataset.currentProjectId;
const currentResourcePath = topbar?.dataset.currentResourcePath;
if (currentProjectId) {
  storageSet('sessionStorage', 'atlas-ui-current-project-id', currentProjectId);
  storageSet('sessionStorage', 'atlas-ui-current-project-href', `/projects/${encodeURIComponent(currentProjectId)}/resources`);
  if (currentResourcePath) storageSet('sessionStorage', 'atlas-ui-current-resource-path', currentResourcePath);
}

const rememberedProjectHref = storageGet('sessionStorage', 'atlas-ui-current-project-href');
document.querySelectorAll('[data-resources-nav]').forEach((item) => {
  if (!rememberedProjectHref) return;
  if (item instanceof HTMLAnchorElement) {
    item.href = rememberedProjectHref;
    item.title = 'Resources';
    return;
  }
  const link = document.createElement('a');
  link.href = rememberedProjectHref;
  link.dataset.resourcesNav = '';
  link.title = 'Resources';
  link.innerHTML = item.innerHTML;
  item.replaceWith(link);
});

const dirtyDraftForms = new Set();
// Join fields stay in the saved form but cannot affect a concatenate submission.
document.querySelectorAll('.recipe-form').forEach((form) => {
  const combine = form.querySelector('select[name="combine"]');
  const join = form.querySelector('[data-recipe-join]');
  if (!combine || !join) return;
  const syncCombine = () => {
    join.hidden = combine.value !== 'join';
    join.disabled = join.hidden;
  };
  combine.addEventListener('change', syncCombine);
  syncCombine();
});

const markDirty = (event) => { dirtyDraftForms.add(event.currentTarget); };
const clearDirty = (event) => { dirtyDraftForms.delete(event.currentTarget); };
document.querySelectorAll('[data-draft-protect]').forEach((form) => {
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  form.addEventListener('submit', clearDirty);
});
window.addEventListener?.('beforeunload', (event) => {
  if (!dirtyDraftForms.size) return;
  event.preventDefault();
  event.returnValue = '';
});

const resourcePropertyBatchFocusKey = 'atlas-ui-resource-property-batch-focus';
const rememberResourcePropertyFocus = (candidate) => {
  try {
    sessionStorage.setItem(resourcePropertyBatchFocusKey, JSON.stringify({
      resourceId: candidate?.value ?? null,
      pathname: window.location.pathname,
    }));
  } catch {}
};
const resourcePropertyBatch = document.querySelector('#resource-property-batch');
const propertyFocusCandidate = (checkbox) => {
  const current = checkbox.closest('[data-resource-property-focus]');
  const findSibling = (direction) => {
    let sibling = current?.[direction];
    while (sibling) {
      const container = sibling.matches?.('[data-resource-property-focus]')
        ? sibling
        : sibling.querySelector?.('[data-resource-property-focus]');
      const candidate = container?.querySelector('input[name="resource_id"]:not(:checked)');
      if (candidate && !candidate.disabled && !container.hidden && !container.closest('[hidden]')) return candidate;
      sibling = sibling[direction];
    }
    return null;
  };
  return findSibling('nextElementSibling') ?? findSibling('previousElementSibling');
};
resourcePropertyBatch?.addEventListener('submit', () => {
  const selected = [...document.querySelectorAll('input[form="resource-property-batch"][name="resource_id"]:checked')];
  rememberResourcePropertyFocus(propertyFocusCandidate(selected.at(-1)));
});
const restoreResourcePropertyFocus = () => {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(resourcePropertyBatchFocusKey) ?? 'null'); } catch {}
  if (!saved) return;
  try { sessionStorage.removeItem(resourcePropertyBatchFocusKey); } catch {}
  if (saved.pathname !== window.location.pathname) return;
  const target = [...document.querySelectorAll('[data-resource-property-focus]')]
    .find((container) => container.dataset.resourcePropertyFocus === saved.resourceId)
    ?.querySelector('input[name="resource_id"]');
  (target ?? document.querySelector('[data-resource-property-empty-action]'))?.focus();
};
restoreResourcePropertyFocus();

document.querySelectorAll('[data-project-filter]').forEach((input) => {
  const list = input.closest('.projects-home-list-panel')?.querySelector('.projects-home-list');
  if (!(input instanceof HTMLInputElement) || !list) return;
  const rows = [...list.querySelectorAll('[data-project-search]')];
  const filterRows = () => {
    const query = input.value.trim().toLocaleLowerCase();
    let visible = 0;
    rows.forEach((row) => {
      const match = !query || (row.dataset.projectSearch ?? '').toLocaleLowerCase().includes(query);
      row.hidden = !match;
      if (match) visible += 1;
    });
    list.classList.toggle('is-empty-filter', visible === 0);
  };
  input.addEventListener('input', filterRows);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    const first = rows.find((row) => !row.hidden && row.matches('a, button, [tabindex]'));
    if (!first) return;
    event.preventDefault();
    first.focus();
  });
  rows.forEach((row, index) => row.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const visible = rows.filter((candidate) => !candidate.hidden && candidate.matches('a, button, [tabindex]'));
    const position = visible.indexOf(row);
    const target = event.key === 'Home' ? visible[0]
      : event.key === 'End' ? visible.at(-1)
        : event.key === 'ArrowDown' ? visible[position + 1]
          : visible[position - 1];
    if (!target) return;
    event.preventDefault();
    target.focus();
  }));
});

const updateTemporaryWorkSelection = (payload) => {
  document.querySelectorAll('[data-work-source-count]').forEach((item) => { item.textContent = `Selected ${payload.count ?? 0} files`; });
  document.querySelectorAll('[data-work-open]').forEach((item) => {
    const active = Number(payload.count ?? 0) > 0 && payload.href;
    item.href = active ? payload.href : '#';
    item.classList.toggle('is-disabled', !active);
    item.setAttribute('aria-disabled', String(!active));
  });
};

const bindTemporaryWorkSources = (root, context) => {
  root.querySelectorAll('[data-work-source]').forEach((checkbox) => {
    if (checkbox.dataset.workSourceBound === 'true') return;
    checkbox.dataset.workSourceBound = 'true';
    checkbox.addEventListener('change', async () => {
      const notice = document.querySelector('[data-work-source-notice]');
      checkbox.disabled = true;
      if (notice) notice.textContent = 'Updating selection…';
      try {
        const response = await fetch(`${context.projectBase}/work/selection`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            csrf: context.csrf ?? '',
            action: checkbox.checked ? 'add' : 'remove',
            resource_id: checkbox.dataset.resourceId ?? '',
            path: checkbox.dataset.resourcePath ?? '',
            folder: context.folder ?? '',
            focus: context.focus ?? '',
            origin_view_id: context.viewId ?? '',
          }),
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true) throw new Error(result.error || 'Selection could not be updated.');
        document.querySelectorAll(`[data-work-source][data-resource-id="${CSS.escape(result.resource_id ?? '')}"]`).forEach((item) => { item.checked = result.selected === true; });
        updateTemporaryWorkSelection(result);
        if (notice) notice.textContent = '';
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        if (notice) notice.textContent = error.message;
      } finally { checkbox.disabled = false; }
    });
  });
};

document.querySelectorAll('[data-resource-workspace]').forEach((workspace) => {
  const projectId = workspace.dataset.projectId;
  const projectBase = workspace.dataset.projectBase;
  const tree = workspace.querySelector('[data-resource-tree]');
  const fileList = workspace.querySelector('[data-resource-file-list]');
  const listToggle = document.querySelector(`[data-resource-list-toggle][aria-controls="${CSS.escape(fileList?.id ?? '')}"]`);
  if (!projectId || !projectBase || !tree || !fileList || !listToggle) return;
  const storageKey = `atlas-ui-open-folders:${projectId}`;
  const selectedFolderKey = `atlas-ui-selected-folder:${projectId}`;
  const resourceListKey = `atlas-ui-resource-list:${projectId}`;
  const folders = [...tree.querySelectorAll('[data-project-folder]')];
  const folderControls = [...tree.querySelectorAll('[data-folder-select]')];
  const folderToggles = [...tree.querySelectorAll('[data-folder-toggle]')];
  let fileGroups = [...fileList.querySelectorAll('[data-folder-files]')];
  let reflowPaneWidths = () => {};
  const folderOpen = (folder) => folder?.dataset.folderOpen === 'true';
  const setFolderOpen = (folder, open) => {
    if (!folder) return;
    folder.dataset.folderOpen = String(open);
    const toggle = folder.querySelector(':scope > [data-folder-toggle]');
    const children = folder.querySelector(':scope > .workspace-tree-folder-children');
    toggle?.setAttribute('aria-expanded', String(open));
    if (toggle) {
      const name = folder.querySelector(':scope > [data-folder-select]')?.textContent?.trim() ?? 'folder';
      toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${name}`);
    }
    if (children) children.hidden = !open;
  };
  const saved = storageGet('localStorage', storageKey);
  if (saved != null) {
    let openPaths = [];
    try { openPaths = JSON.parse(saved); } catch { openPaths = []; }
    const openSet = new Set(Array.isArray(openPaths) ? openPaths : []);
    folders.forEach((folder) => setFolderOpen(folder, openSet.has(folder.dataset.folderPath ?? '')));
  }
  const focusedPath = tree.dataset.focusPath;
  const focusedRow = focusedPath ? fileList.querySelector(`[data-resource-path="${CSS.escape(focusedPath)}"]`) : null;
  const focusedFolderPath = focusedPath?.split('/').slice(0, -1).join('/') ?? null;
  if (focusedFolderPath != null) {
    folders.filter((folder) => {
      const folderPath = folder.dataset.folderPath ?? '';
      return folderPath === focusedFolderPath || focusedFolderPath.startsWith(`${folderPath}/`);
    }).forEach((folder) => setFolderOpen(folder, true));
  }
  const saveFolders = () => storageSet('localStorage', storageKey, JSON.stringify(
    folders.filter(folderOpen).map((folder) => folder.dataset.folderPath ?? ''),
  ));
  if (focusedRow) saveFolders();

  const controls = folderControls;
  const visibleControls = () => controls.filter((item) => item.getClientRects().length > 0);
  const ownExpandableFolder = (control) => {
    const folder = control.closest('.workspace-tree-folder');
    return folder?.matches('[data-project-folder]') ? folder : null;
  };
  const parentFolderControl = (control) => {
    const node = control.closest('.workspace-tree-folder');
    const parent = node?.parentElement?.closest('[data-project-folder]');
    return parent?.querySelector(':scope > [data-folder-select]') ?? null;
  };
  const openResource = (row) => {
    const action = tree.dataset.openAction;
    const csrf = tree.dataset.csrf;
    const relativePath = row.dataset.resourcePath;
    if (!action || !csrf || !relativePath) return;
    const form = document.createElement('form');
    form.method = 'post';
    form.action = action;
    for (const [name, value] of [['csrf', csrf], ['path', relativePath]]) {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
    }
    document.body.append(form);
    form.requestSubmit();
  };
  controls.forEach((control) => control.addEventListener('keydown', (event) => {
    const folder = ownExpandableFolder(control);
    if (event.key === 'ArrowRight' && folder) {
      if (!folderOpen(folder)) {
        setFolderOpen(folder, true);
        saveFolders();
      } else {
        const visible = visibleControls();
        visible[visible.indexOf(control) + 1]?.focus();
      }
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowLeft') {
      if (folder && folderOpen(folder)) {
        setFolderOpen(folder, false);
        saveFolders();
      } else {
        parentFolderControl(control)?.focus();
      }
      event.preventDefault();
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const visible = visibleControls();
    const position = visible.indexOf(control);
    const target = event.key === 'ArrowDown' ? visible[position + 1] : visible[position - 1];
    if (!target) return;
    event.preventDefault();
    target.focus();
  }));

  const bindFileGroup = (group) => {
    if (!group || group.dataset.folderBound === 'true') return;
    group.dataset.folderBound = 'true';
    group.querySelector('[data-resource-name-sort]')?.addEventListener('click', (event) => {
      const button = event.currentTarget;
      const rows = [...group.querySelectorAll('[data-resource-row]')];
      const direction = button.dataset.sortDirection === 'asc' ? 'desc' : 'asc';
      rows.sort((left, right) => (left.dataset.resourceName ?? '').localeCompare(right.dataset.resourceName ?? '', undefined, { numeric: true }) * (direction === 'asc' ? 1 : -1));
      group.append(...rows);
      button.dataset.sortDirection = direction;
      button.textContent = direction === 'asc' ? 'Name ↑' : 'Name ↓';
      button.setAttribute('aria-label', `Sort files by name ${direction === 'asc' ? 'descending' : 'ascending'}`);
    });
    bindTemporaryWorkSources(group, {
      projectBase,
      csrf: workspace.dataset.csrf,
      folder: workspace.dataset.selectedFolder,
      focus: tree.dataset.focusPath,
      viewId: workspace.dataset.activeViewId,
    });
    group.querySelectorAll('[data-open-resource]').forEach((row) => {
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          openResource(row);
          return;
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          const folderPath = row.dataset.resourcePath?.split('/').slice(0, -1).join('/') ?? '';
          const target = folderControls.find((control) => (control.dataset.folderPath ?? '') === folderPath);
          if (!target) return;
          folders.filter((folder) => {
            const candidate = folder.dataset.folderPath ?? '';
            return candidate === folderPath || folderPath.startsWith(`${candidate}/`);
          }).forEach((folder) => setFolderOpen(folder, true));
          saveFolders();
          target.focus();
          return;
        }
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        const visibleRows = [...fileList.querySelectorAll('[data-open-resource]')]
          .filter((item) => item.getClientRects().length > 0);
        const position = visibleRows.indexOf(row);
        const target = event.key === 'ArrowDown' ? visibleRows[position + 1] : visibleRows[position - 1];
        if (!target) return;
        event.preventDefault();
        target.focus();
      });
      row.addEventListener('dblclick', (event) => {
        event.preventDefault();
        openResource(row);
      });
    });
  };

  const folderLoadRequests = new Map();
  const loadFolderGroup = (folderPath) => {
    const group = fileGroups.find((item) => (item.dataset.folderFiles ?? '') === folderPath);
    if (!group || group.dataset.folderLoaded === 'true') return Promise.resolve(group);
    if (folderLoadRequests.has(folderPath)) return folderLoadRequests.get(folderPath);
    group.setAttribute('aria-busy', 'true');
    group.querySelector('[data-folder-loading]')?.remove();
    group.insertAdjacentHTML('beforeend', '<p class="workspace-empty" data-folder-loading>Loading this folder…</p>');
    const query = new URLSearchParams({ folder: folderPath, fragment: 'folder-files' });
    const request = fetch(`${projectBase}/resources?${query}`, { headers: { accept: 'text/html' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Folder load failed with status ${response.status}.`);
        const template = document.createElement('template');
        template.innerHTML = (await response.text()).trim();
        const replacement = template.content.firstElementChild;
        if (!replacement || replacement.dataset.folderFiles !== folderPath) throw new Error('Folder response did not match the selected folder.');
        replacement.hidden = workspace.dataset.selectedFolder !== folderPath;
        group.replaceWith(replacement);
        fileGroups = [...fileList.querySelectorAll('[data-folder-files]')];
        bindFileGroup(replacement);
        return replacement;
      })
      .catch(() => {
        group.removeAttribute('aria-busy');
        group.querySelector('[data-folder-loading]')?.remove();
        if (!group.querySelector('[data-folder-load-error]')) {
          group.insertAdjacentHTML('beforeend', '<p class="callout warn" data-folder-load-error>This folder could not be loaded. Select it again to retry.</p>');
        }
        return group;
      })
      .finally(() => folderLoadRequests.delete(folderPath));
    folderLoadRequests.set(folderPath, request);
    return request;
  };

  const setSelectedFolder = (requestedPath, { persist = true, clearResource = false } = {}) => {
    const group = fileGroups.find((item) => (item.dataset.folderFiles ?? '') === requestedPath)
      ?? fileGroups.find((item) => (item.dataset.folderFiles ?? '') === '');
    const selectedPath = group?.dataset.folderFiles ?? '';
    fileGroups.forEach((item) => { item.hidden = item !== group; });
    folderControls.forEach((control) => control.classList.toggle('is-selected', (control.dataset.folderPath ?? '') === selectedPath));
    document.querySelectorAll('[data-selected-folder-label]').forEach((label) => {
      const projectName = workspace.dataset.projectName ?? 'Project';
      label.textContent = selectedPath ? `${projectName} / ${selectedPath.split('/').join(' / ')}` : projectName;
    });
    workspace.dataset.selectedFolder = selectedPath;
    if (persist) storageSet('localStorage', selectedFolderKey, selectedPath);
    if (!workspace.dataset.activeViewId) {
      document.querySelectorAll('[data-resource-view-mode]').forEach((link) => {
        const target = new URL(link.href, window.location.href);
        target.searchParams.delete('view');
        target.searchParams.set('scope_path', selectedPath);
        if (link.dataset.resourceViewMode === 'files') target.searchParams.set('folder', selectedPath);
        else target.searchParams.delete('folder');
        link.href = `${target.pathname}${target.search}`;
      });
      document.querySelectorAll('[data-resource-view-scope-label]').forEach((label) => {
        label.textContent = selectedPath || 'Project root';
      });
      document.querySelectorAll('[data-resource-view-scope-input], .resource-view-save input[name="scope_path"]').forEach((input) => {
        input.value = selectedPath;
      });
      document.querySelectorAll('[data-resource-view-files-link]').forEach((link) => {
        const target = new URL(link.href, window.location.href);
        target.searchParams.delete('view');
        target.searchParams.set('mode', 'files');
        target.searchParams.set('scope_path', selectedPath);
        target.searchParams.set('folder', selectedPath);
        link.href = `${target.pathname}${target.search}`;
      });
    }
    if (clearResource) {
      const inspector = workspace.querySelector('[data-resource-inspector]');
      if (inspector) inspector.innerHTML = '<span class="workspace-kicker">Selected resource</span><h2>Choose a resource</h2><p>Select a file from the current folder to see its known local facts and open it with its default app.</p>';
      focusedRow?.classList.remove('is-focused');
      focusedRow?.removeAttribute('data-focused-resource');
      focusedRow?.removeAttribute('tabindex');
      const topbarResource = document.querySelector('.topbar-context small');
      topbarResource?.remove();
      if (topbar) topbar.dataset.currentResourcePath = '';
      storageRemove('sessionStorage', 'atlas-ui-current-resource-path');
      const locationQuery = new URLSearchParams({ mode: 'files', scope_path: selectedPath, folder: selectedPath });
      window.history.replaceState({}, '', `${projectBase}/resources?${locationQuery}`);
    }
    return selectedPath;
  };

  const selectFolder = (requestedPath, options = {}) => {
    const selectedPath = setSelectedFolder(requestedPath, options);
    setFileListExpanded(true);
    return loadFolderGroup(selectedPath);
  };

  const savedSelectedFolder = storageGet('localStorage', selectedFolderKey);
  const initialFolder = focusedFolderPath ?? (workspace.dataset.selectedFolderExplicit === 'true'
    ? workspace.dataset.selectedFolder ?? ''
    : savedSelectedFolder ?? workspace.dataset.selectedFolder ?? '');
  const selectedFolder = setSelectedFolder(initialFolder, { persist: true });
  if (selectedFolder && (focusedPath || workspace.dataset.selectedFolderExplicit === 'true')) {
    folders.filter((folder) => {
      const folderPath = folder.dataset.folderPath ?? '';
      return folderPath === selectedFolder || selectedFolder.startsWith(`${folderPath}/`);
    }).forEach((folder) => setFolderOpen(folder, true));
    saveFolders();
  }

  fileGroups.forEach(bindFileGroup);
  void loadFolderGroup(selectedFolder);

  folderControls.forEach((control) => {
    control.addEventListener('click', (event) => {
      event.preventDefault();
      void selectFolder(control.dataset.folderPath ?? '', { clearResource: true });
    });
    const folder = ownExpandableFolder(control);
    if (folder) control.addEventListener('dblclick', (event) => {
      event.preventDefault();
      setFolderOpen(folder, !folderOpen(folder));
      saveFolders();
    });
  });

  folderToggles.forEach((toggle) => toggle.addEventListener('click', () => {
    const folder = toggle.closest('[data-project-folder]');
    setFolderOpen(folder, !folderOpen(folder));
    saveFolders();
  }));

  workspace.querySelector('[data-collapse-all-folders]')?.addEventListener('click', () => {
    folders.forEach((folder) => setFolderOpen(folder, false));
    saveFolders();
  });

  const compactResourceWorkspace = () => workspace.getBoundingClientRect().width <= 900;
  const setFileListExpanded = (expanded, { persist = true } = {}) => {
    fileList.hidden = !expanded;
    workspace.classList.toggle('is-file-list-collapsed', !expanded);
    listToggle.setAttribute('aria-expanded', String(expanded));
    listToggle.textContent = compactResourceWorkspace()
      ? (expanded ? 'Show resource details' : 'Back to file list')
      : (expanded ? 'Hide file list' : 'Show file list');
    if (persist) storageSet('localStorage', resourceListKey, expanded ? 'expanded' : 'collapsed');
    if (!expanded && fileList.contains(document.activeElement)) listToggle.focus();
    window.requestAnimationFrame(reflowPaneWidths);
  };
  const initialListExpanded = focusedPath
    ? !compactResourceWorkspace()
    : storageGet('localStorage', resourceListKey) !== 'collapsed';
  setFileListExpanded(initialListExpanded, { persist: false });
  listToggle.addEventListener('click', () => setFileListExpanded(listToggle.getAttribute('aria-expanded') !== 'true'));

  const paneWidthKey = `atlas-ui-resource-pane-widths:${projectId}`;
  const paneResizers = [...workspace.querySelectorAll('[data-resource-pane-resizer]')];
  let paneWidths = { folder: 270, list: 500 };
  try {
    const storedWidths = JSON.parse(storageGet('localStorage', paneWidthKey) ?? '{}');
    if (Number.isFinite(storedWidths.folder)) paneWidths.folder = storedWidths.folder;
    if (Number.isFinite(storedWidths.list)) paneWidths.list = storedWidths.list;
  } catch {}
  const applyPaneWidth = (pane, requested) => {
    const total = workspace.getBoundingClientRect().width;
    const compact = total <= 900;
    const minimum = pane === 'folder' ? (compact ? 140 : 170) : 280;
    const reserved = pane === 'folder'
      ? (compact ? 240 : (fileList.hidden ? 280 : paneWidths.list + 280 + 12))
      : paneWidths.folder + 280 + 12;
    const maximum = Math.max(minimum, Math.min(pane === 'folder' ? 520 : 760, total - reserved));
    const width = clamp(Math.round(requested), minimum, maximum);
    paneWidths[pane] = width;
    workspace.style.setProperty(pane === 'folder' ? '--resource-folder-pane' : '--resource-list-pane', `${width}px`);
    workspace.querySelector(`[data-resource-pane-resizer="${pane}"]`)?.setAttribute('aria-valuenow', String(width));
    return width;
  };
  const persistPaneWidths = () => storageSet('localStorage', paneWidthKey, JSON.stringify(paneWidths));
  reflowPaneWidths = () => {
    applyPaneWidth('folder', paneWidths.folder);
    applyPaneWidth('list', paneWidths.list);
  };
  reflowPaneWidths();
  paneResizers.forEach((handle) => {
    const pane = handle.dataset.resourcePaneResizer;
    if (!['folder', 'list'].includes(pane)) return;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startWidth = paneWidths[pane];
      handle.setPointerCapture(event.pointerId);
      workspace.classList.add('is-resizing-pane');
      const move = (moveEvent) => applyPaneWidth(pane, startWidth + moveEvent.clientX - startX);
      const finish = () => {
        persistPaneWidths();
        workspace.classList.remove('is-resizing-pane');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
    });
    handle.addEventListener('keydown', (event) => {
      let next = null;
      if (event.key === 'ArrowLeft') next = paneWidths[pane] - 20;
      else if (event.key === 'ArrowRight') next = paneWidths[pane] + 20;
      else if (event.key === 'Home') next = Number(handle.getAttribute('aria-valuemin'));
      else if (event.key === 'End') next = Number(handle.getAttribute('aria-valuemax'));
      if (next == null) return;
      event.preventDefault();
      applyPaneWidth(pane, next);
      persistPaneWidths();
    });
  });
  let resourceWorkspaceWasCompact = compactResourceWorkspace();
  window.addEventListener('resize', () => {
    const compact = compactResourceWorkspace();
    if (compact !== resourceWorkspaceWasCompact && focusedPath) {
      setFileListExpanded(!compact, { persist: false });
    } else {
      reflowPaneWidths();
    }
    resourceWorkspaceWasCompact = compact;
  });

  if (focusedRow) window.requestAnimationFrame(() => {
    focusedRow.focus({ preventScroll: true });
    focusedRow.scrollIntoView({ block: 'center' });
  });
});

document.querySelectorAll('[data-work-selection-context]').forEach((context) => {
  bindTemporaryWorkSources(context, {
    projectBase: context.dataset.projectBase,
    csrf: context.dataset.csrf,
    folder: context.dataset.selectedFolder,
    focus: context.dataset.focusPath,
    viewId: context.dataset.activeViewId,
  });
});

const importTerminalStatuses = new Set(['completed', 'partial', 'failed', 'unavailable']);

document.querySelectorAll('[data-import-status-href]:not([data-activity-live])').forEach((region) => {
  let polls = 0;
  const follow = async () => {
    polls += 1;
    try {
      const response = await fetch(region.dataset.importStatusHref, { headers: { accept: 'application/json' } });
      const result = await response.json();
      if (result?.href && importTerminalStatuses.has(result.status)) {
        window.location.assign(result.href);
        return;
      }
    } catch {}
    window.setTimeout(follow, polls < 240 ? 500 : 2000);
  };
  window.setTimeout(follow, 100);
});

const activityRegion = document.querySelector('[data-activity-live]');
if (activityRegion) {
  const connection = activityRegion.querySelector('.activity-manager-connection');
  const openKeys = () => new Set([...activityRegion.querySelectorAll('[data-activity-key][open]')]
    .map((item) => item.dataset.activityKey));
  const refreshActivity = async () => {
    const selected = activityRegion.dataset.selectedActivity;
    const fragmentHref = new URL(activityRegion.dataset.fragmentHref, window.location.origin);
    if (selected) fragmentHref.searchParams.set('selected', selected);
    const response = await fetch(fragmentHref, { headers: { accept: 'text/html' } });
    if (!response.ok) throw new Error('Activity update failed.');
    const template = document.createElement('template');
    template.innerHTML = await response.text();
    const next = template.content.querySelector('[data-activity-live]');
    if (!next) throw new Error('Activity update was incomplete.');
    const expanded = openKeys();
    const focusedControl = activityRegion.contains(document.activeElement) ? document.activeElement : null;
    const focusedActivity = focusedControl?.closest?.('[data-activity-key]') ?? null;
    const focusedActivityKey = focusedActivity?.dataset.activityKey ?? null;
    const focusableControls = focusedActivity
      ? [...focusedActivity.querySelectorAll('summary, a, button, input, select, textarea, [tabindex]')]
      : [];
    const focusedControlIndex = focusableControls.indexOf(focusedControl);
    activityRegion.innerHTML = next.innerHTML;
    activityRegion.querySelectorAll('[data-activity-key]').forEach((item) => {
      item.open = expanded.has(item.dataset.activityKey);
    });
    if (focusedActivityKey) {
      const nextFocusedActivity = [...activityRegion.querySelectorAll('[data-activity-key]')]
        .find((item) => item.dataset.activityKey === focusedActivityKey);
      const nextControls = nextFocusedActivity
        ? [...nextFocusedActivity.querySelectorAll('summary, a, button, input, select, textarea, [tabindex]')]
        : [];
      const nextFocus = nextControls[focusedControlIndex] ?? nextFocusedActivity?.querySelector(':scope > summary');
      nextFocus?.focus({ preventScroll: true });
    }
  };
  let fallbackTimer = null;
  let fallbackCount = 0;
  const fallback = () => {
    if (fallbackTimer) return;
    const nextPoll = async () => {
      fallbackCount += 1;
      try { await refreshActivity(); } catch {}
      const status = activityRegion.querySelector('.activity-manager-connection');
      if (fallbackCount >= 12) {
        if (status) status.textContent = 'Live updates are unavailable. Reopen Activity to retry.';
        fallbackTimer = null;
        return;
      }
      if (status) status.textContent = 'Live connection unavailable. Checking periodically.';
      fallbackTimer = window.setTimeout(() => { fallbackTimer = null; nextPoll(); }, 5000);
    };
    nextPoll();
  };
  if (typeof EventSource === 'function') {
    const events = new EventSource(activityRegion.dataset.eventsHref);
    events.addEventListener('ready', () => {
      const status = activityRegion.querySelector('.activity-manager-connection');
      if (status) status.textContent = 'Local activity is updating live.';
    });
    events.addEventListener('change', () => refreshActivity().catch(fallback));
    events.addEventListener('error', () => { events.close(); fallback(); });
  } else {
    if (connection) connection.textContent = 'Live updates are unavailable. Checking periodically.';
    fallback();
  }
  if (activityRegion.dataset.importStatusHref) {
    let importPolls = 0;
    const followImport = async () => {
      importPolls += 1;
      try {
        const response = await fetch(activityRegion.dataset.importStatusHref, { headers: { accept: 'application/json' } });
        const result = await response.json();
        if (result?.href && importTerminalStatuses.has(result.status)) {
          window.location.assign(result.href);
          return;
        }
      } catch {}
      window.setTimeout(followImport, importPolls < 240 ? 500 : 2000);
    };
    window.setTimeout(followImport, 250);
  }
}

let overlayReturnFocus = null;
function focusAtlasOverlay(dialog) {
  const initialFocus = dialog.querySelector('[data-overlay-initial-focus]');
  const fallbackFocus = dialog.querySelector('input, button');
  (initialFocus ?? fallbackFocus)?.focus();
}

function closeAtlasOverlay(dialog) {
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return;
  if (dialog.dataset.overlayDirty === 'true' && dialog.hasAttribute('data-overlay-dirty-protect')
    && !window.confirm('Close Settings and discard unsaved display changes?')) return;
  dialog.close();
  const returnHref = dialog.dataset.overlayReturnHref;
  if (returnHref) {
    window.location.assign(returnHref);
    return;
  }
  const target = overlayReturnFocus;
  overlayReturnFocus = null;
  target?.focus?.();
}

document.querySelectorAll('[data-overlay-open]').forEach((button) => {
  button.addEventListener('click', () => {
    const dialog = document.getElementById(button.dataset.overlayOpen);
    if (!(dialog instanceof HTMLDialogElement)) return;
    overlayReturnFocus = button;
    dialog.showModal();
    window.setTimeout(() => focusAtlasOverlay(dialog), 0);
  });
});

document.querySelectorAll('[data-atlas-overlay]').forEach((dialog) => {
  if (dialog.hasAttribute('data-overlay-dirty-protect')) {
    const form = dialog.querySelector('form');
    const markDirty = () => { dialog.dataset.overlayDirty = 'true'; };
    form?.addEventListener('input', markDirty);
    form?.addEventListener('change', markDirty);
    form?.addEventListener('submit', () => { dialog.dataset.overlayDirty = 'false'; });
  }
  dialog.querySelectorAll('[data-overlay-close]').forEach((button) => button.addEventListener('click', () => closeAtlasOverlay(dialog)));
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeAtlasOverlay(dialog);
  });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeAtlasOverlay(dialog);
  });
  if (dialog.hasAttribute('data-overlay-autostart') && !dialog.open) {
    dialog.showModal();
    window.setTimeout(() => focusAtlasOverlay(dialog), 0);
  }
});

const currentLocation = window.location ?? null;
if (currentLocation?.pathname !== '/settings') {
  document.querySelectorAll('a[href="/settings"]').forEach((link) => {
    const returnHref = currentLocation?.pathname
      ? `${currentLocation.pathname}${currentLocation.search ?? ''}`
      : '/projects';
    link.href = `/settings?return_to=${encodeURIComponent(returnHref)}`;
  });
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (document.querySelector('[data-overlay-dirty-protect][open]')) return;
    document.querySelector('[data-overlay-open="atlas-search"]')?.click();
  }
});
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function applyRailWidth(shell, handle, configuration, value) {
  const width = clamp(Math.round(value), configuration.minimum, configuration.maximum);
  shell.style.setProperty(configuration.property, `${width}px`);
  handle.setAttribute('aria-valuenow', String(width));
  if (handle.dataset.rail === 'app') {
    const compact = width <= configuration.compactThreshold;
    shell.classList.toggle('is-compact-app-rail', compact);
    const toggle = shell.querySelector('[data-toggle-rail]');
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!compact));
      toggle.setAttribute('aria-label', compact ? 'Expand navigation' : 'Collapse navigation');
      const symbol = toggle.querySelector('[aria-hidden="true"]');
      if (symbol) symbol.textContent = compact ? '›' : '‹';
    }
  }
  return width;
}

function attachResizer(handle) {
  const configuration = configurations[handle.dataset.rail];
  const shell = handle.closest('.app-shell, .studio-shell');
  const rail = shell?.querySelector(configuration?.railSelector);
  if (!configuration || !shell || !rail) return;

  const storageKey = `atlas-ui-${handle.dataset.rail}-rail-width`;
  const apply = (value) => applyRailWidth(shell, handle, configuration, value);

  const saved = Number.parseInt(storageGet('sessionStorage', storageKey), 10);
  if (Number.isFinite(saved)) apply(saved);
  else apply(rail.getBoundingClientRect().width);

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startWidth = rail.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    shell.classList.add('is-resizing-rail');

    const move = (moveEvent) => apply(startWidth + moveEvent.clientX - startX);
    const finish = () => {
      const width = Math.round(rail.getBoundingClientRect().width);
      storageSet('sessionStorage', storageKey, String(width));
      if (handle.dataset.rail === 'app' && width > configuration.compactThreshold) {
        storageSet('sessionStorage', `${storageKey}-expanded`, String(width));
      }
      shell.classList.remove('is-resizing-rail');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });

  handle.addEventListener('keydown', (event) => {
    const current = rail.getBoundingClientRect().width;
    let next = null;
    if (event.key === 'ArrowLeft') next = current - 16;
    else if (event.key === 'ArrowRight') next = current + 16;
    else if (event.key === 'Home') next = configuration.minimum;
    else if (event.key === 'End') next = configuration.maximum;
    if (next == null) return;
    event.preventDefault();
    const width = apply(next);
    storageSet('sessionStorage', storageKey, String(width));
  });
}

document.querySelectorAll('.rail-resizer').forEach(attachResizer);

if (document.documentElement?.dataset?.technicalIds === 'shown') {
  document.querySelectorAll('details.technical-details, details.technical-id').forEach((details) => {
    details.open = true;
  });
}

document.querySelectorAll('[data-toggle-rail]').forEach((button) => {
  button.addEventListener('click', () => {
    const shell = button.closest('.app-shell');
    const handle = shell?.querySelector('.app-rail-resizer');
    const rail = shell?.querySelector(configurations.app.railSelector);
    if (!shell || !handle || !rail) return;
    const storageKey = 'atlas-ui-app-rail-width';
    const current = rail.getBoundingClientRect().width;
    const compact = current <= configurations.app.compactThreshold;
    const remembered = Number.parseInt(storageGet('sessionStorage', `${storageKey}-expanded`), 10);
    const next = compact && Number.isFinite(remembered) ? remembered : compact ? 228 : configurations.app.minimum;
    const width = applyRailWidth(shell, handle, configurations.app, next);
    storageSet('sessionStorage', storageKey, String(width));
    if (width > configurations.app.compactThreshold) storageSet('sessionStorage', `${storageKey}-expanded`, String(width));
  });
});

document.querySelectorAll('[data-status-guide-toggle]').forEach((button) => {
  const guide = button.closest('.status-guide');
  const panel = guide?.querySelector('[data-status-guide-panel]');
  const close = guide?.querySelector('[data-status-guide-close]');
  if (!panel || typeof panel.addEventListener !== 'function') return;
  const hide = (restoreFocus = true) => {
    if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
    else panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus();
  };
  button.addEventListener('click', () => {
    if (typeof panel.showPopover === 'function') panel.showPopover();
    else panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    window.setTimeout(() => close?.focus(), 0);
  });
  close?.addEventListener('click', hide);
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    hide();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || button.getAttribute('aria-expanded') !== 'true') return;
    event.preventDefault();
    hide();
  });
  panel.addEventListener('toggle', (event) => button.setAttribute('aria-expanded', String(event.newState === 'open')));
});

const resourceContextCard = document.querySelector('[data-resource-context-card]');
if (resourceContextCard && typeof resourceContextCard.addEventListener === 'function') {
  const title = resourceContextCard.querySelector('[data-resource-context-title]');
  const body = resourceContextCard.querySelector('[data-resource-context-body]');
  const delay = Number.parseInt(document.documentElement.dataset.contextDelay, 10) || 650;
  let timer = null;
  let active = null;
  const hide = () => {
    window.clearTimeout(timer);
    if (typeof resourceContextCard.hidePopover === 'function' && resourceContextCard.matches(':popover-open')) resourceContextCard.hidePopover();
    else resourceContextCard.hidden = true;
    active = null;
  };
  const show = (row) => {
    active = row;
    if (title) title.textContent = row.dataset.contextTitle ?? '';
    if (body) body.textContent = row.dataset.contextBody ?? '';
    if (typeof resourceContextCard.showPopover === 'function') resourceContextCard.showPopover();
    else resourceContextCard.hidden = false;
    window.requestAnimationFrame(() => {
      const box = row.getBoundingClientRect();
      const card = resourceContextCard.getBoundingClientRect();
      const roomRight = box.right + 12 + card.width <= window.innerWidth - 14;
      const left = roomRight ? box.right + 12 : Math.max(14, box.left - card.width - 12);
      const top = Math.max(14, Math.min(box.top, window.innerHeight - card.height - 14));
      resourceContextCard.style.left = `${left}px`;
      resourceContextCard.style.top = `${top}px`;
    });
  };
  document.querySelectorAll('[data-resource-context]').forEach((row) => {
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => show(row), delay); };
    row.addEventListener('mouseenter', schedule);
    row.addEventListener('focus', schedule);
    row.addEventListener('mouseleave', () => { if (active === row) timer = window.setTimeout(hide, 180); else window.clearTimeout(timer); });
    row.addEventListener('blur', () => { if (active === row) hide(); else window.clearTimeout(timer); });
  });
  resourceContextCard.addEventListener('mouseenter', () => window.clearTimeout(timer));
  resourceContextCard.addEventListener('mouseleave', hide);
  window.addEventListener('resize', hide);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !active) return;
    const restore = active;
    hide();
    restore.focus?.();
  });
}

const importFiles = document.querySelector('[data-import-files]');
const pickerNotice = document.querySelector('[data-file-picker-notice]');

async function desktopPickerMethod(method) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const api = window.pywebview?.api;
    if (typeof api?.[method] === 'function') return api[method].bind(api);
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return null;
}

async function activateDesktopPickerControls() {
  const controls = [...document.querySelectorAll('[data-requires-desktop-picker]')];
  if (!controls.length) return;
  const readyMethod = await desktopPickerMethod('picker_ready');
  let ready = false;
  if (readyMethod) {
    try { ready = (await readyMethod())?.ready === true; } catch { ready = false; }
  }
  controls.forEach((control) => { control.disabled = !ready || control.dataset.importRunning === 'true'; });
  if (pickerNotice) pickerNotice.textContent = ready ? '' : 'The Desktop file picker did not become ready. You can retry after reopening Atlas.';
}

activateDesktopPickerControls();

async function chooseDesktopFile(button, method = 'pick_file') {
  const picker = await desktopPickerMethod(method);
  if (!picker) {
    if (pickerNotice) pickerNotice.textContent = 'The desktop file picker is not ready. Try again.';
    return { status: 'unavailable' };
  }
  button.disabled = true;
  try {
    return await picker();
  } finally {
    button.disabled = false;
  }
}

importFiles?.addEventListener('click', async () => {
  const selection = await chooseDesktopFile(importFiles, 'pick_import_files');
  if (selection?.queue_id) window.location.assign(`/files/queue/${encodeURIComponent(selection.queue_id)}`);
  else if (!['cancelled', 'unavailable'].includes(selection?.status) && pickerNotice) pickerNotice.textContent = selection?.message ?? 'Atlas could not register the selected files. Try again.';
});

document.querySelectorAll('[data-import-add-files], [data-import-add-folder]').forEach((button) => {
  button.addEventListener('click', async () => {
    const method = button.hasAttribute('data-import-add-folder') ? 'pick_import_folder' : 'pick_import_files';
    const picker = await desktopPickerMethod(method);
    if (!picker) {
      if (pickerNotice) pickerNotice.textContent = 'The desktop picker is not ready. Try again.';
      return;
    }
    button.disabled = true;
    try {
      const selection = await picker(button.dataset.importQueue || null);
      if (selection?.queue_id) window.location.assign(`/files/queue/${encodeURIComponent(selection.queue_id)}`);
      else if (selection?.status !== 'cancelled' && pickerNotice) pickerNotice.textContent = selection?.message ?? 'Atlas could not add this selection.';
    } finally {
      button.disabled = false;
    }
  });
});

document.querySelectorAll('[data-pick-folder]').forEach((button) => {
  button.addEventListener('click', async () => {
    const picker = await desktopPickerMethod('pick_folder');
    if (!picker) {
      const notice = document.querySelector('[data-folder-picker-notice]');
      if (notice) notice.textContent = 'The desktop folder picker is not ready. Try again.';
      return;
    }
    button.disabled = true;
    try {
      const selection = await picker();
      if (!selection?.selection_id) {
        if (selection?.status !== 'cancelled') {
          const notice = document.querySelector('[data-folder-picker-notice]');
          if (notice) notice.textContent = selection?.message ?? 'Atlas could not register the selected folder. Try again.';
        }
        return;
      }
      const form = button.closest('form');
      const target = form?.querySelector('input[name="folder_selection_id"]');
      if (target) target.value = selection.selection_id;
      const label = form?.querySelector('[data-folder-selection-name]');
      if (label) label.textContent = selection.name ?? 'Folder selected';
    } finally {
      button.disabled = false;
    }
  });
});

document.querySelectorAll('[data-compare-picker]').forEach((button) => {
  button.addEventListener('click', async () => {
    const selection = await chooseDesktopFile(button);
    if (!selection?.selection_id) return;
    const side = button.dataset.comparePicker;
    const left = button.dataset.leftSelection;
    const query = left ? `?left=${encodeURIComponent(left)}` : '';
    window.location.assign(`/compare/selected/${encodeURIComponent(side)}/${encodeURIComponent(selection.selection_id)}${query}`);
  });
});

document.querySelectorAll('[data-resource-relink-picker]').forEach((button) => {
  button.addEventListener('click', async () => {
    const form = button.closest('form[data-resource-relink-form]');
    const selection = await chooseDesktopFile(button, 'pick_file');
    if (!selection?.selection_id) {
      if (!['cancelled', 'unavailable'].includes(selection?.status)) {
        const notice = form?.querySelector('[data-resource-relink-notice]');
        if (notice) notice.textContent = selection?.message ?? 'Atlas could not register the selected file. Try again.';
      }
      return;
    }
    const target = form?.querySelector('input[name="selection_id"]');
    const name = form?.querySelector('[data-resource-relink-name]');
    const confirm = form?.querySelector('[data-resource-relink-confirm]');
    const notice = form?.querySelector('[data-resource-relink-notice]');
    if (target) target.value = selection.selection_id;
    if (name) name.textContent = selection.name ?? 'File selected';
    if (confirm) confirm.disabled = false;
    if (notice) notice.textContent = '';
  });
});

document.querySelectorAll('[data-project-folder-form]').forEach((form) => {
  const projectPicker = form.querySelector('[data-project-picker]');
  const groups = [...form.querySelectorAll('[data-project-folders]')];
  const submit = form.querySelector('button[type="submit"]');
  const pathLabel = form.querySelector('[data-project-path]');
  const fileNameInput = form.querySelector('input[name="file_name"]');
  const formatPicker = form.querySelector('select[name="format"]');

  const updateSelection = () => {
    const group = groups.find((item) => !item.hidden);
    const selected = group?.querySelector('input[name="folder"]:checked');
    const importRunning = form.dataset.importRunning === 'true';
    const hasActionableItems = Number.parseInt(form.dataset.importActionableCount ?? '1', 10) > 0;
    if (submit) submit.disabled = importRunning || !hasActionableItems || !selected;
    if (pathLabel) {
      const projectName = projectPicker?.selectedOptions[0]?.textContent?.replace(/ — unavailable$/u, '') ?? 'Project';
      pathLabel.textContent = selected
        ? `${projectName} / ${selected.dataset.folderPath} / ${fileNameInput?.value || form.dataset.fileName || 'file'}`
        : 'Choose an existing folder.';
    }
  };

  const updateProject = () => {
    for (const group of groups) {
      const active = group.dataset.projectId === projectPicker?.value;
      group.hidden = !active;
      group.querySelectorAll('input[name="folder"]').forEach((input) => { input.disabled = !active; });
    }
    updateSelection();
  };

  projectPicker?.addEventListener('change', updateProject);
  form.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === 'folder') updateSelection();
    if (event.target === formatPicker && fileNameInput) {
      fileNameInput.value = fileNameInput.value.replace(/\.(csv|xlsx)$/iu, '') + `.${formatPicker.value}`;
      updateSelection();
    }
  });
  fileNameInput?.addEventListener('input', updateSelection);
  updateProject();
});

const settingsForm = document.querySelector('.settings-layout');
const syncSettingsChoice = (input) => {
  if (!(input instanceof HTMLInputElement) || input.type !== 'radio') return;
  if (input.name === 'theme') {
    document.documentElement.dataset.theme = input.value;
    const selectedTheme = settingsForm?.querySelector('[data-settings-selected-theme]');
    if (selectedTheme) selectedTheme.value = input.value;
  }
  if (input.name === 'accent') {
    document.documentElement.dataset.accent = input.value;
    const selectedAccent = settingsForm?.querySelector('[data-settings-selected-accent]');
    if (selectedAccent) selectedAccent.value = input.value;
  }
};

settingsForm?.addEventListener('submit', () => {
  storageRemove('sessionStorage', 'atlas-ui-app-rail-width');
  storageRemove('sessionStorage', 'atlas-ui-project-rail-width');
  syncSettingsChoice(settingsForm.querySelector('input[name="theme"]:checked'));
  syncSettingsChoice(settingsForm.querySelector('input[name="accent"]:checked'));
});

settingsForm?.addEventListener('change', (event) => {
  syncSettingsChoice(event.target);
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.dataset.atlasSubmitting === 'true') {
    event.preventDefault();
    return;
  }
  form.dataset.atlasSubmitting = 'true';
  form.setAttribute('aria-busy', 'true');
  const status = document.createElement('div');
  status.className = 'atlas-processing-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const action = event.submitter?.textContent?.trim() || 'Working';
  status.textContent = `${action}… Atlas is working locally. Keep this window open.`;
  document.body.append(status);
}, true);

const workDraftConflict = document.querySelector('#work-draft-conflict');
workDraftConflict?.focus?.();
