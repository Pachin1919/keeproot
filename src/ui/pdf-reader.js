// Adapted from Mozilla PDF.js examples/learning/helloworld.html and display/api.js,
// 6.4.299, d0991a0d53f3bb3a7307e3b83f279c1d117aafb3, Apache-2.0.
// Only canvas rendering is used: no scripting sandbox, XFA, forms or action layers.
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 500;
const MAX_PIXELS = 12_000_000;
const MAX_DIMENSION = 8192;

async function openPdfReader(root) {
  const messages = JSON.parse(root.dataset.pdfMessages);
  const status = root.querySelector('[data-pdf-status]');
  const canvas = root.querySelector('[data-pdf-canvas]');
  const stage = root.querySelector('[data-pdf-stage]');
  const previous = root.querySelector('[data-pdf-prev]');
  const next = root.querySelector('[data-pdf-next]');
  const pageInput = root.querySelector('[data-pdf-page]');
  const total = root.querySelector('[data-pdf-total]');
  const zoom = root.querySelector('[data-pdf-zoom]');
  const controller = new AbortController();
  let library; let loadingTask; let pdf; let renderTask; let wantedPage = 1; let sequence = 0; let closed = false;
  let resizeTimer; let stageWidth = stage.clientWidth;
  const controls = () => {
    previous.disabled = !pdf || wantedPage <= 1; next.disabled = !pdf || wantedPage >= pdf.numPages;
    pageInput.disabled = !pdf; zoom.disabled = !pdf;
  };
  const fail = error => {
    if (closed) return;
    canvas.hidden = true; stage.setAttribute('aria-busy', 'false'); status.setAttribute('role', 'alert');
    const key = error.name === 'PasswordException' ? 'pdf_password' : error.name === 'InvalidPDFException' ? 'pdf_invalid'
      : error.code === 'PDF_CHANGED' ? 'pdf_changed' : error.code === 'PDF_PAGE_LIMIT' ? 'pdf_page_limit'
      : error.code === 'PDF_LIMIT' ? 'pdf_limit' : 'pdf_error';
    status.textContent = messages[key]; controls();
  };
  const boundedError = code => Object.assign(new Error(code), { code });
  async function render(number = wantedPage) {
    if (!pdf || closed) return;
    if (!Number.isInteger(number) || number < 1 || number > pdf.numPages) { pageInput.value = String(wantedPage); return; }
    wantedPage = number; pageInput.value = String(number); controls();
    const ticket = ++sequence; const pending = renderTask;
    pending?.cancel(); canvas.hidden = true; stage.setAttribute('aria-busy', 'true');
    status.setAttribute('role', 'status'); status.textContent = messages.pdf_rendering;
    let page;
    try {
      if (pending) await pending.promise.catch(() => {});
      if (closed || ticket !== sequence) return;
      page = await pdf.getPage(number);
      if (closed || ticket !== sequence) return;
      const natural = page.getViewport({ scale: 1 });
      const scale = zoom.value === 'fit' ? Math.min(2, Math.max(0.1, (stage.clientWidth - 40) / natural.width)) : Number(zoom.value);
      const viewport = page.getViewport({ scale });
      const outputScale = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.ceil(viewport.width * outputScale); const height = Math.ceil(viewport.height * outputScale);
      if (![width, height].every(Number.isFinite) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw boundedError('PDF_LIMIT');
      canvas.width = width; canvas.height = height;
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0], annotationMode: library.AnnotationMode.DISABLE });
      await renderTask.promise;
      if (closed || ticket !== sequence) return;
      canvas.hidden = false; stage.setAttribute('aria-busy', 'false');
      status.textContent = messages.pdf_page_status.replace('{page}', String(number)).replace('{total}', String(pdf.numPages));
    } catch (error) {
      if (ticket === sequence && error.name !== 'RenderingCancelledException') fail(error);
    } finally { page?.cleanup(); }
  }
  previous.addEventListener('click', () => render(wantedPage - 1));
  next.addEventListener('click', () => render(wantedPage + 1));
  pageInput.addEventListener('change', () => render(Number(pageInput.value)));
  zoom.addEventListener('change', () => render());
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const width = stage.clientWidth;
    if (width === stageWidth) return;
    stageWidth = width; clearTimeout(resizeTimer);
    if (pdf && zoom.value === 'fit') resizeTimer = setTimeout(() => render(), 100);
  }) : null;
  observer?.observe(stage);
  window.addEventListener('pagehide', () => {
    closed = true; sequence++; clearTimeout(resizeTimer); observer?.disconnect(); controller.abort(); renderTask?.cancel(); loadingTask?.destroy().catch(() => {});
  }, { once: true });
  try {
    const url = new URL(root.dataset.pdfUrl, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/projects\/[^/]+\/resources\/read-pdf$/u.test(url.pathname)
      || !/^[a-f0-9]{64}$/u.test(url.searchParams.get('expected_sha256') ?? '')) throw boundedError('PDF_CHANGED');
    library = await import('/assets/pdfjs/build/pdf.mjs');
    if (closed) return;
    library.GlobalWorkerOptions.workerSrc = '/assets/pdfjs/build/pdf.worker.mjs';
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw boundedError(response.status === 409 ? 'PDF_CHANGED' : 'PDF_ERROR');
    if (!response.headers.get('content-type')?.startsWith('application/pdf')) throw boundedError('PDF_ERROR');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) throw boundedError('PDF_LIMIT');
    if (closed) return;
    loadingTask = library.getDocument({ data: new Uint8Array(bytes),
      cMapUrl: '/assets/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/assets/pdfjs/standard_fonts/',
      wasmUrl: '/assets/pdfjs/wasm/', iccUrl: '/assets/pdfjs/iccs/',
      enableXfa: false, stopAtErrors: true, useWorkerFetch: false, useWasm: false, disableFontFace: true, useSystemFonts: true,
      maxImageSize: MAX_PIXELS });
    pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PAGES) { pdf = null; await loadingTask.destroy(); throw boundedError('PDF_PAGE_LIMIT'); }
    if (closed) return;
    pageInput.max = String(pdf.numPages); total.textContent = `/ ${pdf.numPages}`; controls(); await render();
  } catch (error) { fail(error); }
}

for (const root of document.querySelectorAll('[data-pdf-reader]')) openPdfReader(root);
