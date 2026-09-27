import {
  getDocument,
  GlobalWorkerOptions,
  PasswordResponses,
  RenderingCancelledException,
  TextLayer,
} from './vendor/pdf.min.mjs';
import Tesseract from './vendor/ocr/tesseract.esm.min.js';
import '../ocr-layout.js';

const { inspectCanvasTextLayout } = globalThis.WordExplainerOcrLayout;

const VENDOR_ROOT = new URL('./vendor/', import.meta.url).href;
const OCR_ROOT = new URL('./vendor/ocr/', import.meta.url).href;
const OCR_CORE_URL = new URL('core/tesseract-core-simd-lstm.wasm.js', OCR_ROOT).href;
GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR_ROOT).href;

const MAX_RENDER_CONCURRENCY = 2;
const MAX_RENDERED_PAGES = 4;
const PAGE_KEEP_RADIUS = 1;
const MAX_PAGE_CANVAS_PIXELS = 8_000_000;
const MAX_OCR_CROP_PIXELS = 6_000_000;
const OCR_IDLE_TIMEOUT_MS = 180_000;
const OCR_RECOGNITION_TIMEOUT_MS = 60_000;
const MAX_PDF_BYTES = 256 * 1024 * 1024;

const viewerContainer = document.getElementById('viewer-container');
const viewer = document.getElementById('viewer');
const emptyState = document.getElementById('empty-state');
const fileInput = document.getElementById('file-input');
const urlInput = document.getElementById('url-input');
const urlForm = document.getElementById('url-form');
const pageInput = document.getElementById('page-input');
const pageCountEl = document.getElementById('page-count');
const documentTitle = document.getElementById('document-title');
const zoomInput = document.getElementById('zoom-input');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingTitle = document.getElementById('loading-title');
const loadingProgress = document.getElementById('loading-progress');
const dropOverlay = document.getElementById('drop-overlay');
const statusEl = document.getElementById('status');
const ocrButton = document.getElementById('ocr-mode');
const revealToolbarButton = document.getElementById('reveal-toolbar');
const vocabularyButton = document.getElementById('open-vocabulary');

let pdfDocument = null;
let loadingTask = null;
let firstPageBaseViewport = null;
let currentScale = 1;
let fitToWidth = true;
let currentPage = 1;
let generation = 0;
let renderObserver = null;
let visibilityObserver = null;
let statusTimer = null;
let dragDepth = 0;
let zoomWheelTimer = null;
let pendingWheelScale = null;
let pendingWheelAnchor = null;
let resizeTimer = null;
let evictionTimer = null;
let activeRenderCount = 0;
let renderSequence = 0;
let ocrMode = false;
let ocrSelectionState = null;
let ocrWorkerPromise = null;
let ocrWorker = null;
let ocrBusy = false;
let ocrIdleTimer = null;
let zoomSnapshot = null;
let zoomTransitionSequence = 0;

const renderJobs = new Map();
const renderQueue = [];
const renderWaiters = new Map();
const visiblePages = new Map();
const pageAccessTimes = new Map();

function setStatus(message, type = '', duration = 3200) {
  clearTimeout(statusTimer);
  statusEl.textContent = message;
  statusEl.className = `status visible${type ? ` ${type}` : ''}`;
  if (duration > 0) {
    statusTimer = setTimeout(() => {
      statusEl.className = 'status';
    }, duration);
  }
}

function showLoading(title, progress = '准备中…') {
  loadingTitle.textContent = title;
  loadingProgress.textContent = progress;
  loadingOverlay.hidden = false;
}

