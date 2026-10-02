'use strict';

// Optional browser checks: install Playwright or provide it through NODE_PATH.
// Uses isolated pages and an in-memory extension API; never calls the model.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8">
<style>body{margin:0;font:22px/1.6 sans-serif;min-height:1800px}p{margin:0}#word{position:absolute;left:2px;top:220px}#player{position:absolute;left:220px;top:340px;width:360px;height:160px;background:#222;color:white;user-select:none}#blank{position:absolute;left:10px;top:410px;width:140px;height:90px}textarea{position:absolute;left:20px;top:540px}</style>
<p id="word">Extraordinary</p><div id="player" class="bpx-player-container"><video></video><div id="overlay">Video overlay</div></div><div id="blank"></div><textarea id="search">The evening light fell softly across the page.</textarea>
<script src="/positioning.js"></script><script src="/output-formatting.js"></script><script src="/shortcuts.js"></script><script src="/theme.js"></script><script src="/content.js"></script></html>`;
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (name === '/fixture') { res.setHeader('Content-Type', 'text/html'); res.end(fixture); return; }
  const filename = path.resolve(root, '.' + name);
  if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(filename));
  } catch (_) { res.writeHead(404).end(); }
});

function mockChrome() {
  const stored = { enabled: true, showQuickSave: true, apiKey: 'sk-fixture', theme: 'light' };
  const storageListeners = [];
  window.requests = [];
  window.ports = [];
  window.chrome = {
    commands: { async getAll() { return [{ name: '_execute_action', shortcut: 'Ctrl+Shift+X' }]; } },
    storage: {
      local: {
        get(keys, callback) {
          const names = Array.isArray(keys) ? keys : Object.keys(keys);
          const data = Object.fromEntries(names.map((key) => [key, stored[key] ?? keys[key]]));
          if (callback) { callback(data); return; }
          return Promise.resolve(data);
        },
        async set(values) {
          const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: stored[key], newValue: value }]));
          Object.assign(stored, values);
          storageListeners.forEach((fn) => fn(changes, 'local'));
        },
        async remove() {},
      },
      onChanged: { addListener(fn) { storageListeners.push(fn); } },
    },
    runtime: {
      getURL(file) { return location.origin + '/' + file; },
      onMessage: { addListener() {} },
      async sendMessage() { return { ok: true }; },
      connect() {
        const listeners = [], disconnects = [];
        const port = {
          disconnected: false,
          onMessage: { addListener(fn) { listeners.push(fn); } },
          onDisconnect: { addListener(fn) { disconnects.push(fn); } },
          postMessage(msg) { window.requests.push(msg); },
          emit(msg) { listeners.forEach((fn) => fn(msg)); },
          disconnect() { if (port.disconnected) return; port.disconnected = true; disconnects.forEach((fn) => fn()); },
        };
        window.ports.push(port);
        return port;
      },
    },
  };
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  let count = 0;
  const passed = (name) => { count++; console.log('✓ ' + name); };
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.WE_BROWSER_CHANNEL ? { channel: process.env.WE_BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(mockChrome);
    await page.goto(base + '/popup/popup.html');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'quick-text');
    assert.equal(await page.locator('#settings').getAttribute('open'), null);
    await page.evaluate(() => navigator.clipboard.writeText('The evening light fell softly across the page.'));
    await page.locator('#quick-text').press('Control+V');
    await page.waitForFunction(() => requests.length === 1);
    assert.equal(await page.evaluate(() => requests[0].text), 'The evening light fell softly across the page.');
    await page.evaluate(() => {
      ports[0].emit({ type: 'CHUNK', text: '**译文：**\n傍晚的光线柔和地洒在书页上。<img src=x onerror=alert(1)>' });
      ports[0].emit({ type: 'DONE' });
    });
    assert.equal(await page.locator('#quick-result img').count(), 0);
    assert.match(await page.locator('#quick-result').innerText(), /傍晚的光线/);
    assert.equal(await page.locator('#quick-status').innerText(), '翻译完成');
    passed('唤醒界面自动聚焦、粘贴自动翻译、结果安全渲染');

    await page.locator('#quick-text').fill('first');
    await page.locator('#quick-translate').click();
    await page.locator('#quick-text').fill('second');
    await page.locator('#quick-translate').click();
    await page.evaluate(() => {
      ports[1].emit({ type: 'CHUNK', text: '过时的结果' });
      ports[2].emit({ type: 'CHUNK', text: '第二次结果' });
      ports[2].emit({ type: 'ERROR', message: '模拟网络错误' });
    });
    assert.equal(await page.locator('#quick-result').innerText(), '第二次结果');
    assert.equal(await page.locator('#quick-status').innerText(), '模拟网络错误');
    assert.equal(await page.evaluate(() => ports[1].disconnected), true);
    await page.locator('#quick-clear').click();
    assert.equal(await page.locator('#quick-text').inputValue(), '');
    await page.locator('#quick-text').fill('retry');
    await page.locator('#quick-text').press('Control+Enter');
    await page.evaluate(() => ports.at(-1).disconnect());
    assert.match(await page.locator('#quick-status').innerText(), /连接中断/);
    passed('重复请求取消旧结果，错误保留已有输出，断连提示，清空及键盘提交');

    await page.goto(base + '/fixture');
    await page.waitForFunction(() => document.getElementById('we-extension-root')?.shadowRoot.adoptedStyleSheets.length);
    const triggers = page.locator('.we-trigger:not(.we-exit)');
    // A real reverse drag finishing almost at the screen's left edge.
    const word = await page.locator('#word').boundingBox();
    await page.mouse.move(word.x + word.width - 1, word.y + 16);
    await page.mouse.down();
    await page.mouse.move(2, word.y + 16, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(520);
    assert.equal(await triggers.count(), 3);
    for (const trigger of await triggers.all()) {
      const box = await trigger.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 800);
      assert.ok(box.y >= 0 && box.y + box.height <= 700);
    }
    await page.locator('.we-trigger-zh:not(.we-exit)').click();
    assert.equal(await page.evaluate(() => requests.length), 1);
    passed('真实从右向左划选，左边缘三个按钮可见且可以点击');

    await page.mouse.dblclick(300, 400);
    await page.waitForTimeout(100);
    assert.equal(await triggers.count(), 0);
    passed('保留旧选区时双击模拟 B 站播放器不触发');

    await page.evaluate(() => {
      getSelection().removeAllRanges();
      const node = document.getElementById('word').firstChild;
      document.caretPositionFromPoint = () => ({ offsetNode: node, offset: 3 });
    });
    await page.locator('#blank').dblclick();
    await page.waitForTimeout(100);
    assert.equal(await triggers.count(), 0);
    passed('空白区双击即使光标 API 返回邻近单词也不触发');

    await page.locator('#word').dblclick();
    await page.waitForTimeout(100);
    assert.equal(await triggers.count(), 3);
    await page.locator('#search').evaluate((input) => {
      input.focus(); input.setSelectionRange(0, input.value.length);
      input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 40, clientY: 560, button: 0 }));
    });
    await page.waitForTimeout(100);
    assert.equal(await triggers.count(), 1);
    passed('普通文字双击与网页搜索输入框划选仍可用');

    // Check geometry at all four edges, with the actual CSS and animation.
    for (const [x, y] of [[1, 1], [799, 1], [1, 699], [799, 699]]) {
      await page.locator('#word').evaluate((element, point) => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: point[0], clientY: point[1], button: 0 }));
      }, [x, y]);
      await page.waitForTimeout(520);
      assert.equal(await triggers.count(), 3);
      for (const trigger of await triggers.all()) {
        const box = await trigger.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 800);
        assert.ok(box.y >= 0 && box.y + box.height <= 700);
      }
    }
    passed('真实按钮样式在屏幕四角不越界');
    assert.deepEqual(errors, []);
    console.log(`\n${count} 组浏览器交互检查通过。`);
  } finally {
    await browser?.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
