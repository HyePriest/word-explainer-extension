const DEFAULT_MODEL = 'deepseek-v4-flash';

const toggle = document.getElementById('toggle');
const statusText = document.getElementById('status-text');
const modelSelect = document.getElementById('model');
const modelStatus = document.getElementById('model-status');
const themeSelect = document.getElementById('theme');
const themeStatus = document.getElementById('theme-status');
const apiKeyInput = document.getElementById('api-key');
const keyStatus = document.getElementById('key-status');
const showQuickSaveToggle = document.getElementById('show-quick-save');
const ocrStatus = document.getElementById('ocr-status');

function setStatus(element, message, type = '') {
  element.textContent = message;
  element.className = `status${type ? ` ${type}` : ''}`;
}

let themePreference = 'system';
WordExplainerTheme.subscribe(({ preference }) => {
  themePreference = preference;
  themeSelect.value = preference;
});
WordExplainerTheme.ready.then((loaded) => {
  themeSelect.disabled = false;
  if (!loaded) setStatus(themeStatus, '读取外观设置失败，可重新选择', 'error');
});

themeSelect.addEventListener('change', async () => {
  const preference = themeSelect.value;
  themeSelect.disabled = true;
  setStatus(themeStatus, '');
  try {
    await WordExplainerTheme.setPreference(preference);
  } catch (_) {
    themeSelect.value = themePreference;
    setStatus(themeStatus, '保存外观设置失败，请重试', 'error');
  } finally {
    themeSelect.disabled = false;
  }
});

chrome.storage.local.get({ enabled: false, model: DEFAULT_MODEL, apiKey: '', showQuickSave: false }, ({ enabled, model, apiKey, showQuickSave }) => {
  toggle.checked = !!enabled;
  statusText.textContent = enabled ? '已开启' : '已关闭';
  showQuickSaveToggle.checked = !!showQuickSave;

  const normalizedModel = model === 'deepseek-v4-pro' || model === 'deepseek-reasoner'
    ? 'deepseek-v4-pro'
    : DEFAULT_MODEL;
  modelSelect.value = normalizedModel;
  if (model !== normalizedModel) chrome.storage.local.set({ model: normalizedModel });

  if (apiKey) {
    apiKeyInput.placeholder = `已保存 ····${apiKey.slice(-4)}`;
  } else {
    document.getElementById('settings').open = true;
  }
});

showQuickSaveToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ showQuickSave: showQuickSaveToggle.checked });
});

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  await chrome.storage.local.set({ enabled });
  statusText.textContent = enabled ? '已开启' : '已关闭';
});

modelSelect.addEventListener('change', async () => {
  const model = modelSelect.value;
  await chrome.storage.local.set({ model });
  setStatus(modelStatus, model === 'deepseek-v4-pro' ? '已切换为 V4 Pro' : '已切换为 V4 Flash', 'success');
});

document.getElementById('save-key').addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key.startsWith('sk-')) {
    setStatus(keyStatus, '格式错误，应以 sk- 开头', 'error');
    return;
  }

  await chrome.storage.local.set({ apiKey: key });
  apiKeyInput.value = '';
  apiKeyInput.placeholder = `已保存 ····${key.slice(-4)}`;
  setStatus(keyStatus, 'API Key 已保存', 'success');
});

document.getElementById('clear-key').addEventListener('click', async () => {
  await chrome.storage.local.remove('apiKey');
  apiKeyInput.value = '';
  apiKeyInput.placeholder = 'sk-...';
  setStatus(keyStatus, 'API Key 已删除');
});

document.getElementById('open-pdf-reader').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pdf/reader.html') });
  window.close();
});

document.getElementById('open-vocabulary').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('vocabulary/index.html') });
  window.close();
});

document.getElementById('start-page-ocr').addEventListener('click', async () => {
  if (!toggle.checked) {
    setStatus(ocrStatus, '请先开启划词解释', 'error');
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('没有找到当前页面');
    const extensionRoot = chrome.runtime.getURL('');
    const isExtensionPage = tab.url?.startsWith(extensionRoot);
    const message = {
      type: 'START_PAGE_OCR_V3',
      targetUrl: isExtensionPage ? (tab.url || '') : '',
      ocrProtocol: 3,
    };
    let response;
    if (isExtensionPage) {
      response = await chrome.runtime.sendMessage(message);
    } else {
      try { response = await chrome.tabs.sendMessage(tab.id, message); } catch (_) {}
      if (response?.ocrProtocol !== 3) {
        try {
          const injection = await chrome.runtime.sendMessage({
            type: 'INJECT_CONTENT_SCRIPT',
            tabId: tab.id,
          });
          if (!injection?.ok) throw new Error(injection?.error || '无法在当前页面启动插件');
          response = await chrome.tabs.sendMessage(tab.id, message);
        } catch (error) {
          throw new Error(`当前页面无法启动区域 OCR：${formatError(error)}`);
        }
      }
    }
    if (!response?.ok || response.ocrProtocol !== 3) {
      throw new Error(response?.message || '当前页面无法启动区域 OCR');
    }
    window.close();
  } catch (error) {
    setStatus(ocrStatus, formatError(error) || '当前页面无法使用区域 OCR', 'error');
  }
});

function formatError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  if (message && /Cannot access|chrome:\/\/|extensions gallery|Web Store|Missing host permission/i.test(message)) {
    return '浏览器禁止插件在这个页面运行。Chrome 内置页、应用商店和其他扩展页面不能使用区域 OCR';
  }
  if (message && /file:\/\/|file URL/i.test(message)) {
    return '本地文件需要先在扩展详情中开启“允许访问文件网址”';
  }
  if (message) return message;
  try {
    const text = String(error);
    return text === '[object Object]' ? '浏览器拒绝了这个操作' : text;
  } catch (_) {
    return '浏览器拒绝了这个操作';
  }
}
