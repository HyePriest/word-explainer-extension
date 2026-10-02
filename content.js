// ============================================================
//  content.js — 划词解释 · 悬浮气泡 UI
//  负责：检测划选 → 渲染 Popover → 实时 Markdown 渲染 → 关闭交互
// ============================================================

(function () {
  'use strict';

  const { calculatePopoverPlacement, calculateTriggerOrigin, rectanglesOverlap } = WordExplainerPositioning;
  const { normalizeExplanationMarkdown, classifyInput, parseMarkdown } = WordExplainerOutputFormatting;
  const { isPageOcrShortcut } = WordExplainerShortcuts;

  const CONTENT_BUILD = '2.5.10';
  const previousUiHost = document.getElementById('we-extension-root');
  if (previousUiHost?.dataset.weContentBuild === CONTENT_BUILD && previousUiHost.shadowRoot) return;
  previousUiHost?.remove();

  // ---- 全局状态 ----
  let currentPopover = null;
  let currentPort = null;
  let triggerBtns = [];
  let pendingText = null;
  let pendingRect = null;
  let pendingRange = null;
  let pendingVocabularyPayload = null;
  let pendingAnchorRatio = { x: 0.5, y: 0.5 };
  let extensionEnabled = false;
  let outsideClickListener = null; // 统一管理外部点击监听器
  let outsideClickTimer = null;
  let panelPinned = false;
  let panelPosition = null;
  let panelSize = null;
  let inertiaFrame = null;
  let uiHost = null;
  let uiRoot = null;
  let currentUtterance = null;
  let quickSaveEnabled = false;
  let pageOcrSession = null;
  let pageOcrShortcutPending = false;
  let pageOcrStatusEl = null;
  let resultSelectionMenu = null;
  let selectionTimer = null;
  let selectionRevision = 0;
  let resolveSettingsReady;
  const settingsReady = new Promise((resolve) => { resolveSettingsReady = resolve; });
  const MAX_INPUT_CHARACTERS = 20_000;
  const MAX_PAGE_OCR_PIXELS = 6_000_000;

  // 将插件 UI 放进独立 Shadow DOM，避免网页样式、body 定位和变换干扰。
  function createUiRoot() {
    const existingHost = document.getElementById('we-extension-root');
    if (existingHost?.shadowRoot) {
      uiHost = existingHost;
      uiRoot = existingHost.shadowRoot;
      return;
    }

    uiHost = document.createElement('div');
    uiHost.id = 'we-extension-root';
    uiHost.dataset.weContentBuild = CONTENT_BUILD;
    uiHost.style.cssText = [
      'all:initial!important',
      'position:absolute!important',
      'inset:0 auto auto 0!important',
      'width:0!important',
      'height:0!important',
      'z-index:2147483647!important',
      'pointer-events:none!important',
    ].join(';');

    uiRoot = uiHost.attachShadow({ mode: 'open' });
    const stylesheetUrl = chrome.runtime.getURL('popover.css');
    fetch(stylesheetUrl)
      .then((response) => {
        if (!response.ok) throw new Error('无法载入插件样式');
        return response.text();
      })
      .then((cssText) => {
        const stylesheet = new CSSStyleSheet();
        stylesheet.replaceSync(cssText);
        uiRoot.adoptedStyleSheets = [stylesheet];
      })
      .catch(() => {
        // 兼容不支持 constructable stylesheet 的旧版浏览器。
        const fallbackLink = document.createElement('link');
        fallbackLink.rel = 'stylesheet';
        fallbackLink.href = stylesheetUrl;
        uiRoot.appendChild(fallbackLink);
      });
    document.documentElement.appendChild(uiHost);
  }

  createUiRoot();
  WordExplainerTheme.subscribe(({ resolved }) => {
    uiHost.dataset.weTheme = resolved;
    // The host resets inherited page styles with !important.
    uiHost.style.setProperty('color-scheme', resolved, 'important');
  });

  // 初始化时读取状态
  chrome.storage.local.get(
    ['enabled', 'panelPinned', 'panelPosition', 'panelSize', 'panelMode', 'showQuickSave'],
    ({ enabled, panelPinned: storedPinned, panelPosition: storedPosition, panelSize: storedSize, panelMode: legacyMode, showQuickSave }) => {
      extensionEnabled = !!enabled;
      quickSaveEnabled = !!showQuickSave;
      panelPinned = typeof storedPinned === 'boolean'
        ? storedPinned
        : legacyMode === 'pinned-left' || legacyMode === 'pinned-right';
      panelPosition = isValidPoint(storedPosition) ? storedPosition : null;
      panelSize = isValidPanelSize(storedSize) ? storedSize : null;
      resolveSettingsReady();
    }
  );

  function isValidPoint(value) {
    return value && Number.isFinite(value.left) && Number.isFinite(value.top);
  }

  function isValidPanelSize(value) {
    return value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0;
  }

  // 实时响应开关变化
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.enabled) {
      extensionEnabled = !!changes.enabled.newValue;
      if (!extensionEnabled) {
        dismissPopover();
        dismissTrigger();
        cancelPageOcr();
      }
    }

    let panelStateChanged = false;
    if (changes.panelPinned && typeof changes.panelPinned.newValue === 'boolean') {
      panelPinned = changes.panelPinned.newValue;
      panelStateChanged = true;
    }
    if (changes.panelPosition) {
      panelPosition = isValidPoint(changes.panelPosition.newValue)
        ? changes.panelPosition.newValue
        : null;
      panelStateChanged = true;
    }
    if (changes.panelSize) {
      panelSize = isValidPanelSize(changes.panelSize.newValue)
        ? changes.panelSize.newValue
        : null;
      if (currentPopover) applyStoredPanelSize(currentPopover);
    }
    if (changes.showQuickSave) quickSaveEnabled = !!changes.showQuickSave.newValue;
    if (panelStateChanged && currentPopover) applyPanelState(currentPopover);
  });

  // ---- 事件：检测鼠标划选 ----
  // 使用捕获阶段，避免 B 站评论区等网页拦截 mouseup 后插件收不到事件。
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', cancelPendingSelection, true);

  function cancelPendingSelection() {
    selectionRevision += 1;
    clearTimeout(selectionTimer);
  }

  function onMouseUp(e) {
    cancelPendingSelection();
    const revision = selectionRevision;
    if (e.button !== 0 || !uiHost.isConnected) return;
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    const eventPath = e.composedPath();

    // 情况 1：点击在触发按钮上 → 由按钮自身的 click 处理，这里直接返回
    if (triggerBtns.some((btn) => eventPath.includes(btn))) {
      return;
    }

    // 翻译框内选词后的操作菜单独立于网页划词按钮，点击时不要关闭翻译框。
    if (resultSelectionMenu && eventPath.includes(resultSelectionMenu)) {
      return;
    }

    // 情况 2：点击在解释气泡内部 → 允许用户自由划选/复制
    if (currentPopover && eventPath.includes(currentPopover)) {
      return;
    }

    // 情况 3：点击在气泡/触发按钮外部 → 关闭它们
    if (currentPopover || triggerBtns.length > 0) {
      if (!panelPinned) dismissPopover();
      dismissTrigger();
      dismissResultSelectionMenu();
    }

    // 情况 4：检测划选，展示触发按钮
    // 播放器双击及控件点击不能拿旧选区或附近文字当作新划词。
    if (eventPath.some((node) => node instanceof Element && node.matches(
      'video, audio, button, [role="button"], .bpx-player-container, .bilibili-player-video-wrap, .html5-video-player'
    ))) return;

    selectionTimer = setTimeout(async () => {
      await settingsReady;
      if (!extensionEnabled || revision !== selectionRevision || !uiHost.isConnected) return;

      const selected = readSelection(eventPath, { x: mouseX, y: mouseY }, e.detail >= 2);
      if (!selected) return;

      const { text, range, rect, context } = selected;
      if (text.length === 0 || text.length > MAX_INPUT_CHARACTERS) return;
      if (isPrimarilyChineseText(text)) return;

      if (range && currentPopover && currentPopover.contains(range.commonAncestorContainer)) return;

      pendingText = text;
      pendingRect = rect;
      pendingRange = range?.cloneRange() || null;
      pendingVocabularyPayload = buildVocabularyPayload(text, range, context ? { context } : {});
      pendingAnchorRatio = {
        x: rect.width > 0 ? Math.min(1, Math.max(0, (mouseX - rect.left) / rect.width)) : 0.5,
        y: rect.height > 0 ? Math.min(1, Math.max(0, (mouseY - rect.top) / rect.height)) : 0.5,
      };
      showTriggerButton(rect, mouseX, mouseY);
    }, 45);
  }

  function readSelection(eventPath = [], fallbackPoint = null, allowWordFallback = false) {
    const control = eventPath.find((node) => isSelectableTextControl(node))
      || (eventPath.length === 0 && isSelectableTextControl(document.activeElement) ? document.activeElement : null);
    if (control) {
      const start = control.selectionStart;
      const end = control.selectionEnd;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return null;
      const text = control.value.slice(Math.min(start, end), Math.max(start, end)).trim();
      if (!text) return null;
      return {
        text,
        range: null,
        rect: fallbackPoint ? makeSelectionFallbackRect(fallbackPoint.x, fallbackPoint.y) : control.getBoundingClientRect(),
        context: String(control.value || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      };
    }

    const { roots, shadowRoots } = collectSelectionRoots(eventPath);
    const seenSelections = new Set();
    const candidates = [];

    for (const root of roots) {
      let selection = null;
      try {
        selection = root === document ? window.getSelection() : root.getSelection?.();
      } catch (_) {}
      if (!selection || seenSelections.has(selection)) continue;
      seenSelections.add(selection);

      const text = String(selection).trim();
      if (!text) continue;
      const detectedRange = getSelectionRange(selection, shadowRoots);
      const rangeMatchesText = selectionTextsMatch(detectedRange, text);
      const range = rangeMatchesText ? detectedRange : null;
      const rawRect = range?.getBoundingClientRect?.();
      const rect = isUsableRect(rawRect)
        ? rawRect
        : fallbackPoint
          ? makeSelectionFallbackRect(fallbackPoint.x, fallbackPoint.y)
          : null;
      if (!rect) continue;
      candidates.push({
        text,
        range,
        rect,
        context: getRangeContext(range),
      });
    }

    if (candidates.length === 0 && allowWordFallback && fallbackPoint) {
      return readWordAtPoint(fallbackPoint, shadowRoots);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.text.length - a.text.length);
    return candidates[0];
  }

  function selectionTextsMatch(range, selectedText) {
    if (!range) return false;
    try {
      const normalize = (value) => String(value).replace(/\s+/g, ' ').trim();
      return normalize(range.toString()) === normalize(selectedText);
    } catch (_) {
      return false;
    }
  }

  function readWordAtPoint(point, shadowRoots) {
    let node = null;
    let offset = 0;
    try {
      const caret = document.caretPositionFromPoint?.(point.x, point.y, { shadowRoots });
      node = caret?.offsetNode || null;
      offset = caret?.offset || 0;
    } catch (_) {}
    if (!node) {
      try {
        const caretRange = document.caretRangeFromPoint?.(point.x, point.y);
        node = caretRange?.startContainer || null;
        offset = caretRange?.startOffset || 0;
      } catch (_) {}
    }
    if (node?.nodeType !== Node.TEXT_NODE) return null;

    const value = String(node.nodeValue || '');
    const words = value.matchAll(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu);
    for (const match of words) {
      const start = match.index;
      const end = start + match[0].length;
      if (offset < start || offset > end) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const rawRect = range.getBoundingClientRect();
      // 光标 API 在视频、空白区也可能返回最近的文本节点，必须命中实际字符。
      const hitWord = Array.from(range.getClientRects()).some((rect) => (
        point.x >= rect.left - 2 && point.x <= rect.right + 2
        && point.y >= rect.top - 2 && point.y <= rect.bottom + 2
      ));
      if (!hitWord) return null;
      return {
        text: match[0],
        range,
        rect: isUsableRect(rawRect) ? rawRect : makeSelectionFallbackRect(point.x, point.y),
        context: String(node.parentElement?.textContent || value).replace(/\s+/g, ' ').trim().slice(0, 500),
      };
    }
    return null;
  }

  function collectSelectionRoots(eventPath) {
    const roots = [document];
    const shadowRoots = [];
    const addRoot = (root) => {
      if (!root || roots.includes(root)) return;
      if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
        roots.unshift(root);
        shadowRoots.push(root);
      }
    };

    for (const node of eventPath) {
      try { addRoot(node?.getRootNode?.()); } catch (_) {}
    }

    let active = document.activeElement;
    while (active?.shadowRoot) {
      addRoot(active.shadowRoot);
      active = active.shadowRoot.activeElement;
    }
    return { roots, shadowRoots };
  }

  function getSelectionRange(selection, shadowRoots) {
    if (typeof selection.getComposedRanges === 'function') {
      try {
        const [staticRange] = selection.getComposedRanges({ shadowRoots });
        if (staticRange) {
          const range = document.createRange();
          range.setStart(staticRange.startContainer, staticRange.startOffset);
          range.setEnd(staticRange.endContainer, staticRange.endOffset);
          return range;
        }
      } catch (_) {}
    }
    try {
      if (selection.rangeCount > 0) return selection.getRangeAt(0).cloneRange();
    } catch (_) {}
    return null;
  }

  function getRangeContext(range) {
    if (!range) return '';
    try {
      const container = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentElement
        : range.commonAncestorContainer;
      return String(container?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    } catch (_) {
      return '';
    }
  }

  function isUsableRect(rect) {
    return !!rect
      && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
      && (rect.width > 0 || rect.height > 0);
  }

  function makePointRect(x, y) {
    const left = Number.isFinite(x) ? x : window.innerWidth / 2;
    const top = Number.isFinite(y) ? y : window.innerHeight / 2;
    return { left, right: left, top, bottom: top, width: 0, height: 0 };
  }

  // 某些 Shadow DOM 页面只能读到选中文字和鼠标落点，拿不到 Range 矩形。
  // 为落点保留一整行文字的安全区，避免弹窗紧贴鼠标后遮住正在翻译的句子。
  function makeSelectionFallbackRect(x, y) {
    const point = makePointRect(x, y);
    const lineSafety = 20;
    const top = Math.max(0, point.top - lineSafety);
    const bottom = Math.min(window.innerHeight, point.bottom + lineSafety);
    return {
      left: point.left,
      right: point.right,
      top,
      bottom,
      width: 0,
      height: Math.max(0, bottom - top),
      preferVertical: true,
    };
  }

  function isSelectableTextControl(node) {
    if (node instanceof HTMLTextAreaElement) return !node.disabled;
    if (!(node instanceof HTMLInputElement) || node.disabled) return false;
    return ['text', 'search', 'url', 'tel', 'email'].includes((node.type || 'text').toLowerCase());
  }

  // 中文正文通常不需要翻译；日语、韩语及其他文字应允许触发。
  function isPrimarilyChineseText(text) {
    const normalized = text.normalize('NFKC');
    const hanCount = (normalized.match(/\p{Script=Han}/gu) || []).length;
    const kanaCount = (normalized.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
    const hangulCount = (normalized.match(/\p{Script=Hangul}/gu) || []).length;
    const languageCharCount = (normalized.match(/\p{L}/gu) || []).length;

    // 纯数字、符号或空白没有需要解释的语言内容。
    if (languageCharCount === 0) return true;
    if (kanaCount > 0 || hangulCount > 0) return false;
    if (hanCount === languageCharCount) {
      const pageLanguage = String(document.documentElement.lang || '').toLowerCase();
      return !pageLanguage.startsWith('ja') && !pageLanguage.startsWith('ko');
    }

    return hanCount / languageCharCount >= 0.6;
  }

  // 长文本判断：超过 8 个词视为长句/段落，只显示中文按钮
  function isLongText(text) {
    return classifyInput(text) === 'PASSAGE';
  }

  // ESC 键关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancelPendingSelection();
      if (pageOcrSession) cancelPageOcr();
      if (currentPopover) dismissPopover();
      if (triggerBtns.length > 0) dismissTrigger();
    }
  });

  window.addEventListener('keydown', (event) => {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    if (!isPageOcrShortcut(event, platform)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pageOcrShortcutPending || pageOcrSession) return;
    pageOcrShortcutPending = true;
    settingsReady.then(async () => {
      try {
        if (!extensionEnabled) throw new Error('请先开启划词解释');
        const response = await chrome.runtime.sendMessage({ type: 'PAGE_OCR_SHORTCUT_TRIGGER' });
        if (!response?.ok) throw new Error(response?.error || '无法启动区域 OCR');
      } catch (error) {
        showPageOcrStatus(error?.message || '无法启动区域 OCR', 'error', 6000);
      } finally {
        pageOcrShortcutPending = false;
      }
    });
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.targetUrl && message.targetUrl !== location.href) return;
    if (message?.type === 'TRANSLATE_SELECTION') {
      const ok = translateCurrentSelection();
      sendResponse?.({ ok, message: ok ? '' : '当前页面没有可翻译的选中文字' });
      return;
    }
    if (message?.type === 'START_PAGE_OCR_V3' || message?.type === 'START_PAGE_OCR_V2') {
      settingsReady.then(() => {
        const result = startPageOcr(message.imageDataUrl);
        sendResponse?.({ ...result, ocrProtocol: 3 });
      });
      return true;
    }
  });

  function translateCurrentSelection() {
    if (!extensionEnabled) return false;
    const selected = readSelection([]);
    const text = selected?.text || '';
    if (!text || text.length > MAX_INPUT_CHARACTERS || isPrimarilyChineseText(text)) return false;
    const range = selected.range;
    const rect = selected.rect || {
      left: window.innerWidth / 2,
      right: window.innerWidth / 2,
      top: window.innerHeight / 2,
      bottom: window.innerHeight / 2,
      width: 0,
      height: 0,
    };
    dismissTrigger();
    showPopover(text, rect, 'ZH', buildVocabularyPayload(text, range, selected.context ? { context: selected.context } : {}), range);
    return true;
  }

  // ============================================================
  //  网页区域 OCR：框选可见区域 → 截图裁剪 → 后台本地识别
  // ============================================================

  function startPageOcr(imageDataUrl) {
    if (!extensionEnabled) return { ok: false, message: '请先开启划词解释' };
    cancelPageOcr();
    dismissPopoverSilent();
    dismissTrigger();

    const frozenScreenshot = typeof imageDataUrl === 'string' && imageDataUrl.startsWith('data:image/')
      ? imageDataUrl
      : '';
    const overlay = document.createElement('div');
    overlay.className = 'we-page-ocr-overlay';
    overlay.innerHTML = `
      <div class="we-page-ocr-help">
        <strong>区域 OCR</strong>
        <span>${frozenScreenshot ? '画面已冻结；拖动框选需要识别的英文文字，按 Esc 取消' : '拖动框选需要识别的英文文字，按 Esc 取消'}</span>
      </div>
      <div class="we-page-ocr-selection" hidden><span></span></div>
    `;
    if (frozenScreenshot) {
      overlay.classList.add('we-frozen');
      overlay.style.backgroundImage = `linear-gradient(rgba(15, 23, 42, 0.22), rgba(15, 23, 42, 0.22)), url("${frozenScreenshot}")`;
    }
    const session = {
      overlay,
      selection: overlay.querySelector('.we-page-ocr-selection'),
      helpText: overlay.querySelector('.we-page-ocr-help span'),
      active: true,
      phase: 'ready',
      pointerId: null,
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
      screenshotDataUrl: frozenScreenshot,
    };
    pageOcrSession = session;
    overlay.addEventListener('pointerdown', beginPageOcrDrag);
    overlay.addEventListener('pointermove', updatePageOcrDrag);
    overlay.addEventListener('pointerup', finishPageOcrDrag);
    overlay.addEventListener('pointercancel', finishPageOcrDrag);
    overlay.addEventListener('contextmenu', (event) => event.preventDefault());
    overlay.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
    uiRoot.appendChild(overlay);
    return { ok: true };
  }

  function beginPageOcrDrag(event) {
    const session = pageOcrSession;
    if (!session?.active || session.phase !== 'ready' || event.button !== 0) return;
    event.preventDefault();
    session.phase = 'dragging';
    session.pointerId = event.pointerId;
    session.startX = clampNumber(event.clientX, 0, window.innerWidth);
    session.startY = clampNumber(event.clientY, 0, window.innerHeight);
    session.currentX = session.startX;
    session.currentY = session.startY;
    session.selection.hidden = false;
    session.overlay.classList.add('we-selecting');
    try { session.overlay.setPointerCapture(event.pointerId); } catch (_) {}
    renderPageOcrSelection(session);
  }

  function updatePageOcrDrag(event) {
    const session = pageOcrSession;
    if (!session?.active || session.phase !== 'dragging' || event.pointerId !== session.pointerId) return;
    event.preventDefault();
    session.currentX = clampNumber(event.clientX, 0, window.innerWidth);
    session.currentY = clampNumber(event.clientY, 0, window.innerHeight);
    renderPageOcrSelection(session);
  }

  function finishPageOcrDrag(event) {
    const session = pageOcrSession;
    if (!session?.active || session.phase !== 'dragging' || event.pointerId !== session.pointerId) return;
    event.preventDefault();
    updatePageOcrDrag(event);
    try { session.overlay.releasePointerCapture(event.pointerId); } catch (_) {}
    const region = getPageOcrRegion(session);
    if (region.width < 12 || region.height < 12) {
      session.phase = 'ready';
      session.pointerId = null;
      session.selection.hidden = true;
      session.overlay.classList.remove('we-selecting');
      session.helpText.textContent = '框选区域太小，请重新拖动；按 Esc 取消';
      return;
    }
    session.phase = 'processing';
    recognizePageOcrRegion(session, region).catch((error) => {
      if (!session.active) return;
      session.active = false;
      if (pageOcrSession === session) pageOcrSession = null;
      showPageOcrStatus(error?.message || '区域 OCR 失败', 'error', 6000);
    });
  }

  function renderPageOcrSelection(session) {
    const region = getPageOcrRegion(session);
    Object.assign(session.selection.style, {
      left: `${region.left}px`,
      top: `${region.top}px`,
      width: `${region.width}px`,
      height: `${region.height}px`,
    });
    const sizeLabel = session.selection.querySelector('span');
    if (sizeLabel) sizeLabel.textContent = `${Math.round(region.width)} × ${Math.round(region.height)}`;
  }

  function getPageOcrRegion(session) {
    const left = Math.min(session.startX, session.currentX);
    const top = Math.min(session.startY, session.currentY);
    return {
      left,
      top,
      right: Math.max(session.startX, session.currentX),
      bottom: Math.max(session.startY, session.currentY),
      width: Math.abs(session.currentX - session.startX),
      height: Math.abs(session.currentY - session.startY),
    };
  }

  async function recognizePageOcrRegion(session, region) {
    session.overlay.remove();
    session.overlay = null;
    if (!session.active || pageOcrSession !== session) return;

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    let screenshotDataUrl = session.screenshotDataUrl;
    session.screenshotDataUrl = '';
    if (!screenshotDataUrl) {
      await waitForNextPaint();
      const captureResponse = await chrome.runtime.sendMessage({ type: 'PAGE_OCR_CAPTURE' });
      if (!captureResponse?.ok) {
        throw new Error(captureResponse?.error || '无法截取当前页面');
      }
      screenshotDataUrl = captureResponse.result?.imageDataUrl || '';
      if (!screenshotDataUrl.startsWith('data:image/')) {
        throw new Error('浏览器没有返回页面截图');
      }
    }
    showPageOcrStatus('正在准备本地英文 OCR…');
    let croppedImage = await cropPageOcrImage(screenshotDataUrl, region, viewport);
    screenshotDataUrl = '';
    if (!session.active || pageOcrSession !== session) return;
    showPageOcrStatus('正在识别英文文字…');
    const recognitionPromise = chrome.runtime.sendMessage({
      type: 'PAGE_OCR_RECOGNIZE',
      imageDataUrl: croppedImage,
    });
    croppedImage = '';
    const response = await recognitionPromise;
    if (!response?.ok) throw new Error(response?.error || '本地 OCR 识别失败');
    if (!session.active || pageOcrSession !== session) return;

    const text = normalizePageOcrText(response.result?.text || '');
    if (!text) throw new Error('这个区域没有识别到英文文字，请框得更紧或放大页面后重试');
    session.active = false;
    pageOcrSession = null;
    clearPageOcrStatus();
    const source = buildPageOcrSource();
    showPopover(text, region, 'ZH', buildVocabularyPayload(text, null, {
      context: text,
      source,
      kind: 'ocr',
    }));
  }

  function waitForNextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function loadCapturedImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('无法读取页面截图'));
      image.src = dataUrl;
    });
  }

  async function cropPageOcrImage(dataUrl, region, viewport) {
    const image = await loadCapturedImage(dataUrl);
    const scaleX = image.naturalWidth / Math.max(1, viewport.width);
    const scaleY = image.naturalHeight / Math.max(1, viewport.height);
    const sourceX = Math.max(0, Math.floor(region.left * scaleX));
    const sourceY = Math.max(0, Math.floor(region.top * scaleY));
    const sourceWidth = Math.max(1, Math.min(image.naturalWidth - sourceX, Math.ceil(region.width * scaleX)));
    const sourceHeight = Math.max(1, Math.min(image.naturalHeight - sourceY, Math.ceil(region.height * scaleY)));
    const desiredBoost = sourceWidth < 1200 ? Math.min(2, 1200 / sourceWidth) : 1;
    const maxDimensionFactor = 3200 / Math.max(sourceWidth, sourceHeight);
    const maxPixelFactor = Math.sqrt(MAX_PAGE_OCR_PIXELS / (sourceWidth * sourceHeight));
    const outputFactor = Math.max(0.25, Math.min(desiredBoost, maxDimensionFactor, maxPixelFactor));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * outputFactor));
    canvas.height = Math.max(1, Math.round(sourceHeight * outputFactor));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );
    const cropped = canvas.toDataURL('image/png');
    canvas.width = 0;
    canvas.height = 0;
    image.src = '';
    return cropped;
  }

  function normalizePageOcrText(text) {
    return String(text)
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.replace(/[\t ]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function buildPageOcrSource() {
    const internalPage = location.protocol === 'chrome-extension:';
    const title = document.getElementById('document-title')?.textContent?.trim()
      || document.title
      || location.hostname
      || '页面截图';
    const url = internalPage ? '' : location.href.split('#')[0];
    return {
      kind: 'ocr',
      title,
      url,
      documentId: document.body.dataset.pdfFingerprint || url || title,
      page: null,
    };
  }

  function showPageOcrStatus(message, type = '', duration = 0) {
    clearPageOcrStatus();
    const status = document.createElement('div');
    status.className = `we-page-ocr-status${type ? ` we-${type}` : ''}`;
    status.textContent = message;
    uiRoot.appendChild(status);
    pageOcrStatusEl = status;
    if (duration > 0) {
      setTimeout(() => {
        if (pageOcrStatusEl === status) clearPageOcrStatus();
      }, duration);
    }
  }

  function clearPageOcrStatus() {
    pageOcrStatusEl?.remove();
    pageOcrStatusEl = null;
  }

  function cancelPageOcr() {
    if (pageOcrSession) {
      pageOcrSession.active = false;
      pageOcrSession.screenshotDataUrl = '';
      pageOcrSession.overlay?.remove();
      pageOcrSession = null;
    }
    clearPageOcrStatus();
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // 窗口缩放时关闭
  window.addEventListener('resize', () => {
    if (currentPopover && panelPinned) {
      applyStoredPanelSize(currentPopover);
      clampPinnedPopover(currentPopover, true);
    } else if (currentPopover) {
      dismissPopover();
    }
    if (triggerBtns.length > 0) dismissTrigger();
  });

  // ============================================================
  //  图标 SVG 定义
  // ============================================================

  // 中文按钮：对话气泡 + 两条横线，象征"文字释义"
  const ICON_ZH = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18">
    <path d="M6 4h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-4 3v-3H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
      stroke="white" stroke-width="1.6" stroke-linejoin="round"/>
    <line x1="8" y1="9" x2="16" y2="9" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="8" y1="13" x2="13" y2="13" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`;

  // 英文按钮：开卷书本，象征"查阅原文释义"
  const ICON_EN = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="18" height="18">
    <path d="M4 5.5C4 5.5 8 4 12 5.5V19C8 17.5 4 19 4 19V5.5Z"
      stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M20 5.5C20 5.5 16 4 12 5.5V19C16 17.5 20 19 20 19V5.5Z"
      stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="7" y1="9" x2="10" y2="8.5" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="7" y1="12" x2="10" y2="11.5" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="14" y1="8.5" x2="17" y2="9" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="14" y1="11.5" x2="17" y2="12" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;

  const ICON_SAVE = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="17" height="17">
    <path d="M12 3.8l2.45 4.96 5.48.8-3.97 3.86.94 5.46L12 16.3l-4.9 2.58.94-5.46-3.97-3.86 5.48-.8L12 3.8z"
      stroke="white" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`;

  // ============================================================
  //  触发按钮
  // ============================================================

  function showTriggerButton(rect, mouseX, mouseY) {
    // 触发按钮属于页面内容坐标系。这样页面滚动时它会跟着原文自然移动，
    // 而不是固定在视口中或在第一次 scroll 事件时被销毁。
    const longText = isLongText(pendingText || '');
    const supportsEnglishExplanation = isLatinBasedText(pendingText || '');
    const triggerDy = chooseTriggerVerticalOffset(mouseX, mouseY);

    // 长文本：只显示中文按钮，居中出现在鼠标正上方
    // 短文本：两个按钮，向左上/右上分裂
    const configs = longText || !supportsEnglishExplanation
      ? [
          { icon: ICON_ZH, classes: 'we-trigger we-trigger-zh', mode: 'ZH', title: '中文解释', dx: 0, dy: triggerDy, solo: true },
        ]
      : [
          { icon: ICON_ZH, classes: 'we-trigger we-trigger-zh', mode: 'ZH', title: '中文释义', dx: -44, dy: triggerDy },
          { icon: ICON_EN, classes: 'we-trigger we-trigger-en', mode: 'EN', title: '英英释义', dx:  44, dy: triggerDy },
        ];

    if (!longText && supportsEnglishExplanation && quickSaveEnabled && classifyInput(pendingText || '') === 'WORD') {
      configs[0].dx = -50;
      configs[1].dx = 50;
      configs.push({
        icon: ICON_SAVE,
        classes: 'we-trigger we-trigger-save',
        action: 'save',
        title: '直接加入生词本',
        dx: 0,
        dy: triggerDy,
      });
    }

    const viewport = window.visualViewport;
    const offsetLeft = viewport?.offsetLeft || 0;
    const offsetTop = viewport?.offsetTop || 0;
    const origin = calculateTriggerOrigin({
      x: mouseX - offsetLeft, y: mouseY - offsetTop, offsets: configs,
      viewportWidth: viewport?.width || document.documentElement.clientWidth || window.innerWidth,
      viewportHeight: viewport?.height || window.innerHeight,
    });
    const originX = origin.x + offsetLeft + window.scrollX;
    const originY = origin.y + offsetTop + window.scrollY;

    configs.forEach((cfg) => {
      const btn = document.createElement('div');
      btn.className = cfg.classes;
      btn.innerHTML = `<button class="we-trigger-core" type="button" tabindex="-1">${cfg.icon}</button>`;
      btn.title = cfg.title;
      btn.dataset.mode = cfg.mode;

      // 起始位置：鼠标坐标
      btn.style.top = originY + 'px';
      btn.style.left = originX + 'px';

      // 终点偏移量，动画 & hover 都通过 CSS 变量引用
      btn.style.setProperty('--dx', cfg.dx + 'px');
      btn.style.setProperty('--dy', cfg.dy + 'px');
      btn.style.setProperty('--overshoot-x', cfg.dx * 1.08 + 'px');
      btn.style.setProperty('--overshoot-y', cfg.dy * 1.08 + 'px');

      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (cfg.action === 'save') {
          const payload = pendingVocabularyPayload;
          if (!payload) return;
          btn.classList.add('we-saving');
          try {
            await sendVocabularyMessage({ type: 'VOCAB_ADD', payload });
            btn.classList.remove('we-saving');
            btn.classList.add('we-saved');
            const core = btn.querySelector('.we-trigger-core');
            if (core) core.textContent = '✓';
            btn.title = '已加入生词本';
            setTimeout(dismissTrigger, 420);
          } catch (_) {
            btn.classList.remove('we-saving');
            btn.title = '保存失败，请刷新页面后重试';
          }
          return;
        }
        const mode = btn.dataset.mode;
        const text = pendingText;
        const r = getPendingRect() || pendingRect;
        const vocabularyPayload = pendingVocabularyPayload;
        const range = pendingRange?.cloneRange() || null;
        dismissTrigger();
        if (text && r) showPopover(text, r, mode, vocabularyPayload, range);
      });

      uiRoot.appendChild(btn);
      triggerBtns.push(btn);
    });

    // 外部点击关闭（延迟绑定，避免当前 mouseup 误触）
    outsideClickTimer = setTimeout(() => {
      outsideClickTimer = null;
      if (triggerBtns.length === 0) return;
      outsideClickListener = (e) => {
        const path = e.composedPath();
        const clickedOnBtn = triggerBtns.some((b) => path.includes(b));
        if (!clickedOnBtn) dismissTrigger();
      };
      document.addEventListener('mousedown', outsideClickListener, true);
    }, 100);
  }

  function isLatinBasedText(text) {
    const letters = String(text).match(/\p{L}/gu) || [];
    return letters.length > 0 && letters.every((letter) => /\p{Script=Latin}/u.test(letter));
  }

  function chooseTriggerVerticalOffset(mouseX, mouseY) {
    const aboveY = mouseY - 50;
    const belowY = mouseY + 50;
    if (aboveY < 24) return 50;
    if (belowY > window.innerHeight - 24) return -50;

    const likelyOverlayAbove = document.elementsFromPoint(mouseX, aboveY).some((element) => {
      if (!(element instanceof Element) || element === document.documentElement || element === document.body) return false;
      const style = getComputedStyle(element);
      const zIndex = Number.parseInt(style.zIndex, 10);
      return ['fixed', 'sticky', 'absolute'].includes(style.position) && Number.isFinite(zIndex) && zIndex >= 10;
    });
    return likelyOverlayAbove ? 50 : -50;
  }

  function getPendingRect() {
    if (!pendingRange) return null;
    try {
      return pendingRange.getBoundingClientRect();
    } catch (_) {
      return null;
    }
  }

  function clearTriggerListeners() {
    if (outsideClickTimer) {
      clearTimeout(outsideClickTimer);
      outsideClickTimer = null;
    }
    if (outsideClickListener) {
      document.removeEventListener('mousedown', outsideClickListener, true);
      outsideClickListener = null;
    }
  }

  function dismissTrigger() {
    clearTriggerListeners();
    if (triggerBtns.length === 0) {
      pendingText = null;
      pendingRect = null;
      pendingRange = null;
      pendingVocabularyPayload = null;
      return;
    }

    triggerBtns.forEach((btn) => {
      btn.classList.add('we-exit');
      btn.addEventListener('animationend', () => {
        if (btn.parentNode) btn.parentNode.removeChild(btn);
      }, { once: true });
      setTimeout(() => {
        if (btn.parentNode) btn.parentNode.removeChild(btn);
      }, 250);
    });

    triggerBtns = [];
    pendingText = null;
    pendingRect = null;
    pendingRange = null;
    pendingVocabularyPayload = null;
  }

  // ============================================================
  //  创建并展示 Popover
  // ============================================================

  const LOADING_PHRASES = {
    ZH: [
      'AI 思考中…',
      '查阅释义中…',
      '分析语境中…',
      '知识整合中…',
      '理解语义中…',
      '组织语言中…',
    ],
    EN: [
      'Thinking in English…',
      'Consulting the dictionary…',
      'Crafting your explanation…',
      'Parsing the context…',
      'Analyzing nuance…',
      'Preparing breakdown…',
    ],
  };

  function getRandomPhrase(mode) {
    const list = LOADING_PHRASES[mode] || LOADING_PHRASES.ZH;
    return list[Math.floor(Math.random() * list.length)];
  }

  function showPopover(text, rect, mode = 'ZH', vocabularyPayload = null, anchorRange = null, displayOptions = {}) {
    const replacementState = displayOptions.replaceCurrent
      ? capturePopoverReplacementState(currentPopover)
      : null;
    dismissPopoverSilent();

    const inputType = classifyInput(text);
    const loadingText = getRandomPhrase(mode);
    const popover = document.createElement('div');
    popover.className = 'we-popover';
    popover.innerHTML = `
      <div class="we-header" title="拖动"></div>
      <div class="we-actions">
        <button class="we-pin" type="button" title="固定在当前位置" aria-label="固定翻译框">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6zm3 11v7"/></svg>
        </button>
        <button class="we-close" type="button" title="关闭" aria-label="关闭解释">×</button>
      </div>
      <div class="we-body">
        <div class="we-source-title">
          <span class="we-source-text"></span>
          <button class="we-save-word" type="button" title="加入生词本" aria-label="加入生词本">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.45 4.96 5.48.8-3.97 3.86.94 5.46L12 16.3l-4.9 2.58.94-5.46-3.97-3.86 5.48-.8L12 3.8z"/></svg>
          </button>
          <button class="we-speak" type="button" title="朗读英文" aria-label="朗读英文">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4zm12-1.5c1.1.8 1.7 2 1.7 3.5s-.6 2.7-1.7 3.5M18.8 6c1.8 1.5 2.8 3.5 2.8 6s-1 4.5-2.8 6"/></svg>
          </button>
        </div>
        <div class="we-ocr-source" hidden>
          <strong>OCR 识别原文</strong>
          <div class="we-ocr-source-text"></div>
        </div>
        <div class="we-loading">
          <div class="we-dot-spinner">
            <span class="we-dot"></span>
            <span class="we-dot"></span>
            <span class="we-dot"></span>
          </div>
          <span class="we-loading-text"></span>
        </div>
        <div class="we-result"></div>
      </div>
      <div class="we-resize-handle we-resize-n" data-resize="n"></div>
      <div class="we-resize-handle we-resize-e" data-resize="e"></div>
      <div class="we-resize-handle we-resize-s" data-resize="s"></div>
      <div class="we-resize-handle we-resize-w" data-resize="w"></div>
      <div class="we-resize-handle we-resize-ne" data-resize="ne"></div>
      <div class="we-resize-handle we-resize-se" data-resize="se" title="拖动调整大小；双击恢复默认大小"></div>
      <div class="we-resize-handle we-resize-sw" data-resize="sw"></div>
      <div class="we-resize-handle we-resize-nw" data-resize="nw"></div>
    `;

    uiRoot.appendChild(popover);
    currentPopover = popover;
    const localResultEl = popover.querySelector('.we-result');
    const bodyEl = popover.querySelector('.we-body');
    const sourceTitleEl = popover.querySelector('.we-source-text');
    const resultVocabularyPayload = vocabularyPayload || buildVocabularyPayload(text, null);
    const sourceKind = resultVocabularyPayload?.source?.kind === 'ocr' ? 'OCR' : 'SELECTION';
    popover.querySelector('.we-loading-text').textContent = loadingText;

    if (sourceKind === 'OCR') {
      const ocrSource = popover.querySelector('.we-ocr-source');
      ocrSource.hidden = false;
      ocrSource.querySelector('.we-ocr-source-text').textContent = text;
    }

    if (inputType !== 'PASSAGE' && sourceKind !== 'OCR') {
      sourceTitleEl.textContent = formatSourceTitle(text, inputType);
      popover.classList.add('we-has-source');
    }

    const saveWordButton = popover.querySelector('.we-save-word');
    if (inputType === 'WORD' && isLatinBasedText(text)) {
      popover.classList.add('we-can-save-word');
      initializeSaveWordButton(saveWordButton, resultVocabularyPayload);
    }

    // 翻译框中的原文、OCR 原文和解释结果都允许继续划词；新结果复用当前翻译框。
    bodyEl.addEventListener('mouseup', () => {
      setTimeout(() => showResultSelectionMenu(bodyEl, resultVocabularyPayload), 0);
    });
    popover.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('.we-body')) dismissResultSelectionMenu();
    });

    popover.querySelector('.we-speak').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSpeech(text, e.currentTarget);
    });

    applyStoredPanelSize(popover);
    applyPanelState(popover);
    if (!panelPinned && replacementState) {
      restorePopoverReplacementState(popover, replacementState);
    } else if (!panelPinned) {
      positionPopover(popover, rect);
    }
    enablePopoverDrag(popover);
    enablePopoverResize(popover);
    if (!replacementState) installSelectionAvoidance(popover, rect, anchorRange);

    popover.querySelector('.we-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismissPopover();
    });

    popover.querySelector('.we-pin').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanelPinned(popover);
    });

    // 插件上下文失效保护
    let port;
    try {
      port = chrome.runtime.connect({ name: 'word-explainer' });
      currentPort = port;
    } catch (err) {
      localResultEl.innerHTML = '<span class="we-error">插件上下文已失效，请刷新页面后重试。</span>';
      bodyEl.classList.add('we-showing-result');
      return;
    }

    let markdownText = '';
    let renderFrame = null;
    let followStreamingOutput = true;
    const isNearResultBottom = () => (
      bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight <= 48
    );

    // 流式输出期间允许回看前文。回到底部后会自动恢复跟随新内容。
    bodyEl.addEventListener('wheel', (event) => {
      if (event.deltaY < 0) followStreamingOutput = false;
    }, { passive: true });
    bodyEl.addEventListener('scroll', () => {
      dismissResultSelectionMenu();
      followStreamingOutput = isNearResultBottom();
    }, { passive: true });

    const render = (showCursor) => {
      renderFrame = null;
      if (!popover.isConnected) return;
      const previousScrollTop = bodyEl.scrollTop;
      const shouldFollow = followStreamingOutput || isNearResultBottom();
      dismissResultSelectionMenu();
      const normalizedMarkdown = normalizeExplanationMarkdown(markdownText, inputType);
      localResultEl.innerHTML = parseMarkdown(normalizedMarkdown) + (showCursor ? '<span class="we-cursor">|</span>' : '');
      if (shouldFollow) {
        bodyEl.scrollTop = bodyEl.scrollHeight;
      } else {
        bodyEl.scrollTop = previousScrollTop;
      }
      if (panelPinned) clampPinnedPopover(popover, false);
      popover.__weScheduleAvoidance?.();
    };

    const scheduleRender = () => {
      if (renderFrame) return;
      renderFrame = requestAnimationFrame(() => render(true));
    };

    port.onMessage.addListener((msg) => {
      if (currentPort !== port || currentPopover !== popover) return;
      if (msg.type === 'CHUNK') {
        if (markdownText === '') bodyEl.classList.add('we-showing-result');
        markdownText += msg.text;
        scheduleRender();
      } else if (msg.type === 'DONE') {
        if (renderFrame) cancelAnimationFrame(renderFrame);
        bodyEl.classList.add('we-showing-result');
        if (!markdownText) markdownText = '未返回解释内容，请重试。';
        render(false);
        if (panelPinned) clampPinnedPopover(popover, true);
      } else if (msg.type === 'ERROR') {
        if (renderFrame) cancelAnimationFrame(renderFrame);
        bodyEl.classList.add('we-showing-result');
        localResultEl.innerHTML = '<span class="we-error">抱歉，解释失败：' + escapeHtml(String(msg.message || '未知错误')) + '</span>';
        if (panelPinned) clampPinnedPopover(popover, true);
        popover.__weScheduleAvoidance?.();
      }
    });

    port.onDisconnect.addListener(() => {
      if (renderFrame) cancelAnimationFrame(renderFrame);
      if (currentPort === port) currentPort = null;
    });
    port.postMessage({ type: 'EXPLAIN', text, mode, inputType, sourceKind });
  }

  function formatSourceTitle(text, inputType) {
    const trimmed = String(text).trim();
    if (inputType !== 'WORD') return trimmed;
    const letters = trimmed.match(/\p{L}/gu) || [];
    const isAllCaps = letters.length >= 2
      && letters.every((letter) => /\p{Lu}/u.test(letter));
    return isAllCaps ? trimmed.toLocaleLowerCase() : trimmed;
  }

  function getUiSelection() {
    try {
      const shadowSelection = typeof uiRoot?.getSelection === 'function' ? uiRoot.getSelection() : null;
      if (shadowSelection) return shadowSelection;
    } catch (_) {}
    return window.getSelection();
  }

  function capturePopoverReplacementState(popover) {
    if (!popover?.isConnected) return null;
    const rect = popover.getBoundingClientRect();
    return {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
    };
  }

  function restorePopoverReplacementState(popover, state) {
    popover.style.left = state.left + 'px';
    popover.style.top = state.top + 'px';
    popover.style.right = '';
    popover.style.transform = '';
    popover.dataset.weUserPositioned = 'true';
    popover.classList.add('we-detached', 'we-settled');
    updateEdgeState(popover, state.left, state.top);
  }

  function showResultSelectionMenu(selectionRoot, basePayload) {
    dismissResultSelectionMenu();
    if (!selectionRoot?.isConnected || !basePayload || currentPopover !== selectionRoot.closest('.we-popover')) return;

    const selection = getUiSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const text = selection.toString().trim();
    if (!text || text.length > MAX_INPUT_CHARACTERS || isPrimarilyChineseText(text)) return;
    if (!selectionRoot.contains(selection.anchorNode) || !selectionRoot.contains(selection.focusNode)) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    const ocrSource = selectionRoot.querySelector('.we-ocr-source-text');
    const selectedFromOcrSource = !!ocrSource
      && ocrSource.contains(selection.anchorNode)
      && ocrSource.contains(selection.focusNode);
    const source = {
      ...(basePayload.source || getVocabularySource(null)),
      kind: selectedFromOcrSource ? 'ocr' : getVocabularySource(null).kind,
    };
    const payload = buildVocabularyPayload(text, range, {
      context: extractSelectionContext(text, range),
      source,
    });
    const inputType = classifyInput(text);
    const supportsEnglishExplanation = isLatinBasedText(text);
    const actions = inputType === 'PASSAGE' || !supportsEnglishExplanation
      ? [{ icon: ICON_ZH, mode: 'ZH', className: 'we-result-action-zh', title: '用中文解释选中内容' }]
      : [
          { icon: ICON_ZH, mode: 'ZH', className: 'we-result-action-zh', title: '用中文解释选中内容' },
          { icon: ICON_EN, mode: 'EN', className: 'we-result-action-en', title: '用英文解释选中内容' },
        ];
    if (inputType === 'WORD' && supportsEnglishExplanation) {
      actions.push({ icon: ICON_SAVE, action: 'save', className: 'we-result-action-save', title: '收藏选中的单词' });
    }

    const menu = document.createElement('div');
    menu.className = 'we-result-action-menu';
    menu.setAttribute('role', 'toolbar');
    menu.setAttribute('aria-label', '选中文字操作');
    menu.style.visibility = 'hidden';

    actions.forEach((action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `we-result-action ${action.className}`;
      button.innerHTML = action.icon;
      button.title = action.title;
      button.setAttribute('aria-label', action.title);
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;

        if (action.action !== 'save') {
          dismissResultSelectionMenu(menu);
          showPopover(text, rect, action.mode, payload, null, { replaceCurrent: true });
          return;
        }

        button.disabled = true;
        button.classList.add('we-busy');
        try {
          await sendVocabularyMessage({ type: 'VOCAB_ADD', payload });
          button.classList.remove('we-busy');
          button.classList.add('we-saved');
          button.textContent = '✓';
          button.title = `已收藏 ${text}`;
          setTimeout(() => dismissResultSelectionMenu(menu), 700);
        } catch (_) {
          button.classList.remove('we-busy');
          button.classList.add('we-save-error');
          button.textContent = '!';
          button.title = '收藏失败，请刷新页面后重试';
          setTimeout(() => dismissResultSelectionMenu(menu), 1600);
        }
      });
      menu.appendChild(button);
    });

    uiRoot.appendChild(menu);
    resultSelectionMenu = menu;
    const menuRect = menu.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const left = clampNumber(centerX - menuRect.width / 2, 6, Math.max(6, window.innerWidth - menuRect.width - 6));
    const aboveTop = rect.top - menuRect.height - 8;
    const top = aboveTop >= 6
      ? aboveTop
      : Math.min(Math.max(6, window.innerHeight - menuRect.height - 6), rect.bottom + 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';
  }

  function dismissResultSelectionMenu(expectedMenu = null) {
    if (!resultSelectionMenu) return;
    if (expectedMenu && resultSelectionMenu !== expectedMenu) return;
    const menu = resultSelectionMenu;
    resultSelectionMenu = null;
    menu.remove();
  }

  async function initializeSaveWordButton(button, payload) {
    if (!button || !payload) return;
    let saved = false;
    const update = () => {
      button.classList.toggle('we-saved', saved);
      button.title = saved ? '从生词本移除' : '加入生词本';
      button.setAttribute('aria-label', button.title);
    };
    update();

    try {
      const status = await sendVocabularyMessage({ type: 'VOCAB_STATUS', word: payload.word });
      saved = !!status.saved;
      update();
    } catch (_) {}

    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      button.classList.add('we-busy');
      try {
        if (saved) {
          await sendVocabularyMessage({ type: 'VOCAB_REMOVE', payload: { word: payload.word } });
          saved = false;
        } else {
          await sendVocabularyMessage({ type: 'VOCAB_ADD', payload });
          saved = true;
        }
        update();
      } catch (_) {
        button.title = '操作失败，请刷新页面后重试';
      } finally {
        button.disabled = false;
        button.classList.remove('we-busy');
      }
    });
  }

  async function sendVocabularyMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '生词本操作失败');
    return response.result;
  }

  function buildVocabularyPayload(text, range, overrides = {}) {
    const source = overrides.source || getVocabularySource(range, overrides);
    return {
      word: formatSourceTitle(text, classifyInput(text)),
      context: typeof overrides.context === 'string'
        ? overrides.context
        : extractSelectionContext(text, range),
      source,
    };
  }

  function getVocabularySource(range, overrides = {}) {
    const startElement = range
      ? (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement)
      : null;
    const pageShell = startElement?.closest?.('.page-shell');
    const isPdfReader = location.pathname.endsWith('/pdf/reader.html') || !!pageShell;
    if (isPdfReader) {
      const title = document.getElementById('document-title')?.textContent?.trim() || document.title;
      return {
        kind: overrides.kind === 'ocr' ? 'ocr' : 'pdf',
        title,
        url: document.body.dataset.pdfOriginalUrl || '',
        documentId: document.body.dataset.pdfFingerprint || title,
        page: Number(overrides.page || pageShell?.dataset.pageNumber) || null,
      };
    }
    return {
      kind: location.protocol === 'file:' ? 'file' : 'web',
      title: document.title || location.hostname || '网页',
      url: location.href.split('#')[0],
      documentId: location.href.split('#')[0],
      page: null,
    };
  }

  function extractSelectionContext(selectedText, range) {
    if (!range) return selectedText;
    const node = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!node) return selectedText;

    const pageShell = node.closest?.('.page-shell');
    const container = pageShell?.querySelector('.textLayer')
      || node.closest?.('p, li, blockquote, figcaption, td, th, dd, dt, article')
      || node.parentElement
      || node;
    const fullText = String(container.innerText || container.textContent || selectedText).replace(/\s+/g, ' ').trim();
    const needle = String(selectedText || '').replace(/\s+/g, ' ').trim();
    if (!fullText || !needle) return needle;

    const index = fullText.toLocaleLowerCase('en-US').indexOf(needle.toLocaleLowerCase('en-US'));
    if (index < 0) return fullText.slice(0, 500);
    const roughStart = Math.max(0, index - 240);
    const roughEnd = Math.min(fullText.length, index + needle.length + 240);
    let start = roughStart;
    let end = roughEnd;
    const before = fullText.slice(roughStart, index);
    const after = fullText.slice(index + needle.length, roughEnd);
    const beforeBoundary = Math.max(before.lastIndexOf('. '), before.lastIndexOf('? '), before.lastIndexOf('! '));
    const afterMatch = after.search(/[.!?](?:\s|$)/);
    if (beforeBoundary >= 0) start = roughStart + beforeBoundary + 2;
    if (afterMatch >= 0) end = index + needle.length + afterMatch + 1;
    return fullText.slice(start, end).trim().slice(0, 500);
  }

  function toggleSpeech(text, button) {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;
    if (currentUtterance && speechSynthesis.speaking) {
      speechSynthesis.cancel();
      currentUtterance = null;
      button.classList.remove('we-speaking');
      button.title = '朗读英文';
      return;
    }

    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
      ? 'ja-JP'
      : /\p{Script=Hangul}/u.test(text)
        ? 'ko-KR'
        : 'en-US';
    utterance.rate = 0.92;
    currentUtterance = utterance;
    button.classList.add('we-speaking');
    button.title = '停止朗读';
    const finish = () => {
      if (currentUtterance !== utterance) return;
      currentUtterance = null;
      button.classList.remove('we-speaking');
      button.title = '朗读英文';
    };
    utterance.addEventListener('end', finish, { once: true });
    utterance.addEventListener('error', finish, { once: true });
    speechSynthesis.speak(utterance);
  }

  function applyStoredPanelSize(popover) {
    const manual = isValidPanelSize(panelSize);
    popover.classList.toggle('we-manual-size', manual);
    if (manual) {
      popover.style.width = Math.min(panelSize.width, window.innerWidth) + 'px';
      popover.style.height = Math.min(panelSize.height, window.innerHeight) + 'px';
    } else {
      popover.style.width = '';
      popover.style.height = '';
    }
  }

  function applyPanelState(popover) {
    popover.classList.toggle('we-pinned', panelPinned);
    popover.classList.toggle('we-detached', panelPinned);
    popover.classList.remove('we-pinned-left', 'we-pinned-right');

    if (panelPinned) {
      cancelInertia();
      popover.classList.remove('we-edge-left', 'we-edge-right', 'we-edge-top');
      popover.style.right = '';
      popover.style.transform = '';

      const rect = popover.getBoundingClientRect();
      const fallback = {
        left: Math.max(0, window.innerWidth - rect.width),
        top: Math.min(72, Math.max(0, window.innerHeight - rect.height)),
      };
      const position = isValidPoint(panelPosition) ? panelPosition : fallback;
      popover.style.left = position.left + 'px';
      popover.style.top = position.top + 'px';
      clampPinnedPopover(popover, false);
    }

    updatePinButton(popover);
  }

  function updatePinButton(popover) {
    const pinButton = popover.querySelector('.we-pin');
    if (!pinButton) return;
    pinButton.classList.toggle('we-active', panelPinned);
    pinButton.title = panelPinned ? '取消固定，恢复随网页移动' : '固定在当前位置';
    pinButton.setAttribute('aria-label', panelPinned ? '取消固定翻译框' : '固定翻译框');
  }

  function togglePanelPinned(popover) {
    const rect = popover.getBoundingClientRect();
    cancelInertia();

    if (!panelPinned) {
      panelPinned = true;
      panelPosition = clampFixedPoint(rect.left, rect.top, rect.width, rect.height);
      popover.classList.add('we-pinned', 'we-detached');
      popover.classList.remove('we-edge-left', 'we-edge-right', 'we-edge-top');
      popover.style.left = panelPosition.left + 'px';
      popover.style.top = panelPosition.top + 'px';
      popover.style.right = '';
      popover.style.transform = '';
    } else {
      panelPinned = false;
      popover.classList.remove('we-pinned');
      popover.classList.add('we-detached');
      popover.style.left = rect.left + window.scrollX + 'px';
      popover.style.top = rect.top + window.scrollY + 'px';
      keepPopoverInViewport(popover);
    }

    updatePinButton(popover);
    chrome.storage.local.set({ panelPinned, panelPosition });
    chrome.storage.local.remove('panelMode');
  }

  function clampFixedPoint(left, top, width, height) {
    return {
      left: Math.min(Math.max(0, window.innerWidth - width), Math.max(0, left)),
      top: Math.min(Math.max(0, window.innerHeight - height), Math.max(0, top)),
    };
  }

  function clampPinnedPopover(popover, persist) {
    if (!panelPinned || !popover.isConnected) return;

    let rect = popover.getBoundingClientRect();
    if (rect.width > window.innerWidth) popover.style.width = window.innerWidth + 'px';
    if (rect.height > window.innerHeight) popover.style.height = window.innerHeight + 'px';
    rect = popover.getBoundingClientRect();

    const currentLeft = parseFloat(popover.style.left);
    const currentTop = parseFloat(popover.style.top);
    panelPosition = clampFixedPoint(
      Number.isFinite(currentLeft) ? currentLeft : rect.left,
      Number.isFinite(currentTop) ? currentTop : rect.top,
      rect.width,
      rect.height
    );
    popover.style.left = panelPosition.left + 'px';
    popover.style.top = panelPosition.top + 'px';

    if (persist) chrome.storage.local.set({ panelPosition });
  }

  function enablePopoverDrag(popover) {
    const header = popover.querySelector('.we-header');

    popover.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.we-close, .we-resize-handle, a, button, input, textarea, select')) return;

      // 整个内容区保留普通划选（包括 OCR 原文）；按住 Alt 时仍可从内容区拖动。
      if (e.target.closest('.we-body') && !e.altKey) return;

      cancelInertia();
      const startX = e.clientX;
      const startY = e.clientY;
      const startRect = popover.getBoundingClientRect();
      const wasPinned = panelPinned;
      const startLeft = startRect.left + (wasPinned ? 0 : window.scrollX);
      const startTop = startRect.top + (wasPinned ? 0 : window.scrollY);
      const previousUserSelect = document.body.style.userSelect;
      let dragging = false;
      let lastDx = 0;
      let lastDy = 0;
      let samples = [{ x: e.clientX, y: e.clientY, time: performance.now() }];

      // 拖动期间只更新合成层 transform，避免每一帧触发布局与重绘。
      const minDx = -startRect.left;
      const maxDx = window.innerWidth - startRect.right;
      const minDy = -startRect.top;
      const visibleHeight = Math.min(startRect.height, window.innerHeight);
      const maxDy = window.innerHeight - startRect.top - visibleHeight;

      const onPointerMove = (moveEvent) => {
        if (moveEvent.pointerId !== e.pointerId) return;

        const rawDx = moveEvent.clientX - startX;
        const rawDy = moveEvent.clientY - startY;
        if (!dragging && Math.hypot(rawDx, rawDy) < 4) return;

        if (!dragging) {
          dragging = true;
          document.body.style.userSelect = 'none';
          popover.dataset.weUserPositioned = 'true';
          popover.__weStopAvoidance?.();
          popover.classList.add('we-dragging', 'we-detached', 'we-settled');
          header?.classList.add('we-dragging');
        }

        moveEvent.preventDefault();
        lastDx = Math.min(Math.max(rawDx, minDx), Math.max(minDx, maxDx));
        lastDy = Math.min(Math.max(rawDy, minDy), Math.max(minDy, maxDy));
        popover.style.transform = `translate3d(${lastDx}px, ${lastDy}px, 0)`;

        const now = performance.now();
        samples.push({ x: moveEvent.clientX, y: moveEvent.clientY, time: now });
        samples = samples.filter((sample) => now - sample.time <= 120);
      };

      const onPointerUp = (upEvent) => {
        if (upEvent.pointerId !== e.pointerId) return;
        document.removeEventListener('pointermove', onPointerMove, true);
        document.removeEventListener('pointerup', onPointerUp, true);
        document.removeEventListener('pointercancel', onPointerUp, true);
        document.body.style.userSelect = previousUserSelect;

        if (dragging) {
          const finalLeft = startLeft + lastDx;
          const finalTop = startTop + lastDy;
          popover.style.left = finalLeft + 'px';
          popover.style.top = finalTop + 'px';
          popover.style.transform = '';

          if (wasPinned) {
            panelPosition = { left: finalLeft, top: finalTop };
            chrome.storage.local.set({ panelPosition });
          } else {
            updateEdgeState(popover, finalLeft, finalTop);
          }

          const releaseTime = performance.now();
          samples.push({ x: upEvent.clientX, y: upEvent.clientY, time: releaseTime });
          samples = samples.filter((sample) => releaseTime - sample.time <= 120);
          const last = samples[samples.length - 1];
          const first = samples.find((sample) => last.time - sample.time >= 40) || samples[0];
          const elapsed = Math.max(1, last.time - first.time);
          const velocityX = (last.x - first.x) / elapsed;
          const velocityY = (last.y - first.y) / elapsed;
          if (!wasPinned && Math.hypot(velocityX, velocityY) >= 0.55) {
            startPopoverInertia(popover, velocityX, velocityY);
          }
        }

        popover.classList.remove('we-dragging');
        header?.classList.remove('we-dragging');
      };

      document.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
      document.addEventListener('pointerup', onPointerUp, true);
      document.addEventListener('pointercancel', onPointerUp, true);
    });
  }

  function enablePopoverResize(popover) {
    const handles = popover.querySelectorAll('.we-resize-handle');

    handles.forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        cancelInertia();

        const direction = handle.dataset.resize || '';
        const startRect = popover.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const wasPinned = panelPinned;
        const previousUserSelect = document.body.style.userSelect;
        const minWidth = Math.min(280, window.innerWidth);
        const minHeight = Math.min(160, window.innerHeight);
        let finalRect = {
          left: startRect.left,
          top: startRect.top,
          width: startRect.width,
          height: startRect.height,
        };

        document.body.style.userSelect = 'none';
        popover.classList.add('we-resizing', 'we-manual-size', 'we-detached', 'we-settled');

        const onPointerMove = (moveEvent) => {
          if (moveEvent.pointerId !== e.pointerId) return;
          moveEvent.preventDefault();

          const dx = moveEvent.clientX - startX;
          const dy = moveEvent.clientY - startY;
          let left = startRect.left;
          let top = startRect.top;
          let width = startRect.width;
          let height = startRect.height;

          if (direction.includes('e')) {
            width = clampNumber(startRect.width + dx, minWidth, window.innerWidth - startRect.left);
          }
          if (direction.includes('w')) {
            const right = startRect.right;
            width = clampNumber(startRect.width - dx, minWidth, right);
            left = right - width;
          }
          if (direction.includes('s')) {
            height = clampNumber(startRect.height + dy, minHeight, window.innerHeight - startRect.top);
          }
          if (direction.includes('n')) {
            const bottom = startRect.bottom;
            height = clampNumber(startRect.height - dy, minHeight, bottom);
            top = bottom - height;
          }

          finalRect = { left, top, width, height };
          popover.style.left = left + (wasPinned ? 0 : window.scrollX) + 'px';
          popover.style.top = top + (wasPinned ? 0 : window.scrollY) + 'px';
          popover.style.width = width + 'px';
          popover.style.height = height + 'px';
          popover.style.transform = '';
        };

        const onPointerUp = (upEvent) => {
          if (upEvent.pointerId !== e.pointerId) return;
          document.removeEventListener('pointermove', onPointerMove, true);
          document.removeEventListener('pointerup', onPointerUp, true);
          document.removeEventListener('pointercancel', onPointerUp, true);
          document.body.style.userSelect = previousUserSelect;
          popover.classList.remove('we-resizing');
          popover.style.width = finalRect.width + 'px';
          popover.style.height = finalRect.height + 'px';

          panelSize = {
            width: Math.round(finalRect.width),
            height: Math.round(finalRect.height),
          };

          if (wasPinned) {
            panelPosition = { left: finalRect.left, top: finalRect.top };
            chrome.storage.local.set({ panelSize, panelPosition });
          } else {
            chrome.storage.local.set({ panelSize });
            updateEdgeState(
              popover,
              finalRect.left + window.scrollX,
              finalRect.top + window.scrollY
            );
          }
        };

        document.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('pointercancel', onPointerUp, true);
      });
    });

    popover.querySelector('.we-resize-se')?.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetPanelSize(popover);
    });
  }

  function clampNumber(value, min, max) {
    return Math.min(Math.max(min, max), Math.max(min, value));
  }

  function resetPanelSize(popover) {
    panelSize = null;
    popover.classList.remove('we-manual-size', 'we-resizing');
    popover.style.width = '';
    popover.style.height = '';
    chrome.storage.local.remove('panelSize');

    requestAnimationFrame(() => {
      if (panelPinned) clampPinnedPopover(popover, true);
      else keepPopoverInViewport(popover);
    });
  }

  function cancelInertia() {
    if (!inertiaFrame) return;
    cancelAnimationFrame(inertiaFrame);
    inertiaFrame = null;
  }

  function startPopoverInertia(popover, velocityX, velocityY) {
    if (panelPinned || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    cancelInertia();
    let left = parseFloat(popover.style.left) || popover.getBoundingClientRect().left + window.scrollX;
    let top = parseFloat(popover.style.top) || popover.getBoundingClientRect().top + window.scrollY;
    let lastTime = performance.now();
    let elapsedTotal = 0;

    const step = (now) => {
      if (!popover.isConnected || panelPinned) {
        inertiaFrame = null;
        return;
      }

      const dt = Math.min(32, now - lastTime);
      lastTime = now;
      elapsedTotal += dt;
      left += velocityX * dt;
      top += velocityY * dt;

      const rect = popover.getBoundingClientRect();
      const minLeft = window.scrollX;
      const maxLeft = window.scrollX + Math.max(0, window.innerWidth - rect.width);
      const minTop = window.scrollY;
      const maxTop = window.scrollY + Math.max(0, window.innerHeight - Math.min(rect.height, window.innerHeight));

      if (left <= minLeft || left >= maxLeft) {
        left = Math.min(maxLeft, Math.max(minLeft, left));
        velocityX *= -0.58;
      }
      if (top <= minTop || top >= maxTop) {
        top = Math.min(maxTop, Math.max(minTop, top));
        velocityY *= -0.58;
      }

      const friction = Math.pow(0.991, dt);
      velocityX *= friction;
      velocityY *= friction;
      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
      updateEdgeState(popover, left, top);

      if (Math.hypot(velocityX, velocityY) < 0.025 || elapsedTotal > 1600) {
        inertiaFrame = null;
        return;
      }
      inertiaFrame = requestAnimationFrame(step);
    };

    inertiaFrame = requestAnimationFrame(step);
  }

  function keepPopoverInViewport(popover) {
    const rect = popover.getBoundingClientRect();
    const left = Math.min(
      window.scrollX + Math.max(0, window.innerWidth - rect.width),
      Math.max(window.scrollX, rect.left + window.scrollX)
    );
    const top = Math.min(
      window.scrollY + Math.max(0, window.innerHeight - Math.min(rect.height, window.innerHeight)),
      Math.max(window.scrollY, rect.top + window.scrollY)
    );
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
    updateEdgeState(popover, left, top);
  }

  function updateEdgeState(popover, left, top) {
    const rect = popover.getBoundingClientRect();
    const minLeft = window.scrollX;
    const maxLeft = window.scrollX + Math.max(0, window.innerWidth - rect.width);
    const minTop = window.scrollY;
    const tolerance = 0.75;
    popover.classList.toggle('we-edge-left', Math.abs(left - minLeft) <= tolerance);
    popover.classList.toggle('we-edge-right', Math.abs(left - maxLeft) <= tolerance);
    popover.classList.toggle('we-edge-top', Math.abs(top - minTop) <= tolerance);
  }

  // ============================================================
  //  定位算法
  // ============================================================

  function snapshotRect(rect) {
    if (!rect) return null;
    return {
      left: Number(rect.left),
      right: Number(rect.right),
      top: Number(rect.top),
      bottom: Number(rect.bottom),
      width: Number(rect.width) || Math.max(0, Number(rect.right) - Number(rect.left)),
      height: Number(rect.height) || Math.max(0, Number(rect.bottom) - Number(rect.top)),
      preferVertical: rect.preferVertical === true,
    };
  }

  function getLiveAnchorRect(anchorRange, fallbackRect) {
    if (anchorRange) {
      try {
        const liveRect = anchorRange.getBoundingClientRect();
        if (isUsableRect(liveRect)) return snapshotRect(liveRect);
      } catch (_) {}
    }
    return fallbackRect;
  }

  function installSelectionAvoidance(popover, initialRect, anchorRange) {
    const fallbackRect = snapshotRect(initialRect);
    let frame = null;
    let settledTimer = null;
    let observer = null;

    const check = () => {
      frame = null;
      if (!popover.isConnected || panelPinned || popover.dataset.weUserPositioned === 'true') return;
      const anchorRect = getLiveAnchorRect(anchorRange, fallbackRect);
      if (!anchorRect) return;
      const popoverRect = popover.getBoundingClientRect();
      if (rectanglesOverlap(popoverRect, anchorRect, 4)) positionPopover(popover, anchorRect);
    };
    const schedule = () => {
      if (frame || !popover.isConnected) return;
      frame = requestAnimationFrame(check);
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      if (settledTimer) clearTimeout(settledTimer);
      observer?.disconnect();
      document.removeEventListener('scroll', stop, true);
      window.removeEventListener('resize', schedule);
      frame = null;
      settledTimer = null;
      observer = null;
      delete popover.__weScheduleAvoidance;
      delete popover.__weStopAvoidance;
    };

    popover.__weScheduleAvoidance = schedule;
    popover.__weStopAvoidance = stop;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(schedule);
      observer.observe(popover);
    }
    // 用户一旦滚动，就锁定当前网页位置。后续流式内容扩展不能再追随原选区重新定位。
    document.addEventListener('scroll', stop, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    schedule();
    // 入场动画结束后再以最终几何位置复核一次。
    settledTimer = setTimeout(schedule, 360);
  }

  function positionPopover(popover, rect) {
    const gap = 10;
    const edgePadding = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    popover.classList.remove('we-auto-fit');
    applyStoredPanelSize(popover);
    const measured = popover.getBoundingClientRect();
    const body = popover.querySelector('.we-body');
    const bodyRect = body?.getBoundingClientRect();
    const bodyMaxHeight = body ? Number.parseFloat(getComputedStyle(body).maxHeight) : NaN;
    const expandedDefaultHeight = !popover.classList.contains('we-manual-size')
      && bodyRect
      && Number.isFinite(bodyMaxHeight)
      ? bodyMaxHeight + Math.max(0, measured.height - bodyRect.height)
      : measured.height;
    const placement = calculatePopoverPlacement({
      anchor: rect,
      width: Math.min(Math.max(1, measured.width), viewportWidth),
      height: Math.min(Math.max(measured.height, expandedDefaultHeight), viewportHeight),
      viewportWidth,
      viewportHeight,
      gap,
      edgePadding,
    });
    if (placement.autoFitHeight) {
      popover.style.height = placement.height + 'px';
      popover.classList.add('we-auto-fit');
    }
    if (placement.autoFitWidth) popover.style.width = placement.width + 'px';

    const left = placement.left + window.scrollX;
    const top = placement.top + window.scrollY;
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';
    popover.dataset.wePlacement = placement.side;
    popover.classList.toggle('we-above', placement.side === 'above');
    popover.classList.toggle('we-detached', placement.side === 'left' || placement.side === 'right');
    updateEdgeState(popover, left, top);
  }

  // ============================================================
  //  Markdown 解析器
  // ============================================================

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ============================================================
  //  关闭 Popover
  // ============================================================

  function dismissPopover() {
    dismissResultSelectionMenu();
    if (!currentPopover) return;
    cancelInertia();
    if (currentUtterance) {
      speechSynthesis.cancel();
      currentUtterance = null;
    }
    if (currentPort) {
      try { currentPort.disconnect(); } catch (_) {}
      currentPort = null;
    }
    const popover = currentPopover;
    currentPopover = null;
    popover.__weStopAvoidance?.();
    popover.classList.add('we-exit');
    popover.addEventListener('animationend', () => {
      if (popover.parentNode) popover.parentNode.removeChild(popover);
    }, { once: true });
    setTimeout(() => {
      if (popover.parentNode) popover.parentNode.removeChild(popover);
    }, 400);
  }

  function dismissPopoverSilent() {
    dismissResultSelectionMenu();
    if (!currentPopover) return;
    cancelInertia();
    if (currentUtterance) {
      speechSynthesis.cancel();
      currentUtterance = null;
    }
    if (currentPort) {
      try { currentPort.disconnect(); } catch (_) {}
      currentPort = null;
    }
    const el = currentPopover;
    currentPopover = null;
    el.__weStopAvoidance?.();
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  window.__wordExplainer = {
    explainText(rawText, options = {}) {
      const text = typeof rawText === 'string' ? rawText.trim() : '';
      if (!extensionEnabled) return { ok: false, message: '请先在插件设置中开启划词解释' };
      if (!text) return { ok: false, message: '没有识别到可翻译的文字' };
      if (text.length > MAX_INPUT_CHARACTERS) return { ok: false, message: `识别文字超过 ${MAX_INPUT_CHARACTERS} 个字符` };
      const rect = options.rect || {
        left: window.innerWidth / 2,
        right: window.innerWidth / 2,
        top: window.innerHeight / 2,
        bottom: window.innerHeight / 2,
        width: 0,
        height: 0,
      };
      const vocabularyPayload = options.vocabularyPayload || buildVocabularyPayload(text, null, {
        context: options.context,
        source: options.source,
        kind: options.kind,
        page: options.page,
      });
      showPopover(text, rect, options.mode === 'EN' ? 'EN' : 'ZH', vocabularyPayload);
      return { ok: true };
    },
  };
})();
