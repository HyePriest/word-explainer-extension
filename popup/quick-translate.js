(function () {
  'use strict';
  const input = document.getElementById('quick-text');
  const result = document.getElementById('quick-result');
  const status = document.getElementById('quick-status');
  const copy = document.getElementById('quick-copy');
  const { classifyInput, normalizeExplanationMarkdown, parseMarkdown } = WordExplainerOutputFormatting;
  let port = null;
  let pasteTimer = null;
  let revision = 0;

  function setStatus(text, error = false) {
    status.textContent = text;
    status.className = error ? 'status error' : 'status';
  }

  function cancel() {
    revision += 1;
    clearTimeout(pasteTimer);
    const previous = port;
    port = null;
    try { previous?.disconnect(); } catch (_) {}
  }

  function translate() {
    cancel();
    const text = input.value.trim();
    if (!text || text.length > 20000) {
      setStatus(text ? '文字超过 20,000 字符，请分段翻译' : '请先粘贴或输入文字', true);
      return;
    }
    const inputType = classifyInput(text);
    const currentRevision = revision;
    let markdown = '';
    result.replaceChildren();
    result.hidden = true;
    copy.disabled = true;
    setStatus('正在翻译…');
    try {
      const requestPort = chrome.runtime.connect({ name: 'word-explainer' });
      port = requestPort;
      const finish = (message, error = false) => {
        if (port !== requestPort) return;
        port = null;
        setStatus(message, error);
        requestPort.disconnect();
      };
      requestPort.onMessage.addListener((message) => {
        if (port !== requestPort || revision !== currentRevision) return;
        if (message.type === 'CHUNK') {
          markdown += message.text;
          result.innerHTML = parseMarkdown(normalizeExplanationMarkdown(markdown, inputType));
          result.hidden = false;
          copy.disabled = false;
        } else if (message.type === 'DONE') {
          finish('翻译完成');
        } else if (message.type === 'ERROR') {
          finish(message.message || '翻译失败，请重试', true);
        }
      });
      requestPort.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        if (port !== requestPort) return;
        port = null;
        setStatus(error?.message || '连接中断，请点击翻译重试', true);
      });
      requestPort.postMessage({ type: 'EXPLAIN', text, mode: 'ZH', inputType });
    } catch (_) {
      cancel();
      setStatus('无法连接插件，请重新打开后重试', true);
    }
  }

  input.addEventListener('paste', () => {
    // 等浏览器把本次粘贴应用到输入框，不读取用户剪贴板。
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(translate, 0);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      translate();
    }
  });
  document.getElementById('quick-translate').addEventListener('click', translate);
  document.getElementById('quick-clear').addEventListener('click', () => {
    cancel();
    input.value = '';
    result.replaceChildren();
    result.hidden = true;
    copy.disabled = true;
    setStatus('');
    input.focus();
  });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(result.innerText);
      setStatus('已复制');
    } catch (_) { setStatus('复制失败，可直接选中结果复制', true); }
  });
  window.addEventListener('pagehide', cancel);
  input.focus();

  // 已安装扩展更新时，浏览器可能保留旧绑定或因冲突而未分配快捷键。
  chrome.commands.getAll().then((commands) => {
    const shortcut = commands.find((command) => command.name === '_execute_action')?.shortcut;
    document.getElementById('launch-shortcut-hint').textContent = shortcut
      ? `${shortcut} 打开 · Chrome 新标签页也能用`
      : '快捷键未分配：请到扩展程序 → 键盘快捷键，设置“激活扩展程序”为 Ctrl+Shift+X';
  }).catch(() => {});
})();
