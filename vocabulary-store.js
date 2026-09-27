// ============================================================
//  vocabulary-store.js — 生词本持久化与合并逻辑
//  由后台 Service Worker 统一读写，避免多个页面同时修改造成覆盖。
// ============================================================

const VocabularyStore = (() => {
  'use strict';

  const STORAGE_KEY = 'vocabularyDataV1';
  const FORMAT = 'word-explainer-vocabulary';
  const VERSION = 2;
  const MAX_CONTEXTS_PER_WORD = 5;
  const MAX_CONTEXT_LENGTH = 500;
  const MAX_TITLE_LENGTH = 240;
  const MAX_URL_LENGTH = 2000;
  const STORAGE_QUOTA_BYTES = 10 * 1024 * 1024;
  const SAFE_STORAGE_BYTES = Math.floor(STORAGE_QUOTA_BYTES * 0.9);
  let mutationQueue = Promise.resolve();

  function emptyData() {
    return { format: FORMAT, version: VERSION, entries: [], deletedWords: [] };
  }

  function cleanWord(rawWord) {
    if (typeof rawWord !== 'string') return '';
    const trimmed = rawWord
      .normalize('NFKC')
      .replace(/[’‘]/g, "'")
      .replace(/^[^\p{Script=Latin}\p{M}]+|[^\p{Script=Latin}\p{M}'-]+$/gu, '')
      .trim();
    if (!trimmed || trimmed.length > 120) return '';
    if (!/^[\p{Script=Latin}\p{M}]+(?:['-][\p{Script=Latin}\p{M}]+)*$/u.test(trimmed)) return '';
    return trimmed;
  }

  function normalizeWord(rawWord) {
    return cleanWord(rawWord).toLocaleLowerCase('en-US');
  }

  function cleanString(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function validIso(value, fallback = '') {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fallback;
    return new Date(value).toISOString();
  }

  function createId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `word-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function sanitizeSource(rawSource = {}) {
    const kind = ['pdf', 'web', 'file', 'ocr'].includes(rawSource.kind) ? rawSource.kind : 'web';
    const page = Number.isFinite(Number(rawSource.page)) && Number(rawSource.page) > 0
      ? Math.round(Number(rawSource.page))
      : null;
    return {
      kind,
      title: cleanString(rawSource.title, MAX_TITLE_LENGTH) || '未命名来源',
      url: cleanString(rawSource.url, MAX_URL_LENGTH),
      documentId: cleanString(rawSource.documentId, 240),
      page,
    };
  }

  function createOccurrence(rawOccurrence = {}, fallbackAt = new Date().toISOString()) {
    const context = cleanString(rawOccurrence.context, MAX_CONTEXT_LENGTH);
    const source = sanitizeSource(rawOccurrence.source);
    const capturedAt = validIso(rawOccurrence.capturedAt, fallbackAt);
    const occurrenceKey = [
      source.kind,
      source.documentId || source.url || source.title,
      source.page || '',
      context.toLocaleLowerCase('en-US'),
    ].join('|');
    return { context, source, capturedAt, occurrenceKey };
  }

  function sanitizeEntry(rawEntry) {
    if (!rawEntry || typeof rawEntry !== 'object') return null;
    const key = normalizeWord(rawEntry.word || rawEntry.key);
    if (!key) return null;
    const now = new Date().toISOString();
    const collectedAt = validIso(rawEntry.collectedAt || rawEntry.firstSeenAt, now);
    const firstSeenAt = validIso(rawEntry.firstSeenAt, collectedAt);
    const lastSeenAt = validIso(rawEntry.lastSeenAt, collectedAt);
    const organizedAt = rawEntry.organizedAt ? validIso(rawEntry.organizedAt, '') : null;
    const contexts = [];
    const seen = new Set();
    const rawContexts = Array.isArray(rawEntry.contexts)
      ? rawEntry.contexts
      : [{ context: rawEntry.context, source: rawEntry.source, capturedAt: collectedAt }];

    for (const rawContext of rawContexts) {
      const occurrence = createOccurrence(rawContext, collectedAt);
      if (seen.has(occurrence.occurrenceKey)) continue;
      seen.add(occurrence.occurrenceKey);
      contexts.push(occurrence);
      if (contexts.length >= MAX_CONTEXTS_PER_WORD) break;
    }

    return {
      id: cleanString(rawEntry.id, 160) || createId(),
      key,
      word: cleanWord(rawEntry.word) || key,
      collectedAt,
      firstSeenAt,
      lastSeenAt,
      organizedAt: organizedAt && Date.parse(organizedAt) >= Date.parse(lastSeenAt) ? organizedAt : null,
      count: Math.max(1, Math.round(Number(rawEntry.count) || 1)),
      contexts,
    };
  }

  function sanitizeDeletion(rawDeletion) {
    if (!rawDeletion || typeof rawDeletion !== 'object') return null;
    const key = normalizeWord(rawDeletion.key || rawDeletion.word);
    const deletedAt = validIso(rawDeletion.deletedAt, '');
    if (!key || !deletedAt) return null;
    return { key, deletedAt };
  }

  function mergeDeletions(...groups) {
    const byKey = new Map();
    for (const rawDeletion of groups.flat()) {
      const deletion = sanitizeDeletion(rawDeletion);
      if (!deletion) continue;
      const previous = byKey.get(deletion.key);
      if (!previous || Date.parse(deletion.deletedAt) > Date.parse(previous.deletedAt)) {
        byKey.set(deletion.key, deletion);
      }
    }
    return byKey;
  }

  function resolveEntriesAndDeletions(entries, deletedWords) {
    const deletionMap = mergeDeletions(deletedWords);
    const keptEntries = [];
    for (const rawEntry of entries) {
      const entry = sanitizeEntry(rawEntry);
      if (!entry) continue;
      const deletion = deletionMap.get(entry.key);
      if (deletion && Date.parse(deletion.deletedAt) >= Date.parse(entry.lastSeenAt)) continue;
      if (deletion) deletionMap.delete(entry.key);
      keptEntries.push(entry);
    }
    return { entries: keptEntries, deletedWords: [...deletionMap.values()] };
  }

  async function readData() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const raw = result[STORAGE_KEY];
    if (!raw || !Array.isArray(raw.entries)) return emptyData();
    return {
      format: FORMAT,
      version: VERSION,
      entries: raw.entries.map(sanitizeEntry).filter(Boolean),
      deletedWords: Array.isArray(raw.deletedWords) ? raw.deletedWords.map(sanitizeDeletion).filter(Boolean) : [],
    };
  }

  async function writeData(data) {
    const resolved = resolveEntriesAndDeletions(data.entries, data.deletedWords);
    const cleanData = {
      format: FORMAT,
      version: VERSION,
      entries: resolved.entries,
      deletedWords: resolved.deletedWords,
    };
    const value = { [STORAGE_KEY]: cleanData };
    const projectedVocabularyBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const [currentTotalBytes, currentVocabularyBytes] = await Promise.all([
      chrome.storage.local.getBytesInUse(null),
      chrome.storage.local.getBytesInUse(STORAGE_KEY),
    ]);
    const projectedTotalBytes = currentTotalBytes - currentVocabularyBytes + projectedVocabularyBytes;
    if (projectedTotalBytes > SAFE_STORAGE_BYTES) {
      throw new Error('生词本接近浏览器的存储上限。请先导出生词本，再删除一部分单词后重试');
    }
    try {
      await chrome.storage.local.set(value);
    } catch (error) {
      const message = String(error?.message || error || '');
      if (/quota|exceed|MAX_WRITE/i.test(message) || projectedTotalBytes > STORAGE_QUOTA_BYTES) {
        throw new Error('浏览器没有足够空间保存生词本。请先导出生词本，再删除一部分单词后重试');
      }
      throw error;
    }
    return cleanData;
  }

  function mutate(operation) {
    const run = mutationQueue.then(async () => {
      const data = await readData();
      const result = await operation(data);
      await writeData(data);
      return result;
    });
    mutationQueue = run.catch(() => {});
    return run;
  }

  function mergeContexts(target, incoming) {
    const merged = [];
    const seen = new Set();
    for (const occurrence of [...target, ...incoming]) {
      const clean = createOccurrence(occurrence, occurrence.capturedAt);
      if (seen.has(clean.occurrenceKey)) continue;
      seen.add(clean.occurrenceKey);
      merged.push(clean);
    }
    merged.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    if (merged.length <= MAX_CONTEXTS_PER_WORD) return merged;
    return [...merged.slice(0, MAX_CONTEXTS_PER_WORD - 1), merged[merged.length - 1]];
  }

  function mergeEntry(target, incoming) {
    const incomingIsNewer = Date.parse(incoming.lastSeenAt) > Date.parse(target.lastSeenAt);
    const mergedLastSeen = Date.parse(target.lastSeenAt) >= Date.parse(incoming.lastSeenAt)
      ? target.lastSeenAt
      : incoming.lastSeenAt;
    const organizationCandidates = [target.organizedAt, incoming.organizedAt]
      .filter(Boolean)
      .sort((a, b) => Date.parse(b) - Date.parse(a));
    const organizedAt = organizationCandidates[0] && Date.parse(organizationCandidates[0]) >= Date.parse(mergedLastSeen)
      ? organizationCandidates[0]
      : null;

    target.firstSeenAt = Date.parse(target.firstSeenAt) <= Date.parse(incoming.firstSeenAt)
      ? target.firstSeenAt
      : incoming.firstSeenAt;
    target.collectedAt = Date.parse(target.collectedAt) <= Date.parse(incoming.collectedAt)
      ? target.collectedAt
      : incoming.collectedAt;
    target.lastSeenAt = mergedLastSeen;
    target.organizedAt = organizedAt;
    target.count = Math.max(target.count, incoming.count);
    target.contexts = mergeContexts(target.contexts, incoming.contexts);
    if (incomingIsNewer) target.word = incoming.word;
    return target;
  }

  function recordDeletion(data, key, deletedAt = new Date().toISOString()) {
    if (!key) return;
    const deletionMap = mergeDeletions(data.deletedWords, [{ key, deletedAt }]);
    data.deletedWords = [...deletionMap.values()];
  }

  async function list() {
    const data = await readData();
    data.entries.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    return data;
  }

  function add(payload) {
    return mutate(async (data) => {
      const key = normalizeWord(payload?.word);
      if (!key) throw new Error('只能收藏单个英文单词');
      const now = new Date().toISOString();
      data.deletedWords = data.deletedWords.filter((item) => item.key !== key);
      const occurrence = createOccurrence({
        context: payload.context,
        source: payload.source,
        capturedAt: now,
      }, now);
      let entry = data.entries.find((item) => item.key === key);
      const created = !entry;
      if (!entry) {
        entry = sanitizeEntry({
          id: createId(),
          key,
          word: payload.word,
          collectedAt: now,
          firstSeenAt: now,
          lastSeenAt: now,
          organizedAt: null,
          count: 1,
          contexts: [occurrence],
        });
        data.entries.push(entry);
      } else {
        entry.word = cleanWord(payload.word) || entry.word;
        entry.lastSeenAt = now;
        entry.organizedAt = null;
        entry.count += 1;
        entry.contexts = mergeContexts(entry.contexts, [occurrence]);
      }
      return { entry, created };
    });
  }

  function remove(payload) {
    return mutate(async (data) => {
      const key = normalizeWord(payload?.word);
      const index = data.entries.findIndex((entry) => entry.id === payload?.id || (key && entry.key === key));
      if (index < 0) return { removed: false };
      const [entry] = data.entries.splice(index, 1);
      recordDeletion(data, entry.key);
      return { removed: true, entry };
    });
  }

  async function status(word) {
    const key = normalizeWord(word);
    if (!key) return { saved: false };
    const data = await readData();
    const entry = data.entries.find((item) => item.key === key);
    return { saved: !!entry, entry: entry || null };
  }

  function setOrganized(ids, organized) {
    return mutate(async (data) => {
      const idSet = new Set(Array.isArray(ids) ? ids : []);
      const timestamp = organized ? new Date().toISOString() : null;
      let updated = 0;
      for (const entry of data.entries) {
        if (!idSet.has(entry.id)) continue;
        entry.organizedAt = timestamp;
        updated += 1;
      }
      return { updated, organizedAt: timestamp };
    });
  }

  function deleteMany(ids) {
    return mutate(async (data) => {
      const idSet = new Set(Array.isArray(ids) ? ids : []);
      const before = data.entries.length;
      const kept = [];
      const deletedAt = new Date().toISOString();
      for (const entry of data.entries) {
        if (idSet.has(entry.id)) recordDeletion(data, entry.key, deletedAt);
        else kept.push(entry);
      }
      data.entries = kept;
      return { deleted: before - data.entries.length };
    });
  }

  function importMerge(rawImport) {
    return mutate(async (data) => {
      const rawEntries = Array.isArray(rawImport)
        ? rawImport
        : Array.isArray(rawImport?.entries)
          ? rawImport.entries
          : null;
      if (!rawEntries) throw new Error('这个 JSON 不是生词本备份');

      let added = 0;
      let merged = 0;
      let skipped = 0;
      let deleted = 0;
      const entriesByKey = new Map(data.entries.map((entry) => [entry.key, entry]));
      for (const rawEntry of rawEntries) {
        const incoming = sanitizeEntry(rawEntry);
        if (!incoming) {
          skipped += 1;
          continue;
        }
        const existing = entriesByKey.get(incoming.key);
        if (existing) {
          mergeEntry(existing, incoming);
          merged += 1;
        } else {
          data.entries.push(incoming);
          entriesByKey.set(incoming.key, incoming);
          added += 1;
        }
      }

      const incomingDeletions = Array.isArray(rawImport?.deletedWords) ? rawImport.deletedWords : [];
      const deletionMap = mergeDeletions(data.deletedWords, incomingDeletions);
      data.entries = data.entries.filter((entry) => {
        const deletion = deletionMap.get(entry.key);
        if (!deletion) return true;
        if (Date.parse(deletion.deletedAt) >= Date.parse(entry.lastSeenAt)) {
          deleted += 1;
          return false;
        }
        // 这个词在删除之后又被明确收藏，新的收藏优先。
        deletionMap.delete(entry.key);
        return true;
      });
      data.deletedWords = [...deletionMap.values()];
      return { added, merged, skipped, deleted, total: data.entries.length };
    });
  }

  return {
    STORAGE_KEY,
    FORMAT,
    VERSION,
    list,
    add,
    remove,
    status,
    setOrganized,
    deleteMany,
    importMerge,
    normalizeWord,
  };
})();
