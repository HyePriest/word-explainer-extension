import Tesseract from '../pdf/vendor/ocr/tesseract.esm.min.js';
import '../ocr-layout.js';

const { inspectCanvasTextLayout } = globalThis.WordExplainerOcrLayout;

const OCR_ROOT = new URL('../pdf/vendor/ocr/', import.meta.url).href;
const OCR_CORE_URL = new URL('core/tesseract-core-simd-lstm.wasm.js', OCR_ROOT).href;
const OCR_IDLE_TIMEOUT_MS = 180_000;
const OCR_RECOGNITION_TIMEOUT_MS = 60_000;
let ocrWorkerPromise = null;
let ocrWorker = null;
let ocrIdleTimer = null;
let recognitionQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'ocr-offscreen' || message?.type !== 'OCR_OFFSCREEN_RECOGNIZE') return;
  const run = recognitionQueue.then(() => recognizeImage(message.imageDataUrl));
  recognitionQueue = run.catch(() => {});
  run.then((text) => sendResponse({ ok: true, text }))
    .catch((error) => sendResponse({
      ok: false,
      error: formatOcrError(error, '本地 OCR 识别失败'),
    }));
  return true;
});

async function recognizeImage(imageDataUrl) {
  clearTimeout(ocrIdleTimer);
  const image = await loadImage(imageDataUrl);
  imageDataUrl = '';
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  image.src = '';

  try {
    const result = await recognizeWithRecovery(canvas);
    return normalizeOcrText(result?.data?.text || '');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    scheduleWorkerShutdown();
  }
}

async function recognizeWithRecovery(canvas) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let worker;
    try {
      worker = await getOcrWorker();
      const { PSM } = Tesseract;
      return await withTimeout(
        recognizeCanvasByLayout(worker, canvas, PSM),
        OCR_RECOGNITION_TIMEOUT_MS
      );
    } catch (error) {
      lastError = error;
      await resetOcrWorker(worker);
    }
  }
  throw lastError || new Error('OCR 识别失败');
}

async function recognizeCanvasByLayout(worker, canvas, PSM) {
  const layout = inspectCanvasTextLayout(canvas, PSM);
  if (layout.lineRegions.length >= 2) {
    const lineTexts = [];
    for (const region of layout.lineRegions) {
      const lineCanvas = createLineCanvas(canvas, region);
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
        const result = await worker.recognize(lineCanvas);
        lineTexts.push(normalizeOcrLine(result?.data?.text || ''));
      } finally {
        lineCanvas.width = 0;
        lineCanvas.height = 0;
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

function createLineCanvas(sourceCanvas, region) {
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

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('OCR 识别超时，已自动重试')), timeoutMs);
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

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      reject(new Error('OCR 图片格式无效'));
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取 OCR 图片'));
    image.src = dataUrl;
  });
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
    errorHandler: (error) => {
      console.error('[Word Explainer OCR]', formatOcrError(error, 'Tesseract Worker 返回了未知错误'));
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

function scheduleWorkerShutdown() {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = setTimeout(async () => {
    const worker = ocrWorker;
    ocrWorker = null;
    ocrWorkerPromise = null;
    ocrIdleTimer = null;
    try { await worker?.terminate(); } catch (_) {}
    chrome.runtime.sendMessage({ type: 'OCR_OFFSCREEN_IDLE' }).catch(() => {});
  }, OCR_IDLE_TIMEOUT_MS);
}

function normalizeOcrText(text) {
  return String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
