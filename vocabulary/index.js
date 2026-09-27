const state = {
  entries: [],
  filter: 'pending',
  search: '',
  source: '',
  selected: new Set(),
};

const listEl = document.getElementById('word-list');
const emptyEl = document.getElementById('empty-state');
const noticeEl = document.getElementById('notice');
const selectVisible = document.getElementById('select-visible');
const sourceFilter = document.getElementById('source-filter');
let noticeTimer = null;

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '操作失败');
  return response.result;
}

async function loadEntries(preserveSelection = true) {
  const data = await send({ type: 'VOCAB_LIST' });
  state.entries = Array.isArray(data.entries) ? data.entries : [];
  if (preserveSelection) {
    const validIds = new Set(state.entries.map((entry) => entry.id));
    state.selected = new Set([...state.selected].filter((id) => validIds.has(id)));
  } else {
    state.selected.clear();
  }
  updateSourceOptions();
  await updateSummary();
  render();
}

function localDate(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '日期未知';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes >= 1024 * 100 ? 0 : 1)} KB`;
}

async function updateSummary() {
  const pending = state.entries.filter((entry) => !entry.organizedAt).length;
  const organized = state.entries.length - pending;
  const bytes = await chrome.storage.local.getBytesInUse('vocabularyDataV1');
  document.getElementById('pending-count').textContent = String(pending);
  document.getElementById('organized-count').textContent = String(organized);
  document.getElementById('all-count').textContent = String(state.entries.length);
  document.getElementById('summary').textContent = `${state.entries.length} 个单词 · ${pending} 个未整理 · 占用 ${formatBytes(bytes)}`;
}

function updateSourceOptions() {
  const current = state.source;
  const sources = new Map();
  for (const entry of state.entries) {
    for (const occurrence of entry.contexts || []) {
      const source = occurrence.source || {};
      const id = source.documentId || source.url || source.title;
      if (id && !sources.has(id)) sources.set(id, source.title || id);
    }
  }
  const options = ['<option value="">全部来源</option>'];
  [...sources.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'))
    .forEach(([id, title]) => options.push(`<option value="${escapeHtml(id)}">${escapeHtml(title)}</option>`));
  sourceFilter.innerHTML = options.join('');
  if (sources.has(current)) sourceFilter.value = current;
  else state.source = '';
}

function visibleEntries() {
  const query = state.search.toLocaleLowerCase('zh-CN');
  return state.entries.filter((entry) => {
    if (state.filter === 'pending' && entry.organizedAt) return false;
    if (state.filter === 'organized' && !entry.organizedAt) return false;
    if (state.source && !(entry.contexts || []).some((item) => {
      const source = item.source || {};
      return (source.documentId || source.url || source.title) === state.source;
    })) return false;
    if (!query) return true;
    const haystack = [
      entry.word,
      ...(entry.contexts || []).flatMap((item) => [item.context, item.source?.title, item.source?.url]),
    ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
    return haystack.includes(query);
  });
}

function render() {
  const visible = visibleEntries();
  const groups = new Map();
  for (const entry of visible) {
    const date = localDate(entry.lastSeenAt || entry.collectedAt);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(entry);
  }

  listEl.innerHTML = [...groups.entries()].map(([date, entries]) => `
    <section class="date-group">
      <div class="date-heading"><h2>${date}</h2><span>${entries.length} 个单词</span></div>
      <div class="cards">${entries.map(renderEntry).join('')}</div>
    </section>
  `).join('');
  emptyEl.hidden = visible.length > 0;
  updateSelectionUi(visible);
}

function renderEntry(entry) {
  const headword = displayHeadword(entry);
  const occurrence = entry.contexts?.[entry.contexts.length - 1] || {};
  const source = occurrence.source || {};
  const sourceText = [source.title, source.page ? `第 ${source.page} 页` : ''].filter(Boolean).join(' · ');
  return `
    <article class="word-card${state.selected.has(entry.id) ? ' selected' : ''}" data-id="${escapeHtml(entry.id)}">
      <input class="word-checkbox" type="checkbox" aria-label="选择 ${escapeHtml(headword)}" ${state.selected.has(entry.id) ? 'checked' : ''}>
      <div class="word-main">
        <div class="word-line"><span class="word">${escapeHtml(headword)}</span>${entry.organizedAt ? '<span class="badge">已整理</span>' : ''}</div>
        ${occurrence.context ? `<p class="context">${escapeHtml(occurrence.context)}</p>` : ''}
        ${sourceText ? `<div class="source">${escapeHtml(sourceText)}</div>` : ''}
      </div>
      <div class="word-meta">遇到 ${entry.count || 1} 次${entry.organizedAt ? `<br>整理于 ${localDate(entry.organizedAt)}` : ''}</div>
    </article>
  `;
}

function displayHeadword(entry) {
  const original = String(entry?.word || entry?.key || '').trim();
  const normalized = String(entry?.key || original.toLocaleLowerCase('en-US')).trim();
  const letters = original.replace(/[^\p{L}\p{M}]/gu, '');
  const upper = letters.toLocaleUpperCase('en-US');
  const lower = letters.toLocaleLowerCase('en-US');
  const isShortAcronym = letters.length >= 2 && letters.length <= 6 && letters === upper && upper !== lower;
  const tail = original.slice(1);
  const hasMixedCase = original !== original.toLocaleLowerCase('en-US')
    && original !== original.toLocaleUpperCase('en-US');
  const hasInternalCapital = hasMixedCase && tail !== tail.toLocaleLowerCase('en-US');
  return isShortAcronym || hasInternalCapital ? original : normalized;
}

function updateSelectionUi(visible = visibleEntries()) {
  const selectedCount = state.selected.size;
  document.getElementById('selection-count').textContent = `已选 ${selectedCount} 个`;
  for (const id of ['copy-organize', 'copy-words', 'mark-organized', 'mark-pending', 'delete-selected']) {
    document.getElementById(id).disabled = selectedCount === 0;
  }
  const visibleIds = visible.map((entry) => entry.id);
  const selectedVisible = visibleIds.filter((id) => state.selected.has(id)).length;
  selectVisible.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
}

function selectedEntries() {
  return state.entries.filter((entry) => state.selected.has(entry.id));
}

function buildMarkdown(entries) {
  const groups = new Map();
  const sorted = [...entries].sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt));
  for (const entry of sorted) {
    const date = localDate(entry.lastSeenAt || entry.collectedAt);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(entry);
  }
  const sections = [];
  for (const [date, words] of groups) {
    const lines = [`## ${date}`, ''];
    for (const entry of words) {
      const occurrence = entry.contexts?.[entry.contexts.length - 1] || {};
      const source = occurrence.source || {};
      lines.push(`- **${displayHeadword(entry)}**`);
      if (occurrence.context) lines.push(`  - 原句：${occurrence.context}`);
      if (source.title) lines.push(`  - 来源：${source.title}${source.page ? `，第 ${source.page} 页` : ''}`);
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('浏览器没有允许复制，请手动重试');
  }
}

