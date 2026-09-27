'use strict';

const assert = require('node:assert/strict');
const manifest = require('../manifest.json');
const { isPageOcrShortcut } = require('../shortcuts.js');
const {
  calculatePopoverPlacement,
  rectanglesOverlap,
} = require('../positioning.js');
const {
  ExpiringLruCache,
  buildCacheKey,
  buildExplanationUserPayload,
  extractSseEvents,
  getOutputTokenLimit,
  isRetryableStatus,
} = require('../background-core.js');
const {
  analyzeTextLines,
  chooseOcrPageSegmentation,
  getTextLineRegions,
} = require('../ocr-layout.js');
const {
  normalizeExplanationMarkdown,
} = require('../output-formatting.js');

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  process.stdout.write(`✓ ${name}\n`);
}

function placementRect(placement) {
  return {
    left: placement.left,
    top: placement.top,
    right: placement.left + placement.width,
    bottom: placement.top + placement.height,
  };
}

test('三行选区与大翻译框保持分离', () => {
  const anchor = { left: 372, right: 1580, top: 133, bottom: 232 };
  const placement = calculatePopoverPlacement({
    anchor,
    width: 616,
    height: 702,
    viewportWidth: 1630,
    viewportHeight: 950,
    gap: 10,
    edgePadding: 8,
  });
  assert.equal(placement.side, 'below');
  assert.equal(placement.top, 242);
  assert.equal(placement.autoFitHeight, true);
  assert.equal(rectanglesOverlap(placementRect(placement), anchor), false);
});

test('只有鼠标落点时优先上下避让', () => {
  const anchor = { left: 865, right: 865, top: 98, bottom: 138, preferVertical: true };
  const placement = calculatePopoverPlacement({
    anchor,
    width: 616,
    height: 702,
    viewportWidth: 1280,
    viewportHeight: 854,
    gap: 10,
    edgePadding: 8,
  });
  assert.equal(placement.side, 'below');
  assert.equal(placement.top, 148);
  assert.equal(rectanglesOverlap(placementRect(placement), anchor), false);
});

test('选区靠近底部时放到上方', () => {
  const anchor = { left: 180, right: 720, top: 700, bottom: 730 };
  const placement = calculatePopoverPlacement({
    anchor,
    width: 380,
    height: 322,
    viewportWidth: 1280,
    viewportHeight: 854,
    gap: 10,
    edgePadding: 8,
  });
  assert.equal(placement.side, 'above');
  assert.equal(rectanglesOverlap(placementRect(placement), anchor), false);
});

test('SSE 在任意字节位置拆分后仍能还原事件', () => {
  const source = [
    'data: {"choices":[{"delta":{"content":"声乐"}}]}',
    'data: {"choices":[{"delta":{"content":"老师"}}]}',
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
  for (let split = 1; split < source.length; split += 1) {
    let buffer = '';
    const events = [];
    for (const chunk of [source.slice(0, split), source.slice(split)]) {
      buffer += chunk;
      const extracted = extractSseEvents(buffer);
      buffer = extracted.remainder;
      events.push(...extracted.events);
    }
    assert.equal(buffer, '');
    assert.deepEqual(events, source.trim().split(/\n\n/));
  }
});

test('输出上限随长文长度增长且不超过 8000', () => {
  assert.equal(getOutputTokenLimit('WORD', 'word'), 700);
  assert.equal(getOutputTokenLimit('PHRASE', 'in context'), 900);
  assert.equal(getOutputTokenLimit('PASSAGE', 'short sentence'), 1200);
  assert.equal(getOutputTokenLimit('PASSAGE', 'x'.repeat(20_000)), 8000);
});

test('短时缓存支持过期与 LRU 淘汰', () => {
  const cache = new ExpiringLruCache(2, 100);
  cache.set('a', 'A', 0);
  cache.set('b', 'B', 1);
  assert.equal(cache.get('a', 2), 'A');
  cache.set('c', 'C', 3);
  assert.equal(cache.get('b', 4), null);
  assert.equal(cache.get('a', 101), null);
});

test('只重试临时 HTTP 状态', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(status), true);
  for (const status of [400, 401, 403, 404]) assert.equal(isRetryableStatus(status), false);
});

test('OCR 请求带有独立来源标记且不会复用普通划词缓存', () => {
  const ocrPayload = buildExplanationUserPayload('PASSAGE', 'Recognized text', 'OCR');
  assert.deepEqual(ocrPayload, {
    input_type: 'PASSAGE',
    output_scope: 'STANDARD',
    source_kind: 'OCR',
    source_text: 'Recognized text',
  });
  assert.notEqual(
    buildCacheKey('model', 'ZH', 'PASSAGE', 'Recognized text', 'OCR'),
    buildCacheKey('model', 'ZH', 'PASSAGE', 'Recognized text', 'SELECTION')
  );
});

