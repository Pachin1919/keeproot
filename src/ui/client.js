const configurations = {
  app: {
    property: '--app-rail-width',
    railSelector: '#atlas-primary-nav',
    minimum: 180,
    maximum: 360,
  },
  project: {
    property: '--project-rail-width',
    railSelector: '#atlas-project-rail',
    minimum: 220,
    maximum: 420,
  },
};

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function attachResizer(handle) {
  const configuration = configurations[handle.dataset.rail];
  const shell = handle.closest('.app-shell, .studio-shell');
  const rail = shell?.querySelector(configuration?.railSelector);
  if (!configuration || !shell || !rail) return;

  const storageKey = `atlas-ui-${handle.dataset.rail}-rail-width`;
  const apply = (value) => {
    const width = clamp(Math.round(value), configuration.minimum, configuration.maximum);
    shell.style.setProperty(configuration.property, `${width}px`);
    handle.setAttribute('aria-valuenow', String(width));
    return width;
  };

  const saved = Number.parseInt(sessionStorage.getItem(storageKey), 10);
  if (Number.isFinite(saved)) apply(saved);

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startWidth = rail.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    shell.classList.add('is-resizing-rail');

    const move = (moveEvent) => apply(startWidth + moveEvent.clientX - startX);
    const finish = () => {
      const width = Math.round(rail.getBoundingClientRect().width);
      sessionStorage.setItem(storageKey, String(width));
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
    sessionStorage.setItem(storageKey, String(width));
  });
}

document.querySelectorAll('.rail-resizer').forEach(attachResizer);

document.querySelector('.settings-layout')?.addEventListener('submit', () => {
  sessionStorage.removeItem('atlas-ui-app-rail-width');
  sessionStorage.removeItem('atlas-ui-project-rail-width');
});