function showNotice(message, type = '') {
  clearTimeout(noticeTimer);
  noticeEl.textContent = message;
  noticeEl.className = `notice visible${type ? ` ${type}` : ''}`;
  noticeTimer = setTimeout(() => { noticeEl.className = 'notice'; }, 5000);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

listEl.addEventListener('change', (event) => {
  const checkbox = event.target.closest('.word-checkbox');
  if (!checkbox) return;
  const card = checkbox.closest('.word-card');
  const id = card.dataset.id;
  if (checkbox.checked) state.selected.add(id);
  else state.selected.delete(id);
  card.classList.toggle('selected', checkbox.checked);
  updateSelectionUi();
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.filter = tab.dataset.filter;
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    render();
  });
});

document.getElementById('search').addEventListener('input', (event) => {
  state.search = event.target.value.trim();
  render();
});

sourceFilter.addEventListener('change', () => {
  state.source = sourceFilter.value;
  render();
});

selectVisible.addEventListener('change', () => {
  const ids = visibleEntries().map((entry) => entry.id);
  if (selectVisible.checked) ids.forEach((id) => state.selected.add(id));
  else ids.forEach((id) => state.selected.delete(id));
  render();
});

document.getElementById('copy-organize').addEventListener('click', async () => {
  const entries = selectedEntries();
  if (!entries.length) return;
  try {
    await copyText(buildMarkdown(entries));
    await send({ type: 'VOCAB_SET_ORGANIZED', ids: entries.map((entry) => entry.id), organized: true });
    state.selected.clear();
    await loadEntries();
    showNotice(`已复制 ${entries.length} 个单词，并记录整理日期`, 'success');
  } catch (error) {
    showNotice(error.message || '复制失败，未修改整理状态', 'error');
  }
});