test('普通英文的冗余语言状态会从最终显示中移除', () => {
  const output = normalizeExplanationMarkdown(
    '**语言：英文（无明显拼写错误）**\n\n**译文：**\n这是译文。',
    'PASSAGE'
  );
  assert.equal(output, '**译文：**\n这是译文。');
});

test('多段译文只保留标签加粗并统一正文格式', () => {
  const output = normalizeExplanationMarkdown(
    '**译文：**\n**第一段译文。**\n\n**第二段译文。**\n\n- **phrase**：说明',
    'PASSAGE'
  );
  assert.equal(output, '**译文：**\n第一段译文。\n\n第二段译文。\n\n- **phrase**：说明');
});

function createSyntheticTextImage(width, height, lineBands) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (const [top, bottom] of lineBands) {
    for (let x = 8; x < width - 8; x += 14) {
      const glyphWidth = Math.min(8, width - 8 - x);
      for (let y = top; y <= bottom; y += 1) {
        for (let glyphX = x; glyphX < x + glyphWidth; glyphX += 1) {
          const index = (y * width + glyphX) * 4;
          data[index] = 20;
          data[index + 1] = 20;
          data[index + 2] = 20;
        }
      }
    }
  }
  return { data, width, height };
}

test('宽幅两行 OCR 区域不会再误判为单行', () => {
  const image = createSyntheticTextImage(520, 92, [[14, 30], [54, 70]]);
  const analysis = analyzeTextLines(image, image.width, image.height);
  assert.equal(analysis.lineCount, 2);
  const selected = chooseOcrPageSegmentation(image, image.width, image.height, {
    SINGLE_LINE: 'single-line',
    SINGLE_BLOCK: 'single-block',
    AUTO: 'auto',
  });
  assert.equal(selected.mode, 'single-block');
});

test('明确的单行 OCR 区域仍使用单行模式', () => {
  const image = createSyntheticTextImage(420, 64, [[20, 38]]);
  const selected = chooseOcrPageSegmentation(image, image.width, image.height, {
    SINGLE_LINE: 'single-line',
    SINGLE_BLOCK: 'single-block',
    AUTO: 'auto',
  });
  assert.equal(selected.analysis.lineCount, 1);
  assert.equal(selected.mode, 'single-line');
});

test('网页 OCR 使用 Win+Shift+Y，不再占用扩展快捷键槽', () => {
  assert.equal(manifest.commands['start-page-ocr'], undefined);
  assert.equal(manifest.commands['translate-selection-direct'].suggested_key.default, 'Ctrl+Shift+X');
  assert.equal(isPageOcrShortcut({ code: 'KeyY', shiftKey: true, metaKey: true }, 'Win32'), true);
  assert.equal(isPageOcrShortcut({ code: 'KeyY', shiftKey: true, metaKey: false }, 'Win32'), false);
  assert.equal(isPageOcrShortcut({ code: 'KeyY', shiftKey: true, metaKey: true, repeat: true }, 'Win32'), false);
  assert.equal(isPageOcrShortcut({ code: 'KeyY', shiftKey: true, metaKey: true }, 'MacIntel'), false);
});

test('多行 OCR 会生成互不重叠且保持顺序的逐行识别区域', () => {
  const image = createSyntheticTextImage(520, 110, [[10, 25], [45, 61], [82, 98]]);
  const analysis = analyzeTextLines(image, image.width, image.height);
  const regions = getTextLineRegions(analysis, image.width, image.height);
  assert.equal(regions.length, 3);
  assert.equal(regions.every((region) => region.width === image.width && region.height > 0), true);
  assert.equal(regions[0].top + regions[0].height <= regions[1].top, true);
  assert.equal(regions[1].top + regions[1].height <= regions[2].top, true);
  assert.equal(regions[0].textTop <= 10 && regions[0].textBottom >= 26, true);
  assert.equal(regions[2].textTop <= 82 && regions[2].textBottom >= 99, true);
});

test('单行或行数过多时不会强行拆分 OCR', () => {
  const oneLine = createSyntheticTextImage(420, 64, [[20, 38]]);
  const oneLineAnalysis = analyzeTextLines(oneLine, oneLine.width, oneLine.height);
  assert.deepEqual(getTextLineRegions(oneLineAnalysis, oneLine.width, oneLine.height), []);

  const manyBands = Array.from({ length: 13 }, (_, index) => [index * 7 + 1, index * 7 + 4]);
  const manyLines = createSyntheticTextImage(420, 96, manyBands);
  const manyLineAnalysis = analyzeTextLines(manyLines, manyLines.width, manyLines.height);
  assert.deepEqual(getTextLineRegions(manyLineAnalysis, manyLines.width, manyLines.height), []);
});

process.stdout.write(`\n${passed} 项回归测试全部通过。\n`);