function hideLoading() {
  loadingOverlay.hidden = true;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(index === 0 || value >= 10 ? 0 : 1)} ${units[index]}`;
}

function isPdfFile(file) {
  return file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
}

async function readLocalFile(file) {
  if (!isPdfFile(file)) {
    setStatus('请选择 PDF 文件', 'error');
    return;
  }
  if (file.size > MAX_PDF_BYTES) {
    setStatus(`这个 PDF 有 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_PDF_BYTES)} 的安全上限`, 'error', 0);
    return;
  }

  showLoading('正在读取本地 PDF', formatBytes(file.size) || '读取中…');
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    history.replaceState(null, '', location.pathname);
    await openPdfData(data, file.name, '');
  } catch (error) {
    handleOpenError(error);
  }
}

async function fetchPdf(url, localRelay = false) {
  showLoading(localRelay ? '正在接收本地 PDF' : '正在读取在线 PDF', '正在连接…');
  const response = await fetch(url, { credentials: localRelay ? 'omit' : 'include' });
  if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);

  const total = Number(response.headers.get('content-length')) || 0;
  if (total > MAX_PDF_BYTES) {
    throw new Error(`这个 PDF 有 ${formatBytes(total)}，超过 ${formatBytes(MAX_PDF_BYTES)} 的安全上限`);
  }
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > MAX_PDF_BYTES) {
      throw new Error(`这个 PDF 超过 ${formatBytes(MAX_PDF_BYTES)} 的安全上限`);
    }
    return data;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    if (loaded > MAX_PDF_BYTES) {
      try { await reader.cancel(); } catch (_) {}
      throw new Error(`这个 PDF 超过 ${formatBytes(MAX_PDF_BYTES)} 的安全上限，已停止读取`);
    }
    chunks.push(value);
    loadingProgress.textContent = total
      ? `已读取 ${Math.round((loaded / total) * 100)}% · ${formatBytes(loaded)} / ${formatBytes(total)}`
      : `已读取 ${formatBytes(loaded)}`;
  }

  const data = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

async function openPdfUrl(rawUrl, preferredName = '', source = 'online') {
  let url;
  try {
    url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch (_) {
    setStatus('请输入有效的 HTTP 或 HTTPS PDF 网址', 'error');
    return;
  }

  const localRelay = source === 'windows'
    && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.protocol === 'http:';
  urlInput.value = localRelay ? '' : url.href;
  try {
    const data = await fetchPdf(url.href, localRelay);
    const safePreferredName = String(preferredName || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 240);
    const label = safePreferredName || decodeURIComponent(url.pathname.split('/').pop() || '在线 PDF');
    if (localRelay) {
      // 本机中转地址只在本次打开期间有效，避免刷新页面时访问已经关闭的端口。
      history.replaceState(null, '', location.pathname);
    } else {
      history.replaceState(null, '', `${location.pathname}?url=${encodeURIComponent(url.href)}`);
    }
    await openPdfData(data, label, localRelay ? '' : url.href);
  } catch (error) {
    handleOpenError(error);
  }
}

function resetRenderingState() {
  generation += 1;
  renderObserver?.disconnect();
  visibilityObserver?.disconnect();
  renderObserver = null;
  visibilityObserver = null;
  visiblePages.clear();
  pageAccessTimes.clear();
  renderQueue.length = 0;
  activeRenderCount = 0;
  clearTimeout(evictionTimer);

  for (const job of renderJobs.values()) {
    try { job.renderTask?.cancel(); } catch (_) {}
    try { job.textLayer?.cancel(); } catch (_) {}
  }
  renderJobs.clear();

  for (const waiters of renderWaiters.values()) {
    for (const resolve of waiters) resolve(false);
  }
  renderWaiters.clear();
}

async function destroyCurrentDocument() {
  resetRenderingState();
  setOcrMode(false, false);
  cancelOcrSelection();
  removeZoomSnapshot();
  clearPageContent(viewer);

  if (loadingTask) {
    try { await loadingTask.destroy(); } catch (_) {}
  }
  loadingTask = null;
  pdfDocument = null;
  firstPageBaseViewport = null;
  viewer.replaceChildren();
}

function createLoadingTask(data) {
  const task = getDocument({
    data,
    cMapUrl: new URL('cmaps/', VENDOR_ROOT).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', VENDOR_ROOT).href,
    wasmUrl: new URL('wasm/', VENDOR_ROOT).href,
    iccUrl: new URL('iccs/', VENDOR_ROOT).href,
    useWasm: false,
    canvasMaxAreaInBytes: MAX_PAGE_CANVAS_PIXELS * 4,
    enableXfa: false,
  });

  task.onProgress = ({ loaded, total }) => {
    if (!total) return;
    loadingProgress.textContent = `解析中 ${Math.min(100, Math.round((loaded / total) * 100))}%`;
  };

  task.onPassword = (updatePassword, reason) => {
    const message = reason === PasswordResponses.INCORRECT_PASSWORD
      ? '密码错误，请重新输入 PDF 密码：'
      : '这份 PDF 需要密码：';
    const password = window.prompt(message);
    if (password === null) {
      task.destroy();
      return;
    }
    updatePassword(password);
  };

  return task;
}

async function openPdfData(data, fallbackName, originalUrl = '') {
  await destroyCurrentDocument();
  const openGeneration = generation;
  showLoading('正在解析 PDF', '读取文档结构…');

  const task = createLoadingTask(data);
  loadingTask = task;
  const loadedDocument = await task.promise;
  if (openGeneration !== generation) return;
  pdfDocument = loadedDocument;

  const firstPage = await pdfDocument.getPage(1);
  if (openGeneration !== generation) return;
  firstPageBaseViewport = firstPage.getViewport({ scale: 1 });
  currentScale = calculateFitScale();
  fitToWidth = true;
  currentPage = 1;

  let title = fallbackName || 'PDF 文档';
  try {
    const metadata = await pdfDocument.getMetadata();
    const metadataTitle = getUsefulMetadataTitle(metadata?.info?.Title);
    if (metadataTitle) title = metadataTitle;
  } catch (_) {}

  documentTitle.textContent = title;
  documentTitle.title = title;
  document.title = `${title} · PDF 阅读器`;
  document.body.dataset.pdfFingerprint = pdfDocument.fingerprints?.[0] || `${title}:${pdfDocument.numPages}`;
  document.body.dataset.pdfOriginalUrl = originalUrl;
  pageCountEl.textContent = String(pdfDocument.numPages);
  pageInput.max = String(pdfDocument.numPages);
  pageInput.disabled = false;
  document.body.classList.add('document-loaded');
  setControlsEnabled(true);

  buildPageShells(1);
  emptyState.hidden = true;
  viewer.hidden = false;
  const buildGeneration = generation;
  const rendered = await ensurePageRendered(1, -100);
  if (buildGeneration !== generation) return;
  if (rendered) scrollToPagePosition(1, false);
  hideLoading();
  setStatus(`已打开 ${pdfDocument.numPages} 页 · PDF 数据仅保存在当前标签页内存中`);
}

function getUsefulMetadataTitle(value) {
  if (typeof value !== 'string') return '';
  const title = value.replace(/\0/g, '').trim();
  if (!title) return '';
  if (/^\(?\s*(anonymous|untitled|unknown|未命名)\s*\)?$/i.test(title)) return '';
  return title;
}

function handleOpenError(error) {
  hideLoading();
  const message = error?.message || '无法打开这份 PDF';
  setStatus(message, 'error', 6000);
}

function calculateFitScale() {
  if (!firstPageBaseViewport) return 1;
  const horizontalPadding = window.innerWidth <= 720 ? 20 : 56;
  const availableWidth = Math.max(220, viewerContainer.clientWidth - horizontalPadding);
  return clamp(availableWidth / firstPageBaseViewport.width, 0.4, 2.5);
}

function buildPageShells(pageToRestore = currentPage) {
  if (!pdfDocument || !firstPageBaseViewport) return;
  resetRenderingState();
  const buildGeneration = generation;
  clearPageContent(viewer);
  viewer.replaceChildren();

  const fragment = document.createDocumentFragment();
  const estimatedWidth = firstPageBaseViewport.width * currentScale;
  const estimatedHeight = firstPageBaseViewport.height * currentScale;

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const shell = document.createElement('section');
    shell.className = 'page-shell loading';
    shell.id = `page-${pageNumber}`;
    shell.dataset.pageNumber = String(pageNumber);
    shell.dataset.renderState = 'idle';
    shell.style.width = `${estimatedWidth}px`;
    shell.style.height = `${estimatedHeight}px`;
    shell.style.setProperty('--total-scale-factor', String(currentScale));

    const badge = document.createElement('span');
    badge.className = 'page-number-badge';
    badge.textContent = String(pageNumber);
    shell.appendChild(badge);
    fragment.appendChild(shell);
  }
  viewer.appendChild(fragment);

  renderObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) queuePageRender(entry.target, 10, buildGeneration);
    }
  }, {
    root: viewerContainer,
    rootMargin: '900px 240px',
    threshold: 0.01,
  });

  visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pageNumber = Number(entry.target.dataset.pageNumber);
      if (entry.isIntersecting) visiblePages.set(pageNumber, entry.intersectionRatio);
      else visiblePages.delete(pageNumber);
    }
    updateCurrentPageFromVisibility();
  }, {
    root: viewerContainer,
    threshold: [0.01, 0.1, 0.25, 0.5, 0.75, 1],
  });

  viewer.querySelectorAll('.page-shell').forEach((shell) => {
    renderObserver.observe(shell);
    visibilityObserver.observe(shell);
  });

  currentPage = clamp(Math.round(Number(pageToRestore) || 1), 1, pdfDocument.numPages);
  pageInput.value = String(currentPage);
  queuePageRender(document.getElementById(`page-${currentPage}`), -100, buildGeneration);
  queueNeighborPages(currentPage, -50, buildGeneration);
  updateZoomInput();
  updateNavigationButtons();
}

function queuePageRender(shell, priority = 10, renderGeneration = generation) {
  if (!shell || renderGeneration !== generation || !shell.isConnected) return;
  const state = shell.dataset.renderState;
  if (state === 'rendered' || state === 'loading') return;

  if (state === 'error') resetShellForRender(shell);
  if (shell.dataset.renderState === 'queued') {
    const queued = renderQueue.find((item) => item.shell === shell && item.renderGeneration === renderGeneration);
    if (queued) queued.priority = Math.min(queued.priority, priority);
  } else {
    shell.dataset.renderState = 'queued';
    renderQueue.push({ shell, priority, renderGeneration, sequence: renderSequence++ });
  }
  renderQueue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  pumpRenderQueue();
}

function pumpRenderQueue() {
  while (activeRenderCount < MAX_RENDER_CONCURRENCY && renderQueue.length > 0) {
    const item = renderQueue.shift();
    if (item.renderGeneration !== generation || !item.shell.isConnected || item.shell.dataset.renderState !== 'queued') continue;
    activeRenderCount += 1;
    renderPage(item.shell, item.renderGeneration).finally(() => {
      if (item.renderGeneration === generation) {
        activeRenderCount = Math.max(0, activeRenderCount - 1);
        pumpRenderQueue();
      }
    });
  }
}

async function renderPage(shell, renderGeneration) {
  if (!pdfDocument || renderGeneration !== generation || shell.dataset.renderState !== 'queued') return false;
  shell.dataset.renderState = 'loading';
  shell.classList.add('loading');
  const pageNumber = Number(shell.dataset.pageNumber);

  try {
    const page = await pdfDocument.getPage(pageNumber);
    if (renderGeneration !== generation || !shell.isConnected) return false;

    const viewport = page.getViewport({ scale: currentScale });
    shell.style.width = `${viewport.width}px`;
    shell.style.height = `${viewport.height}px`;
    shell.style.setProperty('--total-scale-factor', String(viewport.scale));
    clearPageContent(shell);

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    const desiredOutputScale = Math.min(window.devicePixelRatio || 1, 2);
    const pixelBudgetScale = Math.sqrt(MAX_PAGE_CANVAS_PIXELS / (viewport.width * viewport.height));
    const outputScale = Math.max(0.25, Math.min(desiredOutputScale, pixelBudgetScale));
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const textLayerElement = document.createElement('div');
    textLayerElement.className = 'textLayer';
    textLayerElement.style.setProperty('--total-scale-factor', String(viewport.scale));
    shell.prepend(canvas, textLayerElement);

    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      background: '#ffffff',
    });
    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      }),
      container: textLayerElement,
      viewport,
    });
    renderJobs.set(pageNumber, { renderTask, textLayer, renderGeneration });

    await Promise.all([renderTask.promise, textLayer.render()]);
    if (renderGeneration !== generation || !shell.isConnected) return false;
    shell.classList.remove('loading');
    shell.dataset.renderState = 'rendered';
    renderObserver?.unobserve(shell);
    pageAccessTimes.set(pageNumber, performance.now());
    settlePageWaiters(pageNumber, true);
    schedulePageEviction();
    return true;
  } catch (error) {
    if (error instanceof RenderingCancelledException || renderGeneration !== generation) return false;
    shell.classList.remove('loading');
    shell.dataset.renderState = 'error';
    const errorEl = document.createElement('div');
    errorEl.className = 'page-error';
    errorEl.textContent = `第 ${pageNumber} 页渲染失败：${error?.message || '未知错误'}`;
    shell.appendChild(errorEl);
    settlePageWaiters(pageNumber, false);
    return false;
  } finally {
    if (renderJobs.get(pageNumber)?.renderGeneration === renderGeneration) renderJobs.delete(pageNumber);
  }
}

function ensurePageRendered(pageNumber, priority = 0) {
  const shell = document.getElementById(`page-${pageNumber}`);
  if (!shell) return Promise.resolve(false);
  if (shell.dataset.renderState === 'rendered') {
    pageAccessTimes.set(pageNumber, performance.now());
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const waiters = renderWaiters.get(pageNumber) || [];
    waiters.push(resolve);
    renderWaiters.set(pageNumber, waiters);
    queuePageRender(shell, priority, generation);
  });
}

function settlePageWaiters(pageNumber, result) {
  const waiters = renderWaiters.get(pageNumber);
  if (!waiters) return;
  renderWaiters.delete(pageNumber);
  for (const resolve of waiters) resolve(result);
}

function resetShellForRender(shell) {
  clearPageContent(shell);
  shell.dataset.renderState = 'idle';
  shell.classList.add('loading');
}

function queueNeighborPages(pageNumber, priority = 5, renderGeneration = generation) {
  for (const neighbor of [pageNumber - 1, pageNumber + 1]) {
    if (neighbor < 1 || neighbor > (pdfDocument?.numPages || 0)) continue;
    queuePageRender(document.getElementById(`page-${neighbor}`), priority, renderGeneration);
  }
}

function updateCurrentPageFromVisibility() {
  if (visiblePages.size === 0) return;
  let bestPage = currentPage;
  let bestRatio = -1;
  for (const [pageNumber, ratio] of visiblePages) {
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestPage = pageNumber;
    }
  }
  currentPage = bestPage;
  pageInput.value = String(currentPage);
  pageAccessTimes.set(currentPage, performance.now());
  queueNeighborPages(currentPage, 4);
  updateNavigationButtons();
  schedulePageEviction();
}

async function scrollToPage(pageNumber, smooth = true, waitForRender = true) {
  if (!pdfDocument) return false;
  const targetPage = clamp(Math.round(Number(pageNumber) || 1), 1, pdfDocument.numPages);
  const shell = document.getElementById(`page-${targetPage}`);
  if (!shell) return false;

  currentPage = targetPage;
  pageInput.value = String(targetPage);
  updateNavigationButtons();
  const alreadyRendered = shell.dataset.renderState === 'rendered';

  if (waitForRender && !alreadyRendered) {
    setStatus(`正在准备第 ${targetPage} 页…`, '', 0);
    queueNeighborPages(targetPage, -50);
    const navigationGeneration = generation;
    const rendered = await ensurePageRendered(targetPage, -100);
    if (navigationGeneration !== generation) return false;
    if (!rendered) {
      setStatus(`第 ${targetPage} 页渲染失败`, 'error', 5000);
      return false;
    }
  }

  scrollToPagePosition(targetPage, smooth);
  if (!alreadyRendered) setStatus(`第 ${targetPage} 页已就绪`, '', 1400);
  return true;
}

function scrollToPagePosition(pageNumber, smooth = true) {
  const shell = document.getElementById(`page-${pageNumber}`);
  if (!shell) return;
  viewerContainer.scrollTo({
    top: Math.max(0, shell.offsetTop - 18),
    behavior: smooth ? 'smooth' : 'auto',
  });
}

function schedulePageEviction() {
  clearTimeout(evictionTimer);
  evictionTimer = setTimeout(evictDistantPages, 180);
}

function evictDistantPages() {
  if (!pdfDocument) return;
  const rendered = Array.from(viewer.querySelectorAll('.page-shell[data-render-state="rendered"]'));
  if (rendered.length <= MAX_RENDERED_PAGES) return;

  const protectedPages = new Set(visiblePages.keys());
  for (let offset = -PAGE_KEEP_RADIUS; offset <= PAGE_KEEP_RADIUS; offset += 1) {
    protectedPages.add(currentPage + offset);
  }

  const candidates = rendered
    .filter((shell) => !protectedPages.has(Number(shell.dataset.pageNumber)))
    .sort((a, b) => {
      const pageA = Number(a.dataset.pageNumber);
      const pageB = Number(b.dataset.pageNumber);
      const distanceDifference = Math.abs(pageB - currentPage) - Math.abs(pageA - currentPage);
      if (distanceDifference !== 0) return distanceDifference;
      return (pageAccessTimes.get(pageA) || 0) - (pageAccessTimes.get(pageB) || 0);
    });

  let remaining = rendered.length;
  for (const shell of candidates) {
    if (remaining <= MAX_RENDERED_PAGES) break;
    recyclePageShell(shell);
    remaining -= 1;
  }
}

function recyclePageShell(shell) {
  const pageNumber = Number(shell.dataset.pageNumber);
  clearPageContent(shell);
  shell.dataset.renderState = 'idle';
  shell.classList.add('loading');
  pageAccessTimes.delete(pageNumber);
  renderObserver?.observe(shell);
}

async function setScale(nextScale, keepFitMode = false, anchorClient = null) {
  if (!pdfDocument) return;
  fitToWidth = keepFitMode;
  const clamped = clamp(nextScale, 0.4, 3.5);
  if (Math.abs(clamped - currentScale) < 0.005) {
    updateZoomInput();
    return;
  }

  const previousScale = currentScale;
  const pageToRestore = currentPage;
  const anchor = captureZoomAnchor(pageToRestore, anchorClient);
  const transitionId = ++zoomTransitionSequence;
  ensureZoomSnapshot();

  currentScale = clamped;
  setStatus(`正在调整到 ${Math.round(clamped * 100)}%…`, '', 0);
  buildPageShells(pageToRestore);
  const scaleGeneration = generation;
  const rendered = await ensurePageRendered(pageToRestore, -100);
  if (scaleGeneration !== generation || transitionId !== zoomTransitionSequence) return;

  if (rendered) {
    restoreZoomAnchor(anchor, clamped / previousScale);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    removeZoomSnapshot();
    setStatus(`缩放 ${Math.round(clamped * 100)}%`, '', 1200);
  } else {
    removeZoomSnapshot();
    setStatus(`缩放失败：第 ${pageToRestore} 页无法渲染`, 'error', 5000);
  }
}

function captureZoomAnchor(pageNumber, anchorClient) {
  const containerRect = viewerContainer.getBoundingClientRect();
  const viewportX = clamp(
    Number.isFinite(anchorClient?.clientX)
      ? anchorClient.clientX - containerRect.left
      : viewerContainer.clientWidth / 2,
    0,
    viewerContainer.clientWidth
  );
  const viewportY = clamp(
    Number.isFinite(anchorClient?.clientY)
      ? anchorClient.clientY - containerRect.top
      : viewerContainer.clientHeight / 2,
    0,
    viewerContainer.clientHeight
  );
  const shell = document.getElementById(`page-${pageNumber}`);
  return {
    pageNumber,
    viewportX,
    viewportY,
    pageOffsetX: shell
      ? viewerContainer.scrollLeft + viewportX - shell.offsetLeft
      : viewportX,
    pageOffsetY: shell
      ? viewerContainer.scrollTop + viewportY - shell.offsetTop
      : viewportY,
  };
}

function restoreZoomAnchor(anchor, scaleRatio) {
  const shell = document.getElementById(`page-${anchor.pageNumber}`);
  if (!shell) return;
  viewerContainer.scrollTo({
    left: Math.max(0, shell.offsetLeft + anchor.pageOffsetX * scaleRatio - anchor.viewportX),
    top: Math.max(0, shell.offsetTop + anchor.pageOffsetY * scaleRatio - anchor.viewportY),
    behavior: 'auto',
  });
}

function ensureZoomSnapshot() {
  if (zoomSnapshot?.isConnected) return zoomSnapshot;
  const shell = document.getElementById(`page-${currentPage}`);
  const sourceCanvas = shell?.querySelector('canvas');
  if (!sourceCanvas) return null;

  const pageRect = sourceCanvas.getBoundingClientRect();
  if (pageRect.width < 2 || pageRect.height < 2) return null;

  sourceCanvas.classList.add('zoom-snapshot');
  Object.assign(sourceCanvas.style, {
    left: `${pageRect.left}px`,
    top: `${pageRect.top}px`,
    width: `${pageRect.width}px`,
    height: `${pageRect.height}px`,
  });
  document.body.appendChild(sourceCanvas);
  zoomSnapshot = sourceCanvas;
  return sourceCanvas;
}

function removeZoomSnapshot() {
  const snapshot = zoomSnapshot;
  zoomSnapshot = null;
  if (!snapshot) return;
  releaseCanvas(snapshot);
}

function clearPageContent(root) {
  root.querySelectorAll('canvas').forEach(releaseCanvas);
  root.querySelectorAll('.textLayer, .page-error').forEach((element) => element.remove());
}

function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

function applyZoomInput() {
  const numeric = Number.parseFloat(zoomInput.value.replace('%', '').replace(',', '.'));
  if (!Number.isFinite(numeric)) {
    updateZoomInput();
    return;
  }
  setScale(numeric / 100);
}

function updateZoomInput() {
  zoomInput.value = String(Math.round(currentScale * 100));
}

function setControlsEnabled(enabled) {
  for (const id of ['previous-page', 'next-page', 'zoom-out', 'zoom-in', 'fit-width']) {
    document.getElementById(id).disabled = !enabled;
  }
  ocrButton.disabled = !enabled || ocrBusy;
  zoomInput.disabled = !enabled;
}

function updateNavigationButtons() {
  document.getElementById('previous-page').disabled = !pdfDocument || currentPage <= 1;
  document.getElementById('next-page').disabled = !pdfDocument || currentPage >= pdfDocument.numPages;
}

function setToolbarCollapsed(collapsed, persist = true) {
  document.body.classList.toggle('toolbar-collapsed', collapsed);
  revealToolbarButton.hidden = !collapsed;
  if (persist) chrome.storage.local.set({ pdfToolbarCollapsed: collapsed });
}

function setOcrMode(active, announce = true) {
  ocrMode = !!active && !!pdfDocument;
  document.body.classList.toggle('ocr-mode', ocrMode);
  ocrButton.classList.toggle('active', ocrMode);
  ocrButton.setAttribute('aria-pressed', String(ocrMode));
  if (announce) {
    setStatus(ocrMode ? 'OCR 已开启：在 PDF 页面上拖出需要识别的区域' : '已退出 OCR');
  }
}

function startOcrSelection(event) {
  if (!ocrMode || event.button !== 0) return;
  const shell = event.target.closest('.page-shell');
  if (!shell) return;
  if (shell.dataset.renderState !== 'rendered') {
    setStatus('这一页仍在渲染，请稍后再框选', 'error');
    queuePageRender(shell, -100);
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  cancelOcrSelection();
  const shellRect = shell.getBoundingClientRect();
  const startX = clamp(event.clientX - shellRect.left, 0, shellRect.width);
  const startY = clamp(event.clientY - shellRect.top, 0, shellRect.height);
  const selection = document.createElement('div');
  selection.className = 'ocr-selection';
  selection.style.left = `${startX}px`;
  selection.style.top = `${startY}px`;
  shell.appendChild(selection);

  ocrSelectionState = {
    pointerId: event.pointerId,
    shell,
    selection,
    startX,
    startY,
    currentX: startX,
    currentY: startY,
    renderGeneration: generation,
  };
  document.addEventListener('pointermove', updateOcrSelection, { capture: true, passive: false });
  document.addEventListener('pointerup', finishOcrSelection, true);
  document.addEventListener('pointercancel', finishOcrSelection, true);
}

function updateOcrSelection(event) {
  const state = ocrSelectionState;
  if (!state || event.pointerId !== state.pointerId) return;
  event.preventDefault();
  const shellRect = state.shell.getBoundingClientRect();
  state.currentX = clamp(event.clientX - shellRect.left, 0, shellRect.width);
  state.currentY = clamp(event.clientY - shellRect.top, 0, shellRect.height);
  const left = Math.min(state.startX, state.currentX);
  const top = Math.min(state.startY, state.currentY);
  const width = Math.abs(state.currentX - state.startX);
  const height = Math.abs(state.currentY - state.startY);
  Object.assign(state.selection.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
}

function finishOcrSelection(event) {
  const state = ocrSelectionState;
  if (!state || event.pointerId !== state.pointerId) return;
  document.removeEventListener('pointermove', updateOcrSelection, true);
  document.removeEventListener('pointerup', finishOcrSelection, true);
  document.removeEventListener('pointercancel', finishOcrSelection, true);
  ocrSelectionState = null;

  const left = Math.min(state.startX, state.currentX);
  const top = Math.min(state.startY, state.currentY);
  const width = Math.abs(state.currentX - state.startX);
  const height = Math.abs(state.currentY - state.startY);
  if (width < 12 || height < 12) {
    state.selection.remove();
    setStatus('框选区域太小，请重新选择', 'error');
    return;
  }

  state.selection.classList.add('recognizing');
  setOcrMode(false, false);
  ocrBusy = true;
  ocrButton.disabled = true;
  recognizeOcrRegion(state, { left, top, width, height }).catch((error) => {
    state.selection.remove();
    setStatus(`OCR 失败：${formatOcrError(error, '未知错误')}`, 'error', 8000);
  }).finally(() => {
    ocrBusy = false;
    ocrButton.disabled = !pdfDocument;
    scheduleOcrWorkerShutdown();
  });
}

function cancelOcrSelection() {
  document.removeEventListener('pointermove', updateOcrSelection, true);
  document.removeEventListener('pointerup', finishOcrSelection, true);
  document.removeEventListener('pointercancel', finishOcrSelection, true);
  ocrSelectionState?.selection?.remove();
  ocrSelectionState = null;
}

async function recognizeOcrRegion(state, region) {
  if (state.renderGeneration !== generation || !state.shell.isConnected) return;
  const sourceCanvas = state.shell.querySelector('canvas');
  if (!sourceCanvas) throw new Error('页面图像尚未准备好');

  const shellWidth = state.shell.clientWidth;
  const shellHeight = state.shell.clientHeight;
  const scaleX = sourceCanvas.width / shellWidth;
  const scaleY = sourceCanvas.height / shellHeight;
  const sourceX = Math.max(0, Math.floor(region.left * scaleX));
  const sourceY = Math.max(0, Math.floor(region.top * scaleY));
  const sourceWidth = Math.max(1, Math.min(sourceCanvas.width - sourceX, Math.ceil(region.width * scaleX)));
  const sourceHeight = Math.max(1, Math.min(sourceCanvas.height - sourceY, Math.ceil(region.height * scaleY)));

  const desiredBoost = sourceWidth < 1200 ? Math.min(2, 1200 / sourceWidth) : 1;
  const maxDimensionFactor = 3200 / Math.max(sourceWidth, sourceHeight);
  const maxPixelFactor = Math.sqrt(MAX_OCR_CROP_PIXELS / (sourceWidth * sourceHeight));
  const outputFactor = Math.max(0.25, Math.min(desiredBoost, maxDimensionFactor, maxPixelFactor));
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = Math.max(1, Math.round(sourceWidth * outputFactor));
  cropCanvas.height = Math.max(1, Math.round(sourceHeight * outputFactor));
  const cropContext = cropCanvas.getContext('2d', { alpha: false });
  cropContext.fillStyle = '#ffffff';
  cropContext.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropContext.imageSmoothingEnabled = true;
  cropContext.imageSmoothingQuality = 'high';
  cropContext.drawImage(
    sourceCanvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    cropCanvas.width,
    cropCanvas.height
  );

  setStatus('正在启动本地 OCR…', '', 0);
  if (state.renderGeneration !== generation) {
    state.selection.remove();
    return;
  }
  let result;
  try {
    result = await recognizeOcrWithRecovery(cropCanvas);
  } finally {
    releaseCanvas(cropCanvas);
  }
  const selectionRect = state.selection.getBoundingClientRect();
  state.selection.remove();
  if (state.renderGeneration !== generation) return;

  const text = normalizeOcrText(result?.data?.text || '');
  if (!text) {
    setStatus('这个区域没有识别到英文文字，请尝试放大页面后重新框选', 'error', 6000);
    return;
  }

  const explanationResult = window.__wordExplainer?.explainText(text, {
    mode: 'ZH',
    rect: {
      left: selectionRect.left,
      right: selectionRect.right,
      top: selectionRect.top,
      bottom: selectionRect.bottom,
      width: selectionRect.width,
      height: selectionRect.height,
    },
    context: text,
    kind: 'ocr',
    page: Number(state.shell.dataset.pageNumber) || null,
    source: {
      kind: 'ocr',
      title: documentTitle.textContent.trim() || 'PDF 文档',
      url: document.body.dataset.pdfOriginalUrl || '',
      documentId: document.body.dataset.pdfFingerprint || documentTitle.textContent.trim(),
      page: Number(state.shell.dataset.pageNumber) || null,
    },
  });
  if (!explanationResult?.ok) {
    setStatus(explanationResult?.message || 'OCR 完成，但无法打开翻译框', 'error', 6000);
    return;
  }
  setStatus(`OCR 完成 · 已识别 ${text.length} 个字符`);
}

async function recognizeOcrWithRecovery(canvas) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let worker;
    try {
      worker = await getOcrWorker();
      const { PSM } = Tesseract;
      return await withOcrTimeout(
        recognizeOcrCanvasByLayout(worker, canvas, PSM),
        OCR_RECOGNITION_TIMEOUT_MS
      );
    } catch (error) {
      lastError = error;
      setStatus(attempt === 0 ? 'OCR 首次识别失败，正在自动重试…' : 'OCR 重试失败', attempt === 0 ? '' : 'error', 0);
      await resetOcrWorker(worker);
    }
  }
  throw lastError || new Error('OCR 识别失败');
}

async function recognizeOcrCanvasByLayout(worker, canvas, PSM) {
  const layout = inspectCanvasTextLayout(canvas, PSM);
  if (layout.lineRegions.length >= 2) {
    const lineTexts = [];
    for (const region of layout.lineRegions) {
      const lineCanvas = createOcrLineCanvas(canvas, region);
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
        const result = await worker.recognize(lineCanvas);
        lineTexts.push(normalizeOcrLine(result?.data?.text || ''));
      } finally {
        releaseCanvas(lineCanvas);
      }
    }
    const recognizedLines = lineTexts.filter(Boolean);
    if (recognizedLines.length >= Math.ceil(layout.lineRegions.length * 0.6)) {
      return { data: { text: recognizedLines.join('\n') } };
    }
  }

  await worker.setParameters({ tessedit_pageseg_mode: layout.mode });
  return worker.recognize(canvas);
}

function createOcrLineCanvas(sourceCanvas, region) {
  const textHeight = Math.max(1, region.textBottom - region.textTop);
  const boost = Math.max(1, Math.min(2.5, 48 / textHeight));
  const dimensionLimit = 3200 / Math.max(region.width, region.height);
  const scale = Math.max(1, Math.min(boost, dimensionLimit));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(region.width * scale));
  canvas.height = Math.max(1, Math.round(region.height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    sourceCanvas,
    region.left,
    region.top,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  return canvas;
}

function normalizeOcrLine(text) {
  return String(text).replace(/[\r\n\t ]+/g, ' ').trim();
}

function withOcrTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('OCR 识别超时')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function resetOcrWorker(expectedWorker) {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = null;
  const worker = expectedWorker || ocrWorker;
  if (!expectedWorker || ocrWorker === expectedWorker) {
    ocrWorker = null;
    ocrWorkerPromise = null;
  }
  try { await worker?.terminate(); } catch (_) {}
}

function normalizeOcrText(text) {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getOcrWorker() {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = null;
  if (ocrWorkerPromise) return ocrWorkerPromise;
  const { createWorker, OEM, PSM } = Tesseract;
  ocrWorkerPromise = createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: new URL('worker.min.js', OCR_ROOT).href,
    // Chrome 扩展固定使用已校验的 SIMD LSTM 核心，避免旧版 Relaxed SIMD 截断文件的缓存与自动选择。
    corePath: OCR_CORE_URL,
    langPath: new URL('lang', OCR_ROOT).href,
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: true,
    logger: updateOcrProgress,
    errorHandler: (error) => {
      console.error('[Word Explainer PDF OCR]', formatOcrError(error, 'Tesseract Worker 返回了未知错误'));
    },
  }).then(async (worker) => {
    ocrWorker = worker;
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    return worker;
  }).catch((error) => {
    ocrWorkerPromise = null;
    ocrWorker = null;
    throw new Error(formatOcrError(error, '无法启动本地 OCR 引擎'));
  });
  return ocrWorkerPromise;
}

function scheduleOcrWorkerShutdown() {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = setTimeout(async () => {
    if (ocrBusy) {
      scheduleOcrWorkerShutdown();
      return;
    }
    const worker = ocrWorker;
    ocrWorker = null;
    ocrWorkerPromise = null;
    ocrIdleTimer = null;
    try { await worker?.terminate(); } catch (_) {}
  }, OCR_IDLE_TIMEOUT_MS);
}

function updateOcrProgress(message) {
  const percentage = Number.isFinite(message?.progress) ? Math.round(message.progress * 100) : 0;
  const labels = {
    'loading tesseract core': '正在加载本地 OCR 引擎',
    'initializing tesseract': '正在初始化 OCR 引擎',
    'loading language traineddata': '正在加载本地英文识别模型',
    'initializing api': '正在准备英文识别器',
    'recognizing text': '正在识别文字',
  };
  const label = labels[message?.status] || '正在进行本地 OCR';
  setStatus(`${label}${percentage ? ` ${percentage}%` : '…'}`, '', 0);
}

function formatOcrError(error, fallback) {
  const candidates = [
    typeof error === 'string' ? error : '',
    typeof error?.message === 'string' ? error.message : '',
    typeof error?.error?.message === 'string' ? error.error.message : '',
    typeof error?.reason === 'string' ? error.reason : '',
  ];
  const message = candidates.find((value) => value.trim())?.trim();
  if (message) return message.slice(0, 600);
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized.slice(0, 600);
  } catch (_) {}
  return fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

document.getElementById('open-file').addEventListener('click', () => fileInput.click());
document.getElementById('empty-open-file').addEventListener('click', () => fileInput.click());
document.getElementById('new-reader').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pdf/reader.html') });
});

vocabularyButton.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('vocabulary/index.html') });
});

fileInput.addEventListener('change', () => {
  const [file] = fileInput.files || [];
  if (file) readLocalFile(file);
  fileInput.value = '';
});

urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (url) openPdfUrl(url);
});

document.getElementById('previous-page').addEventListener('click', () => scrollToPage(currentPage - 1));
document.getElementById('next-page').addEventListener('click', () => scrollToPage(currentPage + 1));
document.getElementById('zoom-out').addEventListener('click', () => setScale(currentScale / 1.15));
document.getElementById('zoom-in').addEventListener('click', () => setScale(currentScale * 1.15));
document.getElementById('fit-width').addEventListener('click', () => setScale(calculateFitScale(), true));
document.getElementById('collapse-toolbar').addEventListener('click', () => setToolbarCollapsed(true));
revealToolbarButton.addEventListener('click', () => setToolbarCollapsed(false));
ocrButton.addEventListener('click', () => setOcrMode(!ocrMode));
viewer.addEventListener('pointerdown', startOcrSelection, { capture: true });

zoomInput.addEventListener('change', applyZoomInput);
zoomInput.addEventListener('blur', applyZoomInput);
zoomInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    applyZoomInput();
    zoomInput.blur();
  }
});

pageInput.addEventListener('change', () => scrollToPage(pageInput.value));
pageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    scrollToPage(pageInput.value);
    pageInput.blur();
  }
});

viewerContainer.addEventListener('wheel', (event) => {
  if (!pdfDocument || (!event.ctrlKey && !event.metaKey)) return;
  event.preventDefault();
  pendingWheelScale ??= currentScale;
  pendingWheelScale *= event.deltaY < 0 ? 1.08 : 1 / 1.08;
  pendingWheelAnchor = { clientX: event.clientX, clientY: event.clientY };
  clearTimeout(zoomWheelTimer);
  zoomWheelTimer = setTimeout(() => {
    const nextScale = pendingWheelScale;
    const anchor = pendingWheelAnchor;
    pendingWheelScale = null;
    pendingWheelAnchor = null;
    setScale(nextScale, false, anchor);
  }, 90);
}, { passive: false });

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (ocrMode || ocrSelectionState)) {
    event.preventDefault();
    cancelOcrSelection();
    setOcrMode(false);
    return;
  }
  if (!pdfDocument || event.target.matches('input, textarea')) return;
  if ((event.ctrlKey || event.metaKey) && ['+', '=', '-'].includes(event.key)) {
    event.preventDefault();
    setScale(event.key === '-' ? currentScale / 1.15 : currentScale * 1.15);
  }
});

window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  dropOverlay.hidden = false;
});

window.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const [file] = event.dataTransfer?.files || [];
  if (file) readLocalFile(file);
});

window.addEventListener('resize', () => {
  if (!pdfDocument) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (fitToWidth) setScale(calculateFitScale(), true);
  }, 180);
});

window.addEventListener('pagehide', () => {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = null;
  const worker = ocrWorker;
  ocrWorker = null;
  ocrWorkerPromise = null;
  try { worker?.terminate(); } catch (_) {}
});

chrome.storage.local.get({ pdfToolbarCollapsed: false }, ({ pdfToolbarCollapsed }) => {
  setToolbarCollapsed(!!pdfToolbarCollapsed, false);
});

setControlsEnabled(false);
updateNavigationButtons();

function initializeReader() {
  const params = new URL(location.href).searchParams;
  const initialUrl = params.get('url');
  if (initialUrl) {
    const source = params.get('source') === 'windows' ? 'windows' : 'online';
    const name = params.get('name') || '';
    if (source !== 'windows') urlInput.value = initialUrl;
    openPdfUrl(initialUrl, name, source);
  }
}

initializeReader();