document.getElementById('copy-words').addEventListener('click', async () => {
  const entries = selectedEntries();
  if (!entries.length) return;
  try {
    await copyText(entries.map(displayHeadword).join('\n'));
    showNotice(`已复制 ${entries.length} 个纯单词，不改变整理状态`, 'success');
  } catch (error) {
    showNotice(error.message || '复制失败', 'error');
  }
});

document.getElementById('mark-organized').addEventListener('click', async () => {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    await send({ type: 'VOCAB_SET_ORGANIZED', ids, organized: true });
    state.selected.clear();
    await loadEntries();
    showNotice(`已标记 ${ids.length} 个单词为已整理`, 'success');
  } catch (error) {
    showNotice(error.message || '标记失败', 'error');
  }
});

document.getElementById('mark-pending').addEventListener('click', async () => {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    await send({ type: 'VOCAB_SET_ORGANIZED', ids, organized: false });
    state.selected.clear();
    await loadEntries();
    showNotice(`已撤销 ${ids.length} 个单词的整理状态`, 'success');
  } catch (error) {
    showNotice(error.message || '撤销失败', 'error');
  }
});

document.getElementById('delete-selected').addEventListener('click', async () => {
  const ids = [...state.selected];
  if (!ids.length || !confirm(`确定删除选中的 ${ids.length} 个单词吗？`)) return;
  try {
    await send({ type: 'VOCAB_DELETE', ids });
    state.selected.clear();
    await loadEntries();
    showNotice(`已删除 ${ids.length} 个单词`, 'success');
  } catch (error) {
    showNotice(error.message || '删除失败', 'error');
  }
});

document.getElementById('export-json').addEventListener('click', async () => {
  try {
    const data = await send({ type: 'VOCAB_LIST' });
    const exportData = { ...data, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `word-explainer-vocabulary-${localDate(new Date().toISOString())}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showNotice('JSON 已交给浏览器下载，可保存到任意文件夹', 'success');
  } catch (error) {
    showNotice(error.message || '导出失败', 'error');
  }
});

document.getElementById('import-json').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', async (event) => {
  const [file] = event.target.files || [];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('这个备份文件超过 10 MB，浏览器通常无法完整保存。请拆分后再导入');
    }
    const parsed = JSON.parse(await file.text());
    const result = await send({ type: 'VOCAB_IMPORT_MERGE', data: parsed });
    await loadEntries(false);
    const deletedText = result.deleted ? `，同步删除 ${result.deleted}` : '';
    showNotice(`合并完成：新增 ${result.added}，合并 ${result.merged}${deletedText}，跳过 ${result.skipped}`, 'success');
  } catch (error) {
    showNotice(error.message || '无法导入这个 JSON 文件', 'error');
  }
});

loadEntries(false).catch((error) => showNotice(error.message || '无法读取生词本', 'error'));
